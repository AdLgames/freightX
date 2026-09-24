import { can } from '@harbour/db';
import { data } from 'react-router';
import {
  addLineSchema,
  buildQuoteFormSchema,
  parseQuoteForm,
  quoteFieldErrors,
  readQuoteForm,
  type QuoteFormInput,
  type QuoteFormValues,
  type QuoteIntent,
  type RawLine,
} from '../../validators/quote';
import { getApp } from '../app.server';
import { withOrg, type OrgContext } from '../auth.server';
import { planAllows, type PlanName } from '../billing/plan';
import { currentPlan } from '../billing/plan.server';
import { productSelect, type ProductRecord } from '../catalogue/products.server';
import type { LaneOption } from '../freight.server';
import { requestLogger } from '../logger.server';
import type { RateLimitPolicy } from '../rate-limit.server';
import { readCustomsProfile } from '../settings/customs-profile.server';
import { runCatalogueQuote, type CatalogueOutcome } from './pipeline.server';
import { countSavedQuotes } from './quotes.server';
import type { QuoteView } from './view';

/**
 * Shared server logic of the quote builder routes (`/app/quotes/new`, `/app/quotes/:id/edit`, M4):
 * the option lists, the defaults from the organisation and its customs profile, the no-JS intents
 * (add/remove a line, apply supplier defaults, recalculate), the rate-limited preview and the plan
 * gate on save. The routes only decide whether to create or replace a row.
 */

/** §7.5: 60 requests per minute per user on quote endpoints (preview, recalculate, save). */
export const QUOTE_LIMIT: RateLimitPolicy = { name: 'quote', capacity: 60, windowMs: 60 * 1000 };

export interface SupplierOption {
  id: string;
  name: string;
  defaultIncoterm: string | null;
  defaultCurrency: string | null;
  /** UN/LOCODE of the default pickup location, when one exists. */
  defaultPort: string | null;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  supplierId: string | null;
  hsCode: string;
  hsVerified: boolean;
  hsDescription: string | null;
  originCountry: string;
  unitValue: string;
  currency: string;
  weightKg: string;
  volumeCbm: string;
  archived: boolean;
}

export interface BuilderDefaults {
  vatRegistered: boolean;
  vatPostponed: boolean;
  dutyPayment: string;
  brokerFeePct: string;
  brokerMinimumGbp: string;
  /** Broker terms came from env defaults, not the customs profile. */
  feeTermsFromConfig: boolean;
}

export interface BuilderOptions {
  suppliers: SupplierOption[];
  products: ProductOption[];
  lanes: LaneOption[];
  defaults: BuilderDefaults;
  rateSheet: { version: string; placeholder: boolean };
  calcVersion: string;
}

const toProductOption = (p: ProductRecord): ProductOption => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  supplierId: p.supplierId,
  hsCode: p.hsCode,
  hsVerified: p.hsCodeVerifiedAt !== null,
  hsDescription: p.hsDescription,
  originCountry: p.originCountry,
  unitValue: p.unitValue.toFixed(4),
  currency: p.currency,
  weightKg: p.weightKg.toFixed(3),
  volumeCbm: p.volumeCbm.toFixed(4),
  archived: p.archivedAt !== null,
});

/**
 * Everything the builder page needs. `includeProductIds` keeps archived products that an existing
 * draft still references selectable (a snapshot may keep quoting them; new lines cannot add them).
 */
export const loadBuilderOptions = async (
  ctx: OrgContext,
  includeProductIds: readonly string[] = [],
): Promise<{ options: BuilderOptions; products: ProductRecord[] }> => {
  const app = await getApp();
  const { suppliers, products, profile } = await withOrg(ctx, async (tx) => {
    const [suppliers, products, profile] = await Promise.all([
      tx.supplier.findMany({
        where: { archivedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          defaultIncoterm: true,
          defaultCurrency: true,
          pickupLocations: {
            where: { isDefault: true },
            select: { closestPortCode: true },
            take: 1,
          },
        },
      }),
      tx.product.findMany({
        where: {
          OR: [
            { archivedAt: null },
            ...(includeProductIds.length ? [{ id: { in: [...includeProductIds] } }] : []),
          ],
        },
        orderBy: [{ sku: 'asc' }, { id: 'asc' }],
        select: productSelect,
      }),
      readCustomsProfile(tx, ctx.org.id),
    ]);
    return { suppliers, products, profile };
  });
  const envTerms = app.pricing.brokerDefermentDefaults;
  const profileTerms =
    profile.brokerDefermentFeePct !== null || profile.brokerDefermentMinimumGbp !== null;
  return {
    products,
    options: {
      suppliers: suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        defaultIncoterm: s.defaultIncoterm,
        defaultCurrency: s.defaultCurrency,
        defaultPort: s.pickupLocations[0]?.closestPortCode ?? null,
      })),
      products: products.map(toProductOption),
      lanes: app.lanes,
      defaults: {
        vatRegistered: profile.vatRegistered,
        vatPostponed: profile.usePva,
        dutyPayment: profile.paymentMethod,
        brokerFeePct: profileTerms
          ? (profile.brokerDefermentFeePct ?? '')
          : (envTerms.feePct ?? ''),
        brokerMinimumGbp: profileTerms
          ? (profile.brokerDefermentMinimumGbp ?? '')
          : (envTerms.minimumGbp ?? ''),
        feeTermsFromConfig:
          !profileTerms && (envTerms.feePct !== null || envTerms.minimumGbp !== null),
      },
      rateSheet: { version: app.rateSheet.version, placeholder: app.rateSheet.placeholder },
      calcVersion: app.calcVersion,
    },
  };
};

