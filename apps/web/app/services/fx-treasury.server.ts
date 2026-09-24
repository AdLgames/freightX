import type { FxRateRecord, FxRateStore } from '@harbour/adapters';
import { D } from '@harbour/engine';

/**
 * Home "Treasury" widget: the pound against the dollar and the euro today, and how it moved over
 * the last week. Reads the ECB reference rates the FX refresh writes (the worker job, or the
 * Vercel cron route while the worker has no host) — never a live API in the request path (§5.7),
 * and never the HMRC monthly rate, which is what quotes use and does not move day to day.
 *
 * Direction is from the importer's seat: a stronger pound buys more foreign currency per £, so
 * `stronger` is the favourable colour. Rates are display strings; nothing here prices anything.
 */
export const TREASURY_CURRENCIES = ['USD', 'EUR'] as const;
export type TreasuryCurrency = (typeof TREASURY_CURRENCIES)[number];
export const TREASURY_TREND_DAYS = 7;
/** How far back to look for the comparison point (weekends and ECB holidays have no rate). */
const LOOKBACK_DAYS = 21;
const DAY_MS = 86_400_000;

export interface TreasuryPair {
  pair: string; // e.g. "GBP/USD"
  currency: TreasuryCurrency;
  /** Units of `currency` per £1, 4 decimals. */
  rate: string;
  /** ISO date of the rate. */
  asOf: string;
  /** The rate ~7 days earlier, or null when the store holds too little history. */
  previous: { rate: string; asOf: string } | null;
  /** Signed percentage change over the week, 2 decimals, or null. */
  changePct: string | null;
  direction: 'stronger' | 'weaker' | 'flat' | null;
}

export interface Treasury {
  source: 'ECB';
  /** Date of the newest rate shown, or null when nothing is loaded. */
  asOf: string | null;
  pairs: TreasuryPair[];
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** £1 in `currency` from a GBP-per-unit record, 4 decimals. */
const perPound = (rec: FxRateRecord) => D('1').div(D(rec.rateToGbp));

/** Pure: builds one pair from the ECB rows of the lookback window (oldest first). */
export const computeTreasuryPair = (
  currency: TreasuryCurrency,
  rows: readonly FxRateRecord[],
  now: Date,
): TreasuryPair | null => {
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  const target = isoDate(new Date(now.getTime() - TREASURY_TREND_DAYS * DAY_MS));
  // The newest row on or before the target date; the newest row itself never qualifies.
  const prior = [...rows].reverse().find((r) => r.validFrom <= target && r !== latest) ?? null;
  const rate = perPound(latest);
  const pair: TreasuryPair = {
    pair: `GBP/${currency}`,
    currency,
    rate: rate.toFixed(4),
    asOf: latest.validFrom,
    previous: null,
    changePct: null,
    direction: null,
  };
  if (!prior) return pair;
  const prev = perPound(prior);
  const change = rate.minus(prev).div(prev).times(100);
  const changePct = change.toFixed(2);
  const direction = change.abs().lt('0.005') ? 'flat' : change.gt(0) ? 'stronger' : 'weaker';
  return {
    ...pair,
    previous: { rate: prev.toFixed(4), asOf: prior.validFrom },
    changePct: change.gt(0) ? `+${changePct}` : changePct,
    direction,
  };
};

export const loadTreasury = async (store: FxRateStore, now: Date): Promise<Treasury> => {
  const from = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const pairs: TreasuryPair[] = [];
  for (const currency of TREASURY_CURRENCIES) {
    const rows = await store.history('ECB', currency, from, now);
    const pair = computeTreasuryPair(currency, rows, now);
    if (pair) pairs.push(pair);
  }
  const asOf =
    pairs
      .map((p) => p.asOf)
      .sort()
      .at(-1) ?? null;
  return { source: 'ECB', asOf, pairs };
};
