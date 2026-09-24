import {
  Prisma,
  TenantScopeError,
  recordAudit,
  type QuoteStatus,
  type TenantTransactionClient,
} from '@harbour/db';
import type { LineResult, QuoteResult, QuoteWarning, SpecificDuty } from '@harbour/engine';
import {
  QUOTES_PAGE_SIZE,
  builderInputSchema,
  type QuoteBuilderInput,
  type QuoteListFilter,
  type QuoteStatusValue,
} from '../../validators/quote';
import type { Actor } from '../catalogue/products.server';
import { COUNTED_STATUSES, quoteReference, type QuoteListRow, type QuoteView } from './view';

/**
 * Quote persistence (M4). A `QuoteResult` from the engine is written column-for-column onto
 * `Quote` and `QuoteLine` (§4); every money field is a decimal string in and a decimal string
 * out (`quoteRowToView` is the inverse of `quoteData`, tested for an exact round trip). Lines
 * snapshot the product's HS code, origin, value, currency, weight and volume — the product row
 * is referenced only so the catalogue label can be shown.
 *
 * Status (§5.9): the builder saves DRAFT; `finaliseQuote` stores the engine's READY/INDICATIVE;
 * `acceptQuote` (permission `quote.accept`) is allowed only from READY and after it the
 * database trigger (migration 0002) refuses every change except status → CANCELLED/EXPIRED,
 * which `quoteDbError` turns into a friendly message. Audit rows carry ids and statuses only.
 */

export const quoteLineSelect = {
  id: true,
  productId: true,
  quantity: true,
  hsCode: true,
  originCountry: true,
  unitValue: true,
  currency: true,
  unitValueGbp: true,
  lineGoodsValueGbp: true,
  lineWeightKg: true,
  lineVolumeCbm: true,
  chargeableWeight: true,
  tariffMeasureId: true,
  dutyType: true,
  dutyRatePct: true,
  dutySpecific: true,
  preferenceClaimed: true,
  addRatePct: true,
  vatRatePct: true,
  allocatedFreightGbp: true,
  allocatedFreightToBorderGbp: true,
  allocatedFreightPostBorderGbp: true,
  allocatedOriginFeesGbp: true,
  allocatedDestinationFeesGbp: true,
  allocatedInsuranceGbp: true,
  allocatedPlatformFeeGbp: true,
  assistsGbp: true,
  allocatedFinancingFeeGbp: true,
  allocatedInlandVatAdjustmentGbp: true,
  lineCustomsValueGbp: true,
  lineDutyGbp: true,
  lineVatGbp: true,
  supplierBorneDutyGbp: true,
  supplierBorneVatGbp: true,
  lineLandedCostExVatGbp: true,
  lineLandedCostGbp: true,
  landedCostPerUnit: true,
  landedCostPerUnitIncVat: true,
  product: {
    select: {
      sku: true,
      name: true,
      hsDescription: true,
      hsCodeVerifiedAt: true,
      archivedAt: true,
    },
  },
} satisfies Prisma.QuoteLineSelect;

export const quoteSelect = {
  id: true,
  status: true,
  incoterm: true,
  mode: true,
  originCountry: true,
  originPort: true,
  destinationPort: true,
  fxRate: true,
  fxSource: true,
  fxDate: true,
  fxSnapshots: true,
  rateSource: true,
  rateFetchedAt: true,
  validUntil: true,
  goodsValueGbp: true,
  freightCost: true,
  freightToBorderGbp: true,
  freightPostBorderGbp: true,
  originFees: true,
  destinationFees: true,
  insurancePremium: true,
  customsValue: true,
  totalDuty: true,
  totalVat: true,
  vatRecoverable: true,
  platformFee: true,
  totalLandedCost: true,
  totalLandedCostExVat: true,
  supplierBorneDuty: true,
  supplierBorneVat: true,
  apportionmentBasis: true,
  vatPostponed: true,
  borderOutlay: true,
  assistsGbp: true,
  financingFee: true,
  inlandVatAdjustment: true,
  paymentMethod: true,
  builderInput: true,
  warnings: true,
  calcVersion: true,
  acceptedAt: true,
  createdAt: true,
  updatedAt: true,
  lines: { select: quoteLineSelect, orderBy: { id: 'asc' } },
  // M7
  purchaseOrderId: true,
  purchaseOrder: { select: { poNumber: true, status: true } },
} satisfies Prisma.QuoteSelect;

