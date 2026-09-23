import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import {
  attachmentDisposition,
  MAX_DOCUMENT_BYTES,
  ObjectTooLargeError,
  type ObjectStorage,
  type PresignedPut,
} from '@harbour/adapters';
import { recordAudit, type DocumentScope, type TenantTransactionClient } from '@harbour/db';
import type { DocumentStatusValue, DocumentTypeValue } from '../../components/document-labels';
import {
  REQUIRED_QUOTE_DOCUMENT_TYPES,
  type UploadRequest,
  type UploadScope,
} from '../../validators/documents';
import { getApp } from '../app.server';
import { withOrg, type OrgContext } from '../auth.server';
import { requestLogger, type Logger } from '../logger.server';
import { pageError } from '../page-error';
import type { DocumentServices } from './storage.server';

/**
 * Document vault (M5; brief §7.4, docs/phase-1-workspace-ux.md "Documents").
 *
 * Every function takes the request's `OrgContext`, so tenant scoping (`withOrg`: Prisma scope +
 * RLS) and the RBAC check made by the route apply to all data access. Storage keys are
 * `orgId/{quote|org}/docId` (§7.4); the original file name is sanitised at the boundary, kept
 * for display and `Content-Disposition` only, and NEVER logged or put in audit metadata (§7.3).
 *
 * Upload lifecycle:
 *   createUploadRecord  Document row (status UPLOADED, sha256 '') + presigned PUT (5 min)
 *   completeUpload      head() the object, size must match → SCANNING, audit `doc.upload`,
 *                       scan job enqueued (worker) or run inline (no Redis)
 *   scan (worker)       → CLEAN | REJECTED | UPLOADED/not_scanned  (see @harbour/adapters scan.ts)
 *   verify              CLEAN → VERIFIED by an OWNER/ADMIN (`doc.verify`)
 *   download            presigned GET, 5 min, attachment disposition; audit `doc.download`
 *   delete              soft (`deletedAt`), object removed; audit `doc.delete`
 */

export const PRESIGN_PUT_SECONDS = 5 * 60;
export const PRESIGN_GET_SECONDS = 5 * 60;

// ---------- availability ----------

/** Storage or the "Document storage not configured" page (503). Everything else is unaffected. */
export const requireDocumentStorage = async (): Promise<{
  storage: ObjectStorage;
  documents: DocumentServices;
  logger: Logger;
}> => {
  const app = await getApp();
  const { documents } = app;
  if (!documents.storage) {
    throw pageError(
      503,
      'Document storage not configured',
      'Documents are not available on this server yet. Quotes, products and settings still work.',
      app.env.NODE_ENV === 'production'
        ? null
        : `Set STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY (plus STORAGE_ENDPOINT for R2), or leave them all unset outside production to use a local directory. Reason: ${documents.unavailable ?? 'unknown'}.`,
    );
  }
  return { storage: documents.storage, documents, logger: app.logger };
};

// ---------- reads ----------

export interface DocumentRow {
  id: string;
  type: DocumentTypeValue;
  scope: DocumentScope;
  quoteId: string | null;
  status: DocumentStatusValue;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  scanEngine: string | null;
  scanResult: string | null;
  rejectedReason: string | null;
  uploadedBy: string;
  verifiedAt: string | null;
  createdAt: string;
  /** What the current user may do with it (derived server-side from role + status). */
  canDownload: boolean;
  canDelete: boolean;
  canVerify: boolean;
}

export interface QuoteGroup {
  id: string;
  status: string;
  createdAt: string;
  documents: DocumentRow[];
}

export interface MissingFile {
  quoteId: string;
  type: (typeof REQUIRED_QUOTE_DOCUMENT_TYPES)[number];
  /** A REJECTED upload exists (as opposed to none at all). */
  rejected: boolean;
}

export interface VaultView {
  missing: MissingFile[];
  quotes: QuoteGroup[];
  organisation: DocumentRow[];
  acceptedQuoteCount: number;
}

