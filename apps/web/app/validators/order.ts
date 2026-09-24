import { z } from 'zod';
import { INCOTERMS } from './calculator';
import {
  CURRENCIES,
  decimalString,
  fieldErrors,
  optionalField,
  quantity,
  safeString,
} from './common';
import { UUID_PATTERN } from './quote';

/**
 * Purchase orders (M7, ADR-0013, §5.6). The editor form is flat HTML so it works without
 * JavaScript: item `i` is the group `item_<i>_productId`, `item_<i>_quantity`,
 * `item_<i>_unitCost`. Money crosses this boundary as decimal STRINGS in the PO currency
 * (ADR-0003); quantities are counts.
 */

export const ORDER_STATUSES = [
  'DRAFT',
  'ISSUED',
  'IN_PRODUCTION',
  'READY_TO_SHIP',
  'SHIPPED',
  'CLOSED',
  'CANCELLED',
] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatusValue, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  IN_PRODUCTION: 'In production',
  READY_TO_SHIP: 'Ready to ship',
  SHIPPED: 'Shipped',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/** Status → `.status-pill` modifier (styles.css, "M7"). */
export const ORDER_STATUS_CLASS: Record<OrderStatusValue, string> = {
  DRAFT: 'quote-draft',
  ISSUED: 'order-issued',
  IN_PRODUCTION: 'order-production',
  READY_TO_SHIP: 'order-ready',
  SHIPPED: 'order-shipped',
  CLOSED: 'quote-accepted',
  CANCELLED: 'quote-muted',
};

/** Statuses a PO can move to from each status (ADR-0013 table, mirrored by the 0012 trigger). */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatusValue, readonly OrderStatusValue[]>> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['IN_PRODUCTION', 'READY_TO_SHIP', 'CANCELLED'],
  IN_PRODUCTION: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export const canTransition = (from: OrderStatusValue, to: OrderStatusValue): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

/** Statuses with money still moving: payments are shown as due, quotes may be requested. */
export const OPEN_STATUSES: readonly OrderStatusValue[] = [
  'ISSUED',
  'IN_PRODUCTION',
  'READY_TO_SHIP',
  'SHIPPED',
];

export const MAX_ORDER_ITEMS = 50;
const SANITY_MAX_UNIT_COST = '100000000';

const uuidField = z.string().trim().regex(UUID_PATTERN, 'Choose an item from the list.');

/** `YYYY-MM` from `<input type="month">`; stored as the first of that month (UTC). */
export const SHIP_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const shipMonth = z
  .string()
  .trim()
  .regex(SHIP_MONTH_PATTERN, 'Enter a month as YYYY-MM.')
  .refine((s) => {
    const year = Number(s.slice(0, 4));
    return year >= 2000 && year <= 2100;
  }, 'Enter a year between 2000 and 2100.');

/** First day of the month, midnight UTC, for a validated `YYYY-MM`. */
export const shipMonthToDate = (yyyyMm: string): Date => {
  const m = SHIP_MONTH_PATTERN.exec(yyyyMm);
  if (!m) throw new RangeError('shipMonth must be YYYY-MM');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
};

/** `YYYY-MM` of a stored first-of-month date. */
export const dateToShipMonth = (d: Date): string => d.toISOString().slice(0, 7);

export const PO_NUMBER_PATTERN = /^PO-\d{4}-\d{3,}$/;

const itemSchema = z.object({
  productId: uuidField,
  quantity,
  unitCost: decimalString({ dp: 4, max: SANITY_MAX_UNIT_COST }),
});
export type OrderItemInput = z.infer<typeof itemSchema>;

export const orderFormSchema = z
  .object({
    supplierId: uuidField,
    pickupLocationId: optionalField(uuidField),
    currency: z.enum(CURRENCIES, { error: 'Choose a currency.' }),
    incoterm: z.enum(INCOTERMS, { error: 'Choose an incoterm.' }),
    expectedShipMonth: optionalField(shipMonth),
    notes: optionalField(safeString(2000)),
    /** Editable while DRAFT (ADR-0013); blank keeps the generated number. */
    poNumber: optionalField(
      z.string().trim().toUpperCase().regex(PO_NUMBER_PATTERN, 'Use the form PO-2026-001.'),
    ),
    items: z
      .array(itemSchema)
      .min(1, 'Add at least one product from the catalogue.')
      .max(MAX_ORDER_ITEMS, `An order can have at most ${MAX_ORDER_ITEMS} lines.`),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((l, i) => {
      if (seen.has(l.productId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'productId'],
          message: 'This product is already on the order; change its quantity instead.',
        });
      }
      seen.add(l.productId);
    });
  });
export type OrderFormInput = z.infer<typeof orderFormSchema>;