export type QuoteRecord = Prisma.QuoteGetPayload<{ select: typeof quoteSelect }>;
export type QuoteLineRecord = Prisma.QuoteLineGetPayload<{ select: typeof quoteLineSelect }>;

// ---------- QuoteResult → row ----------

const dec = (s: string): Prisma.Decimal => new Prisma.Decimal(s);
const decOrNull = (s: string | null): Prisma.Decimal | null => (s === null ? null : dec(s));
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

const lineData = (
  l: LineResult,
  quoteId: string,
  organizationId: string,
): Prisma.QuoteLineCreateManyInput => ({
  quoteId,
  organizationId,
  productId: l.ref,
  quantity: l.quantity,
  hsCode: l.hsCode,
  originCountry: l.originCountry,
  unitValue: dec(l.unitValue),
  currency: l.currency,
  unitValueGbp: dec(l.unitValueGbp),
  lineGoodsValueGbp: dec(l.lineGoodsValueGbp),
  lineWeightKg: dec(l.lineWeightKg),
  lineVolumeCbm: dec(l.lineVolumeCbm),
  chargeableWeight: dec(l.chargeableWeight),
  tariffMeasureId: l.tariffMeasureId,
  dutyType: l.dutyType,
  dutyRatePct: decOrNull(l.dutyRatePct),
  dutySpecific: l.dutySpecific === null ? Prisma.JsonNull : json(l.dutySpecific),
  preferenceClaimed: l.preferenceClaimed,
  addRatePct: decOrNull(l.addRatePct),
  vatRatePct: dec(l.vatRatePct),
  allocatedFreightGbp: dec(l.allocatedFreightGbp),
  allocatedFreightToBorderGbp: dec(l.allocatedFreightToBorderGbp),
  allocatedFreightPostBorderGbp: dec(l.allocatedFreightPostBorderGbp),
  allocatedOriginFeesGbp: dec(l.allocatedOriginFeesGbp),
  allocatedDestinationFeesGbp: dec(l.allocatedDestinationFeesGbp),
  allocatedInsuranceGbp: dec(l.allocatedInsuranceGbp),
  allocatedPlatformFeeGbp: dec(l.allocatedPlatformFeeGbp),
  assistsGbp: dec(l.assistsGbp),
  allocatedFinancingFeeGbp: dec(l.allocatedFinancingFeeGbp),
  allocatedInlandVatAdjustmentGbp: dec(l.allocatedInlandVatAdjustmentGbp),
  lineCustomsValueGbp: dec(l.lineCustomsValueGbp),
  lineDutyGbp: dec(l.lineDutyGbp),
  lineVatGbp: dec(l.lineVatGbp),
  supplierBorneDutyGbp: dec(l.supplierBorneDutyGbp),
  supplierBorneVatGbp: dec(l.supplierBorneVatGbp),
  lineLandedCostExVatGbp: dec(l.lineLandedCostExVatGbp),
  lineLandedCostGbp: dec(l.lineLandedCostGbp),
  landedCostPerUnit: dec(l.landedCostPerUnit),
  landedCostPerUnitIncVat: dec(l.landedCostPerUnitIncVat),
});

export interface QuoteWrite {
  view: QuoteView;
  builderInput: QuoteBuilderInput;
  status: QuoteStatusValue;
}

/** Every engine field → its column. `originCountry` is the quote-level one the engine echoes. */
export const quoteData = (w: QuoteWrite, originCountry: string) => {
  const q = w.view.quote;
  const t = q.totals;
  return {
    status: w.status,
    incoterm: q.incoterm,
    mode: q.mode,
    originCountry,
    originPort: w.builderInput.lane.split(':')[0] ?? null,
    destinationPort: w.builderInput.lane.split(':')[1] ?? null,
    fxRate: dec(q.fxRate),
    fxSource: q.fxSource,
    fxDate: new Date(q.fxDate),
    fxSnapshots: json(q.fxSnapshots),
    rateSource: q.rateSource,
    rateFetchedAt: new Date(q.rateFetchedAt),
    validUntil: new Date(q.validUntil),
    goodsValueGbp: dec(t.goodsValueGbp),
    freightCost: dec(t.freightCost),
    freightToBorderGbp: dec(t.freightToBorderGbp),
    freightPostBorderGbp: dec(t.freightPostBorderGbp),
    originFees: dec(t.originFees),
    destinationFees: dec(t.destinationFees),
    insurancePremium: dec(t.insurancePremium),
    customsValue: dec(t.customsValue),
    totalDuty: dec(t.totalDuty),
    totalVat: dec(t.totalVat),
    vatRecoverable: t.vatRecoverable,
    platformFee: dec(t.platformFee),
    totalLandedCost: dec(t.totalLandedCost),
    totalLandedCostExVat: dec(t.totalLandedCostExVat),
    supplierBorneDuty: dec(t.supplierBorneDuty),
    supplierBorneVat: dec(t.supplierBorneVat),
    apportionmentBasis: q.apportionmentBasis,
    vatPostponed: t.vatPostponed,
    borderOutlay: dec(t.borderOutlay),
    assistsGbp: dec(t.assistsGbp),
    financingFee: dec(t.financingFee),
    inlandVatAdjustment: dec(t.inlandVatAdjustment),
    paymentMethod: w.view.dutyPayment.method,
    builderInput: json(w.builderInput),
    warnings: json(q.warnings),
    calcVersion: q.calcVersion,
    purchaseOrderId: w.builderInput.purchaseOrderId ?? null, // M7: composite FK keeps it in-tenant
  };
};

