import { data } from 'react-router';
import {
  DEFAULT_BILL_TYPE,
  emptyLine,
  readBillForm,
  type BillFormValues,
  type BillIntent,
  type VendorTypeValue,
} from '../../validators/bill';
import { withOrg, type OrgContext } from '../auth.server';

/**
 * Shared server logic of the bill editor routes (`/app/bills/new`, `/app/bills/:id/edit`, M8):
 * the option lists (suppliers, purchase orders and their lines), the no-JS intents (add or
 * remove a line, recalculate) and the running total shown next to the form. The routes only
 * decide whether to create or replace a row. No JavaScript is needed: every button is a submit.
 */

export interface BillSupplierOption {
  id: string;
  name: string;
  defaultCurrency: string | null;
  archived: boolean;
}

export interface BillOrderOption {
  id: string;
  poNumber: string;
  status: string;
  currency: string;
  supplierName: string;
  items: Array<{ id: string; sku: string; name: string }>;
}

export interface BillEditorOptions {
  suppliers: BillSupplierOption[];
  orders: BillOrderOption[];
}

/**
 * Everything the editor page needs. `include` keeps the archived supplier / cancelled orders an
 * existing draft still references selectable (new lines cannot add them).
 */
export const loadBillEditorOptions = async (
  ctx: OrgContext,
  include: { supplierId?: string | null; orderIds?: readonly string[] } = {},
): Promise<BillEditorOptions> => {
  const orderIds = include.orderIds ?? [];
  const { suppliers, orders } = await withOrg(ctx, async (tx) => {
    const [suppliers, orders] = await Promise.all([
      tx.supplier.findMany({
        where: {
          OR: [{ archivedAt: null }, ...(include.supplierId ? [{ id: include.supplierId }] : [])],
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, defaultCurrency: true, archivedAt: true },
      }),
      tx.purchaseOrder.findMany({
        where: {
          OR: [
            { status: { not: 'CANCELLED' } },
            ...(orderIds.length ? [{ id: { in: [...orderIds] } }] : []),
          ],
        },
        orderBy: [{ poNumber: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          poNumber: true,
          status: true,
          currency: true,
          supplier: { select: { name: true } },
          items: {
            select: { id: true, sku: true, name: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
        },
      }),
    ]);
    return { suppliers, orders };
  });
  return {
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      defaultCurrency: s.defaultCurrency,
      archived: s.archivedAt !== null,
    })),
    orders: orders.map((o) => ({
      id: o.id,
      poNumber: o.poNumber,
      status: o.status,
      currency: o.currency,
      supplierName: o.supplier.name,
      items: o.items,
    })),
  };
};

/** A blank form, optionally started from a purchase order (`?order=<id>`). */
export const defaultBillValues = (
  options: BillEditorOptions,
  orderId: string | null = null,
  today: string,
): BillFormValues => {
  const order = options.orders.find((o) => o.id === orderId) ?? null;
  const supplier = order
    ? (options.suppliers.find((s) => s.name === order.supplierName) ?? null)
    : null;
  const vendorType: VendorTypeValue = order ? 'SUPPLIER' : 'FORWARDER';
  return {
    scalars: {
      vendorType,
      supplierId: supplier?.id ?? '',
      vendorName: '',
      billType: DEFAULT_BILL_TYPE[vendorType],
      referenceNumber: '',
      isCreditNote: '',
      currency: order?.currency ?? 'GBP',
      totalAmount: '',
      issuedOn: today,
      dueOn: '',
      notes: '',
    },
    lines: order ? [{ ...emptyLine(order.id), costCategory: 'GOODS' }] : [emptyLine()],
  };
};

/** "Add line": a blank row, defaulting to the purchase order of the previous line. */
export const addLine = (values: BillFormValues): BillFormValues => ({
  scalars: values.scalars,
  lines: [...values.lines, emptyLine(values.lines.at(-1)?.purchaseOrderId ?? '')],
});

export const removeLine = (values: BillFormValues, index: number): BillFormValues => ({
  scalars: values.scalars,
  lines: values.lines.filter((_, i) => i !== index),
});

/** Which intent a submission carries; a "Remove" button (`removeLine=<i>`) wins over the field. */
export const readBillIntent = (form: FormData | null): { intent: BillIntent; index: number } => {
  const remove = form?.get('removeLine');
  if (typeof remove === 'string' && /^\d{1,3}$/.test(remove)) {
    return { intent: 'remove-line', index: Number(remove) };
  }
  const raw = form?.get('intent');
  const intents: readonly string[] = ['recalculate', 'add-line', 'save'];
  return {
    intent: typeof raw === 'string' && intents.includes(raw) ? (raw as BillIntent) : 'recalculate',
    index: -1,
  };
};

/** Reads the form and applies the structural intents; the caller validates/saves afterwards. */
export const applyBillIntent = (
  form: FormData | null,
): { intent: BillIntent; values: BillFormValues } => {
  const { intent, index } = readBillIntent(form);
  let values = readBillForm(form);
  if (intent === 'add-line') values = addLine(values);
  if (intent === 'remove-line') values = removeLine(values, index);
  return { intent, values };
};

export interface BillEditorActionData {
  values: BillFormValues;
  errors: Record<string, string>;
  /** A non-field problem shown above the form. */
  formError: string | null;
}

export const billEditorReply = (
  partial: Partial<BillEditorActionData> & { values: BillFormValues },
  status = 200,
) => data<BillEditorActionData>({ errors: {}, formError: null, ...partial }, { status });
