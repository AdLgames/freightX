/**
 * Quotes (M4) against a real Postgres: the builder (no-JS intents and the JSON preview), saving
 * a draft as an exact snapshot (QuoteResult → columns → QuoteResult), finalise / accept / cancel
 * with the immutability trigger, recompute on drafts only, the list, detail and Home widgets,
 * the quick duty check, RBAC, cross-tenant negatives, rate limits, the plan limit and the no-PII
 * log rule (§5.9, §7.2, §7.3, §7.5, §9). Runs only with DATABASE_URL (migrations applied), as a
 * superuser or as a non-superuser member of harbour_app.
 */
import { disposePrismaClient, withOrgTransaction, type PrismaClient, type Role } from '@harbour/db';
import { D, type QuoteResult } from '@harbour/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { productSelect } from '../services/catalogue/products.server';
import { createOrganization } from '../services/organizations.server';
import { runCatalogueQuote } from '../services/quotes/pipeline.server';
import {
  countSavedQuotes,
  getQuote,
  orderedLines,
  quoteDbError,
  quoteRowToResult,
  replaceQuote,
  saveQuote,
} from '../services/quotes/quotes.server';
import { InMemoryRateLimiter } from '../services/rate-limit.server';
import {
  cookieFor,
  createTestApp,
  makeRequest,
  run,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { DOWN_COMMODITY, FIXTURE_NOW, fixtureTariff } from '../test-support/tariff-fixtures';
import { buildQuoteFormSchema, toBuilderInput } from '../validators/quote';
import { action as homeAction, loader as homeLoader } from './app._index';
import { action as quickDutyAction } from './app.api.quick-duty';
import { loader as quotesLoader } from './app.quotes';
import { action as detailAction, loader as detailLoader } from './app.quotes_.$id';
import { action as editAction, loader as editLoader } from './app.quotes_.$id_.edit';
import { action as newAction, loader as newLoader } from './app.quotes_.new';

const DATABASE_URL = process.env.DATABASE_URL;

type RouteFn = (args: { request: Request; params: object; context: object }) => unknown;
const runWith = (fn: unknown, request: Request, params: Record<string, string>) =>
  run((a: { request: Request }) => (fn as RouteFn)({ ...a, params, context: {} }), request);

/** Calls a resource route and reads its JSON body. */
const runJson = async (fn: unknown, request: Request) => {
  let value: unknown;
  try {
    value = await (fn as RouteFn)({ request, params: {}, context: {} });
  } catch (err) {
    value = err;
  }
  if (!(value instanceof Response)) throw new Error('expected a Response');
  const text = await value.text();
  return { status: value.status, headers: value.headers, body: JSON.parse(text) as unknown };
};

interface Actor {
  userId: string;
  orgId: string;
  cookie: string;
  csrf: string;
}

const SECRET_NAME = 'Zhang Wei CONFIDENTIAL tooling batch';
const LANE = 'CNSHA:GBFXT:SEA_LCL';

describe.skipIf(!DATABASE_URL)(
  'quotes: builder, snapshots, status rules and Home (database)',
  () => {
    let t: TestApp;
    let prisma: PrismaClient;
    let clockMs = Date.now();
    const orgIds: string[] = [];
    const userIds: string[] = [];
    let owner: Actor;
    let member: Actor;
    let viewer: Actor;
    let outsider: Actor;
    let toyId: string;
    let sugarId: string;
    let outsiderProductId: string;
    let supplierId: string;

    const signIn = async (role: Role, orgId?: string): Promise<Actor> => {
      const user = await prisma.user.create({ data: { email: uniqueEmail(role.toLowerCase()) } });
      userIds.push(user.id);
      let org = orgId;
      if (!org) {
        org = (await createOrganization(prisma, { userId: user.id, name: `Quotes ${role} Ltd` }))
          .organizationId;
        orgIds.push(org);
      } else {
        const o = org;
        await withOrgTransaction(prisma, o, (tx) =>
          tx.membership.create({ data: { organizationId: o, userId: user.id, role } }),
        );
      }
      const session = await t.app.auth.sessions!.create({
        userId: user.id,
        currentOrgId: org,
        role,
      });
      return {
        userId: user.id,
        orgId: org,
        cookie: cookieFor(session.id),
        csrf: session.data.csrfToken,
      };
    };

    const post = (actor: Actor, path: string, form: Record<string, string>) =>
      makeRequest(path, { cookie: actor.cookie, form: { ...form, _csrf: actor.csrf } });
    const get = (actor: Actor, path: string) => makeRequest(path, { cookie: actor.cookie });

    const createProduct = (
      orgId: string,
      patch: { sku: string; name: string; hsCode: string; verified: boolean; unitValue?: string },
    ) =>
      withOrgTransaction(prisma, orgId, (tx) =>
        tx.product.create({
          data: {
            organizationId: orgId,
            sku: patch.sku,
            name: patch.name,
            hsCode: patch.hsCode,
            hsCodeVerifiedAt: patch.verified ? new Date('2026-09-01T00:00:00Z') : null,
            hsDescription: patch.verified ? 'Wheeled toys' : null,
            originCountry: 'CN',
            unitValue: patch.unitValue ?? '4.5',
            currency: 'USD',
            weightKg: '0.8',
            volumeCbm: '0.004',
          },
          select: { id: true },
        }),
      ).then((p) => p.id);

    const quoteForm = (lines: Array<[string, string]>, extra: Record<string, string> = {}) => {
      const form: Record<string, string> = {
        intent: 'recalculate',
        incoterm: 'FOB',
        lane: LANE,
        dutyPayment: 'BROKER_DEFERMENT',
        vatRegistered: 'on',
        ...extra,
      };
      lines.forEach(([productId, quantity], i) => {
        form[`line_${i}_productId`] = productId;
        form[`line_${i}_quantity`] = quantity;
      });
      return form;
    };

    const quoteIdFrom = (location: string | null): string => {
      const m = /^\/app\/quotes\/([0-9a-f-]{36})\?notice=(\w+)$/.exec(location ?? '');
      if (!m) throw new Error(`unexpected redirect ${location}`);
      return m[1]!;
    };

    const rowOf = (actor: Actor, id: string) =>
      withOrgTransaction(prisma, actor.orgId, (tx) => getQuote(tx, id));

    const auditsOf = (actor: Actor, id: string) =>
      withOrgTransaction(prisma, actor.orgId, (tx) =>
        tx.auditLog.findMany({ where: { targetId: id }, orderBy: { createdAt: 'asc' } }),
      );

    beforeAll(async () => {
      t = await createTestApp({ databaseUrl: DATABASE_URL });
      prisma = t.prisma!;
      t.app.tariff = fixtureTariff();
      t.app.rateLimiter = new InMemoryRateLimiter(() => clockMs);
      owner = await signIn('OWNER');
      member = await signIn('MEMBER', owner.orgId);
      viewer = await signIn('VIEWER', owner.orgId);
      outsider = await signIn('OWNER');
      // The main organisation is on STARTER so the flow is not cut short by the FREE limit; the
      // plan test uses a FREE organisation of its own.
      await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.organization.update({ where: { id: owner.orgId }, data: { plan: 'STARTER' } }),
      );
      toyId = await createProduct(owner.orgId, {
        sku: 'TOY-001',
        name: SECRET_NAME,
        hsCode: '9503004100',
        verified: true,
      });
      sugarId = await createProduct(owner.orgId, {
        sku: 'SUGAR-1',
        name: 'Raw cane sugar',
        hsCode: DOWN_COMMODITY,
        verified: false,
      });
      outsiderProductId = await createProduct(outsider.orgId, {
        sku: 'OTHER-1',
        name: 'Other org product',
        hsCode: '9503004100',
        verified: true,
      });
      supplierId = await withOrgTransaction(prisma, owner.orgId, async (tx) => {
        const s = await tx.supplier.create({
          data: {
            organizationId: owner.orgId,
            name: 'Shenzhen Toys',
            legalName: 'Shenzhen Toys Co Ltd',
            countryCode: 'CN',
            countryOfIncorporation: 'CN',
            defaultIncoterm: 'EXW',
            defaultCurrency: 'USD',
          },
          select: { id: true },
        });
        await tx.pickupLocation.create({
          data: {
            organizationId: owner.orgId,
            supplierId: s.id,
            name: 'Factory',
            country: 'CN',
            closestPortCode: 'CNSZX',
            isDefault: true,
          },
        });
        return s.id;
      });
    });

    afterAll(async () => {
      for (const orgId of orgIds) {
        await withOrgTransaction(prisma, orgId, async (tx) => {
          await tx.document.deleteMany();
          await tx.quote.updateMany({
            where: { status: 'ACCEPTED' },
            data: { status: 'CANCELLED' },
          });
          await tx.quoteLine.deleteMany();
          await tx.quote.deleteMany();
          await tx.pickupLocation.deleteMany();
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

    describe('builder', () => {
      it('loads the options: catalogue products, suppliers with their default port, lanes, defaults', async () => {
        const res = await run(newLoader, get(owner, '/app/quotes/new'));
        expect(res.status).toBe(200);
        const d = res.data as {
          options: {
            products: Array<{ id: string; hsVerified: boolean }>;
            suppliers: Array<{
              id: string;
              defaultPort: string | null;
              defaultIncoterm: string | null;
            }>;
            lanes: unknown[];
            defaults: { vatRegistered: boolean; dutyPayment: string };
          };
          values: { scalars: Record<string, string>; lines: unknown[] };
          planNotice: unknown;
        };
        expect(d.options.products.map((p) => p.id).sort()).toEqual([sugarId, toyId].sort());
        expect(d.options.products.find((p) => p.id === toyId)?.hsVerified).toBe(true);
        expect(d.options.suppliers).toEqual([
          expect.objectContaining({ id: supplierId, defaultPort: 'CNSZX', defaultIncoterm: 'EXW' }),
        ]);
        expect(d.options.lanes.length).toBeGreaterThan(0);
        expect(d.options.defaults).toMatchObject({
          vatRegistered: false,
          dutyPayment: 'BROKER_DEFERMENT',
        });
        expect(d.values.lines).toEqual([]);
        expect(d.planNotice).toBeNull();
      });

      it('`?supplier=` pre-fills the incoterm and origin port', async () => {
        const res = await run(newLoader, get(owner, `/app/quotes/new?supplier=${supplierId}`));
        const d = res.data as { values: { scalars: Record<string, string> } };
        expect(d.values.scalars).toMatchObject({
          supplierId,
          incoterm: 'EXW',
          lane: 'CNSZX:GBFXT:SEA_LCL',
        });
      });

      it('recalculate (no JS): an unverified product gives INDICATIVE with HS_UNVERIFIED, a verified one READY', async () => {
        const unverified = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[sugarId, '10']])),
        );
        expect(unverified.status).toBe(200);
        const u = unverified.data as { view: { quote: QuoteResult } | null; errors: object };
        expect(u.view?.quote.status).toBe('INDICATIVE');
        expect(u.view?.quote.warnings.map((w) => w.code)).toContain('HS_UNVERIFIED');

        const verified = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[toyId, '500']])),
        );
        const v = verified.data as { view: { quote: QuoteResult } | null };
        expect(v.view?.quote.status).toBe('READY');
        expect(v.view?.quote.lines[0]).toMatchObject({
          ref: toyId,
          quantity: 500,
          unitValue: '4.5000',
        });
      });

      it('validation problems come back as field errors, never a 500', async () => {
        const res = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[toyId, '0']], { lane: 'nowhere' })),
        );
        expect(res.status).toBe(400);
        const d = res.data as { errors: Record<string, string>; formError: string };
        expect(d.errors.line_0_quantity).toMatch(/at least 1/);
        expect(d.errors.lane).toMatch(/route/);
        const empty = await run(newAction, post(owner, '/app/quotes/new', quoteForm([])));
        expect(empty.status).toBe(400);
        expect((empty.data as { formError: string }).formError).toMatch(/at least one product/);
      });

      it('add-line appends a catalogue line (merging a repeat), remove-line drops one, apply-supplier sets defaults', async () => {
        const added = await run(
          newAction,
          post(owner, '/app/quotes/new', {
            ...quoteForm([[toyId, '500']]),
            intent: 'add-line',
            addProductId: sugarId,
            addQuantity: '10',
          }),
        );
        expect(added.status).toBe(200);
        const a = added.data as {
          values: { lines: Array<{ productId: string; quantity: string }> };
          view: unknown;
        };
        expect(a.values.lines).toEqual([
          expect.objectContaining({ productId: toyId, quantity: '500' }),
          expect.objectContaining({ productId: sugarId, quantity: '10' }),
        ]);
        expect(a.view).not.toBeNull();

        const merged = await run(
          newAction,
          post(owner, '/app/quotes/new', {
            ...quoteForm([[toyId, '500']]),
            intent: 'add-line',
            addProductId: toyId,
            addQuantity: '100',
          }),
        );
        expect(
          (merged.data as { values: { lines: Array<{ quantity: string }> } }).values.lines,
        ).toEqual([expect.objectContaining({ productId: toyId, quantity: '600' })]);

        const removed = await run(
          newAction,
          post(owner, '/app/quotes/new', {
            ...quoteForm([
              [toyId, '500'],
              [sugarId, '10'],
            ]),
            removeLine: '1',
          }),
        );
        expect((removed.data as { values: { lines: unknown[] } }).values.lines).toHaveLength(1);

        const supplied = await run(
          newAction,
          post(owner, '/app/quotes/new', {
            ...quoteForm([[toyId, '500']]),
            intent: 'apply-supplier',
            supplierId,
          }),
        );
        expect(
          (supplied.data as { values: { scalars: Record<string, string> } }).values.scalars,
        ).toMatchObject({
          incoterm: 'EXW',
          lane: 'CNSZX:GBFXT:SEA_LCL',
          supplierId,
        });
      });

      it('a product from another organisation is rejected on the line', async () => {
        const res = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[outsiderProductId, '5']])),
        );
        expect(res.status).toBe(400);
        expect((res.data as { errors: Record<string, string> }).errors.line_0_productId).toMatch(
          /no longer in your catalogue/,
        );
      });

      it('the JSON preview (`?preview=1`) returns the view and is limited to 60 per minute per user', async () => {
        const fresh = await signIn('MEMBER', owner.orgId);
        const form = { ...quoteForm([[toyId, '500']]), intent: '' };
        for (let i = 0; i < 60; i += 1) {
          const res = await run(newAction, post(fresh, '/app/quotes/new?preview=1', form));
          expect(res.status, `preview ${i + 1}`).toBe(200);
          if (i === 0) {
            expect((res.data as { view: { quote: QuoteResult } }).view.quote.status).toBe('READY');
          }
        }
        const limited = await run(newAction, post(fresh, '/app/quotes/new?preview=1', form));
        expect(limited.status).toBe(429);
        expect((limited.data as { formError: string }).formError).toMatch(
          /Too many quote calculations/,
        );
        // Another user is unaffected; a minute later the bucket has refilled.
        expect((await run(newAction, post(owner, '/app/quotes/new?preview=1', form))).status).toBe(
          200,
        );
        clockMs += 61_000;
        expect((await run(newAction, post(fresh, '/app/quotes/new?preview=1', form))).status).toBe(
          200,
        );
      });
    });

    describe('snapshot round trip (QuoteResult → Prisma Decimal columns → QuoteResult)', () => {
      it('every field reads back identically; money as the same strings', async () => {
        const products = await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.product.findMany({ select: { id: true }, where: { id: { in: [toyId, sugarId] } } }),
        );
        expect(products).toHaveLength(2);
        const rows = await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.product.findMany({ where: { id: { in: [toyId, sugarId] } }, select: productSelect }),
        );
        const schema = buildQuoteFormSchema([LANE]);
        const input = schema.parse({
          incoterm: 'EXW',
          lane: LANE,
          vatRegistered: 'on',
          vatPostponed: 'on',
          dutyPayment: 'BROKER_DEFERMENT',
          brokerFeePct: '2.5',
          brokerMinimumGbp: '25',
          insurancePremiumGbp: '30.50',
          lines: [
            { productId: toyId, quantity: '500', assistsGbp: '120.00', preferenceClaimed: 'on' },
            { productId: sugarId, quantity: '7' },
          ],
        });
        const outcome = await runCatalogueQuote(input, rows, {
          tariff: t.app.tariff,
          fxStore: t.app.stores.fxStore,
          freight: t.app.freight,
          pricing: t.app.pricing,
          now: () => FIXTURE_NOW,
        });
        if (outcome.kind !== 'QUOTE') throw new Error(outcome.message);
        const original = outcome.view.quote;
        expect(original.status).toBe('INDICATIVE'); // the sugar line is unverified
        const actor = { organizationId: owner.orgId, userId: owner.userId };
        const saved = await withOrgTransaction(prisma, owner.orgId, (tx) =>
          saveQuote(tx, actor, {
            view: outcome.view,
            builderInput: toBuilderInput(input),
            status: 'DRAFT',
          }),
        );
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;

        const row = await rowOf(owner, saved.id);
        expect(row).not.toBeNull();
        const back = quoteRowToResult(row!);
        // fxRate is a Decimal(14,6) column, so "0.78" reads back as "0.780000": compare numerically;
        // everything else — every 2 dp / 4 dp money column, weights, rates, dates, JSON — must be
        // the identical string.
        const norm = (q: QuoteResult) => ({ ...q, fxRate: D(q.fxRate).toString() });
        expect(norm(back)).toEqual(norm(original));
        for (const [key, value] of Object.entries(original.totals)) {
          expect(back.totals[key as keyof typeof back.totals], key).toBe(value);
        }
        original.lines.forEach((line, i) => {
          for (const [key, value] of Object.entries(line)) {
            expect(back.lines[i]![key as keyof typeof line], `${i}.${key}`).toEqual(value);
          }
        });
        expect(row!.paymentMethod).toBe('BROKER_DEFERMENT');
        expect(row!.vatPostponed).toBe(true);
        expect(row!.status).toBe('DRAFT');
        const lines = orderedLines(row!);
        expect(lines.map((l) => l.productId)).toEqual([toyId, sugarId]);
        expect(lines[0]!.assistsGbp.toFixed(2)).toBe('120.00');
        const audits = await auditsOf(owner, saved.id);
        expect(audits.map((a) => a.action)).toEqual(['quote.create']);
        expect(audits[0]!.metadata).toEqual({
          status: 'DRAFT',
          computedStatus: 'INDICATIVE',
          lines: 2,
          calcVersion: original.calcVersion,
        });
      });
    });

    describe('save, list, detail, Home', () => {
      let draftId: string;

      it('save creates a DRAFT and redirects to it; the list, the detail page and Home show it', async () => {
        const res = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[toyId, '500']], { intent: 'save' })),
        );
        expect(res.status).toBe(302);
        draftId = quoteIdFrom(res.location);
        expect(res.location).toMatch(/notice=saved$/);

        const list = await run(quotesLoader, get(viewer, '/app/quotes'));
        expect(list.status).toBe(200);
        const l = list.data as {
          rows: Array<{
            id: string;
            status: string;
            reference: string;
            landedCostPerUnit: string | null;
          }>;
          canEdit: boolean;
        };
        const row = l.rows.find((r) => r.id === draftId);
        expect(row).toMatchObject({
          status: 'DRAFT',
          reference: `Q-${draftId.slice(0, 8).toUpperCase()}`,
        });
        expect(row?.landedCostPerUnit).toMatch(/^\d+\.\d{4}$/);
        expect(l.canEdit).toBe(false);

        const filtered = await run(quotesLoader, get(owner, '/app/quotes?status=ACCEPTED'));
        expect(
          (filtered.data as { rows: unknown[] }).rows.some(
            (r) => (r as { id: string }).id === draftId,
          ),
        ).toBe(false);

        const detail = await runWith(
          detailLoader,
          get(owner, `/app/quotes/${draftId}?notice=saved`),
          { id: draftId },
        );
        expect(detail.status).toBe(200);
        const d = detail.data as {
          status: string;
          view: { quote: QuoteResult; lines: Array<{ sku: string }> };
          can: Record<string, boolean>;
          notice: string;
        };
        expect(d.status).toBe('DRAFT');
        expect(d.view.quote.status).toBe('READY');
        expect(d.view.lines[0]?.sku).toBe('TOY-001');
        expect(d.can).toMatchObject({
          edit: true,
          finalise: true,
          recompute: true,
          accept: false,
          cancel: true,
          reopen: false,
        });
        expect(d.notice).toMatch(/Draft saved/);

        const home = await run(homeLoader, get(owner, '/app'));
        const h = home.data as { drafts: Array<{ id: string }>; stats: { draftQuotes: number } };
        expect(h.drafts.map((x) => x.id)).toContain(draftId);
        expect(h.stats.draftQuotes).toBeGreaterThanOrEqual(1);
      });

      it('edit loads the draft as it was left; saving replaces figures and lines (audit quote.update)', async () => {
        const load = await runWith(editLoader, get(owner, `/app/quotes/${draftId}/edit`), {
          id: draftId,
        });
        expect(load.status).toBe(200);
        const d = load.data as {
          values: {
            scalars: Record<string, string>;
            lines: Array<{ productId: string; quantity: string }>;
          };
        };
        expect(d.values.scalars).toMatchObject({
          incoterm: 'FOB',
          lane: LANE,
          vatRegistered: 'on',
        });
        expect(d.values.lines).toEqual([
          expect.objectContaining({ productId: toyId, quantity: '500' }),
        ]);

        const res = await runWith(
          editAction,
          post(
            owner,
            `/app/quotes/${draftId}/edit`,
            quoteForm([[toyId, '250']], { intent: 'save' }),
          ),
          { id: draftId },
        );
        expect(res.status).toBe(302);
        const row = await rowOf(owner, draftId);
        expect(row!.lines).toHaveLength(1);
        expect(row!.lines[0]!.quantity).toBe(250);
        expect((await auditsOf(owner, draftId)).map((a) => a.action)).toEqual([
          'quote.create',
          'quote.update',
        ]);
      });

      it('RBAC: VIEWER cannot open or post to the builder; MEMBER can save but cannot accept', async () => {
        expect((await run(newLoader, get(viewer, '/app/quotes/new'))).status).toBe(403);
        expect(
          (await run(newAction, post(viewer, '/app/quotes/new', quoteForm([[toyId, '1']])))).status,
        ).toBe(403);
        const saved = await run(
          newAction,
          post(member, '/app/quotes/new', quoteForm([[toyId, '5']], { intent: 'save' })),
        );
        expect(saved.status).toBe(302);
        const memberQuote = quoteIdFrom(saved.location);
        await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.quote.update({ where: { id: memberQuote }, data: { status: 'READY' } }),
        );
        const accept = await runWith(
          detailAction,
          post(member, `/app/quotes/${memberQuote}`, { intent: 'accept' }),
          { id: memberQuote },
        );
        expect(accept.status).toBe(403);
        const detail = await runWith(detailLoader, get(member, `/app/quotes/${memberQuote}`), {
          id: memberQuote,
        });
        expect((detail.data as { can: { accept: boolean } }).can.accept).toBe(false);
      });

      it('cross-tenant: the outsider cannot read, edit, accept or cancel this organisation’s quote', async () => {
        expect(
          (await runWith(detailLoader, get(outsider, `/app/quotes/${draftId}`), { id: draftId }))
            .status,
        ).toBe(404);
        expect(
          (await runWith(editLoader, get(outsider, `/app/quotes/${draftId}/edit`), { id: draftId }))
            .status,
        ).toBe(404);
        expect(
          (
            await runWith(
              editAction,
              post(
                outsider,
                `/app/quotes/${draftId}/edit`,
                quoteForm([[toyId, '1']], { intent: 'save' }),
              ),
              { id: draftId },
            )
          ).status,
        ).toBe(404);
        for (const intent of ['accept', 'cancel', 'finalise']) {
          const res = await runWith(
            detailAction,
            post(outsider, `/app/quotes/${draftId}`, { intent }),
            { id: draftId },
          );
          expect(res.status, intent).toBe(404);
        }
        const list = await run(quotesLoader, get(outsider, '/app/quotes'));
        expect((list.data as { rows: unknown[] }).rows).toEqual([]);
        const unchanged = await rowOf(owner, draftId);
        expect(unchanged!.status).toBe('DRAFT');
      });
    });

    describe('status rules (§5.9) and immutability', () => {
      let acceptedId: string;
      let otherDraftId: string;

      it('finalise: DRAFT → READY; accept only when READY (owner); audit quote.accept; acceptedAt set', async () => {
        const saved = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[toyId, '500']], { intent: 'save' })),
        );
        acceptedId = quoteIdFrom(saved.location);
        const early = await runWith(
          detailAction,
          post(owner, `/app/quotes/${acceptedId}`, { intent: 'accept' }),
          { id: acceptedId },
        );
        expect(early.status).toBe(409);
        expect((early.data as { error: string }).error).toMatch(/only READY quotes/);

        const finalised = await runWith(
          detailAction,
          post(owner, `/app/quotes/${acceptedId}`, { intent: 'finalise' }),
          { id: acceptedId },
        );
        expect(finalised.status).toBe(302);
        expect(finalised.location).toMatch(/notice=finalised$/);
        expect((await rowOf(owner, acceptedId))!.status).toBe('READY');

        const accepted = await runWith(
          detailAction,
          post(owner, `/app/quotes/${acceptedId}`, { intent: 'accept' }),
          { id: acceptedId },
        );
        expect(accepted.status).toBe(302);
        expect(accepted.location).toMatch(/notice=accepted$/);
        const row = await rowOf(owner, acceptedId);
        expect(row!.status).toBe('ACCEPTED');
        expect(row!.acceptedAt).toBeInstanceOf(Date);
        const actions = (await auditsOf(owner, acceptedId)).map((a) => a.action);
        expect(actions).toEqual(['quote.create', 'quote.update', 'quote.accept']);
        const detail = await runWith(detailLoader, get(owner, `/app/quotes/${acceptedId}`), {
          id: acceptedId,
        });
        const d = detail.data as {
          can: Record<string, boolean>;
          missing: Array<{ type: string }>;
          view: { quote: QuoteResult };
        };
        expect(d.can).toMatchObject({
          edit: false,
          finalise: false,
          accept: false,
          reopen: false,
          cancel: true,
        });
        expect(d.missing.map((m) => m.type)).toEqual(['COMMERCIAL_INVOICE', 'PACKING_LIST']);
        expect(d.view.quote.status).toBe('READY');
      });

      it('an INDICATIVE quote cannot be accepted; reopen takes it back to DRAFT', async () => {
        const saved = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[sugarId, '3']], { intent: 'save' })),
        );
        const id = quoteIdFrom(saved.location);
        const finalised = await runWith(
          detailAction,
          post(owner, `/app/quotes/${id}`, { intent: 'finalise' }),
          { id },
        );
        expect(finalised.status).toBe(302);
        expect((await rowOf(owner, id))!.status).toBe('INDICATIVE');
        const accept = await runWith(
          detailAction,
          post(owner, `/app/quotes/${id}`, { intent: 'accept' }),
          { id },
        );
        expect(accept.status).toBe(409);
        const reopen = await runWith(
          detailAction,
          post(owner, `/app/quotes/${id}`, { intent: 'reopen' }),
          { id },
        );
        expect(reopen.status).toBe(302);
        expect((await rowOf(owner, id))!.status).toBe('DRAFT');
      });

      it('editing an accepted quote is refused: the edit page redirects, the service says IMMUTABLE and the trigger backs it up', async () => {
        const load = await runWith(editLoader, get(owner, `/app/quotes/${acceptedId}/edit`), {
          id: acceptedId,
        });
        expect(load.status).toBe(302);
        expect(load.location).toBe(`/app/quotes/${acceptedId}`);
        const posted = await runWith(
          editAction,
          post(
            owner,
            `/app/quotes/${acceptedId}/edit`,
            quoteForm([[toyId, '1']], { intent: 'save' }),
          ),
          { id: acceptedId },
        );
        expect(posted.status).toBe(302);
        for (const intent of ['finalise', 'recompute', 'reopen']) {
          const res = await runWith(
            detailAction,
            post(owner, `/app/quotes/${acceptedId}`, { intent }),
            { id: acceptedId },
          );
          expect(res.status, intent).toBe(409);
          expect((res.data as { error: string }).error).toMatch(
            /accepted and can no longer be changed/,
          );
        }
        // Service level: replaceQuote refuses before touching the row…
        const row = await rowOf(owner, acceptedId);
        const actor = { organizationId: owner.orgId, userId: owner.userId };
        const outcome = await runCatalogueQuote(
          buildQuoteFormSchema([LANE]).parse({
            incoterm: 'FOB',
            lane: LANE,
            dutyPayment: 'BROKER_DEFERMENT',
            lines: [{ productId: toyId, quantity: '1' }],
          }),
          await withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.product.findMany({ select: productSelect }),
          ),
          {
            tariff: t.app.tariff,
            fxStore: t.app.stores.fxStore,
            freight: t.app.freight,
            pricing: t.app.pricing,
          },
        );
        if (outcome.kind !== 'QUOTE') throw new Error(outcome.message);
        const replaced = await withOrgTransaction(prisma, owner.orgId, (tx) =>
          replaceQuote(
            tx,
            actor,
            acceptedId,
            { view: outcome.view, builderInput: row!.builderInput as never, status: 'DRAFT' },
            { from: ['DRAFT'] },
          ),
        );
        expect(replaced).toEqual({ ok: false, error: 'IMMUTABLE', status: 'ACCEPTED' });
        // …and the database trigger rejects a direct change to a money column, rendered friendly.
        let caught: unknown = null;
        try {
          await withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.quote.update({ where: { id: acceptedId }, data: { goodsValueGbp: '1.00' } }),
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).not.toBeNull();
        expect(quoteDbError(caught)).toBe('IMMUTABLE');
        expect((await rowOf(owner, acceptedId))!.goodsValueGbp.toFixed(2)).toBe(
          row!.goodsValueGbp.toFixed(2),
        );
      });

      it('recompute picks up a changed product price on a draft; the accepted quote keeps its snapshot', async () => {
        const saved = await run(
          newAction,
          post(owner, '/app/quotes/new', quoteForm([[toyId, '500']], { intent: 'save' })),
        );
        otherDraftId = quoteIdFrom(saved.location);
        const before = await rowOf(owner, otherDraftId);
        const acceptedBefore = await rowOf(owner, acceptedId);
        expect(before!.lines[0]!.unitValue.toFixed(4)).toBe('4.5000');

        await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.product.update({ where: { id: toyId }, data: { unitValue: '9' } }),
        );
        const res = await runWith(
          detailAction,
          post(owner, `/app/quotes/${otherDraftId}`, { intent: 'recompute' }),
          { id: otherDraftId },
        );
        expect(res.status).toBe(302);
        expect(res.location).toMatch(/notice=recomputed$/);
        const after = await rowOf(owner, otherDraftId);
        expect(after!.status).toBe('DRAFT');
        expect(after!.lines[0]!.unitValue.toFixed(4)).toBe('9.0000');
        expect(D(after!.goodsValueGbp.toString()).gt(D(before!.goodsValueGbp.toString()))).toBe(
          true,
        );

        const acceptedAfter = await rowOf(owner, acceptedId);
        expect(acceptedAfter!.lines[0]!.unitValue.toFixed(4)).toBe('4.5000');
        expect(acceptedAfter!.goodsValueGbp.toFixed(2)).toBe(
          acceptedBefore!.goodsValueGbp.toFixed(2),
        );
        expect(acceptedAfter!.updatedAt.getTime()).toBe(acceptedBefore!.updatedAt.getTime());
      });

      it('cancel: a MEMBER cannot cancel an accepted quote, an OWNER can (ACCEPTED → CANCELLED, audit)', async () => {
        const denied = await runWith(
          detailAction,
          post(member, `/app/quotes/${acceptedId}`, { intent: 'cancel' }),
          { id: acceptedId },
        );
        expect(denied.status).toBe(403);
        const res = await runWith(
          detailAction,
          post(owner, `/app/quotes/${acceptedId}`, { intent: 'cancel' }),
          { id: acceptedId },
        );
        expect(res.status).toBe(302);
        expect((await rowOf(owner, acceptedId))!.status).toBe('CANCELLED');
        expect((await auditsOf(owner, acceptedId)).map((a) => a.action)).toContain('quote.cancel');
        const again = await runWith(
          detailAction,
          post(owner, `/app/quotes/${acceptedId}`, { intent: 'cancel' }),
          { id: acceptedId },
        );
        expect(again.status).toBe(409);
        // A member may cancel a draft.
        const cancelled = await runWith(
          detailAction,
          post(member, `/app/quotes/${otherDraftId}`, { intent: 'cancel' }),
          { id: otherDraftId },
        );
        expect(cancelled.status).toBe(302);
      });
    });

    describe('plan limit (FREE: 3 saved quotes)', () => {
      it('the 4th save shows the plan notice and is refused; cancelled quotes do not count', async () => {
        const free = await signIn('OWNER');
        const productId = await createProduct(free.orgId, {
          sku: 'F-1',
          name: 'Free org toy',
          hsCode: '9503004100',
          verified: true,
        });
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const res = await run(
            newAction,
            post(free, '/app/quotes/new', quoteForm([[productId, '1']], { intent: 'save' })),
          );
          expect(res.status, `save ${i + 1}`).toBe(302);
          ids.push(quoteIdFrom(res.location));
        }
        expect(await withOrgTransaction(prisma, free.orgId, (tx) => countSavedQuotes(tx))).toBe(3);
        const fourth = await run(
          newAction,
          post(free, '/app/quotes/new', quoteForm([[productId, '1']], { intent: 'save' })),
        );
        expect(fourth.status).toBe(402);
        const d = fourth.data as { planNotice: unknown; view: unknown; formError: string };
        expect(d.planNotice).toEqual({
          feature: 'savedQuotes',
          requiredPlan: 'STARTER',
          canManageBilling: true,
        });
        expect(d.view).not.toBeNull();
        expect(d.formError).toMatch(/not saved/);
        const page = await run(newLoader, get(free, '/app/quotes/new'));
        expect((page.data as { planNotice: unknown }).planNotice).toMatchObject({
          feature: 'savedQuotes',
        });
        // Recalculate is still allowed at the limit; only saving is gated.
        expect(
          (await run(newAction, post(free, '/app/quotes/new', quoteForm([[productId, '1']]))))
            .status,
        ).toBe(200);

        const cancel = await runWith(
          detailAction,
          post(free, `/app/quotes/${ids[0]}`, { intent: 'cancel' }),
          { id: ids[0]! },
        );
        expect(cancel.status).toBe(302);
        expect(await withOrgTransaction(prisma, free.orgId, (tx) => countSavedQuotes(tx))).toBe(2);
        const again = await run(
          newAction,
          post(free, '/app/quotes/new', quoteForm([[productId, '1']], { intent: 'save' })),
        );
        expect(again.status).toBe(302);
      });
    });

    describe('Home quick duty check', () => {
      const dutyForm = (extra: Record<string, string>) => ({
        intent: 'quick-duty',
        hsCode: '9503004100',
        invoiceValueGbp: '1000',
        originCountry: 'CN',
        ...extra,
      });

      it('returns duty and VAT rates from the tariff fixture without saving anything', async () => {
        const before = await withOrgTransaction(prisma, owner.orgId, (tx) => tx.quote.count());
        const res = await run(homeAction, post(owner, '/app', dutyForm({})));
        expect(res.status).toBe(200);
        const d = res.data as {
          quickDuty: {
            result: {
              kind: string;
              code: string;
              dutyRatePct: string | null;
              vatRatePct: string;
              dutyGbp: string;
              vatGbp: string;
            };
          };
        };
        expect(d.quickDuty.result).toMatchObject({
          kind: 'result',
          code: '9503004100',
          dutyRatePct: '0.0000',
          vatRatePct: '20.00',
          dutyGbp: '0.00',
          vatGbp: '200.00',
        });
        expect(await withOrgTransaction(prisma, owner.orgId, (tx) => tx.quote.count())).toBe(
          before,
        );
      });

      it('degrades gracefully when the tariff service is down, lists candidates for a 6-digit code, validates input', async () => {
        const down = await run(
          homeAction,
          post(owner, '/app', dutyForm({ hsCode: DOWN_COMMODITY })),
        );
        expect(down.status).toBe(200);
        expect(
          (down.data as { quickDuty: { result: { kind: string } } }).quickDuty.result.kind,
        ).toBe('unavailable');
        const heading = await run(homeAction, post(owner, '/app', dutyForm({ hsCode: '950300' })));
        expect(
          (heading.data as { quickDuty: { result: { kind: string; candidates: unknown[] } } })
            .quickDuty.result,
        ).toMatchObject({ kind: 'candidates' });
        const invalid = await run(
          homeAction,
          post(owner, '/app', dutyForm({ invoiceValueGbp: '-1' })),
        );
        expect(invalid.status).toBe(400);
        expect(
          (invalid.data as { quickDuty: { errors: Record<string, string> } }).quickDuty.errors
            .invoiceValueGbp,
        ).toBeDefined();
        const noCsrf = await run(
          homeAction,
          makeRequest('/app', { cookie: owner.cookie, form: dutyForm({}) }),
        );
        expect(noCsrf.status).toBe(403);
      });

      it('the JSON endpoint gives the same result and both share the 10-per-minute tariff limit', async () => {
        const fresh = await signIn('MEMBER', owner.orgId);
        const json = await runJson(
          quickDutyAction,
          post(fresh, '/app/api/quick-duty', dutyForm({})),
        );
        expect(json.status).toBe(200);
        expect(json.headers.get('cache-control')).toBe('no-store');
        expect(json.body).toMatchObject({
          kind: 'result',
          code: '9503004100',
          vatRatePct: '20.00',
        });
        for (let i = 1; i < 10; i += 1) {
          const res = await run(homeAction, post(fresh, '/app', dutyForm({})));
          expect(res.status, `check ${i + 1}`).toBe(200);
        }
        const eleventh = await runJson(
          quickDutyAction,
          post(fresh, '/app/api/quick-duty', dutyForm({})),
        );
        expect(eleventh.status).toBe(429);
        expect(eleventh.headers.get('retry-after')).toMatch(/^\d+$/);
        const viaHome = await run(homeAction, post(fresh, '/app', dutyForm({})));
        expect(viaHome.status).toBe(429);
        expect(
          (viaHome.data as { quickDuty: { result: { kind: string } } }).quickDuty.result.kind,
        ).toBe('rate-limited');
      });
    });

    describe('logs', () => {
      it('never contain e-mail addresses or product names', () => {
        const all = t.lines.join('\n');
        expect(all).not.toMatch(/@example\.test/);
        expect(all).not.toContain('CONFIDENTIAL');
        expect(all).not.toContain('Zhang Wei');
        expect(t.logs.some((l) => l.event === 'quote.saved')).toBe(true);
        expect(t.logs.some((l) => l.event === 'quote.accept')).toBe(true);
        expect(t.logs.some((l) => l.event === 'quick_duty.completed')).toBe(true);
      });
    });
  },
);