// ---------- row → QuoteResult ----------

const fixed = (d: Prisma.Decimal, dp: number): string => d.toFixed(dp);
const fixedOrNull = (d: Prisma.Decimal | null, dp: number): string | null =>
  d === null ? null : d.toFixed(dp);

const lineFromRow = (l: QuoteLineRecord): LineResult => ({
  ref: l.productId,
  hsCode: l.hsCode,
  originCountry: l.originCountry,
  quantity: l.quantity,
  unitValue: fixed(l.unitValue, 4),
  currency: l.currency,
  unitValueGbp: fixed(l.unitValueGbp, 4),
  lineGoodsValueGbp: fixed(l.lineGoodsValueGbp, 2),
  lineWeightKg: fixed(l.lineWeightKg, 3),
  lineVolumeCbm: fixed(l.lineVolumeCbm, 4),
  chargeableWeight: fixed(l.chargeableWeight, 4),
  tariffMeasureId: l.tariffMeasureId,
  dutyType: l.dutyType as LineResult['dutyType'],
  dutyRatePct: fixedOrNull(l.dutyRatePct, 4),
  dutySpecific: (l.dutySpecific as SpecificDuty | null) ?? null,
  preferenceClaimed: l.preferenceClaimed,
  addRatePct: fixedOrNull(l.addRatePct, 4),
  vatRatePct: fixed(l.vatRatePct, 2),
  allocatedFreightGbp: fixed(l.allocatedFreightGbp, 2),
  allocatedFreightToBorderGbp: fixed(l.allocatedFreightToBorderGbp, 2),
  allocatedFreightPostBorderGbp: fixed(l.allocatedFreightPostBorderGbp, 2),
  allocatedOriginFeesGbp: fixed(l.allocatedOriginFeesGbp, 2),
  allocatedDestinationFeesGbp: fixed(l.allocatedDestinationFeesGbp, 2),
  allocatedInsuranceGbp: fixed(l.allocatedInsuranceGbp, 2),
  allocatedPlatformFeeGbp: fixed(l.allocatedPlatformFeeGbp, 2),
  assistsGbp: fixed(l.assistsGbp, 2),
  allocatedFinancingFeeGbp: fixed(l.allocatedFinancingFeeGbp, 2),
  allocatedInlandVatAdjustmentGbp: fixed(l.allocatedInlandVatAdjustmentGbp, 2),
  lineCustomsValueGbp: fixed(l.lineCustomsValueGbp, 2),
  lineDutyGbp: fixed(l.lineDutyGbp, 2),
  lineVatGbp: fixed(l.lineVatGbp, 2),
  supplierBorneDutyGbp: fixed(l.supplierBorneDutyGbp, 2),
  supplierBorneVatGbp: fixed(l.supplierBorneVatGbp, 2),
  lineLandedCostExVatGbp: fixed(l.lineLandedCostExVatGbp, 2),
  lineLandedCostGbp: fixed(l.lineLandedCostGbp, 2),
  landedCostPerUnit: fixed(l.landedCostPerUnit, 4),
  landedCostPerUnitIncVat: fixed(l.landedCostPerUnitIncVat, 4),
});

/** ISO date (`YYYY-MM-DD`) when the stored instant is midnight UTC, else the full instant. */
const isoDateOrInstant = (d: Date): string => {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
};

