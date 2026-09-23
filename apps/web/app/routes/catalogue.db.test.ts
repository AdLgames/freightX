/**
 * Catalogue (M3) against a real Postgres: the HS lookup endpoint, product CRUD with SKU
 * uniqueness and archive, suppliers with pickup locations and payment terms, RBAC, cross-tenant
 * negatives and the no-PII log rule (§7.2, §7.3, §9). Runs only with DATABASE_URL (migrations
 * applied), as a superuser or as a non-superuser member of harbour_app.
 */
import {
  disposePrismaClient,
  withOrgTransaction,
  type Prisma,
  type PrismaClient,
  type Role,
  type TenantTransactionClient,
} from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { getProduct, updateProduct } from '../services/catalogue/products.server';
import { updatePickupLocation } from '../services/catalogue/suppliers.server';
import { createOrganization } from '../services/organizations.server';
import { pageErrorSchema } from '../services/page-error';
import { InMemoryRateLimiter } from '../services/rate-limit.server';
import {
  cookieFor,
  createTestApp,
  makeRequest,
  run,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { DOWN_COMMODITY, fixtureTariff } from '../test-support/tariff-fixtures';
import { action as hsLookupAction, loader as hsLookupLoader } from './app.api.hs-lookup';
import {
  action as editProductAction,
  loader as editProductLoader,
} from './app.products.$productId';
import { action as newProductAction, loader as newProductLoader } from './app.products.new';
import { loader as productsLoader } from './app.products';
import { action as supplierAction, loader as supplierLoader } from './app.suppliers.$supplierId';
import { action as newSupplierAction } from './app.suppliers.new';
import { loader as suppliersLoader } from './app.suppliers';

const DATABASE_URL = process.env.DATABASE_URL;

type RouteFn = (args: { request: Request; params: object; context: object }) => unknown;
/** `run` with route params. */
const runWith = (fn: unknown, request: Request, params: Record<string, string>) =>
  run((a: { request: Request }) => (fn as RouteFn)({ ...a, params, context: {} }), request);

/** Calls a resource route and reads its JSON body (the harness's `run` drops Response bodies). */
const runJson = async (
  fn: unknown,
  request: Request,
): Promise<{ status: number; location: string | null; headers: Headers; body: unknown }> => {
  let value: unknown;
  try {
    value = await (fn as RouteFn)({ request, params: {}, context: {} });
  } catch (err) {
    value = err;
  }
  if (value instanceof Response) {
    const text = await value.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = text;
    }
    return {
      status: value.status,
      location: value.headers.get('location'),
      headers: value.headers,
      body,
    };
  }
  const init = (value as { init?: ResponseInit | null }).init ?? null;
  return {
    status: init?.status ?? 200,
    location: null,
    headers: new Headers(),
    body: (value as { data?: unknown }).data ?? null,
  };
};

interface Actor {
  userId: string;
  orgId: string;
  cookie: string;
  csrf: string;
}

