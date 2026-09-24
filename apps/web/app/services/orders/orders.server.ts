import { Prisma, TenantScopeError, recordAudit, type TenantTransactionClient } from '@harbour/db';
import {
  OPEN_STATUSES,
  ORDERS_PAGE_SIZE,
  canTransition,
  type OrderFormInput,
  type OrderListFilter,
  type OrderStatusValue,
  type PaymentKind,
} from '../../validators/order';
import type { Actor } from '../catalogue/products.server';
import { quoteReference } from '../quotes/view';
import {
  formatPoNumber,
  orderTotals,
  paymentSchedule,
  paymentsDue,
  type PaymentDue,
  type PaymentSource,
} from './schedule';

/**
 * Purchase order persistence (M7, ADR-0013). Every function takes the SCOPED transaction client
 * from `withOrg` (Prisma tenant scope + RLS) and an `Actor` for the audit row that commits with the
 * change. Money stays in the PO currency as `Prisma.Decimal` in and decimal strings out (§3).
 *
 * Rules the database backs up (migration 0012): `PO-YYYY-NNN` numbering from `po_counters`,
 * the status transition table, a frozen row and frozen items once the PO is not DRAFT, and at
 * most one ACCEPTED quote per PO. `orderDbError` turns those refusals into friendly categories.
 *
 * Audit rows carry ids, statuses, enum values and dates only — never amounts (§7.3 spirit: the
 * payment trail belongs to the ledger, not the log).
 */

export const orderItemSelect = {
  id: true,
  productId: true,
  position: true,
  quantity: true,
  unitCost: true,
  lineTotal: true,
  sku: true,
  name: true,
  product: { select: { currency: true, archivedAt: true } },
} satisfies Prisma.PurchaseOrderItemSelect;

