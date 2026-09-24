import { z } from 'zod';
import { ALL_COUNTRY_CODES } from '../data/countries-all';
import { INCOTERMS, parseLaneKey } from './calculator';
import {
  CURRENCIES,
  checkbox,
  decimalString,
  fieldErrors,
  hsCode,
  isoCountry,
  optionalField,
  positiveDecimalString,
  quantity,
} from './common';

/**
 * Quote builder, quotes list, quote actions and the Home quick duty check (M4, §5.6).
 *
 * The builder form is flat HTML so it works without JavaScript: line `i` is the group of fields
 * `line_<i>_productId`, `line_<i>_quantity`, `line_<i>_assistsGbp`, `line_<i>_preferenceClaimed`.
 * Money crosses this boundary as decimal STRINGS (ADR-0003); quantities are counts.
 */

export const MAX_QUOTE_LINES = 20;
const SANITY_MAX_MONEY = '100000000';

/** `CustomsProfile.paymentMethod` values (the Prisma enum, mirrored so the client can import). */
export const QUOTE_DUTY_PAYMENT_METHODS = [
  'BROKER_DEFERMENT',
  'OWN_DEFERMENT',
  'CDS_CASH_ACCOUNT',
] as const;
export type QuoteDutyPaymentMethod = (typeof QUOTE_DUTY_PAYMENT_METHODS)[number];

export const QUOTE_DUTY_PAYMENT_LABELS: Record<QuoteDutyPaymentMethod, string> = {
  BROKER_DEFERMENT: 'Through our forwarding partner (they pay HMRC and invoice you)',
  OWN_DEFERMENT: 'My own HMRC duty deferment account (DAN)',
  CDS_CASH_ACCOUNT: 'My pre-funded HMRC cash account',
};

/** Plain-English incoterm labels (UX spec "Quote builder"). */
export const INCOTERM_LABELS: Record<(typeof INCOTERMS)[number], string> = {
  EXW: 'EXW: I pay from the factory door',
  FCA: 'FCA: supplier hands over to my carrier at origin',
  FOB: 'FOB: supplier pays to the port',
  CFR: 'CFR: supplier pays freight to the UK port',
  CIF: 'CIF: supplier pays freight and insurance to the UK port',
  DAP: 'DAP: supplier delivers to my door, I clear customs',
  DPU: 'DPU: supplier delivers and unloads, I clear customs',
  DDP: 'DDP: supplier delivers duty paid (rarely clean into the UK)',
};

export const QUOTE_INTENTS = [
  'recalculate',
  'add-line',
  'remove-line',
  'apply-supplier',
  'save',
  'preview',
] as const;
export type QuoteIntent = (typeof QUOTE_INTENTS)[number];
export const quoteIntent = z.enum(QUOTE_INTENTS).catch('recalculate');

/** Same grammar as `UUID_RE` in @harbour/db. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = z.string().trim().regex(UUID_PATTERN, 'Choose an item from the list.');

const lineSchema = z.object({
  productId: uuidField,
  quantity,
  assistsGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  preferenceClaimed: checkbox,
});
export type QuoteLineInput = z.infer<typeof lineSchema>;

const baseShape = {
  /** Optional: pre-fills incoterm and origin port; the origin for duty is each product's. */
  supplierId: optionalField(uuidField),
  incoterm: z.enum(INCOTERMS, { error: 'Choose an incoterm.' }),
  /** `${origin}:${destination}:${mode}` from the rate-sheet lane list. */
  lane: z.string().trim().max(30),
  includeOriginFees: checkbox,
  supplierFreightTotalGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  supplierFreightUkGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  insurancePremiumGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  /** Manual FX override for ONE currency: GBP per 1 unit of `manualFxCurrency`. */
  manualFxCurrency: optionalField(z.enum(CURRENCIES, { error: 'Choose a supported currency.' })),
  manualFxRate: optionalField(positiveDecimalString({ dp: 6, max: '1000000' })),
  vatRegistered: checkbox,
  vatPostponed: checkbox,
  dutyPayment: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .enum(QUOTE_DUTY_PAYMENT_METHODS, { error: 'Choose how duty will be paid.' })
      .default('BROKER_DEFERMENT'),
  ),
  brokerFeePct: optionalField(decimalString({ dp: 4, max: '100' })),
  brokerMinimumGbp: optionalField(decimalString({ dp: 2, max: '100000' })),
  lines: z
    .array(lineSchema)
    .min(1, 'Add at least one product from the catalogue.')
    .max(MAX_QUOTE_LINES, `A quote can have at most ${MAX_QUOTE_LINES} lines.`),
};

