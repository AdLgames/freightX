/**
 * Purchase orders (M7, ADR-0013) against a real Postgres: the editor (no-JS intents), numbering
 * `PO-YYYY-NNN` per organisation and year (two parallel creates never share a number), create and
 * update totals, issue freezing the totals and computing the deposit/balance for PREPAID, NET and
 * DEPOSIT_BALANCE terms, the 0012 triggers (an issued PO's lines and money cannot change; status,
 * payment dates and notes can; illegal transitions refused), payments recorded by date, the Home
 * "Payments due" card, "Get freight quote" pre-filling the M4 builder and the saved quote carrying
 * `purchaseOrderId`, one ACCEPTED quote per PO, RBAC, cross-tenant negatives and the no-PII log
 * rule (§5.6, §7.2, §7.3, §9). Runs only with DATABASE_URL (migrations applied), as a superuser or
 * as a non-superuser member of harbour_app.
 */
import { disposePrismaClient, withOrgTransaction, type PrismaClient, type Role } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { createOrganization } from '../services/organizations.server';
import {
  createOrder,
  getOrder,
  listPaymentsDue,
  orderDbError,
  updateOrder,
} from '../services/orders/orders.server';
import { formatPoNumber } from '../services/orders/schedule';
import {
  QUOTE_PO_ACCEPTED_MESSAGE,
  getQuote,
  orderedLines,
  quoteDbError,
} from '../services/quotes/quotes.server';
import {
  cookieFor,
  createTestApp,
  makeRequest,
  run,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { fixtureTariff } from '../test-support/tariff-fixtures';
import { orderFormSchema, type OrderFormValues } from '../validators/order';
import type { QuoteFormValues } from '../validators/quote';
import { loader as homeLoader } from './app._index';
import { loader as ordersLoader } from './app.orders';
import { action as detailAction, loader as detailLoader } from './app.orders_.$id';
import { action as editAction, loader as editLoader } from './app.orders_.$id_.edit';
import { action as newAction, loader as newLoader } from './app.orders_.new';
import { action as quoteDetailAction } from './app.quotes_.$id';
import { action as quoteNewAction, loader as quoteNewLoader } from './app.quotes_.new';

const DATABASE_URL = process.env.DATABASE_URL;

type RouteFn = (args: { request: Request; params: object; context: object }) => unknown;
const runWith = (fn: unknown, request: Request, params: Record<string, string>) =>
  run((a: { request: Request }) => (fn as RouteFn)({ ...a, params, context: {} }), request);

interface Actor {
  userId: string;
  orgId: string;
  cookie: string;
  csrf: string;
}

const SECRET_NAME = 'Zhang Wei CONFIDENTIAL tooling batch';
const YEAR = new Date().getUTCFullYear();
const DAY_MS = 24 * 60 * 60 * 1000;

type TermsInput =
  | { termType: 'PREPAID' }
  | { termType: 'NET'; netDays: number }
  | {
      termType: 'DEPOSIT_BALANCE';
      depositPct: string;
      balanceTrigger: 'ON_SHIPMENT' | 'AGAINST_BILL_OF_LADING' | 'ON_ARRIVAL';
    };

describe.skipIf(!DATABASE_URL)(
  'purchase orders: editor, numbering, issue, freeze, payments, quotes and Home (database)',
  () => {
    let t: TestApp;
    let prisma: PrismaClient;
    let mustSwitchRole = false;
    const orgIds: string[] = [];
    const userIds: string[] = [];
    let owner: Actor;
    let member: Actor;
    let viewer: Actor;
    let outsider: Actor;
    let toyId: string;
    let caseId: string;
    let euroId: string;
    let outsiderProductId: string;
    let outsiderSupplierId: string;
    let depositSupplierId: string;
    let depositPickupId: string;
    let netSupplierId: string;
    let prepaidSupplierId: string;
    let bareSupplierId: string;

    const signIn = async (role: Role, orgId?: string): Promise<Actor> => {
      const user = await prisma.user.create({ data: { email: uniqueEmail(role.toLowerCase()) } });
      userIds.push(user.id);
      let org = orgId;
      if (!org) {
        org = (await createOrganization(prisma, { userId: user.id, name: `Orders ${role} Ltd` }))
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
      patch: { sku: string; name: string; unitValue: string; currency?: string },
    ) =>
      withOrgTransaction(prisma, orgId, (tx) =>
        tx.product.create({
          data: {
            organizationId: orgId,
            sku: patch.sku,
            name: patch.name,
            hsCode: '9503004100',
            hsCodeVerifiedAt: new Date('2026-09-01T00:00:00Z'),
            hsDescription: 'Wheeled toys',
            originCountry: 'CN',
            unitValue: patch.unitValue,
            currency: patch.currency ?? 'USD',
            weightKg: '0.8',
            volumeCbm: '0.004',
          },
          select: { id: true },
        }),
      ).then((p) => p.id);

    const createSupplier = (
      orgId: string,
      patch: { name: string; terms: TermsInput | null; port?: string },
    ) =>
      withOrgTransaction(prisma, orgId, async (tx) => {
        const s = await tx.supplier.create({
          data: {
            organizationId: orgId,
            name: patch.name,
            legalName: `${patch.name} Co Ltd`,
            countryCode: 'CN',
            countryOfIncorporation: 'CN',
            defaultIncoterm: 'FOB',
            defaultCurrency: 'USD',
          },
          select: { id: true },
        });
        const pickup = await tx.pickupLocation.create({
          data: {
            organizationId: orgId,
            supplierId: s.id,
            name: 'Factory',
            country: 'CN',
            closestPortCode: patch.port ?? 'CNSZX',
            isDefault: true,
          },
          select: { id: true },
        });
        if (patch.terms) {
          await tx.paymentTerms.create({
            data: {
              organizationId: orgId,
              supplierId: s.id,
              termType: patch.terms.termType,
              depositPct:
                patch.terms.termType === 'DEPOSIT_BALANCE' ? patch.terms.depositPct : null,
              balanceTrigger:
                patch.terms.termType === 'DEPOSIT_BALANCE' ? patch.terms.balanceTrigger : null,
              netDays: patch.terms.termType === 'NET' ? patch.terms.netDays : null,
            },
          });
        }
        return { id: s.id, pickupId: pickup.id };
      });

    /** The flat editor form: item `i` is `item_<i>_productId` / `_quantity` / `_unitCost`. */
    const orderForm = (
      supplierId: string,
      items: Array<[productId: string, quantity: string, unitCost: string]>,
      extra: Record<string, string> = {},
    ) => {
      const form: Record<string, string> = {
        intent: 'save',
        supplierId,
        currency: 'USD',
        incoterm: 'FOB',
        ...extra,
      };
      items.forEach(([productId, quantity, unitCost], i) => {
        form[`item_${i}_productId`] = productId;
        form[`item_${i}_quantity`] = quantity;
        form[`item_${i}_unitCost`] = unitCost;
      });
      return form;
    };

    const orderIdFrom = (location: string | null): string => {
      const m = /^\/app\/orders\/([0-9a-f-]{36})\?notice=(\w+)$/.exec(location ?? '');
      if (!m) throw new Error(`unexpected redirect ${location}`);
      return m[1]!;
    };

    const createVia = async (
      actor: Actor,
      supplierId: string,
      items: Array<[string, string, string]>,
      extra: Record<string, string> = {},
    ): Promise<string> => {
      const res = await run(
        newAction,
        post(actor, '/app/orders/new', orderForm(supplierId, items, extra)),
      );
      expect(res.status, JSON.stringify(res.data)).toBe(302);
      return orderIdFrom(res.location);
    };

    const act = (actor: Actor, id: string, form: Record<string, string>) =>
      runWith(detailAction, post(actor, `/app/orders/${id}`, form), { id });

    const detail = (actor: Actor, id: string, query = '') =>
      runWith(detailLoader, get(actor, `/app/orders/${id}${query}`), { id });

    const rowOf = (actor: Actor, id: string) =>
      withOrgTransaction(prisma, actor.orgId, (tx) => getOrder(tx, id));

    const auditsOf = (actor: Actor, id: string) =>
      withOrgTransaction(prisma, actor.orgId, (tx) =>
        tx.auditLog.findMany({ where: { targetId: id }, orderBy: { createdAt: 'asc' } }),
      );

    const caught = async (work: () => Promise<unknown>): Promise<unknown> => {
      try {
        await work();
      } catch (err) {
        return err;
      }
      return null;
    };

    /** The quote builder's values (as its loader returns them) back as a flat form. */
    const quoteFormFrom = (values: QuoteFormValues, extra: Record<string, string> = {}) => {
      const form: Record<string, string> = { ...values.scalars, ...extra };
      values.lines.forEach((l, i) => {
        for (const [k, v] of Object.entries(l)) form[`line_${i}_${k}`] = v;
      });
      return form;
    };

    beforeAll(async () => {
      t = await createTestApp({ databaseUrl: DATABASE_URL });
      prisma = t.prisma!;
      t.app.tariff = fixtureTariff();
      const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
        SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
      mustSwitchRole = who?.bypass === true;
      owner = await signIn('OWNER');
      member = await signIn('MEMBER', owner.orgId);
      viewer = await signIn('VIEWER', owner.orgId);
      outsider = await signIn('OWNER');
      // STARTER so the quote saves in the "Get freight quote" flow are not cut short by the FREE limit.
      await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.organization.update({ where: { id: owner.orgId }, data: { plan: 'STARTER' } }),
      );
      toyId = await createProduct(owner.orgId, {
        sku: 'TOY-001',
        name: SECRET_NAME,
        unitValue: '4.5',
      });
      caseId = await createProduct(owner.orgId, {
        sku: 'CASE-1',
        name: 'Display case',
        unitValue: '11',
      });
      euroId = await createProduct(owner.orgId, {
        sku: 'EUR-1',
        name: 'Euro-priced widget',
        unitValue: '10',
        currency: 'EUR',
      });
      outsiderProductId = await createProduct(outsider.orgId, {
        sku: 'OTHER-1',
        name: 'Other org product',
        unitValue: '1',
      });
      const deposit = await createSupplier(owner.orgId, {
        name: 'Shenzhen Toys',
        terms: { termType: 'DEPOSIT_BALANCE', depositPct: '30', balanceTrigger: 'ON_SHIPMENT' },
      });
      depositSupplierId = deposit.id;
      depositPickupId = deposit.pickupId;
      netSupplierId = (
        await createSupplier(owner.orgId, {
          name: 'Ningbo Cases',
          terms: { termType: 'NET', netDays: 60 },
        })
      ).id;
      prepaidSupplierId = (
        await createSupplier(owner.orgId, { name: 'Prepaid Parts', terms: { termType: 'PREPAID' } })
      ).id;
      bareSupplierId = (
        await createSupplier(owner.orgId, { name: 'No Terms Trading', terms: null })
      ).id;
      outsiderSupplierId = (
        await createSupplier(outsider.orgId, {
          name: 'Outsider Supply',
          terms: { termType: 'PREPAID' },
        })
      ).id;
    });

    afterAll(async () => {
      // Issued purchase orders and their items are frozen by the 0012 triggers: only a superuser
      // (like the GDPR hard-delete job) can clear them. As the app role the organisations stay
      // behind with their orders; everything else is removed.
      if (mustSwitchRole) {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE purchase_orders DISABLE TRIGGER purchase_orders_guard',
        );
        await prisma.$executeRawUnsafe(
          'ALTER TABLE purchase_order_items DISABLE TRIGGER purchase_order_items_frozen',
        );
      }
      try {
        for (const orgId of orgIds) {
          await withOrgTransaction(prisma, orgId, async (tx) => {
            await tx.quote.updateMany({
              where: { status: 'ACCEPTED' },
              data: { status: 'CANCELLED' },
            });
            await tx.quoteLine.deleteMany();
            await tx.quote.deleteMany();
            if (mustSwitchRole) {
              await tx.purchaseOrderItem.deleteMany();
              await tx.purchaseOrder.deleteMany();
              await tx.poCounter.deleteMany();
              await tx.paymentTerms.deleteMany();
              await tx.pickupLocation.deleteMany();
              await tx.product.deleteMany();
              await tx.supplier.deleteMany();
            }
            await tx.customsProfile.deleteMany();
            await tx.membership.deleteMany();
            if (mustSwitchRole) await tx.organization.deleteMany();
          });
        }
      } finally {
        if (mustSwitchRole) {
          await prisma.$executeRawUnsafe(
            'ALTER TABLE purchase_orders ENABLE TRIGGER purchase_orders_guard',
          );
          await prisma.$executeRawUnsafe(
            'ALTER TABLE purchase_order_items ENABLE TRIGGER purchase_order_items_frozen',
          );
        }
      }
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      setAppForTests(null);
      await disposePrismaClient();
    });

    describe('editor', () => {
      it('loads the options; `?supplier=` applies the supplier defaults; a VIEWER is refused', async () => {
        const res = await run(newLoader, get(owner, '/app/orders/new'));
        expect(res.status).toBe(200);
        const d = res.data as {
          options: {
            suppliers: Array<{ id: string; hasPaymentTerms: boolean }>;
            products: Array<{ id: string; unitValue: string; currency: string }>;
            pickups: Array<{ id: string; supplierId: string }>;
          };
          values: OrderFormValues;
        };
        expect(d.options.suppliers.map((s) => s.id).sort()).toEqual(
          [depositSupplierId, netSupplierId, prepaidSupplierId, bareSupplierId].sort(),
        );
        expect(d.options.suppliers.find((s) => s.id === bareSupplierId)?.hasPaymentTerms).toBe(
          false,
        );
        expect(d.options.products.map((p) => p.id).sort()).toEqual([toyId, caseId, euroId].sort());
        expect(d.options.products.find((p) => p.id === toyId)).toMatchObject({
          unitValue: '4.5000',
          currency: 'USD',
        });
        expect(d.options.pickups.find((p) => p.id === depositPickupId)?.supplierId).toBe(
          depositSupplierId,
        );
        expect(d.values.items).toEqual([]);

        const pre = await run(
          newLoader,
          get(owner, `/app/orders/new?supplier=${depositSupplierId}`),
        );
        expect((pre.data as { values: OrderFormValues }).values.scalars).toMatchObject({
          supplierId: depositSupplierId,
          currency: 'USD',
          incoterm: 'FOB',
          pickupLocationId: depositPickupId,
        });

        expect((await run(newLoader, get(viewer, '/app/orders/new'))).status).toBe(403);
      });

      it('add-item takes the catalogue price (merging a repeat), remove-item drops a line, a foreign-currency product is refused', async () => {
        const added = await run(
          newAction,
          post(owner, '/app/orders/new', {
            ...orderForm(depositSupplierId, []),
            intent: 'add-item',
            addProductId: toyId,
            addQuantity: '500',
          }),
        );
        expect(added.status).toBe(200);
        const a = added.data as { values: OrderFormValues; errors: Record<string, string> };
        expect(a.values.items).toEqual([{ productId: toyId, quantity: '500', unitCost: '4.5000' }]);
        expect(a.values.scalars.addProductId).toBe('');

        const merged = await run(
          newAction,
          post(owner, '/app/orders/new', {
            ...orderForm(depositSupplierId, [[toyId, '500', '4.5000']]),
            intent: 'add-item',
            addProductId: toyId,
            addQuantity: '100',
          }),
        );
        expect((merged.data as { values: OrderFormValues }).values.items).toEqual([
          { productId: toyId, quantity: '600', unitCost: '4.5000' },
        ]);

        const removed = await run(
          newAction,
          post(owner, '/app/orders/new', {
            ...orderForm(depositSupplierId, [
              [toyId, '500', '4.5000'],
              [caseId, '3', '12.3456'],
            ]),
            intent: 'recalculate',
            removeItem: '0',
          }),
        );
        expect((removed.data as { values: OrderFormValues }).values.items).toEqual([
          { productId: caseId, quantity: '3', unitCost: '12.3456' },
        ]);

        const euro = await run(
          newAction,
          post(owner, '/app/orders/new', {
            ...orderForm(depositSupplierId, []),
            intent: 'add-item',
            addProductId: euroId,
            addQuantity: '1',
          }),
        );
        expect(euro.status).toBe(400);
        expect((euro.data as { errors: Record<string, string> }).errors.addProductId).toMatch(
          /priced in EUR/,
        );
      });

      it('validation and catalogue problems come back as field errors, never a 500', async () => {
        const empty = await run(
          newAction,
          post(owner, '/app/orders/new', orderForm(depositSupplierId, [])),
        );
        expect(empty.status).toBe(400);
        expect((empty.data as { formError: string }).formError).toMatch(/at least one product/);

        const zero = await run(
          newAction,
          post(owner, '/app/orders/new', orderForm(depositSupplierId, [[toyId, '0', '4.5']])),
        );
        expect(zero.status).toBe(400);
        expect((zero.data as { errors: Record<string, string> }).errors.item_0_quantity).toMatch(
          /at least 1/,
        );

        const euroLine = await run(
          newAction,
          post(owner, '/app/orders/new', orderForm(depositSupplierId, [[euroId, '1', '10']])),
        );
        expect(euroLine.status).toBe(400);
        expect(
          (euroLine.data as { errors: Record<string, string> }).errors.item_0_unitCost,
        ).toMatch(/priced in EUR/);

        const foreignProduct = await run(
          newAction,
          post(
            owner,
            '/app/orders/new',
            orderForm(depositSupplierId, [[outsiderProductId, '1', '1']]),
          ),
        );
        expect(foreignProduct.status).toBe(400);
        expect(
          (foreignProduct.data as { errors: Record<string, string> }).errors.item_0_productId,
        ).toMatch(/no longer in your catalogue/);

        const foreignSupplier = await run(
          newAction,
          post(owner, '/app/orders/new', orderForm(outsiderSupplierId, [[toyId, '1', '4.5']])),
        );
        expect(foreignSupplier.status).toBe(400);
        expect(
          (foreignSupplier.data as { errors: Record<string, string> }).errors.supplierId,
        ).toMatch(/Choose a supplier/);

        const wrongPickup = await run(
          newAction,
          post(
            owner,
            '/app/orders/new',
            orderForm(netSupplierId, [[toyId, '1', '4.5']], { pickupLocationId: depositPickupId }),
          ),
        );
        expect(wrongPickup.status).toBe(400);
        expect(
          (wrongPickup.data as { errors: Record<string, string> }).errors.pickupLocationId,
        ).toMatch(/pickup locations/);
        expect(
          await withOrgTransaction(prisma, owner.orgId, (tx) => tx.purchaseOrder.count()),
        ).toBe(0);
      });
    });

    describe('numbering and totals', () => {
      let firstId: string;
      let secondId: string;

      it('creates DRAFT PO-YYYY-001 then -002 with the line totals; another organisation starts at 001 too', async () => {
        firstId = await createVia(owner, depositSupplierId, [[toyId, '500', '4.5']], {
          pickupLocationId: depositPickupId,
          expectedShipMonth: '2026-11',
          notes: 'First batch',
        });
        const first = await rowOf(owner, firstId);
        expect(first).toMatchObject({ poNumber: formatPoNumber(YEAR, 1), status: 'DRAFT' });
        expect(first!.totalGoodsValue.toFixed(2)).toBe('2250.00');
        expect(first!.items).toHaveLength(1);
        expect(first!.items[0]).toMatchObject({ sku: 'TOY-001', name: SECRET_NAME, quantity: 500 });
        expect(first!.items[0]!.unitCost.toFixed(4)).toBe('4.5000');
        expect(first!.items[0]!.lineTotal.toFixed(2)).toBe('2250.00');
        expect(first!.expectedShipMonth?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
        expect(first!.pickupLocationId).toBe(depositPickupId);
        expect(first!.depositAmount).toBeNull();
        expect(first!.issuedAt).toBeNull();
        const audits = await auditsOf(owner, firstId);
        expect(audits.map((a) => a.action)).toEqual(['order.create']);
        expect(audits[0]!.metadata).toEqual({
          supplierId: depositSupplierId,
          currency: 'USD',
          incoterm: 'FOB',
          items: 1,
        });

        secondId = await createVia(owner, netSupplierId, [
          [toyId, '3', '4.4444'],
          [caseId, '3', '12.3456'],
        ]);
        const second = await rowOf(owner, secondId);
        expect(second!.poNumber).toBe(formatPoNumber(YEAR, 2));
        // 13.3332 → 13.33 and 37.0368 → 37.04, summed after rounding.
        expect(second!.items.map((i) => i.lineTotal.toFixed(2))).toEqual(['13.33', '37.04']);
        expect(second!.totalGoodsValue.toFixed(2)).toBe('50.37');

        const theirs = await createVia(outsider, outsiderSupplierId, [
          [outsiderProductId, '1', '1'],
        ]);
        expect((await rowOf(outsider, theirs))!.poNumber).toBe(formatPoNumber(YEAR, 1));
      });

      it('two parallel creates never share a number (the po_counters upsert serialises them)', async () => {
        const actor = { organizationId: owner.orgId, userId: owner.userId };
        const input = orderFormSchema.parse({
          supplierId: depositSupplierId,
          currency: 'USD',
          incoterm: 'FOB',
          items: [{ productId: toyId, quantity: '1', unitCost: '4.5' }],
        });
        const now = new Date();
        const results = await Promise.all([
          withOrgTransaction(prisma, owner.orgId, (tx) => createOrder(tx, actor, input, now)),
          withOrgTransaction(prisma, owner.orgId, (tx) => createOrder(tx, actor, input, now)),
        ]);
        expect(results.every((r) => r.ok)).toBe(true);
        const numbers = results.map((r) => (r.ok ? r.poNumber : '')).sort();
        expect(numbers).toEqual([formatPoNumber(YEAR, 3), formatPoNumber(YEAR, 4)]);
        const counter = await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.poCounter.findFirst({ where: { year: YEAR } }),
        );
        expect(counter?.next).toBe(5);
      });

      it('edit loads the draft; saving replaces lines and totals, may renumber, and refuses a taken number', async () => {
        const load = await runWith(editLoader, get(owner, `/app/orders/${firstId}/edit`), {
          id: firstId,
        });
        expect(load.status).toBe(200);
        const d = load.data as { poNumber: string; values: OrderFormValues };
        expect(d.poNumber).toBe(formatPoNumber(YEAR, 1));
        expect(d.values.scalars).toMatchObject({
          supplierId: depositSupplierId,
          pickupLocationId: depositPickupId,
          expectedShipMonth: '2026-11',
          notes: 'First batch',
        });
        expect(d.values.items).toEqual([{ productId: toyId, quantity: '500', unitCost: '4.5000' }]);

        const saved = await runWith(
          editAction,
          post(
            owner,
            `/app/orders/${firstId}/edit`,
            orderForm(
              depositSupplierId,
              [
                [toyId, '250', '4.5'],
                [caseId, '10', '12.3456'],
              ],
              { pickupLocationId: depositPickupId, poNumber: 'po-2026-900' },
            ),
          ),
          { id: firstId },
        );
        expect(saved.status, JSON.stringify(saved.data)).toBe(302);
        expect(saved.location).toBe(`/app/orders/${firstId}?notice=saved`);
        const row = await rowOf(owner, firstId);
        expect(row!.poNumber).toBe('PO-2026-900');
        expect(row!.items.map((i) => [i.sku, i.quantity, i.lineTotal.toFixed(2)])).toEqual([
          ['TOY-001', 250, '1125.00'],
          ['CASE-1', 10, '123.46'],
        ]);
        expect(row!.totalGoodsValue.toFixed(2)).toBe('1248.46');
        const audits = await auditsOf(owner, firstId);
        expect(audits.map((a) => a.action)).toEqual(['order.create', 'order.update']);
        expect(audits[1]!.metadata).toMatchObject({ items: 2, renumbered: true });

        const taken = await runWith(
          editAction,
          post(
            owner,
            `/app/orders/${secondId}/edit`,
            orderForm(netSupplierId, [[toyId, '1', '4.5']], { poNumber: 'PO-2026-900' }),
          ),
          { id: secondId },
        );
        expect(taken.status).toBe(400);
        expect((taken.data as { errors: Record<string, string> }).errors.poNumber).toMatch(
          /already has that number/,
        );
        expect((await rowOf(owner, secondId))!.poNumber).toBe(formatPoNumber(YEAR, 2));
      });

      it('the list and the detail page show the draft with the right permissions', async () => {
        const list = await run(ordersLoader, get(viewer, '/app/orders?notice=created'));
        expect(list.status).toBe(200);
        const l = list.data as {
          rows: Array<{ id: string; poNumber: string; status: string; totalGoodsValue: string }>;
          canEdit: boolean;
          notice: string;
        };
        expect(l.rows.find((r) => r.id === firstId)).toMatchObject({
          poNumber: 'PO-2026-900',
          status: 'DRAFT',
          totalGoodsValue: '1248.46',
        });
        expect(l.canEdit).toBe(false);
        expect(l.notice).toMatch(/created as a draft/);
        const filtered = await run(ordersLoader, get(owner, '/app/orders?status=ISSUED'));
        expect((filtered.data as { rows: unknown[] }).rows).toEqual([]);

        const d = await detail(owner, firstId, '?notice=created');
        expect(d.status).toBe(200);
        const data = d.data as {
          order: { poNumber: string; status: string; items: unknown[]; paymentTerms: unknown };
          can: Record<string, unknown>;
          issueBlockedBy: string | null;
          notice: string;
        };
        expect(data.order).toMatchObject({ poNumber: 'PO-2026-900', status: 'DRAFT' });
        expect(data.order.items).toHaveLength(2);
        expect(data.order.paymentTerms).toMatchObject({
          termType: 'DEPOSIT_BALANCE',
          depositPct: '30.00',
          balanceTrigger: 'ON_SHIPMENT',
        });
        expect(data.can).toMatchObject({
          edit: true,
          issue: true,
          steps: [],
          cancel: true,
          recordPayment: false,
          getQuote: true,
        });
        expect(data.issueBlockedBy).toBeNull();
        expect(data.notice).toMatch(/Draft created/);

        const asViewer = await detail(viewer, firstId);
        expect((asViewer.data as { can: Record<string, unknown> }).can).toMatchObject({
          edit: false,
          issue: false,
          cancel: false,
          getQuote: false,
        });
        const asMember = await detail(member, firstId);
        expect((asMember.data as { can: Record<string, unknown> }).can).toMatchObject({
          edit: true,
          issue: false,
          cancel: true,
        });
      });
    });

    describe('issue: frozen totals and the payment schedule', () => {
      let depositId: string;

      it('DEPOSIT_BALANCE 30%: deposit rounded, balance the remainder, deposit due on issue, balance awaiting shipment', async () => {
        depositId = await createVia(owner, depositSupplierId, [
          [toyId, '500', '4.5'],
          [caseId, '3', '12.3456'],
        ]);
        const before = Date.now();
        const res = await act(owner, depositId, { intent: 'issue' });
        expect(res.status, JSON.stringify(res.data)).toBe(302);
        expect(res.location).toBe(`/app/orders/${depositId}?notice=issued`);
        const row = await rowOf(owner, depositId);
        expect(row!.status).toBe('ISSUED');
        expect(row!.issuedAt).toBeInstanceOf(Date);
        expect(row!.issuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(row!.totalGoodsValue.toFixed(2)).toBe('2287.04');
        expect(row!.depositPct!.toFixed(2)).toBe('30.00');
        expect(row!.depositAmount!.toFixed(2)).toBe('686.11'); // 686.112 → 686.11
        expect(row!.balanceAmount!.toFixed(2)).toBe('1600.93'); // the remainder, so the two add up
        expect(row!.depositDueAt?.getTime()).toBe(row!.issuedAt!.getTime());
        expect(row!.balanceTrigger).toBe('ON_SHIPMENT');
        expect(row!.balanceDueAt).toBeNull();
        expect(row!.depositPaidAt).toBeNull();
        const audits = await auditsOf(owner, depositId);
        expect(audits.map((a) => a.action)).toEqual(['order.create', 'order.issue']);
        expect(audits[1]!.metadata).toEqual({
          from: 'DRAFT',
          to: 'ISSUED',
          termType: 'DEPOSIT_BALANCE',
          balanceTrigger: 'ON_SHIPMENT',
          items: 2,
        });

        const d = (await detail(owner, depositId, '?notice=issued')).data as {
          order: Record<string, unknown>;
          can: Record<string, unknown>;
          notice: string;
        };
        expect(d.order).toMatchObject({
          status: 'ISSUED',
          depositAmount: '686.11',
          balanceAmount: '1600.93',
          balanceTrigger: 'ON_SHIPMENT',
          balanceDueAt: null,
        });
        expect(d.can).toMatchObject({
          edit: false,
          issue: false,
          recordPayment: true,
          cancel: true,
        });
        expect((d.can.steps as Array<{ to: string }>).map((s) => s.to)).toEqual([
          'IN_PRODUCTION',
          'READY_TO_SHIP',
        ]);
        expect(d.notice).toMatch(/now fixed/);
      });

      it('NET 60: no deposit, the balance due 60 days after issue', async () => {
        const id = await createVia(owner, netSupplierId, [[caseId, '10', '12.3456']]);
        expect((await act(owner, id, { intent: 'issue' })).status).toBe(302);
        const row = await rowOf(owner, id);
        expect(row!.depositPct!.toFixed(2)).toBe('0.00');
        expect(row!.depositAmount!.toFixed(2)).toBe('0.00');
        expect(row!.depositDueAt).toBeNull();
        expect(row!.balanceAmount!.toFixed(2)).toBe('123.46');
        expect(row!.balanceTrigger).toBeNull();
        expect(row!.balanceDueAt!.getTime() - row!.issuedAt!.getTime()).toBe(60 * DAY_MS);
        // Nothing to record for the deposit.
        const nothing = await act(owner, id, { intent: 'deposit-paid', paidAt: '2026-09-24' });
        expect(nothing.status).toBe(409);
        expect((nothing.data as { error: string }).error).toMatch(/Nothing is due/);
      });

      it('PREPAID: the whole amount is the deposit, due on issue; no balance', async () => {
        const id = await createVia(owner, prepaidSupplierId, [[toyId, '2', '4.5']]);
        expect((await act(owner, id, { intent: 'issue' })).status).toBe(302);
        const row = await rowOf(owner, id);
        expect(row!.depositPct!.toFixed(2)).toBe('100.00');
        expect(row!.depositAmount!.toFixed(2)).toBe('9.00');
        expect(row!.depositDueAt?.getTime()).toBe(row!.issuedAt!.getTime());
        expect(row!.balanceAmount!.toFixed(2)).toBe('0.00');
        expect(row!.balanceDueAt).toBeNull();
        const nothing = await act(owner, id, { intent: 'balance-paid', paidAt: '2026-09-24' });
        expect(nothing.status).toBe(409);
      });

      it('refused without payment terms, by a MEMBER, and for an order that is already issued', async () => {
        const bare = await createVia(owner, bareSupplierId, [[toyId, '1', '4.5']]);
        const page = await detail(owner, bare);
        expect((page.data as { issueBlockedBy: string | null }).issueBlockedBy).toMatch(
          /payment terms/,
        );
        const noTerms = await act(owner, bare, { intent: 'issue' });
        expect(noTerms.status).toBe(409);
        expect((noTerms.data as { error: string }).error).toMatch(/Add payment terms/);
        expect((await rowOf(owner, bare))!.status).toBe('DRAFT');

        expect((await act(member, bare, { intent: 'issue' })).status).toBe(403);

        const again = await act(owner, depositId, { intent: 'issue' });
        expect(again.status).toBe(409);
        expect((again.data as { error: string }).error).toMatch(/is issued and cannot be issued/);
      });

      describe('frozen once issued (trigger purchase_orders_guard / purchase_order_items_frozen)', () => {
        it('the edit page redirects, the service says FROZEN and the database refuses money and line changes', async () => {
          const load = await runWith(editLoader, get(owner, `/app/orders/${depositId}/edit`), {
            id: depositId,
          });
          expect(load.status).toBe(302);
          expect(load.location).toBe(`/app/orders/${depositId}`);
          const posted = await runWith(
            editAction,
            post(
              owner,
              `/app/orders/${depositId}/edit`,
              orderForm(depositSupplierId, [[toyId, '1', '1']]),
            ),
            { id: depositId },
          );
          expect(posted.status).toBe(302);

          const actor = { organizationId: owner.orgId, userId: owner.userId };
          const input = orderFormSchema.parse({
            supplierId: depositSupplierId,
            currency: 'USD',
            incoterm: 'FOB',
            items: [{ productId: toyId, quantity: '1', unitCost: '1' }],
          });
          expect(
            await withOrgTransaction(prisma, owner.orgId, (tx) =>
              updateOrder(tx, actor, depositId, input),
            ),
          ).toEqual({ ok: false, error: 'FROZEN', status: 'ISSUED' });

          const before = await rowOf(owner, depositId);
          const money = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrder.update({
                where: { id: depositId },
                data: { totalGoodsValue: '1.00' },
              }),
            ),
          );
          expect(money).not.toBeNull();
          expect(orderDbError(money)).toBe('FROZEN');
          expect(String((money as Error).message)).toMatch(/total_goods_value/);

          const supplier = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrder.update({
                where: { id: depositId },
                data: { supplierId: netSupplierId },
              }),
            ),
          );
          expect(orderDbError(supplier)).toBe('FROZEN');

          const insert = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrderItem.create({
                data: {
                  organizationId: owner.orgId,
                  purchaseOrderId: depositId,
                  productId: caseId,
                  position: 9,
                  quantity: 1,
                  unitCost: '1',
                  lineTotal: '1.00',
                  sku: 'X',
                  name: 'X',
                },
              }),
            ),
          );
          expect(orderDbError(insert)).toBe('FROZEN');
          const remove = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: depositId } }),
            ),
          );
          expect(orderDbError(remove)).toBe('FROZEN');
          const change = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrderItem.updateMany({
                where: { purchaseOrderId: depositId },
                data: { quantity: 1 },
              }),
            ),
          );
          expect(orderDbError(change)).toBe('FROZEN');
          const del = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrder.delete({ where: { id: depositId } }),
            ),
          );
          expect(orderDbError(del)).toBe('FROZEN');

          const after = await rowOf(owner, depositId);
          expect(after!.totalGoodsValue.toFixed(2)).toBe(before!.totalGoodsValue.toFixed(2));
          expect(after!.items).toHaveLength(2);
          expect(after!.items[0]!.quantity).toBe(500);
        });

        it('status, payment dates and notes may still change; an illegal transition is refused', async () => {
          await withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.purchaseOrder.update({
              where: { id: depositId },
              data: {
                notes: 'Confirmed by the factory',
                balanceDueAt: new Date('2026-12-01T00:00:00Z'),
              },
            }),
          );
          const row = await rowOf(owner, depositId);
          expect(row!.notes).toBe('Confirmed by the factory');
          expect(row!.balanceDueAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
          await withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.purchaseOrder.update({ where: { id: depositId }, data: { balanceDueAt: null } }),
          );

          const skip = await act(owner, depositId, { intent: 'close' });
          expect(skip.status).toBe(409);
          expect((skip.data as { error: string }).error).toMatch(/that step is not available/);
          const raw = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrder.update({ where: { id: depositId }, data: { status: 'CLOSED' } }),
            ),
          );
          expect(orderDbError(raw)).toBe('ILLEGAL_TRANSITION');
          const back = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.purchaseOrder.update({ where: { id: depositId }, data: { status: 'DRAFT' } }),
            ),
          );
          expect(orderDbError(back)).toBe('ILLEGAL_TRANSITION');
          expect((await rowOf(owner, depositId))!.status).toBe('ISSUED');
        });

        it('walks ISSUED → IN_PRODUCTION → READY_TO_SHIP → SHIPPED (balance due set) → CLOSED; nothing leaves CLOSED', async () => {
          for (const [intent, to] of [
            ['in-production', 'IN_PRODUCTION'],
            ['ready-to-ship', 'READY_TO_SHIP'],
            ['shipped', 'SHIPPED'],
          ] as const) {
            const res = await act(owner, depositId, { intent });
            expect(res.status, intent).toBe(302);
            expect(res.location).toBe(`/app/orders/${depositId}?notice=status`);
            expect((await rowOf(owner, depositId))!.status).toBe(to);
          }
          const shipped = await rowOf(owner, depositId);
          expect(shipped!.balanceDueAt).toBeInstanceOf(Date); // ON_SHIPMENT: due when marked shipped
          const audits = await auditsOf(owner, depositId);
          expect(audits.map((a) => a.action)).toEqual([
            'order.create',
            'order.issue',
            'order.status',
            'order.status',
            'order.status',
          ]);
          expect(audits.at(-1)!.metadata).toEqual({
            from: 'READY_TO_SHIP',
            to: 'SHIPPED',
            balanceDueSet: true,
          });
          expect((await act(member, depositId, { intent: 'close' })).status).toBe(302);
          expect((await rowOf(owner, depositId))!.status).toBe('CLOSED');
          const d = (await detail(owner, depositId)).data as { can: Record<string, unknown> };
          expect(d.can).toMatchObject({
            steps: [],
            cancel: false,
            recordPayment: false,
            getQuote: false,
          });
          expect((await act(owner, depositId, { intent: 'cancel' })).status).toBe(409);
          expect((await act(owner, depositId, { intent: 'in-production' })).status).toBe(409);
        });
      });
    });

    describe('payments and the Home card', () => {
      let paymentsId: string;
      let paymentsNumber: string;

      it('an issued deposit shows on Home as due; recording it takes a date and audits kind + date only', async () => {
        paymentsId = await createVia(owner, depositSupplierId, [[toyId, '100', '4.5']], {
          pickupLocationId: depositPickupId,
        });
        paymentsNumber = (await rowOf(owner, paymentsId))!.poNumber;
        // Drafts never show as due.
        let due = await withOrgTransaction(prisma, owner.orgId, (tx) => listPaymentsDue(tx, 50));
        expect(due.some((p) => p.orderId === paymentsId)).toBe(false);

        expect((await act(owner, paymentsId, { intent: 'issue' })).status).toBe(302);
        due = await withOrgTransaction(prisma, owner.orgId, (tx) => listPaymentsDue(tx, 50));
        expect(due.filter((p) => p.orderId === paymentsId)).toEqual([
          expect.objectContaining({ kind: 'DEPOSIT', amount: '135.00', currency: 'USD' }),
          expect.objectContaining({ kind: 'BALANCE', amount: '315.00', dueAt: null }),
        ]);
        const home = await run(homeLoader, get(owner, '/app'));
        expect(home.status).toBe(200);
        const h = home.data as {
          paymentsDue: Array<{
            orderId: string;
            poNumber: string;
            kind: string;
            dueAt: string | null;
          }>;
        };
        expect(h.paymentsDue.length).toBeLessThanOrEqual(3);
        expect(h.paymentsDue).toContainEqual(
          expect.objectContaining({
            orderId: paymentsId,
            poNumber: paymentsNumber,
            kind: 'DEPOSIT',
          }),
        );
        // Known due dates come before payments whose date depends on an event.
        const firstUnknown = h.paymentsDue.findIndex((p) => p.dueAt === null);
        if (firstUnknown >= 0) {
          expect(h.paymentsDue.slice(firstUnknown).every((p) => p.dueAt === null)).toBe(true);
        }

        const bad = await act(owner, paymentsId, { intent: 'deposit-paid', paidAt: '2026-02-30' });
        expect(bad.status).toBe(400);
        expect(
          (bad.data as { paymentErrors: { kind: string; errors: Record<string, string> } })
            .paymentErrors,
        ).toMatchObject({
          kind: 'DEPOSIT',
          errors: { paidAt: expect.stringMatching(/calendar date/) },
        });

        expect(
          (await act(viewer, paymentsId, { intent: 'deposit-paid', paidAt: '2026-09-24' })).status,
        ).toBe(403);

        const paid = await act(member, paymentsId, {
          intent: 'deposit-paid',
          paidAt: '2026-09-24',
        });
        expect(paid.status).toBe(302);
        expect(paid.location).toBe(`/app/orders/${paymentsId}?notice=deposit-paid`);
        const row = await rowOf(owner, paymentsId);
        expect(row!.depositPaidAt?.toISOString()).toBe('2026-09-24T00:00:00.000Z');
        expect(row!.balancePaidAt).toBeNull();
        const audits = await auditsOf(owner, paymentsId);
        expect(audits.at(-1)).toMatchObject({
          action: 'order.payment',
          metadata: { kind: 'DEPOSIT', paidAt: '2026-09-24' },
        });
        expect(JSON.stringify(audits.at(-1)!.metadata)).not.toContain('135');

        const twice = await act(owner, paymentsId, {
          intent: 'deposit-paid',
          paidAt: '2026-09-25',
        });
        expect(twice.status).toBe(409);
        expect((twice.data as { error: string }).error).toMatch(/already recorded/);

        due = await withOrgTransaction(prisma, owner.orgId, (tx) => listPaymentsDue(tx, 50));
        expect(due.filter((p) => p.orderId === paymentsId).map((p) => p.kind)).toEqual(['BALANCE']);
        const list = await run(ordersLoader, get(owner, '/app/orders'));
        expect(
          (
            list.data as { rows: Array<{ id: string; depositPaid: boolean; balancePaid: boolean }> }
          ).rows.find((r) => r.id === paymentsId),
        ).toMatchObject({ depositPaid: true, balancePaid: false });
      });

      it('cancelling: a MEMBER may cancel a draft but not an issued order; cancelled orders drop off Home', async () => {
        const draft = await createVia(member, depositSupplierId, [[toyId, '1', '4.5']]);
        const byMember = await act(member, draft, { intent: 'cancel' });
        expect(byMember.status).toBe(302);
        expect(byMember.location).toBe(`/app/orders/${draft}?notice=cancelled`);
        expect((await rowOf(owner, draft))!.status).toBe('CANCELLED');
        expect((await act(owner, draft, { intent: 'issue' })).status).toBe(409);

        const issued = await createVia(owner, prepaidSupplierId, [[toyId, '4', '4.5']]);
        expect((await act(owner, issued, { intent: 'issue' })).status).toBe(302);
        expect((await act(member, issued, { intent: 'cancel' })).status).toBe(403);
        let due = await withOrgTransaction(prisma, owner.orgId, (tx) => listPaymentsDue(tx, 50));
        expect(due.some((p) => p.orderId === issued)).toBe(true);
        expect((await act(owner, issued, { intent: 'cancel' })).status).toBe(302);
        const row = await rowOf(owner, issued);
        expect(row!.status).toBe('CANCELLED');
        expect(row!.depositAmount!.toFixed(2)).toBe('18.00'); // the frozen figures stay
        due = await withOrgTransaction(prisma, owner.orgId, (tx) => listPaymentsDue(tx, 50));
        expect(due.some((p) => p.orderId === issued)).toBe(false);
        expect((await auditsOf(owner, issued)).map((a) => a.action)).toEqual([
          'order.create',
          'order.issue',
          'order.cancel',
        ]);
      });

      describe('"Get freight quote" (the M4 builder from a purchase order)', () => {
        let quoteId: string;

        it('`?po=` pre-fills lines at the PO quantities and unit costs, the supplier, incoterm and the pickup port', async () => {
          const res = await run(quoteNewLoader, get(owner, `/app/quotes/new?po=${paymentsId}`));
          expect(res.status).toBe(200);
          const d = res.data as {
            values: QuoteFormValues;
            purchaseOrder: { id: string; poNumber: string; currency: string } | null;
            rateMonth: string | null;
          };
          expect(d.purchaseOrder).toMatchObject({
            id: paymentsId,
            poNumber: paymentsNumber,
            currency: 'USD',
          });
          expect(d.rateMonth).toMatch(/^\d{4}-\d{2}$/);
          expect(d.values.scalars).toMatchObject({
            supplierId: depositSupplierId,
            incoterm: 'FOB',
            lane: 'CNSZX:GBFXT:SEA_LCL',
            purchaseOrderId: paymentsId,
          });
          expect(d.values.lines).toEqual([
            expect.objectContaining({
              productId: toyId,
              quantity: '100',
              unitCost: '4.5000',
              currency: 'USD',
            }),
          ]);
          expect(
            (await run(quoteNewLoader, get(outsider, `/app/quotes/new?po=${paymentsId}`))).status,
          ).toBe(404);
          expect(
            (await run(quoteNewLoader, get(owner, '/app/quotes/new?po=not-a-uuid'))).status,
          ).toBe(404);
          expect(
            (await run(quoteNewLoader, get(viewer, `/app/quotes/new?po=${paymentsId}`))).status,
          ).toBe(403);
        });

        it('saving the pre-filled builder links the quote to the PO at the PO unit cost; the PO page lists it', async () => {
          // Price the case line on the PO above its catalogue value so the two are distinguishable.
          const priced = await createVia(owner, depositSupplierId, [[caseId, '10', '12.3456']], {
            pickupLocationId: depositPickupId,
          });
          expect((await act(owner, priced, { intent: 'issue' })).status).toBe(302);
          const loaded = (await run(quoteNewLoader, get(owner, `/app/quotes/new?po=${priced}`)))
            .data as {
            values: QuoteFormValues;
          };
          const saved = await run(
            quoteNewAction,
            post(owner, '/app/quotes/new', quoteFormFrom(loaded.values, { intent: 'save' })),
          );
          expect(saved.status, JSON.stringify(saved.data)).toBe(302);
          const m = /^\/app\/quotes\/([0-9a-f-]{36})\?notice=saved$/.exec(saved.location ?? '');
          expect(m).not.toBeNull();
          quoteId = m![1]!;
          const quote = await withOrgTransaction(prisma, owner.orgId, (tx) =>
            getQuote(tx, quoteId),
          );
          expect(quote!.purchaseOrderId).toBe(priced);
          expect(quote!.purchaseOrder?.poNumber).toBe((await rowOf(owner, priced))!.poNumber);
          const lines = orderedLines(quote!);
          expect(lines).toHaveLength(1);
          expect(lines[0]!.quantity).toBe(10);
          expect(lines[0]!.unitValue.toFixed(4)).toBe('12.3456'); // the PO cost, not the catalogue's 11.0000
          expect(lines[0]!.currency).toBe('USD');
          expect((quote!.builderInput as { purchaseOrderId?: string }).purchaseOrderId).toBe(
            priced,
          );

          const d = (await detail(owner, priced)).data as {
            order: { quotes: Array<{ id: string; status: string }>; acceptedQuote: unknown };
          };
          expect(d.order.quotes).toEqual([
            expect.objectContaining({ id: quoteId, status: 'DRAFT' }),
          ]);
          expect(d.order.acceptedQuote).toBeNull();
          const list = await run(ordersLoader, get(owner, '/app/orders'));
          expect(
            (
              list.data as {
                rows: Array<{ id: string; quoteCount: number; acceptedQuote: unknown }>;
              }
            ).rows.find((r) => r.id === priced),
          ).toMatchObject({ quoteCount: 1, acceptedQuote: null });

          // A second quote on the same order; then accept the first and the second is refused
          // (PO_QUOTE_ACCEPTED from the partial unique index), by the route and by the database.
          const second = await run(
            quoteNewAction,
            post(owner, '/app/quotes/new', quoteFormFrom(loaded.values, { intent: 'save' })),
          );
          expect(second.status).toBe(302);
          const secondId = /\/app\/quotes\/([0-9a-f-]{36})\?/.exec(second.location ?? '')![1]!;
          for (const id of [quoteId, secondId]) {
            const fin = await runWith(
              quoteDetailAction,
              post(owner, `/app/quotes/${id}`, { intent: 'finalise' }),
              { id },
            );
            expect(fin.status, `finalise ${id}`).toBe(302);
            expect(
              (await withOrgTransaction(prisma, owner.orgId, (tx) => getQuote(tx, id)))!.status,
            ).toBe('READY');
          }
          const accepted = await runWith(
            quoteDetailAction,
            post(owner, `/app/quotes/${quoteId}`, { intent: 'accept' }),
            { id: quoteId },
          );
          expect(accepted.status).toBe(302);
          const refused = await runWith(
            quoteDetailAction,
            post(owner, `/app/quotes/${secondId}`, { intent: 'accept' }),
            { id: secondId },
          );
          expect(refused.status).toBe(409);
          expect((refused.data as { error: string }).error).toBe(QUOTE_PO_ACCEPTED_MESSAGE);
          expect(
            (await withOrgTransaction(prisma, owner.orgId, (tx) => getQuote(tx, secondId)))!.status,
          ).toBe('READY');
          const raw = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.quote.update({ where: { id: secondId }, data: { status: 'ACCEPTED' } }),
            ),
          );
          expect(raw).not.toBeNull();
          expect(quoteDbError(raw)).toBe('PO_QUOTE_ACCEPTED');

          const after = (await detail(owner, priced)).data as {
            order: { acceptedQuote: { id: string } | null; quotes: unknown[] };
          };
          expect(after.order.acceptedQuote?.id).toBe(quoteId);
          expect(after.order.quotes).toHaveLength(2);
          expect(
            (
              (await run(ordersLoader, get(owner, '/app/orders'))).data as {
                rows: Array<{ id: string; acceptedQuote: { id: string } | null }>;
              }
            ).rows.find((r) => r.id === priced)?.acceptedQuote?.id,
          ).toBe(quoteId);
        });

        it('a quote cannot be attached to a cancelled order, nor to another organisation’s order', async () => {
          const cancelled = await createVia(owner, depositSupplierId, [[toyId, '1', '4.5']], {
            pickupLocationId: depositPickupId,
          });
          const loaded = (await run(quoteNewLoader, get(owner, `/app/quotes/new?po=${cancelled}`)))
            .data as {
            values: QuoteFormValues;
          };
          expect((await act(owner, cancelled, { intent: 'cancel' })).status).toBe(302);
          const res = await run(
            quoteNewAction,
            post(owner, '/app/quotes/new', quoteFormFrom(loaded.values, { intent: 'save' })),
          );
          expect(res.status).toBe(409);
          expect((res.data as { formError: string }).formError).toMatch(
            /cancelled; a quote cannot be attached/,
          );

          // The outsider posts the same form with the owner's PO id and their own product: the
          // product is not in their catalogue, so nothing is saved.
          const foreign = await run(
            quoteNewAction,
            post(outsider, '/app/quotes/new', quoteFormFrom(loaded.values, { intent: 'save' })),
          );
          expect(foreign.status).toBe(400);
          expect(
            await withOrgTransaction(prisma, outsider.orgId, (tx) =>
              tx.quote.count({ where: { purchaseOrderId: cancelled } }),
            ),
          ).toBe(0);
        });
      });
    });

    describe('RBAC and cross-tenant', () => {
      let draftId: string;

      it('VIEWER: reads the list and detail, cannot create, edit or act; MEMBER creates but cannot issue', async () => {
        expect((await run(newLoader, get(viewer, '/app/orders/new'))).status).toBe(403);
        expect(
          (
            await run(
              newAction,
              post(viewer, '/app/orders/new', orderForm(depositSupplierId, [[toyId, '1', '4.5']])),
            )
          ).status,
        ).toBe(403);
        draftId = await createVia(member, depositSupplierId, [[toyId, '7', '4.5']]);
        expect((await run(ordersLoader, get(viewer, '/app/orders'))).status).toBe(200);
        expect((await detail(viewer, draftId)).status).toBe(200);
        expect(
          (await runWith(editLoader, get(viewer, `/app/orders/${draftId}/edit`), { id: draftId }))
            .status,
        ).toBe(403);
        for (const intent of ['issue', 'cancel', 'in-production', 'deposit-paid']) {
          expect(
            (await act(viewer, draftId, { intent, paidAt: '2026-09-24' })).status,
            intent,
          ).toBe(403);
        }
        expect((await act(member, draftId, { intent: 'issue' })).status).toBe(403);
        expect((await rowOf(owner, draftId))!.status).toBe('DRAFT');
        // CSRF is required on every post.
        const noCsrf = await runWith(
          detailAction,
          makeRequest(`/app/orders/${draftId}`, {
            cookie: owner.cookie,
            form: { intent: 'issue' },
          }),
          { id: draftId },
        );
        expect(noCsrf.status).toBe(403);
        // A wrong intent is a 400, not a 500.
        expect((await act(owner, draftId, { intent: 'explode' })).status).toBe(400);
      });

      it('cross-tenant: the outsider cannot read, edit or act on this organisation’s order; their list is their own', async () => {
        expect((await detail(outsider, draftId)).status).toBe(404);
        expect(
          (await runWith(editLoader, get(outsider, `/app/orders/${draftId}/edit`), { id: draftId }))
            .status,
        ).toBe(404);
        expect(
          (
            await runWith(
              editAction,
              post(
                outsider,
                `/app/orders/${draftId}/edit`,
                orderForm(outsiderSupplierId, [[outsiderProductId, '1', '1']]),
              ),
              { id: draftId },
            )
          ).status,
        ).toBe(404);
        for (const intent of ['issue', 'cancel', 'in-production', 'deposit-paid']) {
          expect(
            (await act(outsider, draftId, { intent, paidAt: '2026-09-24' })).status,
            intent,
          ).toBe(404);
        }
        const list = (await run(ordersLoader, get(outsider, '/app/orders'))).data as {
          rows: Array<{ id: string }>;
          count: number;
        };
        expect(list.count).toBe(1);
        expect(list.rows.map((r) => r.id)).not.toContain(draftId);
        expect(
          await withOrgTransaction(prisma, outsider.orgId, (tx) => tx.purchaseOrder.count()),
        ).toBe(1);
        expect((await rowOf(owner, draftId))!.status).toBe('DRAFT');
        // The counter rows are tenant rows too: the outsider's year counter is its own.
        const theirs = await withOrgTransaction(prisma, outsider.orgId, (tx) =>
          tx.poCounter.findMany(),
        );
        expect(theirs).toEqual([
          expect.objectContaining({ organizationId: outsider.orgId, next: 2 }),
        ]);
      });
    });

    describe('logs', () => {
      it('never contain e-mail addresses, product names or amounts from the payment trail', () => {
        const all = t.lines.join('\n');
        expect(all).not.toMatch(/@example\.test/);
        expect(all).not.toContain('CONFIDENTIAL');
        expect(all).not.toContain('Zhang Wei');
        expect(all).not.toContain('686.11');
        expect(t.logs.some((l) => l.event === 'order.created')).toBe(true);
        expect(t.logs.some((l) => l.event === 'order.updated')).toBe(true);
        expect(t.logs.some((l) => l.event === 'order.issue' && l.ok === true)).toBe(true);
        expect(t.logs.some((l) => l.event === 'order.deposit-paid' && l.ok === true)).toBe(true);
        expect(t.logs.some((l) => l.event === 'order.create_refused')).toBe(true);
        expect(
          t.logs.some((l) => l.event === 'quote.saved' && typeof l.purchaseOrderId === 'string'),
        ).toBe(true);
      });
    });
  },
);
