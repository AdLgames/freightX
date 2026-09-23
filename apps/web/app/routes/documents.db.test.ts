/**
 * Document vault against a real Postgres (§7.4, §9): presign → PUT → complete → scan → statuses,
 * download (audit + presigned GET), delete, verify, versioning, missing-files list, cross-tenant
 * negatives, permission denials and "no file names in logs". Runs only with DATABASE_URL, as a
 * superuser or as a `harbour_app` member. Storage is a temp directory; the scanner is swapped per
 * scenario (none / clean / infected) so every outcome is exercised without ClamAV.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveLocalSigningSecret,
  LocalDiskObjectStorage,
  type MalwareScanner,
} from '@harbour/adapters';
import { disposePrismaClient, withOrgTransaction, type PrismaClient } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { createDocumentServices } from '../services/documents/storage.server';
import { createOrganization } from '../services/organizations.server';
import { pageErrorSchema } from '../services/page-error';
import { cookieFor, createTestApp, uniqueEmail, type TestApp } from '../test-support/harness';
import { loader as vaultLoader } from './app.documents';
import { action as completeAction } from './app.documents_.$id.complete';
import { action as deleteAction } from './app.documents_.$id.delete';
import { loader as downloadLoader } from './app.documents_.$id.download';
import { action as verifyAction } from './app.documents_.$id.verify';
import { action as newAction, loader as newLoader } from './app.documents_.new';
import { action as presignAction } from './app.documents_.presign';
import { loader as getLoader } from './files.get.$';
import { action as putAction } from './files.put.$';

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGIN = 'http://localhost:3000';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'latin1');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
]);
const SECRET_NAME = 'Supplier Zhang Wei invoice 4471 CONFIDENTIAL.pdf';

const acceptedQuoteData = {
  status: 'ACCEPTED' as const,
  incoterm: 'FOB' as const,
  mode: 'SEA_LCL' as const,
  originCountry: 'CN',
  fxRate: '0.790000',
  fxSource: 'HMRC_MONTHLY',
  fxDate: new Date('2026-09-01T00:00:00Z'),
  fxSnapshots: {},
  rateSource: 'RATE_SHEET_V1',
  rateFetchedAt: new Date('2026-09-20T00:00:00Z'),
  validUntil: new Date('2026-12-27T00:00:00Z'),
  goodsValueGbp: '790.00',
  freightCost: '300.00',
  freightToBorderGbp: '250.00',
  freightPostBorderGbp: '50.00',
  originFees: '0.00',
  destinationFees: '80.00',
  customsValue: '1040.00',
  totalDuty: '83.20',
  totalVat: '240.64',
  vatRecoverable: true,
  platformFee: '0.00',
  totalLandedCost: '1443.84',
  totalLandedCostExVat: '1203.20',
  apportionmentBasis: 'SEA_WEIGHT_OR_MEASURE',
  warnings: [],
  calcVersion: 'test',
  acceptedAt: new Date(),
};

type RouteFn = (args: {
  request: Request;
  params: Record<string, string>;
  context: object;
}) => unknown;
interface Result {
  status: number;
  location: string | null;
  json: Record<string, unknown> | null;
  data: unknown;
  body: Response | null;
}
const isDataWithInit = (
  v: unknown,
): v is { type: 'DataWithResponseInit'; data: unknown; init: ResponseInit | null } =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'DataWithResponseInit';

/** Like the harness `run` but with route params and JSON bodies. */
const invoke = async (
  fn: unknown,
  request: Request,
  params: Record<string, string> = {},
): Promise<Result> => {
  let value: unknown;
  try {
    value = await (fn as RouteFn)({ request, params, context: {} });
  } catch (err) {
    value = err;
  }
  if (value instanceof Response) {
    const type = value.headers.get('content-type') ?? '';
    const json = type.includes('application/json')
      ? ((await value.clone().json()) as Record<string, unknown>)
      : null;
    return {
      status: value.status,
      location: value.headers.get('location'),
      json,
      data: null,
      body: value,
    };
  }
  if (isDataWithInit(value)) {
    return {
      status: value.init?.status ?? 200,
      location: null,
      json: null,
      data: value.data,
      body: null,
    };
  }
  if (value instanceof Error) throw value;
  return { status: 200, location: null, json: null, data: value, body: null };
};