const refineQuote = (v: z.infer<z.ZodObject<typeof baseShape>>, ctx: z.RefinementCtx): void => {
  if (v.supplierFreightUkGbp !== undefined && v.supplierFreightTotalGbp === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['supplierFreightTotalGbp'],
      message: 'Enter the supplier freight total as well as the UK portion.',
    });
  }
  if ((v.manualFxRate === undefined) !== (v.manualFxCurrency === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['manualFxRate'],
      message: 'Enter both the currency and the rate for a manual exchange rate, or neither.',
    });
  }
  if (v.manualFxCurrency === 'GBP') {
    ctx.addIssue({
      code: 'custom',
      path: ['manualFxCurrency'],
      message: 'GBP needs no exchange rate.',
    });
  }
  const seen = new Set<string>();
  v.lines.forEach((l, i) => {
    if (seen.has(l.productId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', i, 'productId'],
        message: 'This product is already on the quote; change its quantity instead.',
      });
    }
    seen.add(l.productId);
  });
};

/** Build the schema against the lanes the rate sheet actually offers (§5.6 UN/LOCODE allow-list). */
export const buildQuoteFormSchema = (allowedLanes: readonly string[]) => {
  const lanes = new Set(allowedLanes);
  return z
    .object({
      ...baseShape,
      lane: baseShape.lane.refine(
        (k) => parseLaneKey(k) !== null && lanes.has(k),
        'Choose a route from the list.',
      ),
    })
    .superRefine(refineQuote);
};

export type QuoteFormSchema = ReturnType<typeof buildQuoteFormSchema>;
export type QuoteFormInput = z.infer<QuoteFormSchema>;

/** Stored on `Quote.builderInput` (migration 0011) so a draft reopens as it was left. */
export const BUILDER_INPUT_VERSION = 1 as const;
export const builderInputSchema = z
  .object({ ...baseShape, version: z.literal(BUILDER_INPUT_VERSION) })
  .superRefine(refineQuote);
export type QuoteBuilderInput = z.infer<typeof builderInputSchema>;

export const toBuilderInput = (input: QuoteFormInput): QuoteBuilderInput => ({
  ...input,
  version: BUILDER_INPUT_VERSION,
});

// ---------- raw form values (echoed back so the form keeps state without JS) ----------

export const QUOTE_SCALAR_FIELDS = [
  'supplierId',
  'incoterm',
  'lane',
  'includeOriginFees',
  'supplierFreightTotalGbp',
  'supplierFreightUkGbp',
  'insurancePremiumGbp',
  'manualFxCurrency',
  'manualFxRate',
  'vatRegistered',
  'vatPostponed',
  'dutyPayment',
  'brokerFeePct',
  'brokerMinimumGbp',
  'addProductId',
  'addQuantity',
] as const;
export type QuoteScalarField = (typeof QUOTE_SCALAR_FIELDS)[number];

export const LINE_FIELDS = ['productId', 'quantity', 'assistsGbp', 'preferenceClaimed'] as const;
export type LineField = (typeof LINE_FIELDS)[number];
export type RawLine = Record<LineField, string>;

export interface QuoteFormValues {
  scalars: Record<string, string>;
  lines: RawLine[];
}

export const lineFieldName = (index: number, field: LineField): string => `line_${index}_${field}`;

const str = (form: FormData | null, name: string): string => {
  const v = form?.get(name);
  return typeof v === 'string' ? v.slice(0, 4096) : '';
};

/** Reads the flat builder form into scalars and the ordered, non-empty line groups. */
export const readQuoteForm = (form: FormData | null): QuoteFormValues => {
  const scalars: Record<string, string> = {};
  for (const name of QUOTE_SCALAR_FIELDS) scalars[name] = str(form, name);
  const lines: RawLine[] = [];
  for (let i = 0; i < MAX_QUOTE_LINES; i += 1) {
    const productId = str(form, lineFieldName(i, 'productId')).trim();
    if (productId === '') continue;
    lines.push({
      productId,
      quantity: str(form, lineFieldName(i, 'quantity')),
      assistsGbp: str(form, lineFieldName(i, 'assistsGbp')),
      preferenceClaimed: str(form, lineFieldName(i, 'preferenceClaimed')),
    });
  }
  return { scalars, lines };
};