describe.skipIf(!DATABASE_URL)('catalogue: products, suppliers and HS lookup (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  let clockMs = Date.now();
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let owner: Actor;
  let viewer: Actor;
  let other: Actor;
  let mustSwitchRole = false;

  const asAppRole = async (tx: TenantTransactionClient) => {
    if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
  };

  /** A signed-in user with a session in `orgId` (created when omitted) carrying `role`. */
  const signIn = async (role: Role, orgId?: string): Promise<Actor> => {
    const user = await prisma.user.create({ data: { email: uniqueEmail(role.toLowerCase()) } });
    userIds.push(user.id);
    let org = orgId;
    if (!org) {
      org = (await createOrganization(prisma, { userId: user.id, name: `Cat ${role} Ltd` }))
        .organizationId;
      orgIds.push(org);
    } else {
      const o = org;
      await withOrgTransaction(prisma, o, (tx) =>
        tx.membership.create({ data: { organizationId: o, userId: user.id, role } }),
      );
    }
    const session = await t.app.auth.sessions!.create({ userId: user.id, currentOrgId: org, role });
    return {
      userId: user.id,
      orgId: org,
      cookie: cookieFor(session.id),
      csrf: session.data.csrfToken,
    };
  };

  const post = (actor: Actor, path: string, form: Record<string, string>) =>
    makeRequest(path, { cookie: actor.cookie, form: { ...form, _csrf: actor.csrf } });

  const validProduct = {
    intent: 'save',
    sku: 'TOY-001',
    name: 'Wooden train set',
    supplierId: '',
    originCountry: 'CN',
    unitValue: '4.5',
    currency: 'USD',
    weightKg: '0.8',
    volumeCbm: '',
    cartonLengthCm: '40',
    cartonWidthCm: '30',
    cartonHeightCm: '25',
    unitsPerCarton: '12',
    hsCode: '9503.00.41.00',
  };

  beforeAll(async () => {
    t = await createTestApp({ databaseUrl: DATABASE_URL });
    prisma = t.prisma!;
    // The app object is what getApp() resolves to; swap the tariff client and the clock.
    t.app.tariff = fixtureTariff();
    t.app.rateLimiter = new InMemoryRateLimiter(() => clockMs);
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    mustSwitchRole = who?.bypass === true;
    owner = await signIn('OWNER');
    viewer = await signIn('VIEWER', owner.orgId);
    other = await signIn('OWNER');
  });

  afterAll(async () => {
    for (const orgId of orgIds) {
      await withOrgTransaction(prisma, orgId, async (tx) => {
        await tx.pickupLocation.deleteMany();
        await tx.paymentTerms.deleteMany();
        await tx.product.deleteMany();
        await tx.supplier.deleteMany();
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    setAppForTests(null);
    await disposePrismaClient();
  });

  describe('POST /app/api/hs-lookup', () => {
    it('10 digits → the official description, duty, VAT and preference hint as JSON', async () => {
      const res = await runJson(
        hsLookupAction,
        post(owner, '/app/api/hs-lookup', { hsCode: '9503 00 41 00' }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).toMatchObject({
        ok: true,
        kind: 'COMMODITY',
        code: '9503004100',
        description: "Tricycles, scooters, pedal cars and similar wheeled toys; dolls' carriages",
        thirdCountryDuty: '0.00 %',
        vatRate: '20.00 %',
      });
    });

    it('6 digits → candidates to pick from, never a choice', async () => {
      const res = await runJson(
        hsLookupAction,
        post(owner, '/app/api/hs-lookup', { hsCode: '950300' }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, kind: 'CANDIDATES', code: '950300' });
      expect((res.body as { candidates: unknown[] }).candidates).toHaveLength(4);
    });

    it('9 digits → 400; GET → 405; missing CSRF → 403; signed out → redirect', async () => {
      const bad = await run(
        hsLookupAction,
        post(owner, '/app/api/hs-lookup', { hsCode: '950300410' }),
      );
      expect(bad.status).toBe(400);
      await expect(
        run(hsLookupLoader, makeRequest('/app/api/hs-lookup')).then((r) => r.status),
      ).resolves.toBe(405);
      const noCsrf = await run(
        hsLookupAction,
        makeRequest('/app/api/hs-lookup', { cookie: owner.cookie, form: { hsCode: '9503004100' } }),
      );
      expect(noCsrf.status).toBe(403);
      const anon = await run(
        hsLookupAction,
        makeRequest('/app/api/hs-lookup', { form: { hsCode: '9503004100' } }),
      );
      expect(anon.status).toBe(302);
      expect(anon.location).toMatch(/^\/login/);
    });

    it('is limited to 10 lookups per minute per user: the 11th is a 429 with Retry-After', async () => {
      const fresh = await signIn('MEMBER', owner.orgId);
      const codes = ['9503004100', '950300', '8712003000', '6403999600'];
      for (let i = 0; i < 10; i += 1) {
        const res = await run(
          hsLookupAction,
          post(fresh, '/app/api/hs-lookup', { hsCode: codes[i % 4]! }),
        );
        expect(res.status, `call ${i + 1}`).toBe(200);
      }
      const eleventh = await runJson(
        hsLookupAction,
        post(fresh, '/app/api/hs-lookup', { hsCode: '9503004100' }),
      );
      expect(eleventh.status).toBe(429);
      expect(eleventh.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(eleventh.body).toMatchObject({ ok: false, reason: 'RATE_LIMITED' });
      // Another user is unaffected.
      const otherUser = await run(
        hsLookupAction,
        post(owner, '/app/api/hs-lookup', { hsCode: '9503004100' }),
      );
      expect(otherUser.status).toBe(200);
      // After a minute the bucket has refilled.
      clockMs += 61_000;
      const later = await run(
        hsLookupAction,
        post(fresh, '/app/api/hs-lookup', { hsCode: '9503004100' }),
      );
      expect(later.status).toBe(200);
    });
  });

  describe('products', () => {
    let productId: string;
    let unverifiedId: string;

    it('creates a product: carton → CBM, verified HS code with description, audit row', async () => {
      const res = await run(newProductAction, post(owner, '/app/products/new', validProduct));
      expect(res.status).toBe(302);
      const url = new URL(res.location!, 'http://x');
      expect(url.pathname).toBe('/app/products');
      expect(url.searchParams.get('notice')).toBe('saved');
      productId = url.searchParams.get('product')!;

      const rows = await withOrgTransaction(prisma, owner.orgId, async (tx) => ({
        product: await getProduct(tx, productId),
        audits: await tx.auditLog.findMany({ where: { targetId: productId } }),
      }));
      expect(rows.product).toMatchObject({
        sku: 'TOY-001',
        hsCode: '9503004100',
        hsDescription: "Tricycles, scooters, pedal cars and similar wheeled toys; dolls' carriages",
        preferenceEligible: false,
        unitsPerCarton: 12,
        archivedAt: null,
      });
      expect(rows.product!.hsCodeVerifiedAt).toBeInstanceOf(Date);
      expect(rows.product!.volumeCbm.toFixed(4)).toBe('0.0025');
      expect(rows.product!.unitValue.toFixed(4)).toBe('4.5000');
      expect(rows.product!.cartonLengthCm?.toFixed(2)).toBe('40.00');
      expect(rows.audits.map((a) => a.action)).toEqual(['product.create']);
      expect(rows.audits[0]!.metadata).toEqual({
        supplierId: null,
        hsVerified: true,
        volumeSource: 'CARTON',
      });
      expect(JSON.stringify(rows.audits)).not.toContain('TOY-001');
    });

    it('saves unverified with a clear notice when the tariff service is down', async () => {
      const res = await run(
        newProductAction,
        post(owner, '/app/products/new', {
          ...validProduct,
          sku: 'SUGAR-1',
          name: 'Raw cane sugar',
          hsCode: DOWN_COMMODITY,
          volumeCbm: '0.001',
          cartonLengthCm: '',
          cartonWidthCm: '',
          cartonHeightCm: '',
          unitsPerCarton: '',
        }),
      );
      expect(res.status).toBe(302);
      const url = new URL(res.location!, 'http://x');
      expect(url.searchParams.get('notice')).toBe('saved-unverified');
      expect(url.searchParams.get('reason')).toBe('unavailable');
      unverifiedId = url.searchParams.get('product')!;
      const row = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        getProduct(tx, unverifiedId),
      );
      expect(row).toMatchObject({
        hsCodeVerifiedAt: null,
        hsDescription: null,
        cartonLengthCm: null,
      });
      expect(row!.volumeCbm.toFixed(4)).toBe('0.0010');

      const list = await run(
        productsLoader,
        makeRequest('/app/products?notice=saved-unverified&reason=unavailable', {
          cookie: owner.cookie,
        }),
      );
      expect((list.data as { notice: string }).notice).toContain('could not be reached');
    });

    it('a 6-digit code is never saved: the form comes back with the candidates', async () => {
      const res = await run(
        newProductAction,
        post(owner, '/app/products/new', { ...validProduct, sku: 'SIX', hsCode: '950300' }),
      );
      expect(res.status).toBe(400);
      const body = res.data as {
        errors: Record<string, string>;
        hs: { kind: string; result?: { kind: string } };
      };
      expect(body.errors.hsCode).toContain('Choose the 10-digit');
      expect(body.hs).toMatchObject({ kind: 'result', result: { kind: 'CANDIDATES' } });
      expect(
        await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.product.count({ where: { sku: 'SIX' } }),
        ),
      ).toBe(0);

      // Picking a candidate (radio `hsCodeChoice`) overrides the typed code and saves verified.
      const picked = await run(
        newProductAction,
        post(owner, '/app/products/new', {
          ...validProduct,
          sku: 'SIX',
          hsCode: '950300',
          hsCodeChoice: '9503004100',
        }),
      );
      expect(picked.status).toBe(302);
      expect(new URL(picked.location!, 'http://x').searchParams.get('notice')).toBe('saved');
    });

    it('"Check code" (no JS) re-renders the form with the lookup result', async () => {
      const res = await run(
        newProductAction,
        post(owner, '/app/products/new', {
          ...validProduct,
          intent: 'check-hs',
          hsCode: '9503004100',
          sku: '',
        }),
      );
      expect(res.status).toBe(200);
      const body = res.data as {
        hs: { kind: string; result: { description: string } };
        values: { hsCode: string };
      };
      expect(body.hs.result.description).toContain('Tricycles');
      expect(body.values.hsCode).toBe('9503004100');
    });

    it('rejects a duplicate SKU (case-sensitive unique per organisation) with a field error', async () => {
      const res = await run(newProductAction, post(owner, '/app/products/new', validProduct));
      expect(res.status).toBe(400);
      expect((res.data as { errors: Record<string, string> }).errors.sku).toContain('already used');
      // The same SKU in another organisation is fine.
      const elsewhere = await run(newProductAction, post(other, '/app/products/new', validProduct));
      expect(elsewhere.status).toBe(302);
    });

    it('validation errors come back as a 400 with field messages', async () => {
      const res = await run(
        newProductAction,
        post(owner, '/app/products/new', {
          ...validProduct,
          sku: 'BAD',
          unitValue: '1.23456',
          originCountry: 'ZZ',
          hsCode: '123',
        }),
      );
      expect(res.status).toBe(400);
      const errors = (res.data as { errors: Record<string, string> }).errors;
      expect(Object.keys(errors).sort()).toEqual(['hsCode', 'originCountry', 'unitValue']);
    });

    it('lists with search and the archived filter, marking verified and unverified codes', async () => {
      const all = await run(productsLoader, makeRequest('/app/products', { cookie: owner.cookie }));
      const data = all.data as {
        products: Array<{ sku: string; hsCodeVerifiedAt: string | null }>;
        canEdit: boolean;
      };
      expect(data.canEdit).toBe(true);
      expect(data.products.map((p) => p.sku)).toEqual(['SIX', 'SUGAR-1', 'TOY-001']);
      expect(data.products.find((p) => p.sku === 'TOY-001')!.hsCodeVerifiedAt).not.toBeNull();
      expect(data.products.find((p) => p.sku === 'SUGAR-1')!.hsCodeVerifiedAt).toBeNull();

      const search = await run(
        productsLoader,
        makeRequest('/app/products?q=sugar', { cookie: owner.cookie }),
      );
      expect((search.data as typeof data).products.map((p) => p.sku)).toEqual(['SUGAR-1']);
      // Nothing from the other organisation.
      expect(JSON.stringify(all.data)).not.toContain(other.orgId);
    });

    it('edits: the existing verification is kept when the code is unchanged; changed fields are audited', async () => {
      const res = await runWith(
        editProductAction,
        post(owner, `/app/products/${productId}`, {
          ...validProduct,
          name: 'Wooden train set (large)',
          unitValue: '5.25',
        }),
        { productId },
      );
      expect(res.status).toBe(302);
      expect(new URL(res.location!, 'http://x').searchParams.get('notice')).toBe('saved');
      const rows = await withOrgTransaction(prisma, owner.orgId, async (tx) => ({
        product: await getProduct(tx, productId),
        audits: await tx.auditLog.findMany({
          where: { targetId: productId },
          orderBy: { createdAt: 'asc' },
        }),
      }));
      expect(rows.product!.name).toBe('Wooden train set (large)');
      expect(rows.product!.hsCodeVerifiedAt).toBeInstanceOf(Date);
      expect(rows.product!.hsDescription).toContain('Tricycles');
      expect(rows.audits.map((a) => a.action)).toEqual(['product.create', 'product.update']);
      expect(rows.audits[1]!.metadata).toEqual({
        changed: ['name', 'unitValue'],
        hsVerified: true,
      });
    });

    it('archives instead of deleting, hides it from the default list and restores', async () => {
      const res = await runWith(
        editProductAction,
        post(owner, `/app/products/${productId}`, { intent: 'archive' }),
        { productId },
      );
      expect(res.location).toBe('/app/products?notice=archived&archived=on');
      const row = await withOrgTransaction(prisma, owner.orgId, (tx) => getProduct(tx, productId));
      expect(row!.archivedAt).toBeInstanceOf(Date);

      const active = await run(
        productsLoader,
        makeRequest('/app/products', { cookie: owner.cookie }),
      );
      expect(
        (active.data as { products: Array<{ sku: string }> }).products.map((p) => p.sku),
      ).not.toContain('TOY-001');
      const archived = await run(
        productsLoader,
        makeRequest('/app/products?archived=on', { cookie: owner.cookie }),
      );
      expect(
        (archived.data as { products: Array<{ sku: string }> }).products.map((p) => p.sku),
      ).toEqual(['TOY-001']);

      const back = await runWith(
        editProductAction,
        post(owner, `/app/products/${productId}`, { intent: 'restore' }),
        { productId },
      );
      expect(back.location).toBe('/app/products?notice=restored');
      const audits = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.auditLog.findMany({ where: { targetId: productId }, orderBy: { createdAt: 'asc' } }),
      );
      expect(audits.map((a) => a.action)).toEqual([
        'product.create',
        'product.update',
        'product.archive',
        'product.restore',
      ]);
    });

    it('VIEWER can list and open products but every mutation is a 403 page', async () => {
      const list = await run(
        productsLoader,
        makeRequest('/app/products', { cookie: viewer.cookie }),
      );
      expect(list.status).toBe(200);
      expect((list.data as { canEdit: boolean }).canEdit).toBe(false);
      const open = await runWith(
        editProductLoader,
        makeRequest(`/app/products/${productId}`, { cookie: viewer.cookie }),
        { productId },
      );
      expect(open.status).toBe(200);
      expect((open.data as { canEdit: boolean }).canEdit).toBe(false);

      const newPage = await run(
        newProductLoader,
        makeRequest('/app/products/new', { cookie: viewer.cookie }),
      );
      expect(newPage.status).toBe(403);
      expect(pageErrorSchema.safeParse(newPage.data).success).toBe(true);
      const create = await run(
        newProductAction,
        post(viewer, '/app/products/new', { ...validProduct, sku: 'VIEWER' }),
      );
      expect(create.status).toBe(403);
      const archive = await runWith(
        editProductAction,
        post(viewer, `/app/products/${productId}`, { intent: 'archive' }),
        { productId },
      );
      expect(archive.status).toBe(403);
      const lookup = await run(
        hsLookupAction,
        post(viewer, '/app/api/hs-lookup', { hsCode: '9503004100' }),
      );
      expect(lookup.status).toBe(200); // viewing the tariff is not a mutation
    });

    it('cross-tenant: organisation B cannot see, edit or archive A’s product', async () => {
      const open = await runWith(
        editProductLoader,
        makeRequest(`/app/products/${productId}`, { cookie: other.cookie }),
        { productId },
      );
      expect(open.status).toBe(404);
      expect(pageErrorSchema.safeParse(open.data).success).toBe(true);
      const edit = await runWith(
        editProductAction,
        post(other, `/app/products/${productId}`, { ...validProduct, sku: 'STOLEN' }),
        { productId },
      );
      expect(edit.status).toBe(404);
      const archive = await runWith(
        editProductAction,
        post(other, `/app/products/${productId}`, { intent: 'archive' }),
        { productId },
      );
      expect(archive.location).toBe('/app/products?notice=not-found');
      const direct = await withOrgTransaction(prisma, other.orgId, async (tx) => ({
        read: await getProduct(tx, productId),
        update: await updateProduct(
          tx,
          { organizationId: other.orgId, userId: other.userId },
          productId,
          {
            sku: 'STOLEN',
            name: 'x',
            supplierId: null,
            originCountry: 'CN',
            unitValue: '1',
            currency: 'USD',
            weightKg: '1',
            volumeCbm: '0.001',
            cartonLengthCm: null,
            cartonWidthCm: null,
            cartonHeightCm: null,
            unitsPerCarton: null,
            hsCode: '9503004100',
            hs: { verifiedAt: null, description: null, preferenceEligible: false },
          },
        ),
      }));
      expect(direct).toEqual({ read: null, update: { ok: false, error: 'NOT_FOUND' } });
      const still = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        getProduct(tx, productId),
      );
      expect(still!.sku).toBe('TOY-001');
      expect(still!.archivedAt).toBeNull();
    });
  });

  describe('suppliers', () => {
    let supplierId: string;
    let firstPickup: string;
    let secondPickup: string;

    it('creates the legal entity, keeping the deprecated country_code in step', async () => {
      const res = await run(
        newSupplierAction,
        post(owner, '/app/suppliers/new', {
          legalName: 'Shenzhen Widgets Co., Ltd',
          tradingName: 'Widgets SZ',
          registrationNumber: '91440300MA5XXXXXXX',
          countryOfIncorporation: 'HK',
          defaultCurrency: 'USD',
          defaultIncoterm: 'FOB',
        }),
      );
      expect(res.status).toBe(302);
      const url = new URL(res.location!, 'http://x');
      supplierId = url.pathname.split('/').pop()!;
      expect(url.searchParams.get('notice')).toBe('created');
      const row = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.supplier.findUniqueOrThrow({ where: { id: supplierId } }),
      );
      expect(row).toMatchObject({
        name: 'Widgets SZ',
        legalName: 'Shenzhen Widgets Co., Ltd',
        countryOfIncorporation: 'HK',
        countryCode: 'HK',
        defaultCurrency: 'USD',
        defaultIncoterm: 'FOB',
        archivedAt: null,
      });
      const invalid = await run(
        newSupplierAction,
        post(owner, '/app/suppliers/new', { legalName: '', countryOfIncorporation: 'HK' }),
      );
      expect(invalid.status).toBe(400);
    });

    it('pickup locations: the first is the default; a new default clears the old; the DB allows one', async () => {
      const add = (form: Record<string, string>) =>
        runWith(
          supplierAction,
          post(owner, `/app/suppliers/${supplierId}`, { intent: 'pickup-add', ...form }),
          { supplierId },
        );
      const one = await add({
        name: 'Shenzhen factory',
        country: 'CN',
        closestPortChoice: 'CNSZX',
      });
      expect(one.location).toBe(`/app/suppliers/${supplierId}?notice=pickup-added`);
      const two = await add({
        name: 'Xiamen warehouse',
        country: 'CN',
        closestPortCode: 'cnxmn',
        isDefault: 'on',
      });
      expect(two.location).toContain('pickup-added');
      const bad = await add({ name: 'Nowhere', country: 'CN', closestPortCode: 'CNXM' });
      expect(bad.status).toBe(400);
      expect(bad.data as { form: string; errors: Record<string, string> }).toMatchObject({
        form: 'pickup-add',
      });

      const page = await runWith(
        supplierLoader,
        makeRequest(`/app/suppliers/${supplierId}`, { cookie: owner.cookie }),
        { supplierId },
      );
      const view = (
        page.data as {
          supplier: {
            pickupLocations: Array<{
              id: string;
              name: string;
              closestPortCode: string;
              isDefault: boolean;
            }>;
          };
        }
      ).supplier;
      expect(view.pickupLocations.map((p) => [p.name, p.closestPortCode, p.isDefault])).toEqual([
        ['Xiamen warehouse', 'CNXMN', true],
        ['Shenzhen factory', 'CNSZX', false],
      ]);
      secondPickup = view.pickupLocations[0]!.id;
      firstPickup = view.pickupLocations[1]!.id;

      // Belt and braces: the partial unique index refuses a second default however it is written.
      await expect(
        withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.pickupLocation.create({
            data: {
              organizationId: owner.orgId,
              supplierId,
              name: 'Rogue',
              country: 'CN',
              closestPortCode: 'CNSHA',
              isDefault: true,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
      // …and the LOCODE CHECK refuses a malformed code.
      await expect(
        withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.pickupLocation.create({
            data: {
              organizationId: owner.orgId,
              supplierId,
              name: 'Rogue',
              country: 'CN',
              closestPortCode: 'cn-sha',
            },
          }),
        ),
      ).rejects.toThrow(/pickup_locations_closest_port_code_format/);

      // "Make default" and removing the default promotes another.
      const make = await runWith(
        supplierAction,
        post(owner, `/app/suppliers/${supplierId}`, {
          intent: 'pickup-default',
          pickupId: firstPickup,
        }),
        { supplierId },
      );
      expect(make.location).toContain('pickup-default');
      const remove = await runWith(
        supplierAction,
        post(owner, `/app/suppliers/${supplierId}`, {
          intent: 'pickup-remove',
          pickupId: firstPickup,
        }),
        { supplierId },
      );
      expect(remove.location).toContain('pickup-removed');
      const left = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.pickupLocation.findMany({ where: { supplierId } }),
      );
      expect(left.map((p) => [p.id, p.isDefault])).toEqual([[secondPickup, true]]);
    });

    it('payment terms: one row per supplier, upserted, with the DB CHECKs as the last line', async () => {
      const save = (form: Record<string, string>) =>
        runWith(
          supplierAction,
          post(owner, `/app/suppliers/${supplierId}`, { intent: 'payment-terms', ...form }),
          { supplierId },
        );
      const incomplete = await save({ termType: 'DEPOSIT_BALANCE', depositPct: '30' });
      expect(incomplete.status).toBe(400);
      expect(
        (incomplete.data as { form: string; errors: Record<string, string> }).errors.balanceTrigger,
      ).toBeDefined();

      const ok = await save({
        termType: 'DEPOSIT_BALANCE',
        depositPct: '30',
        balanceTrigger: 'AGAINST_BILL_OF_LADING',
      });
      expect(ok.location).toContain('terms-saved');
      const again = await save({ termType: 'NET', netDays: '60' });
      expect(again.location).toContain('terms-saved');
      const rows = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.paymentTerms.findMany({ where: { supplierId } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        termType: 'NET',
        netDays: 60,
        depositPct: null,
        balanceTrigger: null,
      });

      const otherSupplier = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.supplier.create({
          data: {
            organizationId: owner.orgId,
            name: 'Check Co',
            legalName: 'Check Co',
            countryCode: 'CN',
            countryOfIncorporation: 'CN',
          },
          select: { id: true },
        }),
      );
      const insert = (data: Prisma.PaymentTermsUncheckedCreateInput) =>
        withOrgTransaction(prisma, owner.orgId, (tx) => tx.paymentTerms.create({ data }));
      await expect(
        insert({
          organizationId: owner.orgId,
          supplierId: otherSupplier.id,
          termType: 'DEPOSIT_BALANCE',
          depositPct: '150',
          balanceTrigger: 'ON_ARRIVAL',
        }),
      ).rejects.toThrow(/payment_terms_deposit_pct_range/);
      await expect(
        insert({ organizationId: owner.orgId, supplierId: otherSupplier.id, termType: 'NET' }),
      ).rejects.toThrow(/payment_terms_net_needs_days/);
      await expect(
        insert({
          organizationId: owner.orgId,
          supplierId: otherSupplier.id,
          termType: 'DEPOSIT_BALANCE',
          depositPct: '30',
        }),
      ).rejects.toThrow(/payment_terms_deposit_balance_complete/);
    });

    it('a product can use the supplier; the list shows counts, default pickup and terms', async () => {
      const res = await run(
        newProductAction,
        post(owner, '/app/products/new', { ...validProduct, sku: 'WIDGET-1', supplierId }),
      );
      expect(res.status).toBe(302);
      const list = await run(
        suppliersLoader,
        makeRequest('/app/suppliers', { cookie: owner.cookie }),
      );
      const s = (list.data as { suppliers: Array<Record<string, unknown>> }).suppliers.find(
        (x) => x.id === supplierId,
      )!;
      expect(s).toMatchObject({ productCount: 1, paymentTerms: { termType: 'NET', netDays: 60 } });
      // Another organisation's supplier id is rejected.
      const foreign = await run(
        newProductAction,
        post(other, '/app/products/new', { ...validProduct, sku: 'WIDGET-2', supplierId }),
      );
      expect(foreign.status).toBe(400);
      expect((foreign.data as { errors: Record<string, string> }).errors.supplierId).toBeDefined();
    });

    it('cross-tenant: organisation B cannot open, edit or touch A’s supplier or pickup locations', async () => {
      const open = await runWith(
        supplierLoader,
        makeRequest(`/app/suppliers/${supplierId}`, { cookie: other.cookie }),
        { supplierId },
      );
      expect(open.status).toBe(404);
      const save = await runWith(
        supplierAction,
        post(other, `/app/suppliers/${supplierId}`, {
          intent: 'save',
          legalName: 'Hijack',
          countryOfIncorporation: 'CN',
        }),
        { supplierId },
      );
      expect(save.location).toBe('/app/suppliers?notice=not-found');
      const pickup = await runWith(
        supplierAction,
        post(other, `/app/suppliers/${supplierId}`, {
          intent: 'pickup-update',
          pickupId: secondPickup,
          name: 'Hijacked',
          country: 'CN',
          closestPortCode: 'CNSHA',
        }),
        { supplierId },
      );
      expect(pickup.location).toBe(`/app/suppliers/${supplierId}?notice=pickup-missing`);
      const service = await withOrgTransaction(prisma, other.orgId, (tx) =>
        updatePickupLocation(
          tx,
          { organizationId: other.orgId, userId: other.userId },
          supplierId,
          secondPickup,
          {
            name: 'Hijacked',
            country: 'CN',
            closestPortCode: 'CNSHA',
            isDefault: true,
          },
        ),
      );
      expect(service).toEqual({ ok: false, error: 'NOT_FOUND' });
      // RLS on the new tables: raw reads in B's context (as the app role) see nothing of A's.
      const raw = await withOrgTransaction(prisma, other.orgId, async (tx) => {
        await asAppRole(tx);
        const [p] = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM pickup_locations WHERE supplier_id = ${supplierId}::uuid`;
        const [pt] = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM payment_terms WHERE supplier_id = ${supplierId}::uuid`;
        const [s] = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM suppliers WHERE id = ${supplierId}::uuid`;
        return [Number(p?.n), Number(pt?.n), Number(s?.n)];
      });
      expect(raw).toEqual([0, 0, 0]);
      const intact = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.supplier.findUniqueOrThrow({
          where: { id: supplierId },
          include: { pickupLocations: true },
        }),
      );
      expect(intact.legalName).toBe('Shenzhen Widgets Co., Ltd');
      expect(intact.pickupLocations[0]!.name).toBe('Xiamen warehouse');
    });

    it('archives and restores a supplier; VIEWER may only look', async () => {
      const archive = await runWith(
        supplierAction,
        post(owner, `/app/suppliers/${supplierId}`, { intent: 'archive' }),
        { supplierId },
      );
      expect(archive.location).toBe('/app/suppliers?notice=archived&archived=on');
      const restore = await runWith(
        supplierAction,
        post(owner, `/app/suppliers/${supplierId}`, { intent: 'restore' }),
        { supplierId },
      );
      expect(restore.location).toBe('/app/suppliers?notice=restored');
      const audits = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.auditLog.findMany({
          where: { organizationId: owner.orgId },
          orderBy: { createdAt: 'asc' },
        }),
      );
      const actions = audits.map((a) => a.action);
      for (const a of [
        'supplier.create',
        'pickup_location.create',
        'pickup_location.update',
        'pickup_location.delete',
        'payment_terms.update',
        'supplier.archive',
        'supplier.restore',
      ]) {
        expect(actions, a).toContain(a);
      }
      const text = JSON.stringify(audits);
      expect(text).not.toContain('Shenzhen Widgets');
      expect(text).not.toContain('91440300MA5XXXXXXX');

      const denied = await runWith(
        supplierAction,
        post(viewer, `/app/suppliers/${supplierId}`, { intent: 'archive' }),
        { supplierId },
      );
      expect(denied.status).toBe(403);
      const look = await runWith(
        supplierLoader,
        makeRequest(`/app/suppliers/${supplierId}`, { cookie: viewer.cookie }),
        { supplierId },
      );
      expect(look.status).toBe(200);
    });
  });

  it('logs carry ids, chapters and outcomes — never SKUs, names, addresses or registration numbers', () => {
    const text = JSON.stringify(t.logs);
    for (const secret of [
      'TOY-001',
      'Wooden train',
      'Shenzhen Widgets',
      'Widgets SZ',
      '91440300MA5XXXXXXX',
      'Xiamen warehouse',
      '@example.test',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const events = t.logs.map((l) => l.event);
    expect(events).toContain('hs_lookup.completed');
    expect(events).toContain('hs_lookup.rate_limited');
    expect(events).toContain('auth.forbidden');
  });
});