const cleanScanner: MalwareScanner = {
  engine: 'clamav',
  async scan(stream) {
    stream.destroy();
    return { verdict: 'clean' };
  },
};
const infectedScanner: MalwareScanner = {
  engine: 'clamav',
  async scan(stream) {
    stream.destroy();
    return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
  },
};

describe.skipIf(!DATABASE_URL)('document vault (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  let dir: string;
  let storage: LocalDiskObjectStorage;
  const emails: string[] = [];
  const orgIds: string[] = [];

  interface Actor {
    userId: string;
    orgId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
    cookie: string;
    csrf: string;
  }
  let owner: Actor;
  let member: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let acceptedQuoteId: string;
  let outsiderQuoteId: string;

  const newUser = async (label: string) => {
    const email = uniqueEmail(label);
    emails.push(email);
    return prisma.user.create({ data: { email }, select: { id: true } });
  };
  const session = async (userId: string, orgId: string, role: Actor['role']): Promise<Actor> => {
    const s = await t.app.auth.sessions!.create({ userId, currentOrgId: orgId, role });
    return { userId, orgId, role, cookie: cookieFor(s.id), csrf: s.data.csrfToken };
  };
  const useScanner = (scanner: MalwareScanner) => {
    t.app.documents = createDocumentServices({
      env: t.app.env,
      logger: t.app.logger,
      prisma,
      redis: null,
      storage,
      scanner,
    });
  };
  const drain = () => t.app.documents.enqueuer!.drain();

  const req = (
    path: string,
    actor: Actor,
    form?: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${ORIGIN}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        cookie: actor.cookie,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      ...(form ? { body: new URLSearchParams({ _csrf: actor.csrf, ...form }).toString() } : {}),
    });

  /** presign → PUT the bytes through the local storage route → complete. Returns the document id. */
  const upload = async (
    actor: Actor,
    fields: Record<string, string>,
    bytes: Buffer,
    opts: { putBytes?: Buffer; skipPut?: boolean } = {},
  ) => {
    const presign = await invoke(presignAction, req('/app/documents/presign', actor, fields));
    expect(presign.status, JSON.stringify(presign.json)).toBe(201);
    const {
      documentId,
      upload: put,
      completeUrl,
    } = presign.json as {
      documentId: string;
      upload: { url: string; method: string; headers: Record<string, string> };
      completeUrl: string;
    };
    if (!opts.skipPut) {
      const key = new URL(put.url).pathname.replace('/files/put/', '');
      const stored = await invoke(
        putAction,
        new Request(put.url, {
          method: put.method,
          headers: put.headers,
          body: new Uint8Array(opts.putBytes ?? bytes),
        }),
        { '*': key },
      );
      expect(stored.status).toBe(200);
    }
    const complete = await invoke(
      completeAction,
      req(completeUrl, actor, {}, { accept: 'application/json' }),
      { id: documentId },
    );
    return {
      documentId,
      complete,
      key: `${actor.orgId}/${fields.scope === 'QUOTE' ? 'quote' : 'org'}/${documentId}`,
    };
  };

  const docRow = (orgId: string, id: string) =>
    withOrgTransaction(prisma, orgId, (tx) => tx.document.findUniqueOrThrow({ where: { id } }));
  const audits = (orgId: string, targetId: string) =>
    withOrgTransaction(prisma, orgId, (tx) =>
      tx.auditLog.findMany({ where: { targetId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harbour-vault-'));
    t = await createTestApp({ databaseUrl: DATABASE_URL, env: { STORAGE_LOCAL_DIR: dir } });
    prisma = t.prisma!;
    storage = new LocalDiskObjectStorage({
      rootDir: dir,
      secret: deriveLocalSigningSecret('vault-test-secret'),
      baseUrl: ORIGIN,
    });
    useScanner(t.app.documents.scanner); // NoScanner

    const [u1, u2, u3, u4] = await Promise.all([
      newUser('owner'),
      newUser('member'),
      newUser('viewer'),
      newUser('outsider'),
    ]);
    const orgA = await createOrganization(prisma, { userId: u1.id, name: 'Vault Org A' });
    const orgB = await createOrganization(prisma, { userId: u4.id, name: 'Vault Org B' });
    orgIds.push(orgA.organizationId, orgB.organizationId);
    await withOrgTransaction(prisma, orgA.organizationId, async (tx) => {
      await tx.membership.create({
        data: { organizationId: orgA.organizationId, userId: u2.id, role: 'MEMBER' },
      });
      await tx.membership.create({
        data: { organizationId: orgA.organizationId, userId: u3.id, role: 'VIEWER' },
      });
      const q = await tx.quote.create({
        data: { ...acceptedQuoteData, organizationId: orgA.organizationId },
        select: { id: true },
      });
      acceptedQuoteId = q.id;
    });
    await withOrgTransaction(prisma, orgB.organizationId, async (tx) => {
      const q = await tx.quote.create({
        data: { ...acceptedQuoteData, organizationId: orgB.organizationId },
        select: { id: true },
      });
      outsiderQuoteId = q.id;
    });
    owner = await session(u1.id, orgA.organizationId, 'OWNER');
    member = await session(u2.id, orgA.organizationId, 'MEMBER');
    viewer = await session(u3.id, orgA.organizationId, 'VIEWER');
    outsider = await session(u4.id, orgB.organizationId, 'OWNER');
  });

  afterAll(async () => {
    for (const orgId of orgIds) {
      await withOrgTransaction(prisma, orgId, async (tx) => {
        await tx.document.deleteMany();
        await tx.quote.deleteMany({ where: { status: { not: 'ACCEPTED' } } });
        await tx.quote.updateMany({ where: { status: 'ACCEPTED' }, data: { status: 'CANCELLED' } });
        await tx.quote.deleteMany();
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    setAppForTests(null);
    await disposePrismaClient();
    await rm(dir, { recursive: true, force: true });
  });

  it('empty vault: no accepted-quote files are missing until documents exist… (they are, for the accepted quote)', async () => {
    const page = await invoke(vaultLoader, req('/app/documents', viewer));
    expect(page.status).toBe(200);
    const data = page.data as {
      missing: unknown[];
      acceptedQuoteCount: number;
      canUpload: boolean;
      scanner: string;
    };
    expect(data.acceptedQuoteCount).toBe(1);
    expect(data.missing).toEqual([
      { quoteId: acceptedQuoteId, type: 'COMMERCIAL_INVOICE', rejected: false },
      { quoteId: acceptedQuoteId, type: 'PACKING_LIST', rejected: false },
    ]);
    expect(data.canUpload).toBe(false);
    expect(data.scanner).toBe('none');
  });

  it('organisation document: presign → PUT → complete → not scanned → stays Uploaded; then download and delete', async () => {
    const firstLine = t.lines.length;
    const { documentId, complete, key } = await upload(
      owner,
      {
        type: 'EORI_CONFIRMATION',
        scope: 'ORGANISATION',
        filename: SECRET_NAME,
        mimeType: 'application/pdf',
        sizeBytes: String(PDF.length),
      },
      PDF,
    );
    expect(complete.status).toBe(200);
    expect(complete.json).toMatchObject({ ok: true, status: 'SCANNING' });
    await drain();

    const row = await docRow(owner.orgId, documentId);
    expect(row).toMatchObject({
      status: 'UPLOADED',
      scanEngine: 'none',
      scanResult: 'not_scanned',
      rejectedReason: null,
      scope: 'ORGANISATION',
      quoteId: null,
      version: 1,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      originalName: SECRET_NAME,
      storageKey: key,
    });
    expect(row.storageKey.startsWith(`${owner.orgId}/org/`)).toBe(true);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.scannedAt).not.toBeNull();
    expect((await audits(owner.orgId, documentId)).map((a) => [a.action, a.userId])).toEqual([
      ['doc.create', owner.userId],
      ['doc.upload', owner.userId],
      ['doc.scan', null],
    ]);

    // Vault shows it under organisation documents with the "not virus-scanned" badge inputs.
    const page = await invoke(vaultLoader, req('/app/documents?tab=organisation', viewer));
    const org = (page.data as { organisation: Array<Record<string, unknown>> }).organisation;
    expect(org).toHaveLength(1);
    expect(org[0]).toMatchObject({
      id: documentId,
      type: 'EORI_CONFIRMATION',
      originalName: SECRET_NAME,
      status: 'UPLOADED',
      scanResult: 'not_scanned',
      canDownload: true,
      canDelete: false, // viewer
      canVerify: false,
    });

    // Download: 302 to a signed GET that serves the bytes as an attachment; audit doc.download.
    const dl = await invoke(downloadLoader, req(`/app/documents/${documentId}/download`, viewer), {
      id: documentId,
    });
    expect(dl.status).toBe(302);
    const target = new URL(dl.location!);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe(`/files/get/${key}`);
    const exp = Number(target.searchParams.get('exp'));
    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(exp * 1000 - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    const served = await invoke(getLoader, new Request(dl.location!), { '*': key });
    expect(served.status).toBe(200);
    expect(served.body!.headers.get('content-disposition')).toBe(
      `attachment; filename="${SECRET_NAME}"; filename*=UTF-8''${encodeURIComponent(SECRET_NAME)}`,
    );
    expect(Buffer.from(await served.body!.arrayBuffer())).toEqual(PDF);
    expect((await audits(owner.orgId, documentId)).map((a) => a.action)).toContain('doc.download');
    const downloadAudit = (await audits(owner.orgId, documentId)).find(
      (a) => a.action === 'doc.download',
    )!;
    expect(downloadAudit.userId).toBe(viewer.userId);

    // A second completion is a no-op.
    const again = await invoke(
      completeAction,
      req(`/app/documents/${documentId}/complete`, owner, {}, { accept: 'application/json' }),
      { id: documentId },
    );
    expect(again.status).toBe(400);
    expect(again.json).toMatchObject({ ok: false, code: 'NOT_PENDING' });

    // Delete (MEMBER may): soft delete, object gone, audit, no longer listed or downloadable.
    const del = await invoke(deleteAction, req(`/app/documents/${documentId}/delete`, member, {}), {
      id: documentId,
    });
    expect(del.status).toBe(302);
    expect(del.location).toBe('/app/documents?notice=deleted');
    expect((await docRow(owner.orgId, documentId)).deletedAt).not.toBeNull();
    expect(await storage.head(key)).toBeNull();
    expect((await audits(owner.orgId, documentId)).map((a) => a.action)).toContain('doc.delete');
    const after = await invoke(vaultLoader, req('/app/documents?tab=organisation', owner));
    expect((after.data as { organisation: unknown[] }).organisation).toEqual([]);
    const gone = await invoke(downloadLoader, req(`/app/documents/${documentId}/download`, owner), {
      id: documentId,
    });
    expect(gone.status).toBe(404);

    // §7.3: the file name never reaches the logs; the audit metadata holds ids and enums only.
    const text = t.lines.slice(firstLine).join('\n');
    expect(text).not.toContain('Zhang');
    expect(text).not.toContain('CONFIDENTIAL');
    expect(text).not.toContain(SECRET_NAME);
    expect(JSON.stringify(await audits(owner.orgId, documentId))).not.toContain('Zhang');
  });

  it('quote documents: a clean scan → CLEAN, versioning, verify (OWNER only), missing-files list', async () => {
    useScanner(cleanScanner);
    const fields = {
      type: 'COMMERCIAL_INVOICE',
      scope: 'QUOTE',
      quoteId: acceptedQuoteId,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: String(PDF.length),
    };
    const v1 = await upload(member, fields, PDF);
    expect(v1.complete.status).toBe(200);
    await drain();
    expect(await docRow(owner.orgId, v1.documentId)).toMatchObject({
      status: 'CLEAN',
      scanEngine: 'clamav',
      scanResult: 'clean',
      version: 1,
      quoteId: acceptedQuoteId,
      scope: 'QUOTE',
    });
    expect(v1.key.startsWith(`${owner.orgId}/quote/`)).toBe(true);

    const v2 = await upload(member, fields, PDF);
    await drain();
    expect((await docRow(owner.orgId, v2.documentId)).version).toBe(2);
    expect((await docRow(owner.orgId, v1.documentId)).status).toBe('CLEAN'); // history kept

    // Missing list: commercial invoice satisfied, packing list still missing.
    const page = await invoke(vaultLoader, req('/app/documents?tab=quotes', owner));
    const data = page.data as {
      missing: unknown[];
      quotes: Array<{ id: string; documents: Array<Record<string, unknown>> }>;
    };
    expect(data.missing).toEqual([
      { quoteId: acceptedQuoteId, type: 'PACKING_LIST', rejected: false },
    ]);
    expect(data.quotes.map((q) => q.id)).toEqual([acceptedQuoteId]);
    expect(data.quotes[0]!.documents.map((d) => [d.version, d.canVerify])).toEqual([
      [2, true],
      [1, true],
    ]);

    // MEMBER cannot verify (403 page error); OWNER can; then it is no longer verifiable.
    const denied = await invoke(
      verifyAction,
      req(`/app/documents/${v2.documentId}/verify`, member, {}),
      { id: v2.documentId },
    );
    expect(denied.status).toBe(403);
    expect(pageErrorSchema.safeParse(denied.data).success).toBe(true);
    const verified = await invoke(
      verifyAction,
      req(`/app/documents/${v2.documentId}/verify`, owner, {}),
      { id: v2.documentId },
    );
    expect(verified.location).toBe('/app/documents?notice=verified');
    const row = await docRow(owner.orgId, v2.documentId);
    expect(row).toMatchObject({ status: 'VERIFIED', verifiedById: owner.userId });
    expect(row.verifiedAt).not.toBeNull();
    expect((await audits(owner.orgId, v2.documentId)).map((a) => a.action)).toContain('doc.verify');
    const twice = await invoke(
      verifyAction,
      req(`/app/documents/${v2.documentId}/verify`, owner, {}),
      { id: v2.documentId },
    );
    expect(twice.status).toBe(400);

    // The upload page lists the quote as a target and honours ?quoteId= / ?type= presets.
    const form = await invoke(
      newLoader,
      req(`/app/documents/new?quoteId=${acceptedQuoteId}&type=PACKING_LIST`, member),
    );
    expect(form.data).toMatchObject({
      preset: { quoteId: acceptedQuoteId, type: 'PACKING_LIST', scope: 'QUOTE' },
    });
    expect((form.data as { quotes: Array<{ id: string }> }).quotes.map((q) => q.id)).toEqual([
      acceptedQuoteId,
    ]);
  });

  it('scanner FOUND → REJECTED with reason, object removed, cannot be downloaded or verified', async () => {
    useScanner(infectedScanner);
    const { documentId, key } = await upload(
      owner,
      {
        type: 'PACKING_LIST',
        scope: 'QUOTE',
        quoteId: acceptedQuoteId,
        filename: 'pl.png',
        mimeType: 'image/png',
        sizeBytes: String(PNG.length),
      },
      PNG,
    );
    await drain();
    expect(await docRow(owner.orgId, documentId)).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'MALWARE_FOUND',
      scanResult: 'FOUND Eicar-Test-Signature',
      scanEngine: 'clamav',
    });
    expect(await storage.head(key)).toBeNull();
    expect(
      (
        await invoke(downloadLoader, req(`/app/documents/${documentId}/download`, owner), {
          id: documentId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await invoke(verifyAction, req(`/app/documents/${documentId}/verify`, owner, {}), {
          id: documentId,
        })
      ).status,
    ).toBe(400);
    const page = await invoke(vaultLoader, req('/app/documents', owner));
    expect((page.data as { missing: unknown[] }).missing).toEqual([
      { quoteId: acceptedQuoteId, type: 'PACKING_LIST', rejected: true },
    ]);
  });

  it('content that does not match the declared type → REJECTED TYPE_MISMATCH (a PDF uploaded as .png)', async () => {
    useScanner(cleanScanner);
    const { documentId, key } = await upload(
      owner,
      {
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'scan.png',
        mimeType: 'image/png',
        sizeBytes: String(PDF.length),
      },
      PDF,
    );
    await drain();
    expect(await docRow(owner.orgId, documentId)).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'TYPE_MISMATCH',
    });
    expect(await storage.head(key)).toBeNull();
  });

  it('complete refuses a missing object and rejects a size that disagrees with the declaration', async () => {
    useScanner(cleanScanner);
    const missing = await upload(
      owner,
      {
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'never.pdf',
        mimeType: 'application/pdf',
        sizeBytes: String(PDF.length),
      },
      PDF,
      { skipPut: true },
    );
    expect(missing.complete.status).toBe(400);
    expect(missing.complete.json).toMatchObject({ ok: false, code: 'OBJECT_MISSING' });
    expect((await docRow(owner.orgId, missing.documentId)).status).toBe('UPLOADED');

    const short = await upload(
      owner,
      {
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'short.pdf',
        mimeType: 'application/pdf',
        sizeBytes: String(PDF.length),
      },
      PDF,
      { putBytes: PDF.subarray(0, 10) },
    );
    expect(short.complete.status).toBe(400);
    expect(short.complete.json).toMatchObject({ ok: false, code: 'REJECTED' });
    expect(await docRow(owner.orgId, short.documentId)).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'SIZE_MISMATCH',
    });
    expect(await storage.head(short.key)).toBeNull();
  });

  it('validation and permissions: bad metadata is 400 with field errors; VIEWER cannot upload; CSRF is required', async () => {
    const bad = await invoke(
      presignAction,
      req('/app/documents/presign', owner, {
        type: 'COMMERCIAL_INVOICE',
        scope: 'ORGANISATION',
        filename: 'x.exe',
        mimeType: 'application/pdf',
        sizeBytes: '0',
      }),
    );
    expect(bad.status).toBe(400);
    // Field issues are reported first; the extension check (a transform) runs once they pass.
    expect(Object.keys(bad.json!.errors as object).sort()).toEqual(['sizeBytes', 'type']);
    const badExt = await invoke(
      presignAction,
      req('/app/documents/presign', owner, {
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'x.exe',
        mimeType: 'application/pdf',
        sizeBytes: '1',
      }),
    );
    expect(badExt.status).toBe(400);
    expect(Object.keys(badExt.json!.errors as object)).toEqual(['filename']);

    const forbidden = await invoke(
      presignAction,
      req('/app/documents/presign', viewer, {
        type: 'OTHER',
        scope: 'ORGANISATION',
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '1',
      }),
    );
    expect(forbidden.status).toBe(403);
    expect((await invoke(newLoader, req('/app/documents/new', viewer))).status).toBe(403);

    const noCsrf = await invoke(
      presignAction,
      new Request(`${ORIGIN}/app/documents/presign`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          type: 'OTHER',
          scope: 'ORGANISATION',
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: '1',
        }).toString(),
      }),
    );
    expect(noCsrf.status).toBe(403);

    const crossSite = await invoke(
      deleteAction,
      req(`/app/documents/${randomUUID()}/delete`, owner, {}, { origin: 'https://evil.example' }),
      { id: randomUUID() },
    );
    expect(crossSite.status).toBe(403);
  });

  it('cross-tenant: org B cannot see, download, complete, verify or delete org A documents, nor attach to org A quotes', async () => {
    useScanner(cleanScanner);
    const { documentId, key } = await upload(
      owner,
      {
        type: 'VAT_CERTIFICATE',
        scope: 'ORGANISATION',
        filename: 'vat.pdf',
        mimeType: 'application/pdf',
        sizeBytes: String(PDF.length),
      },
      PDF,
    );
    await drain();
    expect(
      (
        await invoke(downloadLoader, req(`/app/documents/${documentId}/download`, outsider), {
          id: documentId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await invoke(
          completeAction,
          req(
            `/app/documents/${documentId}/complete`,
            outsider,
            {},
            { accept: 'application/json' },
          ),
          { id: documentId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await invoke(verifyAction, req(`/app/documents/${documentId}/verify`, outsider, {}), {
          id: documentId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invoke(deleteAction, req(`/app/documents/${documentId}/delete`, outsider, {}), {
          id: documentId,
        })
      ).status,
    ).toBe(404);
    expect(await storage.head(key)).not.toBeNull();
    expect((await docRow(owner.orgId, documentId)).deletedAt).toBeNull();

    const vault = await invoke(vaultLoader, req('/app/documents?tab=organisation', outsider));
    expect((vault.data as { organisation: unknown[]; quotes: unknown[] }).organisation).toEqual([]);

    // Org B cannot attach a document to org A's quote (the quote "does not exist" for B).
    const foreign = await invoke(
      presignAction,
      req('/app/documents/presign', outsider, {
        type: 'COMMERCIAL_INVOICE',
        scope: 'QUOTE',
        quoteId: acceptedQuoteId,
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '1',
      }),
    );
    expect(foreign.status).toBe(400);
    expect(foreign.json).toEqual({ errors: { quoteId: 'Choose a quote of this organisation.' } });
    // …and org A's audit trail has nothing from the outsider.
    expect((await audits(owner.orgId, documentId)).map((a) => a.userId)).not.toContain(
      outsider.userId,
    );

    // Org B's own upload lands under B's key prefix, invisible to A.
    const own = await upload(
      outsider,
      {
        type: 'COMMERCIAL_INVOICE',
        scope: 'QUOTE',
        quoteId: outsiderQuoteId,
        filename: 'b.pdf',
        mimeType: 'application/pdf',
        sizeBytes: String(PDF.length),
      },
      PDF,
    );
    await drain();
    expect(own.key.startsWith(`${outsider.orgId}/quote/`)).toBe(true);
    expect(
      (
        await invoke(downloadLoader, req(`/app/documents/${own.documentId}/download`, owner), {
          id: own.documentId,
        })
      ).status,
    ).toBe(404);
    const a = await invoke(vaultLoader, req('/app/documents?tab=quotes', owner));
    expect((a.data as { quotes: Array<{ id: string }> }).quotes.map((q) => q.id)).not.toContain(
      outsiderQuoteId,
    );
  });

  it('no-JS fallback: the multipart form streams the file through the app with the same checks', async () => {
    useScanner(cleanScanner);
    const form = new FormData();
    form.set('_csrf', member.csrf);
    form.set('type', 'REPRESENTATION_AUTHORITY');
    form.set('scope', 'ORGANISATION');
    form.set('file', new File([new Uint8Array(PDF)], 'authority.pdf', { type: 'application/pdf' }));
    const res = await invoke(
      newAction,
      new Request(`${ORIGIN}/app/documents/new`, {
        method: 'POST',
        headers: { cookie: member.cookie },
        body: form,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.location).toBe('/app/documents?tab=organisation&notice=uploaded');
    await drain();
    const rows = await withOrgTransaction(prisma, owner.orgId, (tx) =>
      tx.document.findMany({ where: { type: 'REPRESENTATION_AUTHORITY', deletedAt: null } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'CLEAN',
      sizeBytes: PDF.length,
      originalName: 'authority.pdf',
      uploadedById: member.userId,
    });

    const wrong = new FormData();
    wrong.set('_csrf', member.csrf);
    wrong.set('type', 'OTHER');
    wrong.set('scope', 'ORGANISATION');
    wrong.set(
      'file',
      new File([new Uint8Array(PDF)], 'malware.exe', { type: 'application/octet-stream' }),
    );
    const bad = await invoke(
      newAction,
      new Request(`${ORIGIN}/app/documents/new`, {
        method: 'POST',
        headers: { cookie: member.cookie },
        body: wrong,
      }),
    );
    expect(bad.status).toBe(400);
    expect((bad.data as { errors: Record<string, string> }).errors.filename).toMatch(/Only \.pdf/);
  });

  it('log snapshot: document events carry ids, never names', () => {
    const events = t.logs
      .map((l) => l.event)
      .filter((e): e is string => typeof e === 'string' && e.startsWith('documents.'));
    expect(new Set(events)).toEqual(
      new Set([
        'documents.configured',
        'documents.local_storage',
        'documents.no_scanner',
        'documents.presigned',
        'documents.uploaded',
        'documents.download',
        'documents.deleted',
        'documents.verified',
        'documents.complete_missing',
        'documents.complete_rejected',
        'documents.upload_invalid',
        'documents.upload_rejected',
      ]),
    );
    const text = t.lines.join('\n');
    for (const name of ['invoice.pdf', 'authority.pdf', 'malware.exe', 'vat.pdf', SECRET_NAME]) {
      expect(text).not.toContain(name);
    }
  });
});
