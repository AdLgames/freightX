import { Prisma, TenantScopeError, recordAudit, type TenantTransactionClient } from '@harbour/db';
import { D, ZERO, fixed2, round2, sum } from '@harbour/engine';
import {
  BILLS_PAGE_SIZE,
  type BillFormInput,
  type BillListFilter,
  type BillStatusValue,
  type BillTypeValue,
  type PaymentFormInput,
  type VendorTypeValue,
} from '../../validators/bill';
import type { Actor } from '../catalogue/products.server';

/**
 * Bill persistence (M8, ADR-0014): the accounts-payable sub-ledger. Every function takes the
 * SCOPED transaction client from `withOrg` (Prisma tenant scope + RLS) and an `Actor` for the
 * audit row that commits with the change. Money stays in the bill currency as `Prisma.Decimal`
 * in and decimal strings out (§3); the GBP figure of a payment is computed here from the rate the
 * bank applied, never typed.
 *
 * Rules the database backs up (migration 0013): a bill is DRAFT until posted; posting needs
 * lines that add up to the total; posted bills are frozen (status, paid date, document and notes
 * aside) and their lines with them; payments only on posted bills, append-only; a vendor's
 * reference is unique. `billDbError` turns those refusals into friendly categories.
 *
 * Audit rows carry ids, statuses, enum values, counts and dates only — never amounts.
 */

export const billLineSelect = {
  id: true,
  position: true,
  costCategory: true,
  unplannedReason: true,
  description: true,
  amount: true,
  purchaseOrderId: true,
  purchaseOrderItemId: true,
  purchaseOrder: { select: { poNumber: true, status: true } },
  purchaseOrderItem: { select: { sku: true, name: true, productId: true } },
} satisfies Prisma.BillLineSelect;

export const billPaymentSelect = {
  id: true,
  paidOn: true,
  amount: true,
  fxRate: true,
  amountGbp: true,
  reference: true,
  createdAt: true,
} satisfies Prisma.BillPaymentSelect;

