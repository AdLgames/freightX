import type { FxInput, FxSource } from '@harbour/engine';

export interface FxRateRecord {
  source: FxSource;
  currency: string;
  /** GBP per 1 unit of `currency`, as a decimal string. */
  rateToGbp: string;
  validFrom: string; // ISO date
  validTo: string; // ISO date
}

/**
 * FX store contract (§5.7). Rates are written by the worker's scheduled jobs and read in the
 * request path — the request path NEVER calls an FX API. The Prisma-backed store lives in the
 * app; this package ships an in-memory one.
 */
export interface FxRateStore {
  /** Latest rate for `currency` from `source` valid at `at`, or null. */
  find(source: FxSource, currency: string, at: Date): Promise<FxRateRecord | null>;
  upsert(records: readonly FxRateRecord[]): Promise<void>;
  /**
   * Records for `currency` from `source` whose `validFrom` falls in [from, to] (dates compared at
   * UTC midnight), oldest first. For trends (the Home treasury widget), never for pricing: a
   * quote resolves one rate with `find`.
   */
  history(source: FxSource, currency: string, from: Date, to: Date): Promise<FxRateRecord[]>;
}

export class InMemoryFxStore implements FxRateStore {
  private readonly records: FxRateRecord[] = [];

  async find(source: FxSource, currency: string, at: Date): Promise<FxRateRecord | null> {
    const t = at.getTime();
    const matches = this.records
      .filter((r) => r.source === source && r.currency === currency)
      .filter((r) => new Date(r.validFrom).getTime() <= t && new Date(r.validTo).getTime() >= t)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return matches[0] ?? null;
  }

  async history(source: FxSource, currency: string, from: Date, to: Date): Promise<FxRateRecord[]> {
    const lo = from.toISOString().slice(0, 10);
    const hi = to.toISOString().slice(0, 10);
    return this.records
      .filter((r) => r.source === source && r.currency === currency)
      .filter((r) => r.validFrom >= lo && r.validFrom <= hi)
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }

  async upsert(records: readonly FxRateRecord[]): Promise<void> {
    for (const rec of records) {
      const i = this.records.findIndex(
        (r) =>
          r.source === rec.source && r.currency === rec.currency && r.validFrom === rec.validFrom,
      );
      if (i >= 0) this.records[i] = rec;
      else this.records.push(rec);
    }
  }
}

export type FxResolution =
  | { ok: true; fx: FxInput; fallbacks: string[] }
  | { ok: false; missing: string[]; fx: FxInput; fallbacks: string[] };

/**
 * Resolve engine FX input for a set of currencies: HMRC monthly first, ECB daily as fallback
 * (the engine emits FX_FALLBACK when it sees `source: "ECB"`). Manual overrides win outright and
 * are labelled MANUAL. Missing currencies are reported, never defaulted.
 */
export const resolveFx = async (
  store: FxRateStore,
  currencies: readonly string[],
  opts: { at: Date; manual?: Readonly<Record<string, string>> },
): Promise<FxResolution> => {
  const rates: Record<string, FxInput['rates'][string]> = {};
  const missing: string[] = [];
  const fallbacks: string[] = [];
  for (const raw of currencies) {
    const ccy = raw.toUpperCase();
    if (ccy === 'GBP') continue;
    const manual = opts.manual?.[ccy];
    if (manual !== undefined) {
      rates[ccy] = {
        rateToGbp: manual,
        source: 'MANUAL',
        date: opts.at.toISOString().slice(0, 10),
      };
      continue;
    }
    const hmrc = await store.find('HMRC_MONTHLY', ccy, opts.at);
    if (hmrc) {
      rates[ccy] = { rateToGbp: hmrc.rateToGbp, source: 'HMRC_MONTHLY', date: hmrc.validFrom };
      continue;
    }
    const ecb = await store.find('ECB', ccy, opts.at);
    if (ecb) {
      rates[ccy] = { rateToGbp: ecb.rateToGbp, source: 'ECB', date: ecb.validFrom };
      fallbacks.push(ccy);
      continue;
    }
    missing.push(ccy);
  }
  const fx: FxInput = { rates };
  return missing.length === 0 ? { ok: true, fx, fallbacks } : { ok: false, missing, fx, fallbacks };
};
