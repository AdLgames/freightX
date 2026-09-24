import { COST_CATEGORIES, type CostCategory, type UnplannedReason } from '@harbour/engine';
import { z } from 'zod';
import {
  CURRENCIES,
  checkbox,
  decimalString,
  fieldErrors,
  optionalField,
  safeString,
} from './common';
import { paidDateSchema } from './order';
import { UUID_PATTERN } from './quote';

/**
 * Bills — the accounts-payable sub-ledger (M8, ADR-0014, §3). The editor form is flat HTML so it
 * works without JavaScript: line `i` is the group `line_<i>_purchaseOrderId`,
 * `line_<i>_purchaseOrderItemId`, `line_<i>_costCategory`, `line_<i>_unplannedReason`,
 * `line_<i>_description`, `line_<i>_amount`. Money crosses this boundary as decimal STRINGS in
 * the bill currency (ADR-0003); the exchange rate actually paid travels with each payment.
 */

export const BILL_STATUSES = ['DRAFT', 'POSTED', 'PAID'] as const;
export type BillStatusValue = (typeof BILL_STATUSES)[number];

export const BILL_STATUS_LABELS: Record<BillStatusValue, string> = {
  DRAFT: 'Draft',
  POSTED: 'Posted',
  PAID: 'Paid',
};

/** Status → `.status-pill` modifier (styles.css, "M8"). */
export const BILL_STATUS_CLASS: Record<BillStatusValue, string> = {
  DRAFT: 'quote-draft',
  POSTED: 'bill-posted',
  PAID: 'quote-accepted',
};

export const VENDOR_TYPES = ['SUPPLIER', 'FORWARDER', 'CUSTOMS_BROKER', 'HMRC', 'OTHER'] as const;
export type VendorTypeValue = (typeof VENDOR_TYPES)[number];
export const VENDOR_TYPE_LABELS: Record<VendorTypeValue, string> = {
  SUPPLIER: 'Supplier (from your list)',
  FORWARDER: 'Freight forwarder',
  CUSTOMS_BROKER: 'Customs broker',
  HMRC: 'HMRC',
  OTHER: 'Other',
};

export const BILL_TYPES = [
  'SUPPLIER_INVOICE',
  'FREIGHT_INVOICE',
  'CUSTOMS_CHARGES',
  'CUSTOMS_STATEMENT',
  'OTHER',
] as const;
export type BillTypeValue = (typeof BILL_TYPES)[number];
export const BILL_TYPE_LABELS: Record<BillTypeValue, string> = {
  SUPPLIER_INVOICE: 'Supplier invoice',
  FREIGHT_INVOICE: 'Freight invoice',
  CUSTOMS_CHARGES: 'Customs charges (broker / forwarder)',
  CUSTOMS_STATEMENT: 'HMRC statement (C79, PVA, deferment)',
  OTHER: 'Other',
};

/** The bill type a vendor usually sends; pre-selected when the vendor type changes. */
export const DEFAULT_BILL_TYPE: Record<VendorTypeValue, BillTypeValue> = {
  SUPPLIER: 'SUPPLIER_INVOICE',
  FORWARDER: 'FREIGHT_INVOICE',
  CUSTOMS_BROKER: 'CUSTOMS_CHARGES',
  HMRC: 'CUSTOMS_STATEMENT',
  OTHER: 'OTHER',
};

/** The engine's categories, verbatim (one per stored quote total — ADR-0014). */
export { COST_CATEGORIES };
export type { CostCategory };
export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  GOODS: 'Goods',
  ASSISTS: 'Assists (tooling, moulds)',
  FREIGHT_TO_BORDER: 'Freight to the UK border',
  FREIGHT_POST_BORDER: 'Freight after the border (UK leg)',
  ORIGIN_FEES: 'Origin fees',
  DESTINATION_FEES: 'Destination fees',
  CLEARANCE: 'Customs clearance fee',
  INSURANCE: 'Insurance',
  DUTY: 'Import duty',
  IMPORT_VAT: 'Import VAT',
  DEFERMENT_FEE: 'Deferment / disbursement fee',
  UNPLANNED: 'Unplanned (demurrage, storage, examination…)',
  OTHER: 'Other',
};

