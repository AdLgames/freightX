/**
 * Warning codes emitted by the engine (§5.9). Blocking warnings force `INDICATIVE` status;
 * a quote with any blocking warning cannot be accepted or booked.
 */
export const BLOCKING_WARNING_CODES = [
  'HS_UNVERIFIED',
  'TARIFF_AMBIGUOUS',
  'RATE_OUTLIER',
  'INCOTERM_FREIGHT_UNKNOWN',
  // Added beyond the brief: no freight rate could be resolved at all. Nothing sensible can be
  // quoted without one, and silently using 0 would violate "fail closed on money".
  'FREIGHT_UNAVAILABLE',
] as const;

export const NON_BLOCKING_WARNING_CODES = [
  'ADD_APPLIES',
  'ADD_RATE_MAX_ASSUMED',
  'QUOTA_APPLIES',
  'EXCISE_APPLIES',
  'PREFERENCE_AVAILABLE',
  'PREFERENCE_NOT_ELIGIBLE',
  'PREFERENCE_AMBIGUOUS',
  'VAT_ASSUMED_STANDARD',
  'VAT_RATE_MAX_ASSUMED',
  'SPECIFIC_DUTY_WEIGHT_BASIS',
  'TARIFF_MANUAL',
  'FX_FALLBACK',
  'FX_MANUAL',
  'FREIGHT_FALLBACK',
  'FREIGHT_SPLIT_ASSUMED',
  'FREIGHT_INCLUDED_IN_PRICE',
  'INSURANCE_IGNORED_CIF',
  'DDP_SUPPLIER_BEARS_DUTY',
  'SANITY_BOUND',
  'RESTRICTED_GOODS',
  'DANGEROUS_GOODS_CHECK',
  'HS_NORMALISED',
  'ASSISTS_INCLUDED',
  'PVA_REQUIRES_VAT_REGISTRATION',
  'BROKER_DEFERMENT_FEE',
  'INLAND_VAT_ADJUSTMENT',
] as const;

export type BlockingWarningCode = (typeof BLOCKING_WARNING_CODES)[number];
export type NonBlockingWarningCode = (typeof NON_BLOCKING_WARNING_CODES)[number];
export type WarningCode = BlockingWarningCode | NonBlockingWarningCode;

export interface QuoteWarning {
  code: WarningCode;
  message: string;
  blocking: boolean;
  /** Line reference (product id / sku) when the warning is line-specific. */
  lineRef?: string;
}

const blockingSet: ReadonlySet<string> = new Set(BLOCKING_WARNING_CODES);

export const isBlockingCode = (code: WarningCode): boolean => blockingSet.has(code);

export const warn = (code: WarningCode, message: string, lineRef?: string): QuoteWarning => {
  const w: QuoteWarning = { code, message, blocking: isBlockingCode(code) };
  if (lineRef !== undefined) w.lineRef = lineRef;
  return w;
};

/** Small helper to accumulate warnings without duplicates of (code, lineRef). */
export class WarningBag {
  private readonly items: QuoteWarning[] = [];

  add(code: WarningCode, message: string, lineRef?: string): void {
    const exists = this.items.some((w) => w.code === code && w.lineRef === lineRef);
    if (!exists) this.items.push(warn(code, message, lineRef));
  }

  addAll(ws: readonly QuoteWarning[]): void {
    for (const w of ws) this.add(w.code, w.message, w.lineRef);
  }

  hasBlocking(): boolean {
    return this.items.some((w) => w.blocking);
  }

  toArray(): QuoteWarning[] {
    return [...this.items];
  }
}
