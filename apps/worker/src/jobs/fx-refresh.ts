import {
  ECB_DAILY_URL,
  HttpError,
  hmrcMonthlyCsvUrl,
  isRetryableHttpError,
  parseEcbDailyXml,
  parseHmrcMonthlyCsv,
  withRetry,
  withTimeout,
  type FetchLike,
  type FxRateStore,
} from '@harbour/adapters';
import type { AlertCode, AlertLevel, AlertSink } from '../ports.js';

/**
 * FX refresh (§5.7): HMRC monthly rates are the primary source; ECB daily reference rates are
 * the fallback the engine labels `FX_FALLBACK`. The request path never calls either API — this
 * job is the only writer.
 *
 * Schedule vs. logic: the queue runs this daily (plus the 25th/1st, §5.7). The job itself decides
 * what is due:
 *   - always fetch the current month's HMRC file (idempotent upsert on (source, currency, validFrom));
 *   - from the 25th, also try next month's file (HMRC publishes ~1 week before the month starts;
 *     a 404 before publication is EXPECTED and is not an alert);
 *   - on the 2nd or later, if the current month's HMRC rates are still absent → critical
 *     `FX_HMRC_MISSING` (runbook: docs/runbooks/tariff-or-fx-job-failed.md §2);
 *   - then refresh ECB daily as fallback data (validity 7 days, set by the parser).
 *
 * Provider errors never throw: they are reported through `alerts` and the summary, and the next
 * scheduled run tries again. Store (database) errors DO throw so BullMQ retries with backoff.
 */
export interface FxRefreshDeps {
  fetch: FetchLike;
  store: FxRateStore;
  now: () => Date;
  alerts: AlertSink;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  /**
   * Currencies whose presence proves the current month's HMRC file is loaded. USD and EUR are
   * in every HMRC monthly file; any one of them found for `now` counts as present.
   */
  sentinelCurrencies?: readonly string[];
}

export interface FxRefreshSummary {
  /** `YYYY-MM` months whose HMRC file was fetched and upserted in this run. */
  hmrcMonthsLoaded: string[];
  hmrcRecords: number;
  ecbRecords: number;
  /** Alerts raised during this run. */
  alerts: number;
  /** Human-readable provider problems (no PII; URLs and error classes only). */
  errors: string[];
}

export const FX_FETCH_TIMEOUT_MS = 5_000;
export const FX_FETCH_RETRIES = 2;
/** Day of month from which next month's HMRC file is attempted. */
export const HMRC_NEXT_MONTH_FROM_DAY = 25;
/** Day of month from which a missing current-month HMRC file is critical. */
export const HMRC_MISSING_ALERT_FROM_DAY = 2;

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export const yearMonthOf = (d: Date): YearMonth => ({
  year: d.getUTCFullYear(),
  month: d.getUTCMonth() + 1,
});

export const nextYearMonth = ({ year, month }: YearMonth): YearMonth =>
  month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };

export const formatYearMonth = ({ year, month }: YearMonth): string =>
  `${year}-${String(month).padStart(2, '0')}`;

const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