/** The raw values as the zod input expects them (lines as objects). */
export const quoteFormCandidate = (values: QuoteFormValues): Record<string, unknown> => ({
  ...values.scalars,
  lines: values.lines.map((l) => ({ ...l })),
});

export const parseQuoteForm = (
  schema: QuoteFormSchema,
  values: QuoteFormValues,
): { ok: true; input: QuoteFormInput } | { ok: false; errors: Record<string, string> } => {
  const parsed = schema.safeParse(quoteFormCandidate(values));
  if (!parsed.success) return { ok: false, errors: quoteFieldErrors(parsed.error.issues) };
  return { ok: true, input: parsed.data };
};

/** Like `fieldErrors`, but `lines.3.quantity` becomes the input's name `line_3_quantity`. */
export const quoteFieldErrors = (issues: readonly z.core.$ZodIssue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors(issues))) {
    const m = /^lines\.(\d+)\.(\w+)$/.exec(key);
    const name = m ? `line_${m[1]}_${m[2]}` : key;
    if (!(name in out)) out[name] = message;
  }
  return out;
};

/** Builder input → raw form values (reopening a draft). */
export const builderInputToValues = (input: QuoteBuilderInput): QuoteFormValues => {
  const flag = (b: boolean): string => (b ? 'on' : '');
  return {
    scalars: {
      supplierId: input.supplierId ?? '',
      incoterm: input.incoterm,
      lane: input.lane,
      includeOriginFees: flag(input.includeOriginFees),
      supplierFreightTotalGbp: input.supplierFreightTotalGbp ?? '',
      supplierFreightUkGbp: input.supplierFreightUkGbp ?? '',
      insurancePremiumGbp: input.insurancePremiumGbp ?? '',
      manualFxCurrency: input.manualFxCurrency ?? '',
      manualFxRate: input.manualFxRate ?? '',
      vatRegistered: flag(input.vatRegistered),
      vatPostponed: flag(input.vatPostponed),
      dutyPayment: input.dutyPayment,
      brokerFeePct: input.brokerFeePct ?? '',
      brokerMinimumGbp: input.brokerMinimumGbp ?? '',
      addProductId: '',
      addQuantity: '',
    },
    lines: input.lines.map((l) => ({
      productId: l.productId,
      quantity: String(l.quantity),
      assistsGbp: l.assistsGbp ?? '',
      preferenceClaimed: flag(l.preferenceClaimed),
    })),
  };
};

/** The "Add from catalogue" row: a product and a quantity. */
export const addLineSchema = z.object({
  addProductId: uuidField,
  addQuantity: quantity,
});

// ---------- list, detail ----------

export const QUOTE_STATUSES = [
  'DRAFT',
  'INDICATIVE',
  'READY',
  'ACCEPTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type QuoteStatusValue = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatusValue, string> = {
  DRAFT: 'Draft',
  INDICATIVE: 'Indicative',
  READY: 'Ready',
  ACCEPTED: 'Accepted',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const QUOTES_PAGE_SIZE = 25;

export const quoteListSchema = z.object({
  status: z.enum(QUOTE_STATUSES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type QuoteListFilter = z.infer<typeof quoteListSchema>;

export const QUOTE_ACTIONS = ['accept', 'cancel', 'reopen', 'finalise', 'recompute'] as const;
export type QuoteAction = (typeof QUOTE_ACTIONS)[number];
export const quoteAction = z.enum(QUOTE_ACTIONS, { error: 'Unknown action.' });

/** Quote ids in URLs: a UUID or nothing (never passed to the database otherwise). */
export const quoteIdParam = z.string().regex(UUID_PATTERN);

// ---------- Home quick duty check ----------

export const quickDutySchema = z.object({
  hsCode,
  invoiceValueGbp: positiveDecimalString({ dp: 2, max: SANITY_MAX_MONEY }),
  originCountry: isoCountry.refine(
    (c) => ALL_COUNTRY_CODES.has(c),
    'Choose an origin country from the list.',
  ),
  preferenceClaimed: checkbox,
});
export type QuickDutyInput = z.infer<typeof quickDutySchema>;
export const QUICK_DUTY_FIELDS = [
  'hsCode',
  'invoiceValueGbp',
  'originCountry',
  'preferenceClaimed',
] as const;

/** `?notice=` values the list page understands after a redirect. */
export const QUOTE_NOTICES = [
  'saved',
  'accepted',
  'cancelled',
  'reopened',
  'finalised',
  'recomputed',
  'not-found',
] as const;
export const quoteNotice = z.enum(QUOTE_NOTICES).optional().catch(undefined);