export const UNPLANNED_REASONS = [
  'DEMURRAGE',
  'DETENTION',
  'STORAGE',
  'CUSTOMS_EXAMINATION',
  'OTHER',
] as const satisfies readonly UnplannedReason[];
export const UNPLANNED_REASON_LABELS: Record<UnplannedReason, string> = {
  DEMURRAGE: 'Demurrage (container held at the port)',
  DETENTION: 'Detention (container returned late)',
  STORAGE: 'Storage',
  CUSTOMS_EXAMINATION: 'Customs examination',
  OTHER: 'Other',
};

export const MAX_BILL_LINES = 100;
const SANITY_MAX_AMOUNT = '1000000000';

const uuidField = z.string().trim().regex(UUID_PATTERN, 'Choose an item from the list.');

/**
 * A line amount in the bill currency, 2 dp, and — unlike every other money field — allowed to be
 * negative: a discount or a rebate line on an invoice. The bill total itself may not be negative
 * (credit notes are flagged instead); the database CHECK and `billFormSchema` insist.
 */
export const signedAmount = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'Enter an amount with up to 2 decimal places.')
  .refine((s) => !/^-?0+(\.0+)?$/.test(s), 'Enter an amount other than zero.');

const dateField = paidDateSchema;

const lineSchema = z
  .object({
    purchaseOrderId: uuidField,
    purchaseOrderItemId: optionalField(uuidField),
    costCategory: z.enum(COST_CATEGORIES, { error: 'Choose a cost category.' }),
    unplannedReason: optionalField(
      z.enum(UNPLANNED_REASONS, { error: 'Choose why the cost arose.' }),
    ),
    description: safeString(200, 1),
    amount: signedAmount,
  })
  .superRefine((l, ctx) => {
    if (l.costCategory === 'UNPLANNED' && l.unplannedReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['unplannedReason'],
        message: 'Say why the unplanned cost arose.',
      });
    }
  })
  .transform((l) => ({
    ...l,
    // The database CHECK: a reason only with UNPLANNED.
    unplannedReason: l.costCategory === 'UNPLANNED' ? l.unplannedReason : undefined,
  }));
export type BillLineInput = z.infer<typeof lineSchema>;

export const billFormSchema = z
  .object({
    vendorType: z.enum(VENDOR_TYPES, { error: 'Choose who sent the bill.' }),
    supplierId: optionalField(uuidField),
    vendorName: optionalField(safeString(200)),
    billType: z.enum(BILL_TYPES, { error: 'Choose the kind of bill.' }),
    referenceNumber: safeString(64, 1),
    isCreditNote: checkbox,
    currency: z.enum(CURRENCIES, { error: 'Choose a currency.' }),
    totalAmount: decimalString({ dp: 2, max: SANITY_MAX_AMOUNT }),
    issuedOn: dateField,
    dueOn: optionalField(dateField),
    notes: optionalField(safeString(2000)),
    lines: z
      .array(lineSchema)
      .min(1, 'Add at least one line and say which purchase order it belongs to.')
      .max(MAX_BILL_LINES, `A bill can have at most ${MAX_BILL_LINES} lines.`),
  })
  .superRefine((v, ctx) => {
    if (v.vendorType === 'SUPPLIER' && v.supplierId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['supplierId'],
        message: 'Choose the supplier this bill is from.',
      });
    }
    if (v.vendorType !== 'SUPPLIER' && v.vendorName === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['vendorName'],
        message: 'Enter the name of the company that sent the bill.',
      });
    }
    if (v.dueOn !== undefined && v.dueOn < v.issuedOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueOn'],
        message: 'The due date cannot be before the issue date.',
      });
    }
  })
  .transform((v) => ({
    ...v,
    // A supplier bill names the supplier row, every other vendor a name (CHECK bills_vendor_identified).
    supplierId: v.vendorType === 'SUPPLIER' ? v.supplierId : undefined,
    vendorName: v.vendorType === 'SUPPLIER' ? undefined : v.vendorName,
  }));
export type BillFormInput = z.infer<typeof billFormSchema>;

export const BILL_INTENTS = ['recalculate', 'add-line', 'remove-line', 'save'] as const;
export type BillIntent = (typeof BILL_INTENTS)[number];

// ---------- raw form values (echoed back so the form keeps state without JS) ----------

export const BILL_SCALAR_FIELDS = [
  'vendorType',
  'supplierId',
  'vendorName',
  'billType',
  'referenceNumber',
  'isCreditNote',
  'currency',
  'totalAmount',
  'issuedOn',
  'dueOn',
  'notes',
] as const;
export type BillScalarField = (typeof BILL_SCALAR_FIELDS)[number];