/**
 * Lines in the order the builder listed them. `quote_lines` has no position column: the stored
 * builder input (one line per product) gives the order; rows without it fall back to id order.
 */
export const orderedLines = (row: QuoteRecord): QuoteLineRecord[] => {
  const input = builderInputSchema.safeParse(row.builderInput);
  if (!input.success) return row.lines;
  const position = new Map(input.data.lines.map((l, i) => [l.productId, i]));
  return [...row.lines].sort(
    (a, b) =>
      (position.get(a.productId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.productId) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );
};

export const quoteRowToResult = (row: QuoteRecord): QuoteResult => {
  return {
    calcVersion: row.calcVersion,
    // ACCEPTED quotes were READY when accepted; other rows report their stored blocking state.
    status:
      row.status === 'READY' || row.status === 'ACCEPTED'
        ? 'READY'
        : row.status === 'INDICATIVE'
          ? 'INDICATIVE'
          : computedStatus(row),
    warnings: (row.warnings as QuoteWarning[] | null) ?? [],
    incoterm: row.incoterm,
    mode: row.mode,
    apportionmentBasis: row.apportionmentBasis as QuoteResult['apportionmentBasis'],
    fxRate: row.fxRate.toString(),
    fxSource: row.fxSource as QuoteResult['fxSource'],
    fxDate: isoDateOrInstant(row.fxDate),
    fxSnapshots: (row.fxSnapshots as QuoteResult['fxSnapshots'] | null) ?? {},
    rateSource: row.rateSource,
    rateFetchedAt: row.rateFetchedAt.toISOString(),
    validUntil: row.validUntil.toISOString(),
    totals: {
      goodsValueGbp: fixed(row.goodsValueGbp, 2),
      freightCost: fixed(row.freightCost, 2),
      freightToBorderGbp: fixed(row.freightToBorderGbp, 2),
      freightPostBorderGbp: fixed(row.freightPostBorderGbp, 2),
      originFees: fixed(row.originFees, 2),
      destinationFees: fixed(row.destinationFees, 2),
      insurancePremium: fixed(row.insurancePremium, 2),
      customsValue: fixed(row.customsValue, 2),
      totalDuty: fixed(row.totalDuty, 2),
      totalVat: fixed(row.totalVat, 2),
      vatRecoverable: row.vatRecoverable,
      vatPostponed: row.vatPostponed,
      borderOutlay: fixed(row.borderOutlay, 2),
      assistsGbp: fixed(row.assistsGbp, 2),
      financingFee: fixed(row.financingFee, 2),
      inlandVatAdjustment: fixed(row.inlandVatAdjustment, 2),
      platformFee: fixed(row.platformFee, 2),
      totalLandedCostExVat: fixed(row.totalLandedCostExVat, 2),
      totalLandedCost: fixed(row.totalLandedCost, 2),
      supplierBorneDuty: fixed(row.supplierBorneDuty, 2),
      supplierBorneVat: fixed(row.supplierBorneVat, 2),
    },
    lines: orderedLines(row).map(lineFromRow),
  };
};

/** A draft's computed state: READY unless any stored warning blocks (§5.9). */
const computedStatus = (row: QuoteRecord): 'READY' | 'INDICATIVE' => {
  const warnings = (row.warnings as QuoteWarning[] | null) ?? [];
  return warnings.some((w) => w.blocking) ? 'INDICATIVE' : 'READY';
};

/** Parses the stored builder input; null when absent or from an unknown version. */
export const builderInputOf = (row: QuoteRecord): QuoteBuilderInput | null => {
  const parsed = builderInputSchema.safeParse(row.builderInput);
  return parsed.success ? parsed.data : null;
};

export const quoteRowToView = (row: QuoteRecord): QuoteView => {
  const input = builderInputOf(row);
  const method = row.paymentMethod ?? input?.dutyPayment ?? 'BROKER_DEFERMENT';
  const hasFee = !row.financingFee.isZero();
  const terms =
    method === 'BROKER_DEFERMENT' && input && (input.brokerFeePct || input.brokerMinimumGbp)
      ? {
          feePct: input.brokerFeePct ?? '0',
          minimumGbp: input.brokerMinimumGbp ?? '0',
          usedDefaults: false,
        }
      : hasFee
        ? { feePct: '0', minimumGbp: fixed(row.financingFee, 2), usedDefaults: true }
        : null;
  let weight = new Prisma.Decimal(0);
  let volume = new Prisma.Decimal(0);
  for (const l of row.lines) {
    weight = weight.plus(l.lineWeightKg);
    volume = volume.plus(l.lineVolumeCbm);
  }
  return {
    quote: quoteRowToResult(row),
    lines: orderedLines(row).map((l) => ({
      ref: l.productId,
      productId: l.productId,
      sku: l.product.sku,
      name: l.product.name,
      hsDescription: l.product.hsDescription,
      hsVerified: l.product.hsCodeVerifiedAt !== null,
      archived: l.product.archivedAt !== null,
    })),
    dutyPayment: { method, brokerFeeTerms: terms },
    freight: { transitDays: null, assumptions: [] },
    shipment: { totalWeightKg: weight.toFixed(3), totalVolumeCbm: volume.toFixed(4) },
    stages: [],
  };
};

// ---------- reads ----------

export const getQuote = (tx: TenantTransactionClient, id: string): Promise<QuoteRecord | null> =>
  tx.quote.findUnique({ where: { id }, select: quoteSelect });

const listSelect = {
  id: true,
  status: true,
  incoterm: true,
  mode: true,
  originPort: true,
  destinationPort: true,
  originCountry: true,
  totalLandedCostExVat: true,
  totalLandedCost: true,
  validUntil: true,
  updatedAt: true,
  lines: { select: { landedCostPerUnit: true }, orderBy: { id: 'asc' } },
} satisfies Prisma.QuoteSelect;

export const listQuotes = async (
  tx: TenantTransactionClient,
  filter: QuoteListFilter,
): Promise<{ rows: QuoteListRow[]; count: number; page: number; pages: number }> => {
  const where = filter.status ? { status: filter.status } : {};
  const count = await tx.quote.count({ where });
  const pages = Math.max(1, Math.ceil(count / QUOTES_PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const rows = await tx.quote.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    skip: (page - 1) * QUOTES_PAGE_SIZE,
    take: QUOTES_PAGE_SIZE,
    select: listSelect,
  });
  return {
    count,
    page,
    pages,
    rows: rows.map((q) => ({
      id: q.id,
      reference: quoteReference(q.id),
      status: q.status,
      incoterm: q.incoterm,
      mode: q.mode,
      originPort: q.originPort,
      destinationPort: q.destinationPort,
      originCountry: q.originCountry,
      lineCount: q.lines.length,
      landedCostPerUnit:
        q.lines.length === 1 ? (q.lines[0]?.landedCostPerUnit.toFixed(4) ?? null) : null,
      totalLandedCostExVat: q.totalLandedCostExVat.toFixed(2),
      totalLandedCost: q.totalLandedCost.toFixed(2),
      validUntil: q.validUntil.toISOString(),
      updatedAt: q.updatedAt.toISOString(),
    })),
  };
};

/** Quotes that count towards `PLAN_LIMITS.savedQuotes`: everything but CANCELLED and EXPIRED. */
export const countSavedQuotes = (tx: TenantTransactionClient): Promise<number> =>
  tx.quote.count({ where: { status: { in: [...COUNTED_STATUSES] as QuoteStatus[] } } });

// ---------- writes ----------

export type QuoteWriteError = 'NOT_FOUND' | 'IMMUTABLE' | 'WRONG_STATUS' | 'PO_QUOTE_ACCEPTED'; // M7: the purchase order already has an accepted quote
export type QuoteWriteResult =
  | { ok: true; id: string; status: QuoteStatusValue }
  | { ok: false; error: QuoteWriteError; status?: QuoteStatusValue };

/** The database trigger / scope errors as a friendly category; anything else is rethrown. */
export const quoteDbError = (err: unknown): QuoteWriteError | null => {
  if (err instanceof TenantScopeError && err.code === 'NOT_FOUND_IN_SCOPE') return 'NOT_FOUND';
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    return 'NOT_FOUND';
  }
  // M7: the only unique index an UPDATE of quotes can violate is quotes_one_accepted_per_po.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return 'PO_QUOTE_ACCEPTED';
  }
  const message = err instanceof Error ? err.message : '';
  if (/ACCEPTED and immutable/.test(message)) return 'IMMUTABLE';
  return null;
};