export const billSelect = {
  id: true,
  vendorType: true,
  supplierId: true,
  vendorName: true,
  billType: true,
  referenceNumber: true,
  isCreditNote: true,
  status: true,
  currency: true,
  totalAmount: true,
  issuedOn: true,
  dueOn: true,
  documentId: true,
  notes: true,
  postedAt: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  supplier: { select: { name: true, archivedAt: true } },
  lines: { select: billLineSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  payments: { select: billPaymentSelect, orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.BillSelect;

export type BillRecord = Prisma.BillGetPayload<{ select: typeof billSelect }>;
export type BillLineRecord = Prisma.BillLineGetPayload<{ select: typeof billLineSelect }>;
export type BillPaymentRecord = Prisma.BillPaymentGetPayload<{ select: typeof billPaymentSelect }>;

// ---------- JSON-safe views ----------

const dec2 = (d: Prisma.Decimal): string => d.toFixed(2);
const day = (d: Date): string => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null): string | null => (d === null ? null : day(d));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The vendor as shown: the supplier's current name, else the name typed on the bill. */
export const vendorLabel = (bill: {
  supplier: { name: string } | null;
  vendorName: string | null;
}): string => bill.supplier?.name ?? bill.vendorName ?? '';

export interface BillLineView {
  id: string;
  position: number;
  costCategory: BillLineRecord['costCategory'];
  unplannedReason: BillLineRecord['unplannedReason'];
  description: string;
  amount: string;
  purchaseOrder: { id: string; poNumber: string; status: string };
  item: { id: string; sku: string; name: string; productId: string } | null;
}

export interface BillPaymentView {
  id: string;
  paidOn: string;
  amount: string;
  fxRate: string;
  amountGbp: string;
  reference: string | null;
}

export interface BillView {
  id: string;
  vendorType: VendorTypeValue;
  vendor: string;
  supplier: { id: string; name: string; archived: boolean } | null;
  billType: BillTypeValue;
  referenceNumber: string;
  isCreditNote: boolean;
  status: BillStatusValue;
  currency: string;
  totalAmount: string;
  /** Sum of the payments, bill currency. */
  paidAmount: string;
  /** total − paid, never negative. */
  outstandingAmount: string;
  /** Sum of the payments' GBP amounts. */
  paidGbp: string;
  issuedOn: string;
  dueOn: string | null;
  documentId: string | null;
  notes: string | null;
  postedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillLineView[];
  /** Sum of the lines, bill currency — equals the total once posted. */
  linesTotal: string;
  payments: BillPaymentView[];
  /** Distinct purchase orders the lines are booked to. */
  orders: Array<{ id: string; poNumber: string }>;
}

export const billRowToView = (row: BillRecord): BillView => {
  const paid = sum(row.payments.map((p) => D(p.amount.toFixed(2))));
  const total = D(row.totalAmount.toFixed(2));
  const outstanding = total.minus(paid).gt(0) ? total.minus(paid) : ZERO;
  const orders = new Map<string, string>();
  for (const l of row.lines) orders.set(l.purchaseOrderId, l.purchaseOrder.poNumber);
  return {
    id: row.id,
    vendorType: row.vendorType,
    vendor: vendorLabel(row),
    supplier:
      row.supplierId !== null && row.supplier
        ? {
            id: row.supplierId,
            name: row.supplier.name,
            archived: row.supplier.archivedAt !== null,
          }
        : null,
    billType: row.billType,
    referenceNumber: row.referenceNumber,
    isCreditNote: row.isCreditNote,
    status: row.status,
    currency: row.currency,
    totalAmount: dec2(row.totalAmount),
    paidAmount: fixed2(paid),
    outstandingAmount: fixed2(outstanding),
    paidGbp: fixed2(sum(row.payments.map((p) => D(p.amountGbp.toFixed(2))))),
    issuedOn: day(row.issuedOn),
    dueOn: dayOrNull(row.dueOn),
    documentId: row.documentId,
    notes: row.notes,
    postedAt: iso(row.postedAt),
    paidAt: iso(row.paidAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: row.lines.map((l): BillLineView => ({
      id: l.id,
      position: l.position,
      costCategory: l.costCategory,
      unplannedReason: l.unplannedReason,
      description: l.description,
      amount: dec2(l.amount),
      purchaseOrder: {
        id: l.purchaseOrderId,
        poNumber: l.purchaseOrder.poNumber,
        status: l.purchaseOrder.status,
      },
      item:
        l.purchaseOrderItemId !== null && l.purchaseOrderItem
          ? {
              id: l.purchaseOrderItemId,
              sku: l.purchaseOrderItem.sku,
              name: l.purchaseOrderItem.name,
              productId: l.purchaseOrderItem.productId,
            }
          : null,
    })),
    linesTotal: fixed2(sum(row.lines.map((l) => D(l.amount.toFixed(2))))),
    payments: row.payments.map((p): BillPaymentView => ({
      id: p.id,
      paidOn: day(p.paidOn),
      amount: dec2(p.amount),
      fxRate: p.fxRate.toString(),
      amountGbp: dec2(p.amountGbp),
      reference: p.reference,
    })),
    orders: [...orders].map(([id, poNumber]) => ({ id, poNumber })),
  };
};

// ---------- reads ----------

export const getBill = (tx: TenantTransactionClient, id: string): Promise<BillRecord | null> =>
  tx.bill.findUnique({ where: { id }, select: billSelect });

export interface BillListRow {
  id: string;
  vendor: string;
  billType: BillTypeValue;
  referenceNumber: string;
  isCreditNote: boolean;
  status: BillStatusValue;
  currency: string;
  totalAmount: string;
  paidAmount: string;
  issuedOn: string;
  dueOn: string | null;
  orders: Array<{ id: string; poNumber: string }>;
  updatedAt: string;
}

const listSelect = {
  id: true,
  vendorName: true,
  billType: true,
  referenceNumber: true,
  isCreditNote: true,
  status: true,
  currency: true,
  totalAmount: true,
  issuedOn: true,
  dueOn: true,
  updatedAt: true,
  supplier: { select: { name: true } },
  lines: { select: { purchaseOrderId: true, purchaseOrder: { select: { poNumber: true } } } },
  payments: { select: { amount: true } },
} satisfies Prisma.BillSelect;

export const listBills = async (
  tx: TenantTransactionClient,
  filter: BillListFilter,
): Promise<{ rows: BillListRow[]; count: number; page: number; pages: number }> => {
  const where: Prisma.BillWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.order ? { lines: { some: { purchaseOrderId: filter.order } } } : {}),
  };
  const count = await tx.bill.count({ where });
  const pages = Math.max(1, Math.ceil(count / BILLS_PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const rows = await tx.bill.findMany({
    where,
    orderBy: [{ issuedOn: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    skip: (page - 1) * BILLS_PAGE_SIZE,
    take: BILLS_PAGE_SIZE,
    select: listSelect,
  });
  return {
    count,
    page,
    pages,
    rows: rows.map((b) => {
      const orders = new Map<string, string>();
      for (const l of b.lines) orders.set(l.purchaseOrderId, l.purchaseOrder.poNumber);
      return {
        id: b.id,
        vendor: vendorLabel(b),
        billType: b.billType,
        referenceNumber: b.referenceNumber,
        isCreditNote: b.isCreditNote,
        status: b.status,
        currency: b.currency,
        totalAmount: dec2(b.totalAmount),
        paidAmount: fixed2(sum(b.payments.map((p) => D(p.amount.toFixed(2))))),
        issuedOn: day(b.issuedOn),
        dueOn: dayOrNull(b.dueOn),
        orders: [...orders].map(([id, poNumber]) => ({ id, poNumber })),
        updatedAt: b.updatedAt.toISOString(),
      };
    }),
  };
};

/** Posted bills with a line on `purchaseOrderId` (the variance screen's input). */
export const listPostedBillsForOrder = (
  tx: TenantTransactionClient,
  purchaseOrderId: string,
): Promise<BillRecord[]> =>
  tx.bill.findMany({
    where: { status: { in: ['POSTED', 'PAID'] }, lines: { some: { purchaseOrderId } } },
    orderBy: [{ issuedOn: 'asc' }, { id: 'asc' }],
    select: billSelect,
  });

// ---------- writes ----------

export type BillWriteError =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'FROZEN'
  | 'ILLEGAL_TRANSITION'
  | 'SUPPLIER_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'REFERENCE_TAKEN'
  | 'NO_LINES'
  | 'NOT_BALANCED'
  | 'OVERPAID'
  | 'PAYMENT_NOT_FOUND';

export type BillWriteResult =
  | { ok: true; id: string; status: BillStatusValue }
  | {
      ok: false;
      error: BillWriteError;
      status?: BillStatusValue;
      /** Form field the problem belongs to, when there is one. */
      field?: string;
      /** Extra detail for the message (a PO number, two amounts) — never PII. */
      detail?: string;
    };

/** The database trigger / scope / unique errors as a friendly category; anything else is rethrown. */
export const billDbError = (err: unknown): BillWriteError | null => {
  if (err instanceof TenantScopeError && err.code === 'NOT_FOUND_IN_SCOPE') return 'NOT_FOUND';
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return 'NOT_FOUND';
    if (err.code === 'P2002') return 'REFERENCE_TAKEN';
    // Composite FK violated: a supplier / order / item outside this organisation (or an item of
    // another order). The scoped pre-checks answer first; this is the database backstop.
    if (err.code === 'P2003') return 'ORDER_NOT_FOUND';
  }
  const message = err instanceof Error ? err.message : '';
  if (/has no lines and cannot be posted/.test(message)) return 'NO_LINES';
  if (/cannot be posted/.test(message)) return 'NOT_BALANCED';
  if (/is not an allowed transition/.test(message)) return 'ILLEGAL_TRANSITION';
  if (/and posted;/.test(message)) return 'FROZEN';
  if (/cannot be deleted/.test(message)) return 'FROZEN';
  if (/append-only/.test(message)) return 'FROZEN';
  if (/is not posted; a payment/.test(message)) return 'WRONG_STATUS';
  return null;
};

export const BILL_FROZEN_MESSAGE =
  'This bill has been posted and can no longer be changed. Record a credit note if it was wrong.';

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
    targetType: 'Bill',
    targetId: id,
    metadata,
  });

const dec = (s: string): Prisma.Decimal => new Prisma.Decimal(s);
const dateOf = (yyyyMmDd: string): Date => new Date(`${yyyyMmDd}T00:00:00Z`);

/** Sum of the parsed line amounts, 2 dp, as a Decimal. */
export const linesTotal = (lines: ReadonlyArray<{ amount: string }>): string =>
  fixed2(sum(lines.map((l) => D(l.amount))));

type Refusal = Extract<BillWriteResult, { ok: false }>;

/** The supplier must exist here and (for a new bill) not be archived. */
const resolveSupplier = async (
  tx: TenantTransactionClient,
  input: BillFormInput,
  previousSupplierId: string | null,
): Promise<Refusal | null> => {
  if (input.supplierId === undefined) return null;
  const s = await tx.supplier.findUnique({
    where: { id: input.supplierId },
    select: { id: true, archivedAt: true },
  });
  if (!s || (s.archivedAt !== null && input.supplierId !== previousSupplierId)) {
    return { ok: false, error: 'SUPPLIER_NOT_FOUND', field: 'supplierId' };
  }
  return null;
};

/**
 * Every line's purchase order must be in THIS organisation (the scoped read returns nothing for
 * any other) and its item, when given, one of that order's. Cancelled drafts are refused: a bill
 * for goods never ordered has nothing to be measured against.
 */
const resolveLines = async (
  tx: TenantTransactionClient,
  input: BillFormInput,
  organizationId: string,
): Promise<Refusal | Omit<Prisma.BillLineCreateManyInput, 'billId'>[]> => {
  const orderIds = [...new Set(input.lines.map((l) => l.purchaseOrderId))];
  const orders = await tx.purchaseOrder.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true, items: { select: { id: true } } },
  });
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const [i, line] of input.lines.entries()) {
    const o = byId.get(line.purchaseOrderId);
    if (!o || o.status === 'CANCELLED') {
      return {
        ok: false,
        error: 'ORDER_NOT_FOUND',
        field: `line_${i}_purchaseOrderId`,
        ...(o ? { detail: 'That purchase order is cancelled.' } : {}),
      };
    }
    if (
      line.purchaseOrderItemId !== undefined &&
      !o.items.some((it) => it.id === line.purchaseOrderItemId)
    ) {
      return { ok: false, error: 'ITEM_NOT_FOUND', field: `line_${i}_purchaseOrderItemId` };
    }
  }
  return input.lines.map((line, i) => ({
    organizationId,
    position: i,
    costCategory: line.costCategory,
    unplannedReason: line.unplannedReason ?? null,
    description: line.description,
    amount: dec(line.amount),
    purchaseOrderId: line.purchaseOrderId,
    purchaseOrderItemId: line.purchaseOrderItemId ?? null,
  }));
};