export const BILL_LINE_FIELDS = [
  'purchaseOrderId',
  'purchaseOrderItemId',
  'costCategory',
  'unplannedReason',
  'description',
  'amount',
] as const;
export type BillLineField = (typeof BILL_LINE_FIELDS)[number];
export type RawBillLine = Record<BillLineField, string>;

export interface BillFormValues {
  scalars: Record<string, string>;
  lines: RawBillLine[];
}

export const lineFieldName = (index: number, field: BillLineField): string =>
  `line_${index}_${field}`;

const str = (form: FormData | null, name: string): string => {
  const v = form?.get(name);
  return typeof v === 'string' ? v.slice(0, 4096) : '';
};

export const emptyLine = (purchaseOrderId = ''): RawBillLine => ({
  purchaseOrderId,
  purchaseOrderItemId: '',
  costCategory: '',
  unplannedReason: '',
  description: '',
  amount: '',
});

/**
 * Reads the flat editor form into scalars and the ordered line groups. A line group counts when
 * any of its fields is filled (an untouched blank row added by "Add line" is kept so the user
 * can fill it in; `parseBillForm` reports its missing fields).
 */
export const readBillForm = (form: FormData | null): BillFormValues => {
  const scalars: Record<string, string> = {};
  for (const name of BILL_SCALAR_FIELDS) scalars[name] = str(form, name);
  const lines: RawBillLine[] = [];
  for (let i = 0; i < MAX_BILL_LINES; i += 1) {
    const present = form?.has(lineFieldName(i, 'description')) ?? false;
    if (!present) continue;
    const line = emptyLine();
    for (const f of BILL_LINE_FIELDS) line[f] = str(form, lineFieldName(i, f));
    lines.push(line);
  }
  return { scalars, lines };
};

export const parseBillForm = (
  values: BillFormValues,
): { ok: true; input: BillFormInput } | { ok: false; errors: Record<string, string> } => {
  const parsed = billFormSchema.safeParse({
    ...values.scalars,
    lines: values.lines.map((l) => ({ ...l })),
  });
  if (!parsed.success) return { ok: false, errors: billFieldErrors(parsed.error.issues) };
  return { ok: true, input: parsed.data };
};

/** Like `fieldErrors`, but `lines.3.amount` becomes the input's name `line_3_amount`. */
export const billFieldErrors = (issues: readonly z.core.$ZodIssue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors(issues))) {
    const m = /^lines\.(\d+)\.(\w+)$/.exec(key);
    const name = m ? `line_${m[1]}_${m[2]}` : key;
    if (!(name in out)) out[name] = message;
  }
  return out;
};

// ---------- detail actions ----------

export const BILL_ACTIONS = ['post', 'delete', 'record-payment', 'remove-payment'] as const;
export type BillAction = (typeof BILL_ACTIONS)[number];
export const billAction = z.enum(BILL_ACTIONS, { error: 'Unknown action.' });

/**
 * A payment: the date, the amount in the bill currency and the exchange rate the bank actually
 * applied (GBP per 1 unit of the bill currency; 1 for GBP bills — the form forces it). The GBP
 * amount is computed, never typed, so the ledger and the bank statement can be reconciled.
 */
export const paymentFormSchema = z.object({
  paidOn: dateField,
  amount: decimalString({ dp: 2, max: SANITY_MAX_AMOUNT, exclusiveMin: true }),
  fxRate: decimalString({ dp: 6, max: '100000', exclusiveMin: true }),
  reference: optionalField(safeString(120)),
});
export type PaymentFormInput = z.infer<typeof paymentFormSchema>;

export const removePaymentSchema = z.object({ paymentId: uuidField });

// ---------- list, detail ----------

export const BILLS_PAGE_SIZE = 25;

export const billListSchema = z.object({
  status: z.enum(BILL_STATUSES).optional().catch(undefined),
  /** Bills with a line on this purchase order. */
  order: z.string().regex(UUID_PATTERN).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type BillListFilter = z.infer<typeof billListSchema>;

/** Bill ids in URLs: a UUID or nothing (never passed to the database otherwise). */
export const billIdParam = z.string().regex(UUID_PATTERN);

/** `?notice=` values the pages understand after a redirect. */
export const BILL_NOTICES = [
  'created',
  'saved',
  'posted',
  'deleted',
  'payment-recorded',
  'payment-removed',
  'not-found',
] as const;
export const billNotice = z.enum(BILL_NOTICES).optional().catch(undefined);