export const orderSelect = {
  id: true,
  poNumber: true,
  status: true,
  supplierId: true,
  pickupLocationId: true,
  currency: true,
  incoterm: true,
  totalGoodsValue: true,
  depositPct: true,
  depositAmount: true,
  depositDueAt: true,
  depositPaidAt: true,
  balanceAmount: true,
  balanceTrigger: true,
  balanceDueAt: true,
  balancePaidAt: true,
  expectedShipMonth: true,
  issuedAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  supplier: {
    select: {
      name: true,
      archivedAt: true,
      paymentTerms: {
        select: { termType: true, depositPct: true, balanceTrigger: true, netDays: true },
      },
    },
  },
  pickupLocation: { select: { name: true, closestPortCode: true, country: true } },
  items: { select: orderItemSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  quotes: {
    select: {
      id: true,
      status: true,
      totalLandedCostExVat: true,
      totalLandedCost: true,
      validUntil: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  },
} satisfies Prisma.PurchaseOrderSelect;

export type OrderRecord = Prisma.PurchaseOrderGetPayload<{ select: typeof orderSelect }>;
export type OrderItemRecord = Prisma.PurchaseOrderItemGetPayload<{
  select: typeof orderItemSelect;
}>;

// ---------- JSON-safe views ----------

const dec2 = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toFixed(2));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export interface OrderItemView {
  id: string;
  productId: string;
  position: number;
  quantity: number;
  unitCost: string;
  lineTotal: string;
  sku: string;
  name: string;
  productArchived: boolean;
}

export interface LinkedQuoteView {
  id: string;
  reference: string;
  status: string;
  totalLandedCostExVat: string;
  totalLandedCost: string;
  validUntil: string;
  updatedAt: string;
}

export interface OrderView {
  id: string;
  poNumber: string;
  status: OrderStatusValue;
  supplier: { id: string; name: string; archived: boolean };
  paymentTerms: {
    termType: string;
    depositPct: string | null;
    balanceTrigger: string | null;
    netDays: number | null;
  } | null;
  pickupLocation: { id: string; name: string; port: string; country: string } | null;
  currency: string;
  incoterm: string;
  totalGoodsValue: string;
  depositPct: string | null;
  depositAmount: string | null;
  depositDueAt: string | null;
  depositPaidAt: string | null;
  balanceAmount: string | null;
  balanceTrigger: string | null;
  balanceDueAt: string | null;
  balancePaidAt: string | null;
  /** `YYYY-MM` or null. */
  expectedShipMonth: string | null;
  issuedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItemView[];
  quotes: LinkedQuoteView[];
  /** The one ACCEPTED quote, when there is one (partial unique index). */
  acceptedQuote: LinkedQuoteView | null;
}

export const orderRowToView = (row: OrderRecord): OrderView => {
  const quotes = row.quotes.map((q): LinkedQuoteView => ({
    id: q.id,
    reference: quoteReference(q.id),
    status: q.status,
    totalLandedCostExVat: q.totalLandedCostExVat.toFixed(2),
    totalLandedCost: q.totalLandedCost.toFixed(2),
    validUntil: q.validUntil.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  }));
  return {
    id: row.id,
    poNumber: row.poNumber,
    status: row.status,
    supplier: {
      id: row.supplierId,
      name: row.supplier.name,
      archived: row.supplier.archivedAt !== null,
    },
    paymentTerms: row.supplier.paymentTerms
      ? {
          termType: row.supplier.paymentTerms.termType,
          depositPct: dec2(row.supplier.paymentTerms.depositPct),
          balanceTrigger: row.supplier.paymentTerms.balanceTrigger,
          netDays: row.supplier.paymentTerms.netDays,
        }
      : null,
    pickupLocation:
      row.pickupLocationId !== null && row.pickupLocation
        ? {
            id: row.pickupLocationId,
            name: row.pickupLocation.name,
            port: row.pickupLocation.closestPortCode,
            country: row.pickupLocation.country,
          }
        : null,
    currency: row.currency,
    incoterm: row.incoterm,
    totalGoodsValue: row.totalGoodsValue.toFixed(2),
    depositPct: dec2(row.depositPct),
    depositAmount: dec2(row.depositAmount),
    depositDueAt: iso(row.depositDueAt),
    depositPaidAt: iso(row.depositPaidAt),
    balanceAmount: dec2(row.balanceAmount),
    balanceTrigger: row.balanceTrigger,
    balanceDueAt: iso(row.balanceDueAt),
    balancePaidAt: iso(row.balancePaidAt),
    expectedShipMonth: row.expectedShipMonth
      ? row.expectedShipMonth.toISOString().slice(0, 7)
      : null,
    issuedAt: iso(row.issuedAt),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: row.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      position: i.position,
      quantity: i.quantity,
      unitCost: i.unitCost.toFixed(4),
      lineTotal: i.lineTotal.toFixed(2),
      sku: i.sku,
      name: i.name,
      productArchived: i.product.archivedAt !== null,
    })),
    quotes,
    acceptedQuote: quotes.find((q) => q.status === 'ACCEPTED') ?? null,
  };
};

// ---------- reads ----------

export const getOrder = (tx: TenantTransactionClient, id: string): Promise<OrderRecord | null> =>
  tx.purchaseOrder.findUnique({ where: { id }, select: orderSelect });

export interface OrderListRow {
  id: string;
  poNumber: string;
  status: OrderStatusValue;
  supplierName: string;
  currency: string;
  totalGoodsValue: string;
  depositAmount: string | null;
  depositPaid: boolean;
  balanceAmount: string | null;
  balancePaid: boolean;
  quoteCount: number;
  acceptedQuote: { id: string; reference: string } | null;
  updatedAt: string;
}

const listSelect = {
  id: true,
  poNumber: true,
  status: true,
  currency: true,
  totalGoodsValue: true,
  depositAmount: true,
  depositPaidAt: true,
  balanceAmount: true,
  balancePaidAt: true,
  updatedAt: true,
  supplier: { select: { name: true } },
  quotes: { select: { id: true, status: true } },
} satisfies Prisma.PurchaseOrderSelect;

