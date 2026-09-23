import type { DecimalInput } from './money.js';
import type { QuoteWarning } from './warnings.js';

export type Incoterm = 'EXW' | 'FCA' | 'FOB' | 'CFR' | 'CIF' | 'DAP' | 'DPU' | 'DDP';
export type Mode = 'SEA_LCL' | 'SEA_FCL' | 'AIR' | 'ROAD' | 'RAIL';
export type ComputedStatus = 'INDICATIVE' | 'READY';
export type DutyType = 'AD_VALOREM' | 'SPECIFIC' | 'COMPOUND' | 'NONE';
export type FxSource = 'HMRC_MONTHLY' | 'ECB' | 'MANUAL';
export type ApportionmentBasis = 'SEA_WEIGHT_OR_MEASURE' | 'AIR_VOLUMETRIC_6000';

/**
 * A tariff measure as normalised by the tariff adapter from the UK Trade Tariff API
 * (`/api/v2/commodities/{code}` → `included[type=measure]`). The engine never sees raw API JSON.
 */
export interface RawTariffMeasure {
  /** HMRC measure SID — stored on QuoteLine.tariffMeasureId. */
  sid: string;
  /** Measure type id: "103" third-country duty, "142" preference, "305" VAT, "552" ADD, ... */
  measureTypeId: string;
  /** Duty expression base string, e.g. "8.00 %", "£ 0.35 / 100 kg", "12.00 % + £ 25.00 / 100 kg". */
  dutyExpression: string;
  /** Geographical area id: "1011" = ERGA OMNES (all countries), ISO alpha-2, or a group id. */
  geographicalAreaId: string;
  /** For group areas (e.g. "1013" EU), the ISO codes of member countries. */
  geographicalAreaMembers?: readonly string[];
  /** Countries explicitly excluded from a group measure (API `excluded_countries`). */
  excludedCountries?: readonly string[];
  additionalCode?: string | null;
  /** ISO dates. When present, the measure is only applied if `asOf` falls within them. */
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
}

export type TariffInput =
  | { kind: 'MEASURES'; measures: readonly RawTariffMeasure[]; verifiedAt: string }
  | {
      kind: 'MANUAL';
      dutyRatePct: DecimalInput;
      vatRatePct: DecimalInput;
      addRatePct?: DecimalInput | null;
    }
  | { kind: 'UNAVAILABLE'; reason: string };

export interface LineInput {
  /** Product id or SKU; echoed on the line result and warnings. */
  ref: string;
  /** 6/8/10 digits. */
  hsCode: string;
  /** True only when the code was verified against the tariff (`Product.hsCodeVerifiedAt`). */
  hsCodeVerified: boolean;
  /** ISO 3166-1 alpha-2. */
  originCountry: string;
  /** Positive integer. Quantities are counts, not money, so `number` is correct here. */
  quantity: number;
  unitValue: DecimalInput;
  /** ISO 4217. */
  currency: string;
  unitWeightKg: DecimalInput;
  unitVolumeCbm: DecimalInput;
  preferenceClaimed?: boolean;
  /**
   * Assists (moulds, tooling, design, artwork) paid to or for the supplier separately from the
   * invoice, apportioned to THIS line's units in this shipment, in GBP. Dutiable: added to the
   * customs value (ADR-0011).
   */
  assistsGbp?: DecimalInput;
  tariff: TariffInput;
}

export interface FxRateInput {
  /** Units of GBP per 1 unit of `currency`. */
  rateToGbp: DecimalInput;
  source: FxSource;
  /** ISO date the rate applies from (HMRC: first of month). */
  date: string;
}

export interface FxInput {
  /** Keyed by ISO 4217 code. GBP is implicit (rate 1). */
  rates: Readonly<Record<string, FxRateInput>>;
}

export interface FreightInput {
  /** "RATE_SHEET_V1" | "SEARATES" | "MANUAL" — stored as Quote.rateSource. */
  source: string;
  /** ISO datetime the rate was fetched. */
  fetchedAt: string;
  /** Provider's own expiry, if any. validUntil = min(this, fetchedAt + 7d). */
  providerValidUntil?: string | null;
  /** Port-to-port / airport-to-airport leg — dutiable (§5.3). */
  toBorderGbp: DecimalInput;
  /** UK haulage / delivery leg. `null` = provider did not split → assumed 0 with FREIGHT_SPLIT_ASSUMED. */
  postBorderGbp?: DecimalInput | null;
  /** Origin charges (export docs, origin THC) — dutiable. */
  originFeesGbp: DecimalInput;
  /** Destination handling (THC, docs) — post-border, VAT base only. */
  destinationFeesGbp: DecimalInput;
  /** Customs clearance / brokerage — post-border. Payable by buyer under every incoterm except DDP. */
  clearanceFeeGbp?: DecimalInput;
  /** True when this came from a fallback source (circuit open, provider down). */
  isFallback?: boolean;
  /** Rate-sheet figure for the same lane (total to-border freight) for outlier detection (§5.8). */
  benchmarkToBorderGbp?: DecimalInput | null;
}

/**
 * For DAP/DPU/DDP the supplier's price already includes freight. The customs value must
 * exclude post-border transport, so we need the supplier's breakdown (§5.5).
 */
export interface SupplierFreightInput {
  /** Total freight the supplier built into the price (informational). */
  totalGbp: DecimalInput;
  /** Post-border (UK) portion. Unknown → assumed 0 with FREIGHT_SPLIT_ASSUMED (conservative). */
  postBorderGbp?: DecimalInput | null;
}