const scalarData = (input: BillFormInput) => ({
  vendorType: input.vendorType,
  supplierId: input.supplierId ?? null,
  vendorName: input.vendorName ?? null,
  billType: input.billType,
  referenceNumber: input.referenceNumber,
  isCreditNote: input.isCreditNote,
  currency: input.currency,
  totalAmount: dec(input.totalAmount),
  issuedOn: dateOf(input.issuedOn),
  dueOn: input.dueOn === undefined ? null : dateOf(input.dueOn),
  notes: input.notes ?? null,
});

const auditShape = (input: BillFormInput) => ({
  vendorType: input.vendorType,
  billType: input.billType,
  currency: input.currency,
  isCreditNote: input.isCreditNote,
  lines: input.lines.length,
  orders: [...new Set(input.lines.map((l) => l.purchaseOrderId))],
});

/** Creates a DRAFT bill with its lines. Audit `bill.create`. */
export const createBill = async (
  tx: TenantTransactionClient,
  actor: Actor,
  input: BillFormInput,
): Promise<BillWriteResult> => {
  const supplierProblem = await resolveSupplier(tx, input, null);
  if (supplierProblem) return supplierProblem;
  const lines = await resolveLines(tx, input, actor.organizationId);
  if ('ok' in lines) return lines;
  let id: string;
  try {
    const created = await tx.bill.create({
      data: { organizationId: actor.organizationId, ...scalarData(input) },
      select: { id: true },
    });
    id = created.id;
    await tx.billLine.createMany({ data: lines.map((l) => ({ ...l, billId: id })) });
  } catch (err) {
    const mapped = billDbError(err);
    if (mapped) return refusal(mapped);
    throw err;
  }
  await audit(tx, actor, 'bill.create', id, auditShape(input));
  return { ok: true, id, status: 'DRAFT' };
};