export const listOrders = async (
  tx: TenantTransactionClient,
  filter: OrderListFilter,
): Promise<{ rows: OrderListRow[]; count: number; page: number; pages: number }> => {
  const where = filter.status ? { status: filter.status } : {};
  const count = await tx.purchaseOrder.count({ where });
  const pages = Math.max(1, Math.ceil(count / ORDERS_PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const rows = await tx.purchaseOrder.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    skip: (page - 1) * ORDERS_PAGE_SIZE,
    take: ORDERS_PAGE_SIZE,
    select: listSelect,
  });
  return {
    count,
    page,
    pages,
    rows: rows.map((o) => {
      const accepted = o.quotes.find((q) => q.status === 'ACCEPTED');
      return {
        id: o.id,
        poNumber: o.poNumber,
        status: o.status,
        supplierName: o.supplier.name,
        currency: o.currency,
        totalGoodsValue: o.totalGoodsValue.toFixed(2),
        depositAmount: dec2(o.depositAmount),
        depositPaid: o.depositPaidAt !== null,
        balanceAmount: dec2(o.balanceAmount),
        balancePaid: o.balancePaidAt !== null,
        quoteCount: o.quotes.length,
        acceptedQuote: accepted
          ? { id: accepted.id, reference: quoteReference(accepted.id) }
          : null,
        updatedAt: o.updatedAt.toISOString(),
      };
    }),
  };
};

/** Home "Payments due": the next `take` unpaid deposits/balances of open orders. */
export const listPaymentsDue = async (
  tx: TenantTransactionClient,
  take: number,
): Promise<PaymentDue[]> => {
  const rows = await tx.purchaseOrder.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      OR: [
        { depositPaidAt: null, depositAmount: { gt: 0 } },
        { balancePaidAt: null, balanceAmount: { gt: 0 } },
      ],
    },
    select: {
      id: true,
      poNumber: true,
      status: true,
      currency: true,
      depositAmount: true,
      depositDueAt: true,
      depositPaidAt: true,
      balanceAmount: true,
      balanceDueAt: true,
      balancePaidAt: true,
      supplier: { select: { name: true } },
    },
  });
  const sources: PaymentSource[] = rows.map((o) => ({
    id: o.id,
    poNumber: o.poNumber,
    supplierName: o.supplier.name,
    status: o.status,
    currency: o.currency,
    depositAmount: dec2(o.depositAmount),
    depositDueAt: iso(o.depositDueAt),
    depositPaidAt: iso(o.depositPaidAt),
    balanceAmount: dec2(o.balanceAmount),
    balanceDueAt: iso(o.balanceDueAt),
    balancePaidAt: iso(o.balancePaidAt),
  }));
  return paymentsDue(sources, take);
};

// ---------- writes ----------

export type OrderWriteError =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'FROZEN'
  | 'ILLEGAL_TRANSITION'
  | 'SUPPLIER_NOT_FOUND'
  | 'PICKUP_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'NUMBER_TAKEN'
  | 'NO_PAYMENT_TERMS'
  | 'NO_ITEMS'
  | 'NOTHING_DUE';

export type OrderWriteResult =
  | { ok: true; id: string; status: OrderStatusValue; poNumber: string }
  | {
      ok: false;
      error: OrderWriteError;
      status?: OrderStatusValue;
      /** Form field the problem belongs to, when there is one. */
      field?: string;
      /** Extra detail for the message (a SKU, a currency) — never PII. */
      detail?: string;
    };

/** The database trigger / scope / unique errors as a friendly category; anything else is rethrown. */
export const orderDbError = (err: unknown): OrderWriteError | null => {
  if (err instanceof TenantScopeError && err.code === 'NOT_FOUND_IN_SCOPE') return 'NOT_FOUND';
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return 'NOT_FOUND';
    if (err.code === 'P2002') return 'NUMBER_TAKEN';
    // Composite FK violated: a supplier / pickup location / product outside this organisation
    // (or a pickup location of another supplier). The scoped pre-checks answer first; this is
    // the database backstop.
    if (err.code === 'P2003') return 'SUPPLIER_NOT_FOUND';
  }
  const message = err instanceof Error ? err.message : '';
  if (/is not an allowed transition/.test(message)) return 'ILLEGAL_TRANSITION';
  if (/and frozen/.test(message)) return 'FROZEN';
  if (/cannot be deleted/.test(message)) return 'FROZEN';
  return null;
};