export const QUOTE_IMMUTABLE_MESSAGE =
  'This quote has been accepted and can no longer be changed. Cancel it and create a new quote if the shipment has changed.';

// M7
export const QUOTE_PO_ACCEPTED_MESSAGE =
  'This purchase order already has an accepted quote. Cancel that quote first if this one should replace it.';

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
    targetType: 'Quote',
    targetId: id,
    metadata,
  });

/** Creates a quote and its lines from a computed result. Audit `quote.create`. */
export const saveQuote = async (
  tx: TenantTransactionClient,
  actor: Actor,
  write: QuoteWrite,
): Promise<QuoteWriteResult> => {
  const originCountry = write.view.quote.lines[0]?.originCountry ?? 'XX';
  const created = await tx.quote.create({
    data: { organizationId: actor.organizationId, ...quoteData(write, originCountry) },
    select: { id: true },
  });
  await tx.quoteLine.createMany({
    data: write.view.quote.lines.map((l) => lineData(l, created.id, actor.organizationId)),
  });
  await audit(tx, actor, 'quote.create', created.id, {
    status: write.status,
    computedStatus: write.view.quote.status,
    lines: write.view.quote.lines.length,
    calcVersion: write.view.quote.calcVersion,
  });
  return { ok: true, id: created.id, status: write.status };
};