const refusal = (error: BillWriteError, status?: BillStatusValue): Refusal =>
  error === 'REFERENCE_TAKEN'
    ? { ok: false, error, field: 'referenceNumber' }
    : { ok: false, error, ...(status ? { status } : {}) };

/** Replaces a DRAFT's scalars and lines. Refused for any other status (the trigger backs this up). */
export const updateBill = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  input: BillFormInput,
): Promise<BillWriteResult> => {
  const existing = await tx.bill.findUnique({
    where: { id },
    select: { status: true, supplierId: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (existing.status !== 'DRAFT') return { ok: false, error: 'FROZEN', status: existing.status };
  const supplierProblem = await resolveSupplier(tx, input, existing.supplierId);
  if (supplierProblem) return supplierProblem;
  const lines = await resolveLines(tx, input, actor.organizationId);
  if ('ok' in lines) return lines;
  try {
    await tx.billLine.deleteMany({ where: { billId: id } });
    await tx.bill.update({ where: { id }, data: scalarData(input), select: { id: true } });
    await tx.billLine.createMany({ data: lines.map((l) => ({ ...l, billId: id })) });
  } catch (err) {
    const mapped = billDbError(err);
    if (mapped) return refusal(mapped, existing.status);
    throw err;
  }
  await audit(tx, actor, 'bill.update', id, auditShape(input));
  return { ok: true, id, status: 'DRAFT' };
};

/**
 * DRAFT → POSTED: the bill becomes a financial record. Refused without lines or when the lines
 * do not add up to the total (checked here for a friendly message; the trigger is the backstop).
 * The caller has checked `bill.post`. Audit `bill.post`.
 */
export const postBill = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  now: Date,
): Promise<BillWriteResult> => {
  const row = await getBill(tx, id);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (row.status !== 'DRAFT') return { ok: false, error: 'WRONG_STATUS', status: row.status };
  if (row.lines.length === 0) return { ok: false, error: 'NO_LINES', status: row.status };
  const total = row.totalAmount.toFixed(2);
  const lines = linesTotal(row.lines.map((l) => ({ amount: l.amount.toFixed(2) })));
  if (lines !== total) {
    return {
      ok: false,
      error: 'NOT_BALANCED',
      status: row.status,
      detail: `The lines add up to ${lines} ${row.currency} but the bill total is ${total} ${row.currency}.`,
    };
  }
  try {
    await tx.bill.update({
      where: { id },
      data: { status: 'POSTED', postedAt: now },
      select: { id: true },
    });
  } catch (err) {
    const mapped = billDbError(err);
    if (mapped) return refusal(mapped, row.status);
    throw err;
  }
  await audit(tx, actor, 'bill.post', id, {
    from: 'DRAFT',
    to: 'POSTED',
    billType: row.billType,
    lines: row.lines.length,
    orders: [...new Set(row.lines.map((l) => l.purchaseOrderId))],
  });
  return { ok: true, id, status: 'POSTED' };
};

/** Deletes a DRAFT (lines cascade). Posted bills are never deleted. Audit `bill.delete`. */
export const deleteBill = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
): Promise<BillWriteResult> => {
  const existing = await tx.bill.findUnique({ where: { id }, select: { status: true } });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (existing.status !== 'DRAFT') return { ok: false, error: 'FROZEN', status: existing.status };
  try {
    await tx.bill.delete({ where: { id }, select: { id: true } });
  } catch (err) {
    const mapped = billDbError(err);
    if (mapped) return refusal(mapped, existing.status);
    throw err;
  }
  await audit(tx, actor, 'bill.delete', id, { from: 'DRAFT' });
  return { ok: true, id, status: 'DRAFT' };
};

/** POSTED when the payments fall short of the total, PAID once they cover it. */
const settle = async (
  tx: TenantTransactionClient,
  id: string,
): Promise<{ status: BillStatusValue; paidOn: Date | null }> => {
  const row = await tx.bill.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      totalAmount: true,
      payments: { select: { amount: true, paidOn: true }, orderBy: { paidOn: 'desc' } },
    },
  });
  const paid = sum(row.payments.map((p) => D(p.amount.toFixed(2))));
  const covered = paid.gte(D(row.totalAmount.toFixed(2)));
  const paidOn = covered ? (row.payments[0]?.paidOn ?? null) : null;
  const next: BillStatusValue = covered ? 'PAID' : 'POSTED';
  if (next !== row.status) {
    await tx.bill.update({
      where: { id },
      data: { status: next, paidAt: paidOn },
      select: { id: true },
    });
  }
  return { status: next, paidOn };
};

