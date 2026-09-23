import { readFileSync } from 'node:fs';
import { parseHmrcMonthlyCsv, type FxRateRecord, type FxRateStore } from '@harbour/adapters';
import type { Logger } from './logger.server';
import { SAMPLE_FX_CSV, adaptersFile } from './paths.server';

/**
 * Seed the FX store at startup (§5.7: rates are never fetched in the request path). In
 * production the worker's HMRC job writes the `FxRate` table; until it exists, `FX_SEED_CSV`
 * points at a downloaded HMRC monthly CSV. With neither, the adapters' *sample* CSV is loaded
 * and flagged loudly — those numbers are not real rates.
 */
export interface FxSeedSummary {
  source: 'env' | 'sample' | 'none';
  path: string | null;
  count: number;
  skipped: number;
}

const monthBounds = (now: Date): { validFrom: string; validTo: string } => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  return { validFrom: first.toISOString().slice(0, 10), validTo: last.toISOString().slice(0, 10) };
};

const coversNow = (records: readonly FxRateRecord[], now: Date): boolean => {
  const t = now.getTime();
  return records.some(
    (r) => new Date(r.validFrom).getTime() <= t && new Date(r.validTo).getTime() >= t,
  );
};

export const seedFxStore = async (opts: {
  store: FxRateStore;
  csvPath: string | undefined;
  logger: Logger;
  now?: () => Date;
}): Promise<FxSeedSummary> => {
  const now = opts.now ?? (() => new Date());
  const { logger } = opts;

  if (opts.csvPath) {
    const parsed = parseHmrcMonthlyCsv(readFileSync(opts.csvPath, 'utf8'));
    await opts.store.upsert(parsed.records);
    logger.info('fx.seeded', {
      source: 'env',
      count: parsed.records.length,
      skipped: parsed.skipped.length,
    });
    return {
      source: 'env',
      path: opts.csvPath,
      count: parsed.records.length,
      skipped: parsed.skipped.length,
    };
  }

  const samplePath = adaptersFile(...SAMPLE_FX_CSV);
  if (!samplePath) {
    logger.error('fx.unseeded', {
      message:
        'No FX_SEED_CSV and the sample CSV could not be found: every non-GBP quote will need a manual rate.',
    });
    return { source: 'none', path: null, count: 0, skipped: 0 };
  }
  const parsed = parseHmrcMonthlyCsv(readFileSync(samplePath, 'utf8'));
  let records = parsed.records;
  if (!coversNow(records, now())) {
    // Sample data is only for wiring checks; keep it usable in dev by re-stamping to this month.
    const bounds = monthBounds(now());
    records = records.map((r) => ({ ...r, ...bounds }));
  }
  await opts.store.upsert(records);
  logger.warn('fx.sample_rates', {
    message:
      '*** SAMPLE FX RATES LOADED *** FX_SEED_CSV is unset, so the adapters sample HMRC CSV is in use. These are NOT real rates. Set FX_SEED_CSV or run the FX job before exposing the calculator.',
    count: records.length,
  });
  return {
    source: 'sample',
    path: samplePath,
    count: records.length,
    skipped: parsed.skipped.length,
  };
};