/** A blank form with the organisation's defaults (optionally pre-set to a supplier). */
export const defaultValues = (
  options: BuilderOptions,
  supplierId: string | null = null,
): QuoteFormValues => {
  const d = options.defaults;
  const values: QuoteFormValues = {
    scalars: {
      supplierId: '',
      incoterm: 'FOB',
      lane: options.lanes[0]?.key ?? '',
      includeOriginFees: '',
      supplierFreightTotalGbp: '',
      supplierFreightUkGbp: '',
      insurancePremiumGbp: '',
      manualFxCurrency: '',
      manualFxRate: '',
      vatRegistered: d.vatRegistered ? 'on' : '',
      vatPostponed: d.vatPostponed ? 'on' : '',
      dutyPayment: d.dutyPayment,
      brokerFeePct: d.brokerFeePct,
      brokerMinimumGbp: d.brokerMinimumGbp,
      addProductId: '',
      addQuantity: '',
      purchaseOrderId: '', // M7
    },
    lines: [],
  };
  const supplier = options.suppliers.find((s) => s.id === supplierId);
  return supplier ? applySupplierDefaults(values, supplier, options.lanes) : values;
};

/** Incoterm and origin port from the supplier (its default pickup location's closest port). */
export const applySupplierDefaults = (
  values: QuoteFormValues,
  supplier: SupplierOption,
  lanes: readonly LaneOption[],
): QuoteFormValues => {
  const scalars: Record<string, string> = { ...values.scalars, supplierId: supplier.id };
  if (supplier.defaultIncoterm) scalars.incoterm = supplier.defaultIncoterm;
  if (supplier.defaultPort) {
    const current = lanes.find((l) => l.key === scalars.lane);
    const lane =
      lanes.find(
        (l) =>
          l.origin === supplier.defaultPort &&
          (!current || (l.mode === current.mode && l.destination === current.destination)),
      ) ?? lanes.find((l) => l.origin === supplier.defaultPort);
    if (lane) scalars.lane = lane.key;
  }
  return { scalars, lines: values.lines };
};

export const addLine = (
  values: QuoteFormValues,
): { values: QuoteFormValues; errors: Record<string, string> } => {
  const parsed = addLineSchema.safeParse({
    addProductId: values.scalars.addProductId,
    addQuantity: values.scalars.addQuantity,
  });
  if (!parsed.success) return { values, errors: quoteFieldErrors(parsed.error.issues) };
  const existing = values.lines.findIndex((l) => l.productId === parsed.data.addProductId);
  const lines: RawLine[] = values.lines.map((l) => ({ ...l }));
  if (existing >= 0) {
    // Same product again: add to its quantity rather than duplicating the line.
    const was = Number(lines[existing]!.quantity) || 0;
    lines[existing]!.quantity = String(was + parsed.data.addQuantity);
  } else {
    lines.push({
      productId: parsed.data.addProductId,
      quantity: String(parsed.data.addQuantity),
      assistsGbp: '',
      preferenceClaimed: '',
    });
  }
  return {
    values: { scalars: { ...values.scalars, addProductId: '', addQuantity: '' }, lines },
    errors: {},
  };
};

export const removeLine = (values: QuoteFormValues, index: number): QuoteFormValues => ({
  scalars: values.scalars,
  lines: values.lines.filter((_, i) => i !== index),
});

// ---------- action plumbing ----------

export interface PlanNoticeData {
  feature: 'savedQuotes';
  requiredPlan: PlanName;
  canManageBilling: boolean;
}