/**
 * Records a payment on a posted bill: date, amount in the bill currency and the rate the bank
 * applied (GBP per unit; forced to 1 for GBP bills). `amountGbp = round2(amount × rate)`. A
 * payment that would take the bill past its total is refused (`OVERPAID`). Moves the bill to PAID
 * when the payments cover the total. Audit `bill.payment` with the date only.
 */
export const recordBillPayment = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  input: PaymentFormInput,
): Promise<BillWriteResult> => {
  const existing = await tx.bill.findUnique({
    where: { id },
    select: {
      status: true,
      currency: true,
      totalAmount: true,
      payments: { select: { amount: true } },
    },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (existing.status === 'DRAFT') {
    return { ok: false, error: 'WRONG_STATUS', status: existing.status };
  }
  const paid = sum(existing.payments.map((p) => D(p.amount.toFixed(2))));
  const amount = D(input.amount);
  if (paid.plus(amount).gt(D(existing.totalAmount.toFixed(2)))) {
    return {
      ok: false,
      error: 'OVERPAID',
      status: existing.status,
      detail: `${fixed2(D(existing.totalAmount.toFixed(2)).minus(paid))} ${existing.currency} is outstanding.`,
    };
  }
  const fxRate = existing.currency === 'GBP' ? D('1') : D(input.fxRate);
  const amountGbp = round2(amount.times(fxRate));
  let paymentId: string;
  try {
    const created = await tx.billPayment.create({
      data: {
        organizationId: actor.organizationId,
        billId: id,
        paidOn: dateOf(input.paidOn),
        amount: dec(input.amount),
        fxRate: dec(fxRate.toString()),
        amountGbp: dec(fixed2(amountGbp)),
        reference: input.reference ?? null,
      },
      select: { id: true },
    });
    paymentId = created.id;
  } catch (err) {
    const mapped = billDbError(err);
    if (mapped) return refusal(mapped, existing.status);
    throw err;
  }
  const { status } = await settle(tx, id);
  await audit(tx, actor, 'bill.payment', id, {
    paymentId,
    paidOn: input.paidOn,
    currency: existing.currency,
    status,
  });
  return { ok: true, id, status };
};

/** Removes a payment (a keying mistake); the bill goes back to POSTED if it no longer covers the total. */
export const removeBillPayment = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  paymentId: string,
): Promise<BillWriteResult> => {
  const existing = await tx.bill.findUnique({ where: { id }, select: { status: true } });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  const removed = await tx.billPayment.deleteMany({ where: { id: paymentId, billId: id } });
  if (removed.count === 0) {
    return { ok: false, error: 'PAYMENT_NOT_FOUND', status: existing.status };
  }
  const { status } = await settle(tx, id);
  await audit(tx, actor, 'bill.payment_removed', id, { paymentId, status });
  return { ok: true, id, status };
};

/** Friendly copy for a failed write. */
export const billErrorMessage = (result: Refusal, verb = 'updated'): string => {
  switch (result.error) {
    case 'NOT_FOUND':
      return 'This bill no longer exists in your organisation.';
    case 'FROZEN':
      return BILL_FROZEN_MESSAGE;
    case 'WRONG_STATUS':
      return result.status === 'DRAFT'
        ? 'Post the bill first: payments are recorded against posted bills.'
        : `This bill is ${(result.status ?? 'in a state that').toLowerCase()} and cannot be ${verb}.`;
    case 'ILLEGAL_TRANSITION':
      return `This bill is ${(result.status ?? '').toLowerCase()}; that step is not available from here.`;
    case 'SUPPLIER_NOT_FOUND':
      return 'Choose a supplier from your list.';
    case 'ORDER_NOT_FOUND':
      return result.detail ?? 'Choose a purchase order from your list for every line.';
    case 'ITEM_NOT_FOUND':
      return 'Choose a line of that purchase order, or leave the product blank for a shared cost.';
    case 'REFERENCE_TAKEN':
      return 'A bill with that reference from this vendor already exists.';
    case 'NO_LINES':
      return 'Add at least one line before posting.';
    case 'NOT_BALANCED':
      return `${result.detail ?? 'The lines do not add up to the bill total.'} Adjust them so they agree, then post.`;
    case 'OVERPAID':
      return `That payment is more than is outstanding${result.detail ? `: ${result.detail}` : '.'}`;
    case 'PAYMENT_NOT_FOUND':
      return 'That payment is no longer on this bill.';
  }
};