const documentSelect = {
  id: true,
  type: true,
  scope: true,
  quoteId: true,
  status: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  version: true,
  scanEngine: true,
  scanResult: true,
  rejectedReason: true,
  verifiedAt: true,
  createdAt: true,
  uploadedBy: { select: { email: true } },
} as const;

type DocumentRecord = {
  id: string;
  type: DocumentTypeValue;
  scope: DocumentScope;
  quoteId: string | null;
  status: DocumentStatusValue;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  scanEngine: string | null;
  scanResult: string | null;
  rejectedReason: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  uploadedBy: { email: string };
};

const DOWNLOADABLE: readonly DocumentStatusValue[] = ['UPLOADED', 'SCANNING', 'CLEAN', 'VERIFIED'];

const toRow = (ctx: OrgContext, d: DocumentRecord): DocumentRow => {
  const { can } = permissions(ctx);
  return {
    id: d.id,
    type: d.type,
    scope: d.scope,
    quoteId: d.quoteId,
    status: d.status,
    originalName: d.originalName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    version: d.version,
    scanEngine: d.scanEngine,
    scanResult: d.scanResult,
    rejectedReason: d.rejectedReason,
    uploadedBy: d.uploadedBy.email,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    canDownload: can.download && DOWNLOADABLE.includes(d.status),
    canDelete: can.upload,
    canVerify: can.verify && d.status === 'CLEAN',
  };
};

const permissions = (ctx: OrgContext) => {
  const role = ctx.role;
  return {
    can: {
      download: true, // every role (§7.2); the route still checks `doc.download`
      upload: role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER',
      verify: role === 'OWNER' || role === 'ADMIN',
    },
  };
};