export const ORDER_INTENTS = [
  'recalculate',
  'add-item',
  'remove-item',
  'apply-supplier',
  'save',
] as const;
export type OrderIntent = (typeof ORDER_INTENTS)[number];

// ---------- raw form values (echoed back so the form keeps state without JS) ----------

export const ORDER_SCALAR_FIELDS = [
  'supplierId',
  'pickupLocationId',
  'currency',
  'incoterm',
  'expectedShipMonth',
  'notes',
  'poNumber',
  'addProductId',
  'addQuantity',
] as const;
export type OrderScalarField = (typeof ORDER_SCALAR_FIELDS)[number];

export const ITEM_FIELDS = ['productId', 'quantity', 'unitCost'] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];
export type RawItem = Record<ItemField, string>;

export interface OrderFormValues {
  scalars: Record<string, string>;
  items: RawItem[];
}

export const itemFieldName = (index: number, field: ItemField): string => `item_${index}_${field}`;

const str = (form: FormData | null, name: string): string => {
  const v = form?.get(name);
  return typeof v === 'string' ? v.slice(0, 4096) : '';
};

/** Reads the flat editor form into scalars and the ordered, non-empty item groups. */
export const readOrderForm = (form: FormData | null): OrderFormValues => {
  const scalars: Record<string, string> = {};
  for (const name of ORDER_SCALAR_FIELDS) scalars[name] = str(form, name);
  const items: RawItem[] = [];
  for (let i = 0; i < MAX_ORDER_ITEMS; i += 1) {
    const productId = str(form, itemFieldName(i, 'productId')).trim();
    if (productId === '') continue;
    items.push({
      productId,
      quantity: str(form, itemFieldName(i, 'quantity')),
      unitCost: str(form, itemFieldName(i, 'unitCost')),
    });
  }
  return { scalars, items };
};

export const parseOrderForm = (
  values: OrderFormValues,
): { ok: true; input: OrderFormInput } | { ok: false; errors: Record<string, string> } => {
  const parsed = orderFormSchema.safeParse({
    ...values.scalars,
    items: values.items.map((l) => ({ ...l })),
  });
  if (!parsed.success) return { ok: false, errors: orderFieldErrors(parsed.error.issues) };
  return { ok: true, input: parsed.data };
};

/** Like `fieldErrors`, but `items.3.quantity` becomes the input's name `item_3_quantity`. */
export const orderFieldErrors = (issues: readonly z.core.$ZodIssue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors(issues))) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(key);
    const name = m ? `item_${m[1]}_${m[2]}` : key;
    if (!(name in out)) out[name] = message;
  }
  return out;
};

/** The "Add from catalogue" row: a product and a quantity (the unit cost defaults from the product). */
export const addItemSchema = z.object({
  addProductId: uuidField,
  addQuantity: quantity,
});

// ---------- detail actions ----------

export const ORDER_ACTIONS = [
  'issue',
  'in-production',
  'ready-to-ship',
  'shipped',
  'close',
  'cancel',
  'deposit-paid',
  'balance-paid',
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
export const orderAction = z.enum(ORDER_ACTIONS, { error: 'Unknown action.' });

/** Status moves per action (issue is separate: it also freezes and computes the schedule). */
export const ACTION_TARGET: Readonly<
  Record<
    Exclude<OrderAction, 'issue' | 'cancel' | 'deposit-paid' | 'balance-paid'>,
    Exclude<OrderStatusValue, 'DRAFT' | 'ISSUED' | 'CANCELLED'>
  >
> = {
  'in-production': 'IN_PRODUCTION',
  'ready-to-ship': 'READY_TO_SHIP',
  shipped: 'SHIPPED',
  close: 'CLOSED',
};

/** `YYYY-MM-DD` from `<input type="date">`, as a real calendar date (UTC midnight). */
export const paidDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date paid as YYYY-MM-DD.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Enter a real calendar date.')
  .refine((s) => s >= '2000-01-01', 'Enter a date after 2000.');

export const paymentFormSchema = z.object({ paidAt: paidDateSchema });

export const PAYMENT_KINDS = ['DEPOSIT', 'BALANCE'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

// ---------- list, detail ----------

export const ORDERS_PAGE_SIZE = 25;

export const orderListSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type OrderListFilter = z.infer<typeof orderListSchema>;

/** Order ids in URLs: a UUID or nothing (never passed to the database otherwise). */
export const orderIdParam = z.string().regex(UUID_PATTERN);

/** `?notice=` values the pages understand after a redirect. */
export const ORDER_NOTICES = [
  'created',
  'saved',
  'issued',
  'status',
  'cancelled',
  'deposit-paid',
  'balance-paid',
  'not-found',
] as const;
export const orderNotice = z.enum(ORDER_NOTICES).optional().catch(undefined);