export interface BuilderActionData {
  values: QuoteFormValues;
  errors: Record<string, string>;
  /** A non-field problem shown above the form. */
  formError: string | null;
  view: QuoteView | null;
  planNotice: PlanNoticeData | null;
}

export const builderReply = (
  partial: Partial<BuilderActionData> & { values: QuoteFormValues },
  status = 200,
) =>
  data<BuilderActionData>(
    { errors: {}, formError: null, view: null, planNotice: null, ...partial },
    { status },
  );

/** Which intent a submission carries; a "Remove" button (`removeLine=<i>`) wins over the field. */
export const readIntent = (
  form: FormData | null,
  url: URL,
): { intent: QuoteIntent; index: number } => {
  if (url.searchParams.get('preview') === '1') return { intent: 'preview', index: -1 };
  const remove = form?.get('removeLine');
  if (typeof remove === 'string' && /^\d{1,2}$/.test(remove)) {
    return { intent: 'remove-line', index: Number(remove) };
  }
  const raw = form?.get('intent');
  const intents: readonly string[] = [
    'recalculate',
    'add-line',
    'apply-supplier',
    'save',
    'preview',
  ];
  const intent =
    typeof raw === 'string' && intents.includes(raw) ? (raw as QuoteIntent) : 'recalculate';
  return { intent, index: -1 };
};

/** Parses and computes; on validation failure returns the errors, never a 500. */
export const computeFromValues = async (
  ctx: OrgContext,
  values: QuoteFormValues,
  products: readonly ProductRecord[],
  lanes: readonly LaneOption[],
): Promise<
  | { ok: true; input: QuoteFormInput; outcome: Extract<CatalogueOutcome, { kind: 'QUOTE' }> }
  | { ok: false; errors: Record<string, string>; formError: string }
> => {
  const schema = buildQuoteFormSchema(lanes.map((l) => l.key));
  const parsed = parseQuoteForm(schema, values);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors,
      formError: parsed.errors.lines ?? 'Check the highlighted fields and try again.',
    };
  }
  const app = await getApp();
  const outcome = await runCatalogueQuote(parsed.input, products, {
    tariff: app.tariff,
    fxStore: app.stores.fxStore,
    freight: app.freight,
    pricing: app.pricing,
  });
  if (outcome.kind === 'FAILED') {
    return {
      ok: false,
      errors: outcome.field ? { [outcome.field]: outcome.message } : {},
      formError: outcome.message,
    };
  }
  return { ok: true, input: parsed.input, outcome };
};

/** One rate-limit token per quote request; `null` when allowed, else the 429 reply. */
export const quoteRateLimit = async (
  ctx: OrgContext,
  request: Request,
  values: QuoteFormValues,
) => {
  const app = await getApp();
  const decision = await app.rateLimiter.consume(ctx.user.id, QUOTE_LIMIT);
  if (decision.allowed) return null;
  requestLogger(app.logger, request).info('quote.rate_limited', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
  });
  return data<BuilderActionData>(
    {
      values,
      errors: {},
      formError: `Too many quote calculations in the last minute. Try again in ${decision.retryAfterSeconds} seconds.`,
      view: null,
      planNotice: null,
    },
    { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
  );
};

/**
 * FREE plan: 3 saved quotes (PLAN_LIMITS.savedQuotes). Drafts, indicative, ready and accepted
 * quotes count; cancelled and expired do not. Returns the notice to render, or null when allowed.
 */
export const savedQuotePlanNotice = async (ctx: OrgContext): Promise<PlanNoticeData | null> => {
  const [plan, count] = await Promise.all([
    currentPlan(ctx),
    withOrg(ctx, (tx) => countSavedQuotes(tx)),
  ]);
  if (planAllows(plan, 'savedQuotes', count)) return null;
  return {
    feature: 'savedQuotes',
    requiredPlan: 'STARTER',
    canManageBilling: can(ctx.role, 'billing.manage'),
  };
};

/** Reads the form and applies the structural intents; the caller computes/saves afterwards. */
export const applyIntent = (
  form: FormData | null,
  url: URL,
  options: BuilderOptions,
): { intent: QuoteIntent; values: QuoteFormValues; errors: Record<string, string> } => {
  const { intent, index } = readIntent(form, url);
  let values = readQuoteForm(form);
  let errors: Record<string, string> = {};
  if (intent === 'add-line') ({ values, errors } = addLine(values));
  if (intent === 'remove-line') values = removeLine(values, index);
  if (intent === 'apply-supplier') {
    const supplier = options.suppliers.find((s) => s.id === values.scalars.supplierId);
    if (supplier) values = applySupplierDefaults(values, supplier, options.lanes);
  }
  return { intent, values, errors };
};