export const runFxRefresh = async (deps: FxRefreshDeps): Promise<FxRefreshSummary> => {
  const now = deps.now();
  const day = now.getUTCDate();
  const timeoutMs = deps.timeoutMs ?? FX_FETCH_TIMEOUT_MS;
  const retries = deps.retries ?? FX_FETCH_RETRIES;
  const sentinels = deps.sentinelCurrencies ?? ['USD', 'EUR'];

  const summary: FxRefreshSummary = {
    hmrcMonthsLoaded: [],
    hmrcRecords: 0,
    ecbRecords: 0,
    alerts: 0,
    errors: [],
  };

  const raise = async (
    level: AlertLevel,
    code: AlertCode,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    summary.alerts += 1;
    await deps.alerts.alert(level, code, message, meta);
  };

  const fetchText = (url: string): Promise<string> =>
    withRetry(
      () =>
        withTimeout(async (signal) => {
          const res = await deps.fetch(url, {
            signal,
            headers: { accept: 'text/csv, text/xml, */*' },
          });
          if (!res.ok) throw new HttpError(res.status, url);
          return res.text();
        }, timeoutMs),
      {
        retries,
        baseDelayMs: 300,
        shouldRetry: isRetryableHttpError,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
    );

  // --- HMRC monthly -------------------------------------------------------------------------
  const current = yearMonthOf(now);
  const months: Array<{ ym: YearMonth; expectedMissing: boolean }> = [
    { ym: current, expectedMissing: false },
  ];
  if (day >= HMRC_NEXT_MONTH_FROM_DAY) {
    months.push({ ym: nextYearMonth(current), expectedMissing: true });
  }

  for (const { ym, expectedMissing } of months) {
    const label = formatYearMonth(ym);
    const url = hmrcMonthlyCsvUrl(ym.year, ym.month);
    let csv: string;
    try {
      csv = await fetchText(url);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Not published yet. For the current month this is caught by the "missing by the 2nd"
        // check below; for next month it is simply expected until ~1 week before month start.
        summary.errors.push(
          `HMRC ${label}: not published (404)${expectedMissing ? ', expected' : ''}`,
        );
        continue;
      }
      summary.errors.push(`HMRC ${label}: ${describeError(err)}`);
      await raise('warning', 'FX_HMRC_FETCH_FAILED', `HMRC monthly FX fetch failed for ${label}`, {
        month: label,
        url,
        error: describeError(err),
      });
      continue;
    }
    let parsed: ReturnType<typeof parseHmrcMonthlyCsv>;
    try {
      parsed = parseHmrcMonthlyCsv(csv);
    } catch (err) {
      // Upstream format change: a code change, not an ops action (runbook §1.3).
      summary.errors.push(`HMRC ${label}: ${describeError(err)}`);
      await raise(
        'warning',
        'FX_HMRC_PARSE_FAILED',
        `HMRC monthly FX CSV for ${label} did not parse`,
        {
          month: label,
          url,
          error: describeError(err),
        },
      );
      continue;
    }
    if (parsed.records.length === 0) {
      summary.errors.push(`HMRC ${label}: file parsed but contained no usable rows`);
      await raise(
        'warning',
        'FX_HMRC_PARSE_FAILED',
        `HMRC monthly FX CSV for ${label} had no usable rows`,
        {
          month: label,
          url,
          skipped: parsed.skipped.length,
        },
      );
      continue;
    }
    await deps.store.upsert(parsed.records);
    summary.hmrcMonthsLoaded.push(label);
    summary.hmrcRecords += parsed.records.length;
  }

  // --- "missing by the 2nd" check (§5.7) --------------------------------------------------
  if (day >= HMRC_MISSING_ALERT_FROM_DAY) {
    const currentLabel = formatYearMonth(current);
    let present = summary.hmrcMonthsLoaded.includes(currentLabel);
    if (!present) {
      for (const ccy of sentinels) {
        if ((await deps.store.find('HMRC_MONTHLY', ccy, now)) !== null) {
          present = true;
          break;
        }
      }
    }
    if (!present) {
      await raise(
        'critical',
        'FX_HMRC_MISSING',
        `HMRC monthly FX rates for ${currentLabel} are missing on day ${day}; quotes are falling back to ECB (FX_FALLBACK). See docs/runbooks/tariff-or-fx-job-failed.md §2.`,
        { month: currentLabel, day, errors: summary.errors },
      );
    }
  }

  // --- ECB daily (fallback data) ------------------------------------------------------------
  try {
    const xml = await fetchText(ECB_DAILY_URL);
    let parsed: ReturnType<typeof parseEcbDailyXml>;
    try {
      parsed = parseEcbDailyXml(xml);
    } catch (err) {
      summary.errors.push(`ECB: ${describeError(err)}`);
      await raise('warning', 'FX_ECB_PARSE_FAILED', 'ECB daily FX XML did not parse', {
        url: ECB_DAILY_URL,
        error: describeError(err),
      });
      return summary;
    }
    await deps.store.upsert(parsed.records);
    summary.ecbRecords = parsed.records.length;
  } catch (err) {
    summary.errors.push(`ECB: ${describeError(err)}`);
    await raise(
      'warning',
      'FX_ECB_FETCH_FAILED',
      'ECB daily FX fetch failed (fallback rates not refreshed)',
      {
        url: ECB_DAILY_URL,
        error: describeError(err),
      },
    );
  }

  return summary;
};