export interface QuoteInput {
  incoterm: Incoterm;
  mode: Mode;
  originCountry: string;
  originPort?: string | null;
  destinationPort?: string | null;
  lines: readonly LineInput[];
  fx: FxInput;
  /** `null` when the freight stage failed → FREIGHT_UNAVAILABLE (blocking). */
  freight: FreightInput | null;
  supplierFreight?: SupplierFreightInput | null;
  /** FCA/FOB only: user states origin charges are NOT included in the supplier price. */
  includeOriginFees?: boolean;
  insurance?: { premiumGbp: DecimalInput } | null;
  /** Drives `vatRecoverable`. */
  vatRegistered: boolean;
  /**
   * Postponed VAT accounting: import VAT is declared on the VAT return instead of being paid at
   * the border. Only honoured when `vatRegistered`; it changes cash at the border, not cost.
   */
  vatPostponed?: boolean;
  /**
   * Duty paid through the forwarder's deferment account: the forwarder charges a fee on the duty
   * and VAT it pays up front. Percentages as decimal strings ("2.5" = 2.5%). Forwarder-specific.
   */
  brokerDeferment?: { feePct: DecimalInput; minimumGbp: DecimalInput } | null;
  /**
   * Estimated UK incidental costs (terminal handling and delivery to the first UK destination)
   * added to the VAT base ONLY when the rate source did not provide the post-border leg.
   */
  inlandVatAdjustmentGbp?: DecimalInput | null;
  platformFeeGbp?: DecimalInput;
  /** ISO datetime used for measure date filtering. Defaults to freight.fetchedAt. */
  asOf?: string;
}

// ---------- Output ----------

export interface SpecificDuty {
  amountGbp: string;
  /** Quantity of `unit` the amount applies per, e.g. 100 for "£ x / 100 kg". */
  per: string;
  unit: 'kg' | 'item';
}

export interface LineResult {
  ref: string;
  hsCode: string;
  originCountry: string;
  quantity: number;
  unitValue: string;
  currency: string;
  unitValueGbp: string;
  lineGoodsValueGbp: string;
  lineWeightKg: string;
  lineVolumeCbm: string;
  chargeableWeight: string;
  tariffMeasureId: string | null;
  dutyType: DutyType;
  dutyRatePct: string | null;
  dutySpecific: SpecificDuty | null;
  preferenceClaimed: boolean;
  addRatePct: string | null;
  vatRatePct: string;
  allocatedFreightGbp: string;
  allocatedFreightToBorderGbp: string;
  allocatedFreightPostBorderGbp: string;
  allocatedOriginFeesGbp: string;
  allocatedDestinationFeesGbp: string;
  allocatedInsuranceGbp: string;
  allocatedPlatformFeeGbp: string;
  assistsGbp: string;
  allocatedFinancingFeeGbp: string;
  allocatedInlandVatAdjustmentGbp: string;
  lineCustomsValueGbp: string;
  lineDutyGbp: string;
  lineVatGbp: string;
  /** Duty/VAT the supplier bears under DDP — informational, excluded from totals. */
  supplierBorneDutyGbp: string;
  supplierBorneVatGbp: string;
  lineLandedCostExVatGbp: string;
  lineLandedCostGbp: string;
  landedCostPerUnit: string;
  landedCostPerUnitIncVat: string;
}

export interface QuoteTotals {
  goodsValueGbp: string;
  /** Freight the buyer pays (to-border + post-border). Zero under CFR/CIF/DAP/DPU/DDP to-border. */
  freightCost: string;
  freightToBorderGbp: string;
  freightPostBorderGbp: string;
  originFees: string;
  destinationFees: string;
  insurancePremium: string;
  customsValue: string;
  totalDuty: string;
  totalVat: string;
  vatRecoverable: boolean;
  /** Postponed VAT accounting in effect: VAT is not paid at the border. */
  vatPostponed: boolean;
  /** Duty + VAT payable at the border (VAT excluded when postponed). Cash, not cost. */
  borderOutlay: string;
  assistsGbp: string;
  financingFee: string;
  /** VAT-base padding applied for unknown UK inland costs (not part of landed cost). */
  inlandVatAdjustment: string;
  platformFee: string;
  totalLandedCostExVat: string;
  totalLandedCost: string;
  supplierBorneDuty: string;
  supplierBorneVat: string;
}

export interface QuoteResult {
  calcVersion: string;
  status: ComputedStatus;
  warnings: QuoteWarning[];
  incoterm: Incoterm;
  mode: Mode;
  apportionmentBasis: ApportionmentBasis;
  /** Primary FX snapshot for the Quote row (first non-GBP currency, else GBP/1). */
  fxRate: string;
  fxSource: FxSource;
  fxDate: string;
  /** All FX snapshots used, keyed by currency. */
  fxSnapshots: Record<string, { rateToGbp: string; source: FxSource; date: string }>;
  rateSource: string;
  rateFetchedAt: string;
  validUntil: string;
  totals: QuoteTotals;
  lines: LineResult[];
}

export type ComputeFailureStage = 'resolveFx' | 'validate';

export type ComputeResult =
  | { ok: true; quote: QuoteResult }
  | {
      ok: false;
      stage: ComputeFailureStage;
      code: string;
      message: string;
      warnings: QuoteWarning[];
    };