export const ORDER_FROZEN_MESSAGE =
  'This purchase order has been issued and can no longer be changed. Cancel it and create a new order if the goods have changed.';

const audit = (
  tx: TenantTransactionClient,
  actor: Actor,
  action: string,
  id: string,
  metadata: Prisma.InputJsonObject,
) =>
  recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action,
    targetType: 'PurchaseOrder',
    targetId: id,
    metadata,
  });

const dec = (s: string): Prisma.Decimal => new Prisma.Decimal(s);

/**
 * Next `PO-YYYY-NNN` for the organisation, inside the caller's transaction. The upsert on
 * `po_counters (organization_id, year)` takes a row lock, so concurrent creates serialise and never
 * share a number (gaps after a rolled-back create are fine). Raw SQL (reviewed): Prisma's upsert
 * is not guaranteed to be a single `INSERT ... ON CONFLICT`. Runs under RLS: `WITH CHECK` refuses
 * any organisation but the current one.
 */
export const allocatePoNumber = async (
  tx: TenantTransactionClient,
  organizationId: string,
  now: Date,
): Promise<string> => {
  const year = now.getUTCFullYear();
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    INSERT INTO po_counters (id, organization_id, year, next)
    VALUES (gen_random_uuid(), ${organizationId}::uuid, ${year}, 2)
    ON CONFLICT (organization_id, year) DO UPDATE SET next = po_counters.next + 1
    RETURNING next - 1 AS n`;
  const n = rows[0]?.n;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error('po_counters returned no number');
  }
  return formatPoNumber(year, n);
};

interface ResolvedItems {
  rows: Omit<Prisma.PurchaseOrderItemCreateManyInput, 'purchaseOrderId'>[];
  totalGoodsValue: string;
}

/**
 * Every product must be in THIS organisation (the scoped read returns nothing for any other) and
 * priced in the PO currency (ADR-0013: unit costs are in the PO currency; a product priced in
 * another currency is refused rather than silently converted).
 */
const resolveItems = async (
  tx: TenantTransactionClient,
  input: OrderFormInput,
  organizationId: string,
): Promise<ResolvedItems | Extract<OrderWriteResult, { ok: false }>> => {
  const ids = input.items.map((i) => i.productId);
  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, sku: true, name: true, currency: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const [i, item] of input.items.entries()) {
    const p = byId.get(item.productId);
    if (!p) {
      return {
        ok: false,
        error: 'PRODUCT_NOT_FOUND',
        field: `item_${i}_productId`,
        detail:
          'One of the products is no longer in your catalogue. Remove the line and add it again.',
      };
    }
    if (p.currency !== input.currency) {
      return {
        ok: false,
        error: 'CURRENCY_MISMATCH',
        field: `item_${i}_unitCost`,
        detail: `${p.sku} is priced in ${p.currency} in your catalogue, but this order is in ${input.currency}. Change the order currency, or edit the product.`,
      };
    }
  }
  const totals = orderTotals(input.items);
  return {
    totalGoodsValue: totals.totalGoodsValue,
    rows: input.items.map((item, i) => {
      const p = byId.get(item.productId)!;
      return {
        organizationId,
        productId: item.productId,
        position: i,
        quantity: item.quantity,
        unitCost: dec(item.unitCost),
        lineTotal: dec(totals.lines[i]!.lineTotal),
        sku: p.sku,
        name: p.name,
      };
    }),
  };
};

/** The supplier must exist here and (for a new order) not be archived; the pickup must be its own. */
const resolveSupplier = async (
  tx: TenantTransactionClient,
  input: OrderFormInput,
  previousSupplierId: string | null,
): Promise<Extract<OrderWriteResult, { ok: false }> | null> => {
  const s = await tx.supplier.findUnique({
    where: { id: input.supplierId },
    select: { id: true, archivedAt: true },
  });
  if (!s || (s.archivedAt !== null && input.supplierId !== previousSupplierId)) {
    return { ok: false, error: 'SUPPLIER_NOT_FOUND', field: 'supplierId' };
  }
  if (input.pickupLocationId !== undefined) {
    const p = await tx.pickupLocation.findUnique({
      where: { id: input.pickupLocationId },
      select: { supplierId: true },
    });
    if (!p || p.supplierId !== input.supplierId) {
      return { ok: false, error: 'PICKUP_NOT_FOUND', field: 'pickupLocationId' };
    }
  }
  return null;
};

const scalarData = (input: OrderFormInput) => ({
  supplierId: input.supplierId,
  pickupLocationId: input.pickupLocationId ?? null,
  currency: input.currency,
  incoterm: input.incoterm,
  expectedShipMonth:
    input.expectedShipMonth === undefined ? null : shipMonthDate(input.expectedShipMonth),
  notes: input.notes ?? null,
});

const shipMonthDate = (yyyyMm: string): Date =>
  new Date(Date.UTC(Number(yyyyMm.slice(0, 4)), Number(yyyyMm.slice(5, 7)) - 1, 1));

/** Creates a DRAFT with a fresh number and its items. Audit `order.create`. */
export const createOrder = async (
  tx: TenantTransactionClient,
  actor: Actor,
  input: OrderFormInput,
  now: Date,
): Promise<OrderWriteResult> => {
  // Everything is checked before the first write, so a refusal leaves no half-made order behind.
  const supplierProblem = await resolveSupplier(tx, input, null);
  if (supplierProblem) return supplierProblem;
  const items = await resolveItems(tx, input, actor.organizationId);
  if ('ok' in items) return items;
  const poNumber = await allocatePoNumber(tx, actor.organizationId, now);
  let id: string;
  try {
    const created = await tx.purchaseOrder.create({
      data: {
        organizationId: actor.organizationId,
        poNumber,
        ...scalarData(input),
        totalGoodsValue: dec(items.totalGoodsValue),
      },
      select: { id: true },
    });
    id = created.id;
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) return { ok: false, error: mapped };
    throw err;
  }
  await tx.purchaseOrderItem.createMany({
    data: items.rows.map((r) => ({ ...r, purchaseOrderId: id })),
  });
  await audit(tx, actor, 'order.create', id, {
    supplierId: input.supplierId,
    currency: input.currency,
    incoterm: input.incoterm,
    items: items.rows.length,
  });
  return { ok: true, id, status: 'DRAFT', poNumber };
};

/**
 * Replaces a DRAFT's scalars and items. Refused for any other status (the trigger backs this
 * up). Audit `order.update` with the changed field names.
 */
export const updateOrder = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  input: OrderFormInput,
): Promise<OrderWriteResult> => {
  const existing = await tx.purchaseOrder.findUnique({
    where: { id },
    select: { status: true, supplierId: true, poNumber: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (existing.status !== 'DRAFT') {
    return { ok: false, error: 'FROZEN', status: existing.status };
  }
  const supplierProblem = await resolveSupplier(tx, input, existing.supplierId);
  if (supplierProblem) return supplierProblem;
  const items = await resolveItems(tx, input, actor.organizationId);
  if ('ok' in items) return items;
  const poNumber = input.poNumber ?? existing.poNumber;
  try {
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    await tx.purchaseOrder.update({
      where: { id },
      data: { ...scalarData(input), poNumber, totalGoodsValue: dec(items.totalGoodsValue) },
      select: { id: true },
    });
    await tx.purchaseOrderItem.createMany({
      data: items.rows.map((r) => ({ ...r, purchaseOrderId: id })),
    });
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) {
      return mapped === 'NUMBER_TAKEN'
        ? { ok: false, error: mapped, field: 'poNumber' }
        : { ok: false, error: mapped, status: existing.status };
    }
    throw err;
  }
  await audit(tx, actor, 'order.update', id, {
    supplierId: input.supplierId,
    currency: input.currency,
    incoterm: input.incoterm,
    items: items.rows.length,
    renumbered: poNumber !== existing.poNumber,
  });
  return { ok: true, id, status: 'DRAFT', poNumber };
};

/**
 * DRAFT → ISSUED: freezes the goods total and computes the deposit/balance from the supplier's
 * payment terms at this moment (ADR-0013). Refused without items or without payment terms — we
 * never invent terms for money. The caller has checked `order.issue`. Audit `order.issue`.
 */
export const issueOrder = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  now: Date,
): Promise<OrderWriteResult> => {
  const row = await getOrder(tx, id);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (row.status !== 'DRAFT') return { ok: false, error: 'WRONG_STATUS', status: row.status };
  if (row.items.length === 0) return { ok: false, error: 'NO_ITEMS', status: row.status };
  const terms = row.supplier.paymentTerms;
  if (!terms) return { ok: false, error: 'NO_PAYMENT_TERMS', status: row.status };
  const total = orderTotals(
    row.items.map((i) => ({ quantity: i.quantity, unitCost: i.unitCost.toFixed(4) })),
  ).totalGoodsValue;
  const schedule = paymentSchedule(
    total,
    {
      termType: terms.termType,
      depositPct: terms.depositPct === null ? null : terms.depositPct.toFixed(2),
      balanceTrigger: terms.balanceTrigger,
      netDays: terms.netDays,
    },
    now,
  );
  try {
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'ISSUED',
        issuedAt: now,
        totalGoodsValue: dec(total),
        depositPct: dec(schedule.depositPct),
        depositAmount: dec(schedule.depositAmount),
        depositDueAt: schedule.depositDueAt,
        balanceAmount: dec(schedule.balanceAmount),
        balanceTrigger: schedule.balanceTrigger,
        balanceDueAt: schedule.balanceDueAt,
      },
      select: { id: true },
    });
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) return { ok: false, error: mapped, status: row.status };
    throw err;
  }
  await audit(tx, actor, 'order.issue', id, {
    from: 'DRAFT',
    to: 'ISSUED',
    termType: terms.termType,
    balanceTrigger: schedule.balanceTrigger,
    items: row.items.length,
  });
  return { ok: true, id, status: 'ISSUED', poNumber: row.poNumber };
};

/**
 * A status move from the ADR-0013 table (ISSUED → IN_PRODUCTION → READY_TO_SHIP → SHIPPED →
 * CLOSED, production skippable). Moving to SHIPPED with an ON_SHIPMENT balance sets its due date.
 * Issue and cancel have their own functions. Audit `order.status` with from/to.
 */
export const moveOrder = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  to: Exclude<OrderStatusValue, 'DRAFT' | 'ISSUED' | 'CANCELLED'>,
  now: Date,
): Promise<OrderWriteResult> => {
  const existing = await tx.purchaseOrder.findUnique({
    where: { id },
    select: { status: true, poNumber: true, balanceTrigger: true, balanceDueAt: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (!canTransition(existing.status, to)) {
    return { ok: false, error: 'ILLEGAL_TRANSITION', status: existing.status };
  }
  const balanceDueAt =
    to === 'SHIPPED' && existing.balanceTrigger === 'ON_SHIPMENT' && existing.balanceDueAt === null
      ? now
      : undefined;
  try {
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: to, ...(balanceDueAt ? { balanceDueAt } : {}) },
      select: { id: true },
    });
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) return { ok: false, error: mapped, status: existing.status };
    throw err;
  }
  await audit(tx, actor, 'order.status', id, {
    from: existing.status,
    to,
    balanceDueSet: balanceDueAt !== undefined,
  });
  return { ok: true, id, status: to, poNumber: existing.poNumber };
};

/** Any status but CLOSED/CANCELLED → CANCELLED. The route decides which permission applies. */
export const cancelOrder = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
): Promise<OrderWriteResult> => {
  const existing = await tx.purchaseOrder.findUnique({
    where: { id },
    select: { status: true, poNumber: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (!canTransition(existing.status, 'CANCELLED')) {
    return { ok: false, error: 'ILLEGAL_TRANSITION', status: existing.status };
  }
  try {
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED' },
      select: { id: true },
    });
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) return { ok: false, error: mapped, status: existing.status };
    throw err;
  }
  await audit(tx, actor, 'order.cancel', id, { from: existing.status, to: 'CANCELLED' });
  return { ok: true, id, status: 'CANCELLED', poNumber: existing.poNumber };
};

/**
 * Records that the deposit or the balance was paid on `paidAt` (a calendar date, UTC midnight).
 * Only for issued (or later, not cancelled) orders whose amount is due. The payments partner's
 * webhook will set the same fields later (ADR-0016). Audit `order.payment` with the kind and the
 * date — never the amount.
 */
export const recordPayment = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  kind: PaymentKind,
  paidAt: Date,
): Promise<OrderWriteResult> => {
  const existing = await tx.purchaseOrder.findUnique({
    where: { id },
    select: {
      status: true,
      poNumber: true,
      depositAmount: true,
      depositPaidAt: true,
      balanceAmount: true,
      balancePaidAt: true,
    },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (!OPEN_STATUSES.includes(existing.status)) {
    return { ok: false, error: 'WRONG_STATUS', status: existing.status };
  }
  const amount = kind === 'DEPOSIT' ? existing.depositAmount : existing.balanceAmount;
  const already = kind === 'DEPOSIT' ? existing.depositPaidAt : existing.balancePaidAt;
  if (amount === null || amount.isZero() || already !== null) {
    return { ok: false, error: 'NOTHING_DUE', status: existing.status };
  }
  try {
    await tx.purchaseOrder.update({
      where: { id },
      data: kind === 'DEPOSIT' ? { depositPaidAt: paidAt } : { balancePaidAt: paidAt },
      select: { id: true },
    });
  } catch (err) {
    const mapped = orderDbError(err);
    if (mapped) return { ok: false, error: mapped, status: existing.status };
    throw err;
  }
  await audit(tx, actor, 'order.payment', id, {
    kind,
    paidAt: paidAt.toISOString().slice(0, 10),
  });
  return { ok: true, id, status: existing.status, poNumber: existing.poNumber };
};

/** Friendly copy for a failed write. */
export const orderErrorMessage = (
  result: Extract<OrderWriteResult, { ok: false }>,
  verb = 'updated',
): string => {
  switch (result.error) {
    case 'NOT_FOUND':
      return 'This purchase order no longer exists in your organisation.';
    case 'FROZEN':
      return ORDER_FROZEN_MESSAGE;
    case 'WRONG_STATUS':
      return `This purchase order is ${(result.status ?? 'in a state that').toLowerCase().replace(/_/g, ' ')} and cannot be ${verb}.`;
    case 'ILLEGAL_TRANSITION':
      return `This purchase order is ${(result.status ?? '').toLowerCase().replace(/_/g, ' ')}; that step is not available from here.`;
    case 'SUPPLIER_NOT_FOUND':
      return 'Choose a supplier from your list.';
    case 'PICKUP_NOT_FOUND':
      return 'Choose one of this supplier’s pickup locations, or none.';
    case 'PRODUCT_NOT_FOUND':
      return result.detail ?? 'One of the products is no longer in your catalogue.';
    case 'CURRENCY_MISMATCH':
      return result.detail ?? 'A product is priced in a different currency from this order.';
    case 'NUMBER_TAKEN':
      return 'Another purchase order already has that number.';
    case 'NO_PAYMENT_TERMS':
      return 'Add payment terms to the supplier before issuing: the deposit and balance are computed from them.';
    case 'NO_ITEMS':
      return 'Add at least one product before issuing.';
    case 'NOTHING_DUE':
      return 'Nothing is due for that payment, or it is already recorded as paid.';
  }
};