/**
 * Replaces a DRAFT's figures and lines with a fresh computation (edit, "update to current
 * catalogue values", finalise). Refused for any other status; the trigger backs this up for
 * ACCEPTED rows. Audit `quote.update` with the status transition.
 */
export const replaceQuote = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  write: QuoteWrite,
  opts: { from: readonly QuoteStatusValue[] },
): Promise<QuoteWriteResult> => {
  const existing = await tx.quote.findUnique({ where: { id }, select: { status: true } });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (existing.status === 'ACCEPTED') return { ok: false, error: 'IMMUTABLE', status: 'ACCEPTED' };
  if (!opts.from.includes(existing.status)) {
    return { ok: false, error: 'WRONG_STATUS', status: existing.status };
  }
  const originCountry = write.view.quote.lines[0]?.originCountry ?? 'XX';
  try {
    await tx.quoteLine.deleteMany({ where: { quoteId: id } });
    await tx.quote.update({
      where: { id },
      data: quoteData(write, originCountry),
      select: { id: true },
    });
    await tx.quoteLine.createMany({
      data: write.view.quote.lines.map((l) => lineData(l, id, actor.organizationId)),
    });
  } catch (err) {
    const mapped = quoteDbError(err);
    if (mapped) return { ok: false, error: mapped, status: existing.status };
    throw err;
  }
  await audit(tx, actor, 'quote.update', id, {
    from: existing.status,
    to: write.status,
    computedStatus: write.view.quote.status,
    lines: write.view.quote.lines.length,
    calcVersion: write.view.quote.calcVersion,
  });
  return { ok: true, id, status: write.status };
};

const transition = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  opts: {
    from: readonly QuoteStatusValue[];
    to: QuoteStatusValue;
    action: string;
    extra?: Record<string, Date | null>;
  },
): Promise<QuoteWriteResult> => {
  const existing = await tx.quote.findUnique({ where: { id }, select: { status: true } });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (!opts.from.includes(existing.status)) {
    return {
      ok: false,
      error: existing.status === 'ACCEPTED' ? 'IMMUTABLE' : 'WRONG_STATUS',
      status: existing.status,
    };
  }
  try {
    await tx.quote.update({
      where: { id },
      data: { status: opts.to, ...(opts.extra ?? {}) },
      select: { id: true },
    });
  } catch (err) {
    const mapped = quoteDbError(err);
    if (mapped) return { ok: false, error: mapped, status: existing.status };
    throw err;
  }
  await audit(tx, actor, opts.action, id, { from: existing.status, to: opts.to });
  return { ok: true, id, status: opts.to };
};

/** READY → ACCEPTED (§5.9). The caller has checked `quote.accept`. */
export const acceptQuote = (tx: TenantTransactionClient, actor: Actor, id: string, now: Date) =>
  transition(tx, actor, id, {
    from: ['READY'],
    to: 'ACCEPTED',
    action: 'quote.accept',
    extra: { acceptedAt: now },
  });

/** Any live status → CANCELLED; the trigger allows ACCEPTED → CANCELLED. */
export const cancelQuote = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  transition(tx, actor, id, {
    from: ['DRAFT', 'INDICATIVE', 'READY', 'ACCEPTED'],
    to: 'CANCELLED',
    action: 'quote.cancel',
  });

/** INDICATIVE/READY → DRAFT so the builder can edit it again. */
export const reopenQuote = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  transition(tx, actor, id, {
    from: ['INDICATIVE', 'READY'],
    to: 'DRAFT',
    action: 'quote.update',
  });