export const loadVault = (ctx: OrgContext): Promise<VaultView> =>
  withOrg(ctx, async (tx) => {
    const [documents, quotes] = await Promise.all([
      tx.document.findMany({
        where: { deletedAt: null },
        select: documentSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      tx.quote.findMany({
        where: { status: { notIn: ['CANCELLED'] } },
        select: { id: true, status: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    ]);
    const rows = documents.map((d) => toRow(ctx, d));
    const byQuote = new Map<string, DocumentRow[]>();
    for (const r of rows) {
      if (r.quoteId) byQuote.set(r.quoteId, [...(byQuote.get(r.quoteId) ?? []), r]);
    }
    const missing: MissingFile[] = [];
    for (const q of quotes) {
      if (q.status !== 'ACCEPTED') continue;
      const docs = byQuote.get(q.id) ?? [];
      for (const type of REQUIRED_QUOTE_DOCUMENT_TYPES) {
        const ofType = docs.filter((d) => d.type === type);
        if (ofType.some((d) => d.status !== 'REJECTED')) continue;
        missing.push({ quoteId: q.id, type, rejected: ofType.length > 0 });
      }
    }
    const groups: QuoteGroup[] = quotes
      .filter((q) => q.status === 'ACCEPTED' || byQuote.has(q.id))
      .map((q) => ({
        id: q.id,
        status: q.status,
        createdAt: q.createdAt.toISOString(),
        documents: byQuote.get(q.id) ?? [],
      }));
    return {
      missing,
      quotes: groups,
      organisation: rows.filter((r) => r.scope === 'ORGANISATION'),
      acceptedQuoteCount: quotes.filter((q) => q.status === 'ACCEPTED').length,
    };
  });

export interface UploadTarget {
  id: string;
  status: string;
  createdAt: string;
}

/** Quotes a document can be attached to (any non-cancelled quote of the organisation). */
export const listUploadTargets = (ctx: OrgContext): Promise<UploadTarget[]> =>
  withOrg(ctx, async (tx) => {
    const quotes = await tx.quote.findMany({
      where: { status: { notIn: ['CANCELLED'] } },
      select: { id: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return quotes.map((q) => ({
      id: q.id,
      status: q.status,
      createdAt: q.createdAt.toISOString(),
    }));
  });

// ---------- upload ----------

export const storageKeyFor = (organizationId: string, scope: UploadScope, documentId: string) =>
  `${organizationId}/${scope === 'QUOTE' ? 'quote' : 'org'}/${documentId}`;

export type CreateUploadResult =
  | { ok: true; documentId: string; version: number; upload: PresignedPut }
  | { ok: false; field: 'quoteId'; message: string };

/**
 * The Document row, in UPLOADED with an empty sha256, plus the presigned PUT the client uses. The
 * quote (if any) must belong to this organisation — checked inside the tenant transaction, so a
 * foreign quote id simply does not exist. Version = 1 + the highest version of the same type on
 * the same target (history is kept; older rows are never touched).
 */
export const createUploadRecord = async (
  ctx: OrgContext,
  storage: ObjectStorage,
  input: UploadRequest,
  request: Request,
): Promise<CreateUploadResult> => {
  const { logger } = await getApp();
  const log = requestLogger(logger, request);
  const documentId = randomUUID();
  const storageKey = storageKeyFor(ctx.org.id, input.scope, documentId);
  return withOrg(ctx, async (tx) => {
    if (input.scope === 'QUOTE') {
      const quote = await tx.quote.findUnique({
        where: { id: input.quoteId ?? '' },
        select: { id: true, status: true },
      });
      if (!quote || quote.status === 'CANCELLED') {
        log.info('documents.upload_rejected', { reason: 'quote_not_found', userId: ctx.user.id });
        return { ok: false, field: 'quoteId', message: 'Choose a quote of this organisation.' };
      }
    }
    const latest = await tx.document.findFirst({
      where: {
        type: input.type,
        scope: input.scope,
        quoteId: input.quoteId,
      },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    await tx.document.create({
      data: {
        id: documentId,
        organizationId: ctx.org.id,
        scope: input.scope,
        quoteId: input.quoteId,
        type: input.type,
        status: 'UPLOADED',
        storageKey,
        originalName: input.filename,
        mimeType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: '',
        version,
        uploadedById: ctx.user.id,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'doc.create',
      targetType: 'Document',
      targetId: documentId,
      metadata: {
        type: input.type,
        scope: input.scope,
        quoteId: input.quoteId,
        version,
        sizeBytes: input.sizeBytes,
        mimeType: input.contentType,
      },
    });
    const upload = await storage.presignPut({
      key: storageKey,
      contentType: input.contentType,
      maxBytes: input.sizeBytes,
      expiresInSec: PRESIGN_PUT_SECONDS,
    });
    log.info('documents.presigned', {
      documentId,
      userId: ctx.user.id,
      orgId: ctx.org.id,
      type: input.type,
      scope: input.scope,
      sizeBytes: input.sizeBytes,
      backend: storage.backend,
    });
    return { ok: true, documentId, version, upload };
  });
};

export type CompleteUploadResult =
  | { ok: true; status: 'SCANNING' }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NOT_PENDING' | 'OBJECT_MISSING' | 'REJECTED';
      message: string;
    };

/**
 * The client says the PUT finished. We do not trust it: `head()` must find the object with the
 * declared size (and, when the backend reports one, the declared content type). A mismatch
 * rejects the document and removes the object. Success → SCANNING, audit `doc.upload`, scan job.
 */
export const completeUpload = async (
  ctx: OrgContext,
  services: { storage: ObjectStorage; documents: DocumentServices },
  documentId: string,
  request: Request,
): Promise<CompleteUploadResult> => {
  const { logger } = await getApp();
  const log = requestLogger(logger, request);
  const { storage } = services;
  const doc = await withOrg(ctx, (tx) =>
    tx.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        status: true,
        storageKey: true,
        sizeBytes: true,
        mimeType: true,
        deletedAt: true,
        scanResult: true,
      },
    }),
  );
  if (!doc || doc.deletedAt)
    return { ok: false, code: 'NOT_FOUND', message: 'That document does not exist.' };
  if (doc.status !== 'UPLOADED' || doc.scanResult !== null) {
    return { ok: false, code: 'NOT_PENDING', message: 'That upload has already been completed.' };
  }
  const head = await storage.head(doc.storageKey);
  if (head === null) {
    log.info('documents.complete_missing', { documentId, userId: ctx.user.id });
    return {
      ok: false,
      code: 'OBJECT_MISSING',
      message: 'The file has not been uploaded yet. Try again.',
    };
  }
  const sizeOk = head.sizeBytes === doc.sizeBytes && head.sizeBytes <= MAX_DOCUMENT_BYTES;
  const typeOk =
    head.contentType === null || head.contentType.split(';')[0]?.trim() === doc.mimeType;
  if (!sizeOk || !typeOk) {
    await storage.delete(doc.storageKey);
    const rejectedReason = sizeOk
      ? 'UNSUPPORTED_TYPE'
      : head.sizeBytes > MAX_DOCUMENT_BYTES
        ? 'TOO_LARGE'
        : 'SIZE_MISMATCH';
    await withOrg(ctx, async (tx) => {
      await tx.document.updateMany({
        where: { id: documentId, status: 'UPLOADED' },
        data: {
          status: 'REJECTED',
          rejectedReason,
          scanResult: rejectedReason,
          scannedAt: new Date(),
        },
      });
      await recordAudit(tx, {
        organizationId: ctx.org.id,
        userId: ctx.user.id,
        action: 'doc.reject',
        targetType: 'Document',
        targetId: documentId,
        metadata: { rejectedReason, receivedBytes: head.sizeBytes, declaredBytes: doc.sizeBytes },
      });
    });
    log.warn('documents.complete_rejected', { documentId, userId: ctx.user.id, rejectedReason });
    return {
      ok: false,
      code: 'REJECTED',
      message: 'The uploaded file did not match what was declared and was rejected.',
    };
  }
  const updated = await withOrg(ctx, async (tx) => {
    const res = await tx.document.updateMany({
      where: { id: documentId, status: 'UPLOADED', scanResult: null },
      data: { status: 'SCANNING' },
    });
    if (res.count !== 1) return false;
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'doc.upload',
      targetType: 'Document',
      targetId: documentId,
      metadata: { sizeBytes: head.sizeBytes, scanEngine: services.documents.scanner.engine },
    });
    return true;
  });
  if (!updated)
    return { ok: false, code: 'NOT_PENDING', message: 'That upload has already been completed.' };
  log.info('documents.uploaded', {
    documentId,
    userId: ctx.user.id,
    orgId: ctx.org.id,
    sizeBytes: head.sizeBytes,
  });
  if (services.documents.enqueuer) {
    await services.documents.enqueuer.enqueueDocumentScan({
      documentId,
      organizationId: ctx.org.id,
    });
  } else {
    log.error('documents.scan_not_enqueued', {
      documentId,
      message: 'No scan enqueuer configured; the document stays SCANNING.',
    });
  }
  return { ok: true, status: 'SCANNING' };
};

/**
 * No-JS / development fallback: the browser cannot PUT to a presigned URL without JavaScript, so
 * the multipart form posts the bytes to the app, which spools them to a temp file (size-limited)
 * and puts them into storage server-side with the same limits, then runs the normal completion.
 * Not the primary path (§7.4 wants direct-to-storage uploads); do not use it for production
 * traffic at scale.
 */
export const serverSideUpload = async (
  ctx: OrgContext,
  services: { storage: ObjectStorage; documents: DocumentServices },
  input: UploadRequest,
  file: ReadableStream<Uint8Array>,
  request: Request,
): Promise<CreateUploadResult | CompleteUploadResult> => {
  const created = await createUploadRecord(ctx, services.storage, input, request);
  if (!created.ok) return created;
  const dir = await mkdtemp(join(tmpdir(), 'harbour-upload-'));
  const tmp = join(dir, 'body');
  try {
    let received = 0;
    const limit = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > input.sizeBytes) throw new ObjectTooLargeError(input.sizeBytes);
        yield chunk;
      }
    };
    const { createWriteStream } = await import('node:fs');
    await pipeline(Readable.fromWeb(file as NodeReadableStream), limit, createWriteStream(tmp));
    if (received !== input.sizeBytes) {
      return {
        ok: false,
        code: 'REJECTED',
        message: 'The file size did not match what was declared.',
      };
    }
    const key = storageKeyFor(ctx.org.id, input.scope, created.documentId);
    await services.storage.put(key, createReadStream(tmp), {
      contentType: input.contentType,
      sizeBytes: received,
    });
  } catch (err) {
    if (err instanceof ObjectTooLargeError) {
      return { ok: false, code: 'REJECTED', message: 'The file is larger than declared.' };
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return completeUpload(ctx, services, created.documentId, request);
};

// ---------- download / verify / delete ----------

/**
 * A 5-minute presigned GET with an attachment disposition, or null when the document is not
 * downloadable (missing, deleted, rejected, or not in this organisation — all indistinguishable
 * to the caller). Audits `doc.download` in the same transaction that read the row.
 */
export const downloadUrl = async (
  ctx: OrgContext,
  storage: ObjectStorage,
  documentId: string,
  request: Request,
): Promise<string | null> => {
  const { logger } = await getApp();
  const doc = await withOrg(ctx, async (tx) => {
    const d = await tx.document.findUnique({
      where: { id: documentId },
      select: { id: true, status: true, storageKey: true, originalName: true, deletedAt: true },
    });
    if (!d || d.deletedAt || !DOWNLOADABLE.includes(d.status)) return null;
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'doc.download',
      targetType: 'Document',
      targetId: d.id,
      metadata: { status: d.status },
    });
    return d;
  });
  if (!doc) return null;
  requestLogger(logger, request).info('documents.download', {
    documentId,
    userId: ctx.user.id,
    orgId: ctx.org.id,
  });
  return storage.presignGet({
    key: doc.storageKey,
    expiresInSec: PRESIGN_GET_SECONDS,
    responseContentDisposition: attachmentDisposition(doc.originalName),
  });
};

export type SimpleResult = { ok: true } | { ok: false; message: string };

export const verifyDocument = async (
  ctx: OrgContext,
  documentId: string,
  request: Request,
): Promise<SimpleResult> => {
  const { logger } = await getApp();
  const result = await withOrg(ctx, async (tx) => {
    const res = await tx.document.updateMany({
      where: { id: documentId, status: 'CLEAN', deletedAt: null },
      data: { status: 'VERIFIED', verifiedById: ctx.user.id, verifiedAt: new Date() },
    });
    if (res.count !== 1) return false;
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'doc.verify',
      targetType: 'Document',
      targetId: documentId,
    });
    return true;
  });
  if (!result) {
    return {
      ok: false,
      message: 'Only a document whose virus scan passed ("Clean") can be verified.',
    };
  }
  requestLogger(logger, request).info('documents.verified', {
    documentId,
    userId: ctx.user.id,
    orgId: ctx.org.id,
  });
  return { ok: true };
};

/** Soft delete: `deletedAt` set, object removed from storage, audit `doc.delete`. Idempotent. */
export const deleteDocument = async (
  ctx: OrgContext,
  storage: ObjectStorage,
  documentId: string,
  request: Request,
): Promise<SimpleResult> => {
  const { logger } = await getApp();
  const doc = await withOrg(ctx, async (tx) => {
    const d = await tx.document.findUnique({
      where: { id: documentId },
      select: { id: true, storageKey: true, deletedAt: true, status: true },
    });
    if (!d) return null;
    if (d.deletedAt) return d;
    await tx.document.updateMany({
      where: { id: documentId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'doc.delete',
      targetType: 'Document',
      targetId: documentId,
      metadata: { statusAtDelete: d.status },
    });
    return d;
  });
  if (!doc) return { ok: false, message: 'That document does not exist.' };
  await storage.delete(doc.storageKey);
  requestLogger(logger, request).info('documents.deleted', {
    documentId,
    userId: ctx.user.id,
    orgId: ctx.org.id,
  });
  return { ok: true };
};

/** For the scan store and tests: the tenant client type, re-exported so tests need no db import. */
export type { TenantTransactionClient };
