/**
 * Bills (M8, ADR-0014) against a real Postgres: the editor (no-JS intents, `?order=` pre-fill),
 * create/update drafts with lines booked to purchase orders, the reference-per-vendor rule,
 * posting (lines must add up; MEMBER cannot post), the 0013 triggers (posted bills and their
 * lines are frozen, payments append-only and only on posted bills), payments with the rate the
 * bank applied (GBP computed, PAID when covered, overpayment refused, GBP bills at 1), the
 * "Costs and variance" page (accepted quote vs posted bills through `absorbActuals`, FX on
 * payments, credit notes, demurrage landing on the bulky SKU), RBAC, cross-tenant negatives and
 * the no-PII log rule (§3, §7.2, §7.3, §9). Runs only with DATABASE_URL (migrations applied), as
 * a superuser or as a non-superuser member of harbour_app.
 */
import { disposePrismaClient, withOrgTransaction, type PrismaClient, type Role } from '@harbour/db';
import { D, round2 } from '@harbour/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { billDbError, getBill, updateBill } from '../services/bills/bills.server';
import { createOrder, issueOrder } from '../services/orders/orders.server';
import { createOrganization } from '../services/organizations.server';
import {
  cookieFor,
  createTestApp,
  makeRequest,
  run,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { fixtureTariff } from '../test-support/tariff-fixtures';
import { billFormSchema, type BillFormValues } from '../validators/bill';
import { orderFormSchema } from '../validators/order';
import type { QuoteFormValues } from '../validators/quote';
import { loader as billsLoader } from './app.bills';
import { action as detailAction, loader as detailLoader } from './app.bills_.$id';
import { action as editAction, loader as editLoader } from './app.bills_.$id_.edit';
import { action as newAction, loader as newLoader } from './app.bills_.new';
import { loader as costsLoader } from './app.orders_.$id_.costs';
import { action as orderDetailAction } from './app.orders_.$id';
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

describe.skipIf(!DATABASE_URL)(
  'bills: ledger, posting, payments, costs and variance (database)',
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
    let supplierId: string;
    let toyId: string;
    let matId: string;
    /** Issued, with an accepted quote: toy 500 × 4.50 + mats 50 × 20.00 = 3,250.00 USD. */
    let orderId: string;
    let toyItemId: string;
    let matItemId: string;
    /** Issued, no quote. */
    let plainOrderId: string;
    let cancelledOrderId: string;
    let outsiderOrderId: string;
    let outsiderSupplierId: string;

    const signIn = async (role: Role, orgId?: string): Promise<Actor> => {
      const user = await prisma.user.create({ data: { email: uniqueEmail(role.toLowerCase()) } });
      userIds.push(user.id);
      let org = orgId;
      if (!org) {
        org = (await createOrganization(prisma, { userId: user.id, name: `Bills ${role} Ltd` }))
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
      patch: { sku: string; name: string; unitValue: string; weightKg: string; volumeCbm: string },
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
            currency: 'USD',
            weightKg: patch.weightKg,
            volumeCbm: patch.volumeCbm,
          },
          select: { id: true },
        }),
      ).then((p) => p.id);

    const createSupplier = (orgId: string, name: string) =>
      withOrgTransaction(prisma, orgId, async (tx) => {
        const s = await tx.supplier.create({
          data: {
            organizationId: orgId,
            name,
            legalName: `${name} Co Ltd`,
            countryCode: 'CN',
            countryOfIncorporation: 'CN',
            defaultIncoterm: 'FOB',
            defaultCurrency: 'USD',
          },
          select: { id: true },
        });
        await tx.pickupLocation.create({
          data: {
            organizationId: orgId,
            supplierId: s.id,
            name: 'Factory',
            country: 'CN',
            closestPortCode: 'CNSZX',
            isDefault: true,
          },
        });
        await tx.paymentTerms.create({
          data: {
            organizationId: orgId,
            supplierId: s.id,
            termType: 'DEPOSIT_BALANCE',
            depositPct: '30',
            balanceTrigger: 'ON_SHIPMENT',
          },
        });
        return s.id;
      });

    /** An issued purchase order straight through the services (M7 is tested elsewhere). */
    const issuedOrder = async (
      actor: Actor,
      supplier: string,
      items: Array<[productId: string, quantity: string, unitCost: string]>,
      issue = true,
    ): Promise<string> => {
      const a = { organizationId: actor.orgId, userId: actor.userId };
      const input = orderFormSchema.parse({
        supplierId: supplier,
        currency: 'USD',
        incoterm: 'FOB',
        items: items.map(([productId, quantity, unitCost]) => ({ productId, quantity, unitCost })),
      });
      const created = await withOrgTransaction(prisma, actor.orgId, (tx) =>
        createOrder(tx, a, input, new Date()),
      );
      if (!created.ok) throw new Error(created.error);
      if (issue) {
        const issued = await withOrgTransaction(prisma, actor.orgId, (tx) =>
          issueOrder(tx, a, created.id, new Date()),
        );
        if (!issued.ok) throw new Error(issued.error);
      }
      return created.id;
    };

    /** The quote builder's values back as a flat form. */
    const quoteFormFrom = (values: QuoteFormValues, extra: Record<string, string> = {}) => {
      const form: Record<string, string> = { ...values.scalars, ...extra };
      values.lines.forEach((l, i) => {
        for (const [k, v] of Object.entries(l)) form[`line_${i}_${k}`] = v;
      });
      return form;
    };

    /** Save a quote from the order, finalise and accept it. */
    const acceptQuoteFor = async (actor: Actor, order: string): Promise<string> => {
      const loaded = (await run(quoteNewLoader, get(actor, `/app/quotes/new?po=${order}`)))
        .data as {
        values: QuoteFormValues;
      };
      const saved = await run(
        quoteNewAction,
        post(actor, '/app/quotes/new', quoteFormFrom(loaded.values, { intent: 'save' })),
      );
      expect(saved.status, JSON.stringify(saved.data)).toBe(302);
      const id = /\/app\/quotes\/([0-9a-f-]{36})\?/.exec(saved.location ?? '')![1]!;
      for (const intent of ['finalise', 'accept']) {
        const res = await runWith(quoteDetailAction, post(actor, `/app/quotes/${id}`, { intent }), {
          id,
        });
        expect(res.status, `${intent}: ${JSON.stringify(res.data)}`).toBe(302);
      }
      return id;
    };

    /** The flat bill form: line `i` is `line_<i>_<field>`. */
    const billForm = (
      scalars: Record<string, string>,
      lines: Array<Record<string, string>>,
      extra: Record<string, string> = {},
    ) => {
      const form: Record<string, string> = {
        intent: 'save',
        vendorType: 'FORWARDER',
        supplierId: '',
        vendorName: 'Fast Freight Ltd',
        billType: 'FREIGHT_INVOICE',
        referenceNumber: 'FF-1001',
        currency: 'GBP',
        totalAmount: '0.00',
        issuedOn: '2026-09-20',
        ...scalars,
        ...extra,
      };
      lines.forEach((l, i) => {
        const full = {
          purchaseOrderId: '',
          purchaseOrderItemId: '',
          costCategory: '',
          unplannedReason: '',
          description: '',
          amount: '',
          ...l,
        };
        for (const [k, v] of Object.entries(full)) form[`line_${i}_${k}`] = v;
      });
      return form;
    };

    const billIdFrom = (location: string | null): string => {
      const m = /^\/app\/bills\/([0-9a-f-]{36})\?notice=(\w+)$/.exec(location ?? '');
      if (!m) throw new Error(`unexpected redirect ${location}`);
      return m[1]!;
    };

    const createVia = async (
      actor: Actor,
      scalars: Record<string, string>,
      lines: Array<Record<string, string>>,
    ): Promise<string> => {
      const res = await run(newAction, post(actor, '/app/bills/new', billForm(scalars, lines)));
      expect(res.status, JSON.stringify(res.data)).toBe(302);
      return billIdFrom(res.location);
    };

    const act = (actor: Actor, id: string, form: Record<string, string>) =>
      runWith(detailAction, post(actor, `/app/bills/${id}`, form), { id });
    const detail = (actor: Actor, id: string, query = '') =>
      runWith(detailLoader, get(actor, `/app/bills/${id}${query}`), { id });
    const costs = (actor: Actor, order: string) =>
      runWith(costsLoader, get(actor, `/app/orders/${order}/costs`), { id: order });

    const rowOf = (actor: Actor, id: string) =>
      withOrgTransaction(prisma, actor.orgId, (tx) => getBill(tx, id));
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
      await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.organization.update({ where: { id: owner.orgId }, data: { plan: 'STARTER' } }),
      );
      supplierId = await createSupplier(owner.orgId, 'Shenzhen Toys');
      // 500 toys (0.004 CBM, 0.8 kg) and 50 mats (0.032 CBM, 1.1 kg): sea chargeable weight
      // 2.0 vs 1.6 → the mats carry 4/9 of any shared physical cost.
      toyId = await createProduct(owner.orgId, {
        sku: 'TOY-001',
        name: SECRET_NAME,
        unitValue: '4.5',
        weightKg: '0.8',
        volumeCbm: '0.004',
      });
      matId = await createProduct(owner.orgId, {
        sku: 'MAT-05',
        name: 'Yoga mat',
        unitValue: '20',
        weightKg: '1.1',
        volumeCbm: '0.032',
      });
      orderId = await issuedOrder(owner, supplierId, [
        [toyId, '500', '4.5'],
        [matId, '50', '20'],
      ]);
      const items = await withOrgTransaction(prisma, owner.orgId, (tx) =>
        tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: orderId },
          select: { id: true, productId: true },
        }),
      );
      toyItemId = items.find((i) => i.productId === toyId)!.id;
      matItemId = items.find((i) => i.productId === matId)!.id;
      await acceptQuoteFor(owner, orderId);
      plainOrderId = await issuedOrder(owner, supplierId, [[toyId, '10', '4.5']]);
      cancelledOrderId = await issuedOrder(owner, supplierId, [[toyId, '1', '4.5']], false);
      expect(
        (
          await runWith(
            orderDetailAction,
            post(owner, `/app/orders/${cancelledOrderId}`, { intent: 'cancel' }),
            { id: cancelledOrderId },
          )
        ).status,
      ).toBe(302);
      outsiderSupplierId = await createSupplier(outsider.orgId, 'Outsider Supply');
      const outsiderProduct = await createProduct(outsider.orgId, {
        sku: 'OTHER-1',
        name: 'Other org product',
        unitValue: '1',
        weightKg: '1',
        volumeCbm: '0.01',
      });
      outsiderOrderId = await issuedOrder(outsider, outsiderSupplierId, [
        [outsiderProduct, '1', '1'],
      ]);
    });

    afterAll(async () => {
      // Posted bills, their lines and payments, issued orders and their items are frozen by the
      // 0012/0013 triggers: only a superuser (like the GDPR hard-delete job) can clear them. As
      // the app role the organisations stay behind with their ledger.
      const triggers: Array<[string, string]> = [
        ['bills', 'bills_guard'],
        ['bill_lines', 'bill_lines_frozen'],
        ['bill_payments', 'bill_payments_guard'],
        ['purchase_orders', 'purchase_orders_guard'],
        ['purchase_order_items', 'purchase_order_items_frozen'],
      ];
      if (mustSwitchRole) {
        for (const [table, trigger] of triggers) {
          await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        }
      }
      try {
        for (const orgId of orgIds) {
          await withOrgTransaction(prisma, orgId, async (tx) => {
            if (mustSwitchRole) {
              await tx.billPayment.deleteMany();
              await tx.billLine.deleteMany();
              await tx.bill.deleteMany();
            }
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
          for (const [table, trigger] of triggers) {
            await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
          }
        }
      }
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      setAppForTests(null);
      await disposePrismaClient();
    });

    describe('editor', () => {
      it('loads suppliers and the open orders with their lines; `?order=` starts a supplier bill; a VIEWER is refused', async () => {
        const res = await run(newLoader, get(owner, '/app/bills/new'));
        expect(res.status).toBe(200);
        const d = res.data as {
          options: {
            suppliers: Array<{ id: string }>;
            orders: Array<{
              id: string;
              poNumber: string;
              items: Array<{ id: string; sku: string }>;
            }>;
          };
          values: BillFormValues;
        };
        expect(d.options.suppliers.map((s) => s.id)).toEqual([supplierId]);
        expect(d.options.orders.map((o) => o.id).sort()).toEqual([orderId, plainOrderId].sort());
        expect(d.options.orders.find((o) => o.id === orderId)?.items.map((i) => i.sku)).toEqual([
          'TOY-001',
          'MAT-05',
        ]);
        expect(d.values.scalars).toMatchObject({ vendorType: 'FORWARDER', currency: 'GBP' });
        expect(d.values.lines).toHaveLength(1);

        const pre = await run(newLoader, get(owner, `/app/bills/new?order=${orderId}`));
        const p = pre.data as { values: BillFormValues };
        expect(p.values.scalars).toMatchObject({
          vendorType: 'SUPPLIER',
          supplierId,
          billType: 'SUPPLIER_INVOICE',
          currency: 'USD',
        });
        expect(p.values.lines).toEqual([
          expect.objectContaining({ purchaseOrderId: orderId, costCategory: 'GOODS' }),
        ]);
        expect((await run(newLoader, get(viewer, '/app/bills/new'))).status).toBe(403);
      });

      it('add-line carries the previous order forward; remove-line drops a row', async () => {
        const added = await run(
          newAction,
          post(owner, '/app/bills/new', {
            ...billForm({}, [{ purchaseOrderId: orderId, description: 'Ocean', amount: '1' }]),
            intent: 'add-line',
          }),
        );
        expect(added.status).toBe(200);
        const a = added.data as { values: BillFormValues };
        expect(a.values.lines).toHaveLength(2);
        expect(a.values.lines[1]).toMatchObject({
          purchaseOrderId: orderId,
          description: '',
          amount: '',
        });
        const removed = await run(
          newAction,
          post(owner, '/app/bills/new', {
            ...billForm({}, [
              { purchaseOrderId: orderId, description: 'A', amount: '1' },
              { purchaseOrderId: orderId, description: 'B', amount: '2' },
            ]),
            intent: 'recalculate',
            removeLine: '0',
          }),
        );
        expect((removed.data as { values: BillFormValues }).values.lines).toEqual([
          expect.objectContaining({ description: 'B' }),
        ]);
      });

      it('validation and tenancy problems come back as field errors, never a 500', async () => {
        const noName = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm({ vendorName: '', totalAmount: '1' }, [
              {
                purchaseOrderId: orderId,
                costCategory: 'FREIGHT_TO_BORDER',
                description: 'x',
                amount: '1',
              },
            ]),
          ),
        );
        expect(noName.status).toBe(400);
        expect((noName.data as { errors: Record<string, string> }).errors.vendorName).toMatch(
          /name/,
        );

        const foreignOrder = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm({ totalAmount: '1' }, [
              {
                purchaseOrderId: outsiderOrderId,
                costCategory: 'FREIGHT_TO_BORDER',
                description: 'x',
                amount: '1',
              },
            ]),
          ),
        );
        expect(foreignOrder.status).toBe(400);
        expect(
          (foreignOrder.data as { errors: Record<string, string> }).errors.line_0_purchaseOrderId,
        ).toMatch(/Choose a purchase order/);

        const cancelled = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm({ totalAmount: '1' }, [
              {
                purchaseOrderId: cancelledOrderId,
                costCategory: 'FREIGHT_TO_BORDER',
                description: 'x',
                amount: '1',
              },
            ]),
          ),
        );
        expect(cancelled.status).toBe(400);
        expect(
          (cancelled.data as { errors: Record<string, string> }).errors.line_0_purchaseOrderId,
        ).toMatch(/cancelled/);

        const wrongItem = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm({ totalAmount: '1' }, [
              {
                purchaseOrderId: plainOrderId,
                purchaseOrderItemId: toyItemId, // an item of the other order
                costCategory: 'GOODS',
                description: 'x',
                amount: '1',
              },
            ]),
          ),
        );
        expect(wrongItem.status).toBe(400);
        expect(
          (wrongItem.data as { errors: Record<string, string> }).errors.line_0_purchaseOrderItemId,
        ).toMatch(/line of that purchase order/);

        const foreignSupplier = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm({ vendorType: 'SUPPLIER', supplierId: outsiderSupplierId, totalAmount: '1' }, [
              { purchaseOrderId: orderId, costCategory: 'GOODS', description: 'x', amount: '1' },
            ]),
          ),
        );
        expect(foreignSupplier.status).toBe(400);
        expect(
          (foreignSupplier.data as { errors: Record<string, string> }).errors.supplierId,
        ).toMatch(/Choose a supplier/);
        expect(await withOrgTransaction(prisma, owner.orgId, (tx) => tx.bill.count())).toBe(0);
      });
    });

    describe('supplier invoice: draft, reference rule, posting, frozen', () => {
      let invoiceId: string;

      it('creates a DRAFT with lines booked to the order’s SKUs; the detail page and list show it', async () => {
        invoiceId = await createVia(
          owner,
          {
            vendorType: 'SUPPLIER',
            supplierId,
            vendorName: '',
            billType: 'SUPPLIER_INVOICE',
            referenceNumber: 'INV-2026-001',
            currency: 'USD',
            totalAmount: '3250.00',
            issuedOn: '2026-09-22',
            dueOn: '2026-10-22',
            notes: 'Deposit 30% on issue',
          },
          [
            {
              purchaseOrderId: orderId,
              purchaseOrderItemId: toyItemId,
              costCategory: 'GOODS',
              description: '500 toys',
              amount: '2250.00',
            },
            {
              purchaseOrderId: orderId,
              purchaseOrderItemId: matItemId,
              costCategory: 'GOODS',
              description: '50 mats',
              amount: '1000.00',
            },
          ],
        );
        const row = await rowOf(owner, invoiceId);
        expect(row).toMatchObject({
          status: 'DRAFT',
          vendorType: 'SUPPLIER',
          supplierId,
          vendorName: null,
          referenceNumber: 'INV-2026-001',
          currency: 'USD',
        });
        expect(row!.totalAmount.toFixed(2)).toBe('3250.00');
        expect(
          row!.lines.map((l) => [l.position, l.purchaseOrderItem?.sku, l.amount.toFixed(2)]),
        ).toEqual([
          [0, 'TOY-001', '2250.00'],
          [1, 'MAT-05', '1000.00'],
        ]);
        expect(row!.issuedOn.toISOString()).toBe('2026-09-22T00:00:00.000Z');
        expect((await auditsOf(owner, invoiceId)).map((a) => a.action)).toEqual(['bill.create']);
        expect((await auditsOf(owner, invoiceId))[0]!.metadata).toEqual({
          vendorType: 'SUPPLIER',
          billType: 'SUPPLIER_INVOICE',
          currency: 'USD',
          isCreditNote: false,
          lines: 2,
          orders: [orderId],
        });

        const d = (await detail(owner, invoiceId, '?notice=created')).data as {
          bill: {
            vendor: string;
            status: string;
            linesTotal: string;
            orders: Array<{ id: string }>;
          };
          can: Record<string, boolean>;
          postBlockedBy: string | null;
          notice: string;
        };
        expect(d.bill).toMatchObject({
          vendor: 'Shenzhen Toys',
          status: 'DRAFT',
          linesTotal: '3250.00',
        });
        expect(d.bill.orders).toEqual([{ id: orderId, poNumber: expect.stringMatching(/^PO-/) }]);
        expect(d.can).toEqual({
          edit: true,
          post: true,
          delete: true,
          recordPayment: false,
          removePayment: false,
        });
        expect(d.postBlockedBy).toBeNull();
        expect(d.notice).toMatch(/Draft recorded/);

        const list = (await run(billsLoader, get(viewer, '/app/bills'))).data as {
          rows: Array<{ id: string; vendor: string; totalAmount: string }>;
          canEdit: boolean;
        };
        expect(list.rows.find((r) => r.id === invoiceId)).toMatchObject({
          vendor: 'Shenzhen Toys',
          totalAmount: '3250.00',
        });
        expect(list.canEdit).toBe(false);
        const forOrder = (await run(billsLoader, get(owner, `/app/bills?order=${plainOrderId}`)))
          .data as { rows: unknown[] };
        expect(forOrder.rows).toEqual([]);
      });

      it('the same reference from the same vendor is refused; another vendor may reuse it', async () => {
        const dup = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm(
              {
                vendorType: 'SUPPLIER',
                supplierId,
                vendorName: '',
                referenceNumber: 'inv-2026-001',
                currency: 'USD',
                totalAmount: '1',
              },
              [{ purchaseOrderId: orderId, costCategory: 'GOODS', description: 'x', amount: '1' }],
            ),
          ),
        );
        // Case matters on the reference itself (it is the vendor's string): a different case is a different reference…
        expect(dup.status).toBe(302);
        const dupId = billIdFrom(dup.location);
        const exact = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm(
              {
                vendorType: 'SUPPLIER',
                supplierId,
                vendorName: '',
                referenceNumber: 'INV-2026-001',
                currency: 'USD',
                totalAmount: '1',
              },
              [{ purchaseOrderId: orderId, costCategory: 'GOODS', description: 'x', amount: '1' }],
            ),
          ),
        );
        expect(exact.status).toBe(400);
        expect((exact.data as { errors: Record<string, string> }).errors.referenceNumber).toMatch(
          /already exists/,
        );
        // …a named vendor with the same reference is fine (and its name is matched case-insensitively).
        const other = await createVia(
          owner,
          { referenceNumber: 'INV-2026-001', vendorName: 'Fast Freight Ltd', totalAmount: '1' },
          [
            {
              purchaseOrderId: orderId,
              costCategory: 'FREIGHT_TO_BORDER',
              description: 'x',
              amount: '1',
            },
          ],
        );
        const again = await run(
          newAction,
          post(
            owner,
            '/app/bills/new',
            billForm(
              { referenceNumber: 'INV-2026-001', vendorName: 'fast freight ltd', totalAmount: '1' },
              [
                {
                  purchaseOrderId: orderId,
                  costCategory: 'FREIGHT_TO_BORDER',
                  description: 'x',
                  amount: '1',
                },
              ],
            ),
          ),
        );
        expect(again.status).toBe(400);
        for (const id of [dupId, other]) {
          const del = await act(owner, id, { intent: 'delete' });
          expect(del.status).toBe(302);
          expect(del.location).toBe('/app/bills?notice=deleted');
          expect(await rowOf(owner, id)).toBeNull();
        }
      });

      it('posting needs lines that add up: the page says so, the route refuses, the trigger backs it up; then posts', async () => {
        const unbalanced = await runWith(
          editAction,
          post(
            owner,
            `/app/bills/${invoiceId}/edit`,
            billForm(
              {
                vendorType: 'SUPPLIER',
                supplierId,
                vendorName: '',
                billType: 'SUPPLIER_INVOICE',
                referenceNumber: 'INV-2026-001',
                currency: 'USD',
                totalAmount: '3000.00',
                issuedOn: '2026-09-22',
              },
              [
                {
                  purchaseOrderId: orderId,
                  purchaseOrderItemId: toyItemId,
                  costCategory: 'GOODS',
                  description: '500 toys',
                  amount: '2250.00',
                },
                {
                  purchaseOrderId: orderId,
                  purchaseOrderItemId: matItemId,
                  costCategory: 'GOODS',
                  description: '50 mats',
                  amount: '1000.00',
                },
              ],
            ),
          ),
          { id: invoiceId },
        );
        expect(unbalanced.status, JSON.stringify(unbalanced.data)).toBe(302);
        const page = (await detail(owner, invoiceId)).data as { postBlockedBy: string | null };
        expect(page.postBlockedBy).toMatch(
          /add up to 3,250\.00 USD but the bill total is 3,000\.00 USD/,
        );
        const refused = await act(owner, invoiceId, { intent: 'post' });
        expect(refused.status).toBe(409);
        expect((refused.data as { error: string }).error).toMatch(
          /lines add up to 3250\.00 USD but the bill total is 3000\.00 USD/,
        );
        const raw = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.bill.update({
              where: { id: invoiceId },
              data: { status: 'POSTED', postedAt: new Date() },
            }),
          ),
        );
        expect(raw).not.toBeNull();
        expect(billDbError(raw)).toBe('NOT_BALANCED');
        expect((await rowOf(owner, invoiceId))!.status).toBe('DRAFT');

        const balanced = await runWith(
          editAction,
          post(
            owner,
            `/app/bills/${invoiceId}/edit`,
            billForm(
              {
                vendorType: 'SUPPLIER',
                supplierId,
                vendorName: '',
                billType: 'SUPPLIER_INVOICE',
                referenceNumber: 'INV-2026-001',
                currency: 'USD',
                totalAmount: '3250.00',
                issuedOn: '2026-09-22',
                dueOn: '2026-10-22',
              },
              [
                {
                  purchaseOrderId: orderId,
                  purchaseOrderItemId: toyItemId,
                  costCategory: 'GOODS',
                  description: '500 toys',
                  amount: '2250.00',
                },
                {
                  purchaseOrderId: orderId,
                  purchaseOrderItemId: matItemId,
                  costCategory: 'GOODS',
                  description: '50 mats',
                  amount: '1000.00',
                },
              ],
            ),
          ),
          { id: invoiceId },
        );
        expect(balanced.status).toBe(302);
        expect((await act(member, invoiceId, { intent: 'post' })).status).toBe(403);
        const posted = await act(owner, invoiceId, { intent: 'post' });
        expect(posted.status, JSON.stringify(posted.data)).toBe(302);
        expect(posted.location).toBe(`/app/bills/${invoiceId}?notice=posted`);
        const row = await rowOf(owner, invoiceId);
        expect(row!.status).toBe('POSTED');
        expect(row!.postedAt).toBeInstanceOf(Date);
        expect((await auditsOf(owner, invoiceId)).map((a) => a.action)).toEqual([
          'bill.create',
          'bill.update',
          'bill.update',
          'bill.post',
        ]);
        expect((await act(owner, invoiceId, { intent: 'post' })).status).toBe(409);
        const d = (await detail(owner, invoiceId)).data as { can: Record<string, boolean> };
        expect(d.can).toEqual({
          edit: false,
          post: false,
          delete: false,
          recordPayment: true,
          removePayment: true,
        });
      });

      it('posted: the edit page redirects, the service says FROZEN, the database refuses lines, money and deletion; notes may change', async () => {
        const load = await runWith(editLoader, get(owner, `/app/bills/${invoiceId}/edit`), {
          id: invoiceId,
        });
        expect(load.status).toBe(302);
        expect(load.location).toBe(`/app/bills/${invoiceId}`);
        const actor = { organizationId: owner.orgId, userId: owner.userId };
        const input = billFormSchema.parse({
          vendorType: 'SUPPLIER',
          supplierId,
          billType: 'SUPPLIER_INVOICE',
          referenceNumber: 'INV-2026-001',
          currency: 'USD',
          totalAmount: '1.00',
          issuedOn: '2026-09-22',
          lines: [
            { purchaseOrderId: orderId, costCategory: 'GOODS', description: 'x', amount: '1.00' },
          ],
        });
        expect(
          await withOrgTransaction(prisma, owner.orgId, (tx) =>
            updateBill(tx, actor, invoiceId, input),
          ),
        ).toEqual({ ok: false, error: 'FROZEN', status: 'POSTED' });
        const money = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.bill.update({ where: { id: invoiceId }, data: { totalAmount: '1.00' } }),
          ),
        );
        expect(billDbError(money)).toBe('FROZEN');
        expect(String((money as Error).message)).toMatch(/total_amount/);
        const insert = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.billLine.create({
              data: {
                organizationId: owner.orgId,
                billId: invoiceId,
                position: 9,
                costCategory: 'OTHER',
                description: 'x',
                amount: '1',
                purchaseOrderId: orderId,
              },
            }),
          ),
        );
        expect(billDbError(insert)).toBe('FROZEN');
        const remove = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.billLine.deleteMany({ where: { billId: invoiceId } }),
          ),
        );
        expect(billDbError(remove)).toBe('FROZEN');
        const del = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.bill.delete({ where: { id: invoiceId } }),
          ),
        );
        expect(billDbError(del)).toBe('FROZEN');
        const viaRoute = await act(owner, invoiceId, { intent: 'delete' });
        expect(viaRoute.status).toBe(409);
        expect((viaRoute.data as { error: string }).error).toMatch(
          /posted and can no longer be changed/,
        );
        const back = await caught(() =>
          withOrgTransaction(prisma, owner.orgId, (tx) =>
            tx.bill.update({ where: { id: invoiceId }, data: { status: 'DRAFT', postedAt: null } }),
          ),
        );
        expect(billDbError(back)).toBe('ILLEGAL_TRANSITION');
        await withOrgTransaction(prisma, owner.orgId, (tx) =>
          tx.bill.update({
            where: { id: invoiceId },
            data: { notes: 'Checked against the packing list' },
          }),
        );
        const row = await rowOf(owner, invoiceId);
        expect(row!.notes).toBe('Checked against the packing list');
        expect(row!.lines).toHaveLength(2);
        expect(row!.totalAmount.toFixed(2)).toBe('3250.00');
      });

      describe('payments', () => {
        let firstPaymentId: string;

        it('are refused on drafts, validated, computed in GBP at the rate paid, and settle the bill', async () => {
          const draft = await createVia(
            owner,
            { referenceNumber: 'DRAFT-1', totalAmount: '5.00' },
            [{ purchaseOrderId: orderId, costCategory: 'OTHER', description: 'x', amount: '5.00' }],
          );
          const onDraft = await act(owner, draft, {
            intent: 'record-payment',
            paidOn: '2026-09-24',
            amount: '5',
            fxRate: '1',
          });
          expect(onDraft.status).toBe(409);
          expect((onDraft.data as { error: string }).error).toMatch(/Post the bill first/);
          const rawOnDraft = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.billPayment.create({
                data: {
                  organizationId: owner.orgId,
                  billId: draft,
                  paidOn: new Date('2026-09-24T00:00:00Z'),
                  amount: '5',
                  fxRate: '1',
                  amountGbp: '5',
                },
              }),
            ),
          );
          expect(billDbError(rawOnDraft)).toBe('WRONG_STATUS');
          expect((await act(owner, draft, { intent: 'delete' })).status).toBe(302);

          const bad = await act(owner, invoiceId, {
            intent: 'record-payment',
            paidOn: '2026-09-24',
            amount: '975.00',
            fxRate: '0',
          });
          expect(bad.status).toBe(400);
          expect(
            (bad.data as { paymentErrors: Record<string, string> }).paymentErrors.fxRate,
          ).toBeDefined();
          expect(
            (
              await act(viewer, invoiceId, {
                intent: 'record-payment',
                paidOn: '2026-09-24',
                amount: '1',
                fxRate: '1',
              })
            ).status,
          ).toBe(403);

          // The 30% deposit at 0.78.
          const deposit = await act(member, invoiceId, {
            intent: 'record-payment',
            paidOn: '2026-09-24',
            amount: '975.00',
            fxRate: '0.78',
            reference: 'TT 4471',
          });
          expect(deposit.status, JSON.stringify(deposit.data)).toBe(302);
          let row = await rowOf(owner, invoiceId);
          expect(row!.status).toBe('POSTED');
          expect(row!.payments).toHaveLength(1);
          expect(row!.payments[0]!.amountGbp.toFixed(2)).toBe('760.50');
          expect(row!.payments[0]!.fxRate.toString()).toBe('0.78');
          firstPaymentId = row!.payments[0]!.id;
          const audit = (await auditsOf(owner, invoiceId)).at(-1)!;
          expect(audit.action).toBe('bill.payment');
          expect(audit.metadata).toEqual({
            paymentId: firstPaymentId,
            paidOn: '2026-09-24',
            currency: 'USD',
            status: 'POSTED',
          });

          const over = await act(owner, invoiceId, {
            intent: 'record-payment',
            paidOn: '2026-10-01',
            amount: '3000.00',
            fxRate: '0.8',
          });
          expect(over.status).toBe(409);
          expect((over.data as { error: string }).error).toMatch(
            /more than is outstanding: 2275\.00 USD/,
          );

          // The balance at 0.80 covers the total → PAID, paid on the last payment's date.
          const balance = await act(owner, invoiceId, {
            intent: 'record-payment',
            paidOn: '2026-10-01',
            amount: '2275.00',
            fxRate: '0.8',
          });
          expect(balance.status).toBe(302);
          row = await rowOf(owner, invoiceId);
          expect(row!.status).toBe('PAID');
          expect(row!.paidAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
          expect(row!.payments.map((p) => p.amountGbp.toFixed(2))).toEqual(['760.50', '1820.00']);
          const d = (await detail(owner, invoiceId)).data as {
            bill: { paidAmount: string; outstandingAmount: string; paidGbp: string };
            can: Record<string, boolean>;
          };
          expect(d.bill).toMatchObject({
            paidAmount: '3250.00',
            outstandingAmount: '0.00',
            paidGbp: '2580.50',
          });
          expect(d.can.recordPayment).toBe(false);
          expect(d.can.removePayment).toBe(true);
          const list = (await run(billsLoader, get(owner, '/app/bills?status=PAID'))).data as {
            rows: Array<{ id: string; paidAmount: string }>;
          };
          expect(list.rows.find((r) => r.id === invoiceId)?.paidAmount).toBe('3250.00');
        });

        it('are append-only: no update; removing one reopens the bill as POSTED', async () => {
          const update = await caught(() =>
            withOrgTransaction(prisma, owner.orgId, (tx) =>
              tx.billPayment.update({ where: { id: firstPaymentId }, data: { amount: '1' } }),
            ),
          );
          expect(billDbError(update)).toBe('FROZEN');
          const gone = await act(owner, invoiceId, {
            intent: 'remove-payment',
            paymentId: firstPaymentId,
          });
          expect(gone.status).toBe(302);
          const row = await rowOf(owner, invoiceId);
          expect(row!.status).toBe('POSTED');
          expect(row!.paidAt).toBeNull();
          expect(row!.payments).toHaveLength(1);
          expect((await auditsOf(owner, invoiceId)).at(-1)).toMatchObject({
            action: 'bill.payment_removed',
            metadata: { paymentId: firstPaymentId, status: 'POSTED' },
          });
          const again = await act(owner, invoiceId, {
            intent: 'remove-payment',
            paymentId: firstPaymentId,
          });
          expect(again.status).toBe(409);
        });
      });
    });

    describe('costs and variance (accepted quote vs posted bills)', () => {
      let freightId: string;

      it('a GBP forwarder invoice with shared freight and demurrage, a credit note; GBP payments take rate 1', async () => {
        freightId = await createVia(
          owner,
          {
            referenceNumber: 'FF-2201',
            vendorName: 'Fast Freight Ltd',
            currency: 'GBP',
            totalAmount: '870.00',
            issuedOn: '2026-10-03',
          },
          [
            {
              purchaseOrderId: orderId,
              costCategory: 'FREIGHT_TO_BORDER',
              description: 'Ocean freight CNSZX–GBFXT',
              amount: '520.00',
            },
            {
              purchaseOrderId: orderId,
              costCategory: 'UNPLANNED',
              unplannedReason: 'DEMURRAGE',
              description: 'Demurrage 4 days',
              amount: '350.00',
            },
          ],
        );
        expect((await act(owner, freightId, { intent: 'post' })).status).toBe(302);
        const paid = await act(owner, freightId, {
          intent: 'record-payment',
          paidOn: '2026-10-10',
          amount: '870.00',
        });
        expect(paid.status, JSON.stringify(paid.data)).toBe(302);
        const row = await rowOf(owner, freightId);
        expect(row!.status).toBe('PAID');
        expect(row!.payments[0]!.fxRate.toString()).toBe('1');
        expect(row!.payments[0]!.amountGbp.toFixed(2)).toBe('870.00');

        const credit = await createVia(
          owner,
          {
            referenceNumber: 'CN-2201',
            vendorName: 'Fast Freight Ltd',
            currency: 'GBP',
            totalAmount: '20.00',
            issuedOn: '2026-10-05',
            isCreditNote: 'on',
          },
          [
            {
              purchaseOrderId: orderId,
              costCategory: 'FREIGHT_TO_BORDER',
              description: 'BAF overcharge',
              amount: '20.00',
            },
          ],
        );
        expect((await rowOf(owner, credit))!.isCreditNote).toBe(true);
        expect((await act(owner, credit, { intent: 'post' })).status).toBe(302);
      });

      it('the order’s costs page: FX from payments (unpaid part estimated), credit note netted, demurrage on the bulky SKU', async () => {
        const res = await costs(owner, orderId);
        expect(res.status).toBe(200);
        const { costs: c } = res.data as {
          costs: {
            quote: { reference: string; vatRecoverable: boolean } | null;
            bills: Array<{
              referenceNumber: string;
              basis: string;
              totalGbp: string | null;
              estimateRate: string | null;
              estimateRateSource: string | null;
            }>;
            postedBillCount: number;
            hasEstimatedFx: boolean;
            warnings: string[];
            result: {
              byCategory: Record<
                string,
                { estimateGbp: string; actualGbp: string; varianceGbp: string; hasActuals: boolean }
              >;
              totals: {
                estimatedLandedCostGbp: string;
                actualLandedCostGbp: string;
                varianceGbp: string;
              };
              missingCategories: string[];
              landedCostCategories: string[];
              lines: Array<{
                sku: string | null;
                quantity: number;
                byCategory: Record<string, { actualGbp: string }>;
                drivers: Array<{ category: string; unplannedReasons: string[] }>;
              }>;
            } | null;
          };
        };
        expect(c.quote?.reference).toMatch(/^Q-/);
        expect(c.postedBillCount).toBe(3);
        const r = c.result!;
        expect(r).not.toBeNull();

        // The supplier invoice: 2,275 USD paid at 0.80 (1,820.00), 975 USD unpaid at today's
        // HMRC rate (or the quote's), flagged as an estimate.
        const inv = c.bills.find((b) => b.referenceNumber === 'INV-2026-001')!;
        expect(inv.basis).toBe('PAYMENTS_AND_RATE');
        expect(inv.estimateRate).not.toBeNull();
        expect(['HMRC_MONTHLY', 'QUOTE']).toContain(inv.estimateRateSource);
        const expectedInvGbp = D('1820.00')
          .plus(round2(D('975').times(D(inv.estimateRate!))))
          .toFixed(2);
        expect(inv.totalGbp).toBe(expectedInvGbp);
        expect(c.hasEstimatedFx).toBe(true);
        expect(r.byCategory.GOODS!.actualGbp).toBe(expectedInvGbp);
        expect(r.byCategory.GOODS!.hasActuals).toBe(true);

        // Freight: 520 − 20 credit note; demurrage 350 shared, allocated by chargeable weight
        // (toys 2.0 vs mats 1.6 → 5/9 and 4/9).
        expect(c.bills.find((b) => b.referenceNumber === 'CN-2201')).toMatchObject({
          basis: 'GBP',
          totalGbp: '-20.00',
        });
        expect(r.byCategory.FREIGHT_TO_BORDER!.actualGbp).toBe('500.00');
        expect(r.byCategory.UNPLANNED!).toMatchObject({
          estimateGbp: '0.00',
          actualGbp: '350.00',
          varianceGbp: '350.00',
        });
        const toys = r.lines.find((l) => l.sku === 'TOY-001')!;
        const mats = r.lines.find((l) => l.sku === 'MAT-05')!;
        expect(toys.quantity).toBe(500);
        expect(toys.byCategory.UNPLANNED!.actualGbp).toBe('194.44');
        expect(mats.byCategory.UNPLANNED!.actualGbp).toBe('155.56');
        expect(
          mats.drivers.some(
            (d) => d.category === 'UNPLANNED' && d.unplannedReasons.includes('DEMURRAGE'),
          ),
        ).toBe(true);

        // Totals are a straight subtraction over the landed-cost categories; missing = estimated
        // but not yet billed.
        expect(
          D(r.totals.actualLandedCostGbp).minus(D(r.totals.estimatedLandedCostGbp)).toFixed(2),
        ).toBe(r.totals.varianceGbp);
        for (const cat of r.missingCategories) {
          expect(r.byCategory[cat]!.hasActuals).toBe(false);
          expect(D(r.byCategory[cat]!.estimateGbp).gt(0)).toBe(true);
          expect(r.landedCostCategories).toContain(cat);
        }
        expect(r.missingCategories).not.toContain('GOODS');
        expect(r.landedCostCategories.includes('IMPORT_VAT')).toBe(!c.quote!.vatRecoverable);
      });

      it('an order without an accepted quote shows actuals only; a bill on two orders counts each order’s own lines', async () => {
        const before = (await costs(owner, plainOrderId)).data as {
          costs: {
            quote: unknown;
            result: unknown;
            actualsOnly: Record<string, string>;
            postedBillCount: number;
          };
        };
        expect(before.costs.quote).toBeNull();
        expect(before.costs.result).toBeNull();
        expect(before.costs.actualsOnly).toEqual({});
        expect(before.costs.postedBillCount).toBe(0);

        const split = await createVia(
          owner,
          {
            referenceNumber: 'FF-2300',
            vendorName: 'Fast Freight Ltd',
            currency: 'GBP',
            totalAmount: '150.00',
            issuedOn: '2026-10-06',
          },
          [
            {
              purchaseOrderId: plainOrderId,
              costCategory: 'DESTINATION_FEES',
              description: 'Port handling (small order)',
              amount: '50.00',
            },
            {
              purchaseOrderId: orderId,
              costCategory: 'DESTINATION_FEES',
              description: 'Port handling',
              amount: '100.00',
            },
          ],
        );
        expect((await act(owner, split, { intent: 'post' })).status).toBe(302);
        const after = (await costs(owner, plainOrderId)).data as {
          costs: {
            actualsOnly: Record<string, string>;
            postedBillCount: number;
            bills: Array<{ referenceNumber: string }>;
          };
        };
        expect(after.costs.actualsOnly).toEqual({ DESTINATION_FEES: '50.00' });
        expect(after.costs.postedBillCount).toBe(1);
        expect(after.costs.bills.map((b) => b.referenceNumber)).toEqual(['FF-2300']);
        const main = (await costs(owner, orderId)).data as {
          costs: {
            result: { byCategory: Record<string, { actualGbp: string }> };
            postedBillCount: number;
          };
        };
        expect(main.costs.result.byCategory.DESTINATION_FEES!.actualGbp).toBe('100.00');
        expect(main.costs.postedBillCount).toBe(4);
        expect(
          (
            (await run(billsLoader, get(owner, `/app/bills?order=${plainOrderId}`))).data as {
              rows: Array<{ id: string }>;
            }
          ).rows.map((r) => r.id),
        ).toEqual([split]);
      });
    });

    describe('RBAC and cross-tenant', () => {
      let draftId: string;

      it('VIEWER reads but cannot create, edit or act; MEMBER creates and pays but cannot post', async () => {
        expect(
          (
            await run(
              newAction,
              post(
                viewer,
                '/app/bills/new',
                billForm({ totalAmount: '1' }, [
                  {
                    purchaseOrderId: orderId,
                    costCategory: 'OTHER',
                    description: 'x',
                    amount: '1',
                  },
                ]),
              ),
            )
          ).status,
        ).toBe(403);
        draftId = await createVia(member, { referenceNumber: 'M-1', totalAmount: '1.00' }, [
          { purchaseOrderId: orderId, costCategory: 'OTHER', description: 'x', amount: '1.00' },
        ]);
        expect((await run(billsLoader, get(viewer, '/app/bills'))).status).toBe(200);
        expect((await detail(viewer, draftId)).status).toBe(200);
        expect((await costs(viewer, orderId)).status).toBe(200);
        expect(
          (await runWith(editLoader, get(viewer, `/app/bills/${draftId}/edit`), { id: draftId }))
            .status,
        ).toBe(403);
        for (const intent of ['post', 'delete', 'record-payment', 'remove-payment']) {
          expect(
            (
              await act(viewer, draftId, {
                intent,
                paidOn: '2026-09-24',
                amount: '1',
                fxRate: '1',
                paymentId: draftId,
              })
            ).status,
            intent,
          ).toBe(403);
        }
        expect((await act(member, draftId, { intent: 'post' })).status).toBe(403);
        const noCsrf = await runWith(
          detailAction,
          makeRequest(`/app/bills/${draftId}`, { cookie: owner.cookie, form: { intent: 'post' } }),
          { id: draftId },
        );
        expect(noCsrf.status).toBe(403);
        expect((await act(owner, draftId, { intent: 'explode' })).status).toBe(400);
      });

      it('cross-tenant: the outsider cannot read, edit or act on this organisation’s bill or costs page', async () => {
        expect((await detail(outsider, draftId)).status).toBe(404);
        expect(
          (await runWith(editLoader, get(outsider, `/app/bills/${draftId}/edit`), { id: draftId }))
            .status,
        ).toBe(404);
        expect(
          (
            await runWith(
              editAction,
              post(
                outsider,
                `/app/bills/${draftId}/edit`,
                billForm({ totalAmount: '1' }, [
                  {
                    purchaseOrderId: outsiderOrderId,
                    costCategory: 'OTHER',
                    description: 'x',
                    amount: '1',
                  },
                ]),
              ),
              { id: draftId },
            )
          ).status,
        ).toBe(404);
        for (const intent of ['post', 'delete', 'record-payment']) {
          expect(
            (
              await act(outsider, draftId, {
                intent,
                paidOn: '2026-09-24',
                amount: '1',
                fxRate: '1',
              })
            ).status,
            intent,
          ).toBe(404);
        }
        expect((await costs(outsider, orderId)).status).toBe(404);
        const list = (await run(billsLoader, get(outsider, '/app/bills'))).data as {
          count: number;
        };
        expect(list.count).toBe(0);
        expect((await rowOf(owner, draftId))!.status).toBe('DRAFT');
      });
    });

    describe('logs', () => {
      it('never contain e-mail addresses, product names or amounts', () => {
        const all = t.lines.join('\n');
        expect(all).not.toMatch(/@example\.test/);
        expect(all).not.toContain('CONFIDENTIAL');
        expect(all).not.toContain('Zhang Wei');
        expect(all).not.toContain('3250');
        expect(all).not.toContain('760.5');
        expect(t.logs.some((l) => l.event === 'bill.created')).toBe(true);
        expect(t.logs.some((l) => l.event === 'bill.updated')).toBe(true);
        expect(t.logs.some((l) => l.event === 'bill.post' && l.ok === true)).toBe(true);
        expect(t.logs.some((l) => l.event === 'bill.record-payment' && l.ok === true)).toBe(true);
        expect(t.logs.some((l) => l.event === 'bill.create_refused')).toBe(true);
      });
    });
  },
);
