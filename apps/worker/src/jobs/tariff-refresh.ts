import {
  TARIFF_CACHE_TTL_MS,
  type TariffCacheStore,
  type TariffLookup,
  type UkTradeTariffClient,
} from '@harbour/adapters';
import { mapWithLimit } from '../limiter.js';
import type { AlertSink, HsCodeSource } from '../ports.js';

/**
 * Nightly tariff cache re-warm (§5.2 24h cache, §11 item 4). Looks every active commodity code
 * up through the resilient `UkTradeTariffClient` so the request path finds a fresh row in
 * `TariffCache` and never pays the live latency / breaker risk during the day.
 *
 * Throttled: at most `concurrency` (5) in flight and a `gapMs` (100ms) gap between starts.
 * Never throws on provider errors — each code is summarised; if more than `degradedThreshold`
 * (20%) of codes were unavailable a `TARIFF_REFRESH_DEGRADED` warning is raised (runbook §4).
 */
export interface TariffRefreshDeps {
  client: Pick<UkTradeTariffClient, 'lookupCommodity'>;
  codes: HsCodeSource | readonly string[];
  now: () => Date;
  alerts: AlertSink;
  concurrency?: number;
  gapMs?: number;
  /** Fraction (0..1) of unavailable codes above which the run is reported as degraded. */
  degradedThreshold?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TariffRefreshSummary {
  codeCount: number;
  ok: number;
  /** Served from the client's cache (still fresh); see `refreshingCacheView` to force a refetch. */
  fromCache: number;
  notFound: number;
  invalid: number;
  malformed: number;
  unavailable: number;
  degraded: boolean;
  startedAt: string;
  finishedAt: string;
}

export const TARIFF_REFRESH_CONCURRENCY = 5;
export const TARIFF_REFRESH_GAP_MS = 100;
export const TARIFF_REFRESH_DEGRADED_THRESHOLD = 0.2;

export const runTariffRefresh = async (deps: TariffRefreshDeps): Promise<TariffRefreshSummary> => {
  const startedAt = deps.now();
  const codes = Array.isArray(deps.codes)
    ? [...(deps.codes as readonly string[])]
    : await (deps.codes as HsCodeSource).listActiveHsCodes();
  const unique = Array.from(new Set(codes));

  const summary: TariffRefreshSummary = {
    codeCount: unique.length,
    ok: 0,
    fromCache: 0,
    notFound: 0,
    invalid: 0,
    malformed: 0,
    unavailable: 0,
    degraded: false,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
  };

  const results = await mapWithLimit(
    unique,
    async (code): Promise<TariffLookup> => {
      try {
        return await deps.client.lookupCommodity(code);
      } catch (err) {
        // The client already maps HTTP/timeouts to UNAVAILABLE; this guards cache-store errors.
        return {
          ok: false,
          reason: 'UNAVAILABLE',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      concurrency: deps.concurrency ?? TARIFF_REFRESH_CONCURRENCY,
      gapMs: deps.gapMs ?? TARIFF_REFRESH_GAP_MS,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
  );

  for (const r of results) {
    if (r.ok) {
      summary.ok += 1;
      if (r.fromCache) summary.fromCache += 1;
      continue;
    }
    switch (r.reason) {
      case 'NOT_FOUND':
        summary.notFound += 1;
        break;
      case 'INVALID_CODE':
        summary.invalid += 1;
        break;
      case 'MALFORMED':
        summary.malformed += 1;
        break;
      case 'UNAVAILABLE':
        summary.unavailable += 1;
        break;
    }
  }

  const threshold = deps.degradedThreshold ?? TARIFF_REFRESH_DEGRADED_THRESHOLD;
  summary.degraded = summary.codeCount > 0 && summary.unavailable / summary.codeCount > threshold;
  summary.finishedAt = deps.now().toISOString();

  if (summary.degraded) {
    await deps.alerts.alert(
      'warning',
      'TARIFF_REFRESH_DEGRADED',
      `Tariff refresh degraded: ${summary.unavailable}/${summary.codeCount} codes unavailable. See docs/runbooks/tariff-or-fx-job-failed.md §4.`,
      { ...summary },
    );
  }
  return summary;
};

/**
 * `UkTradeTariffClient.lookupCommodity` serves fresh cache entries without calling the API, so
 * a nightly run with a 24h TTL would skip anything looked up during the day. This view makes the
 * refresh job treat any entry with less than `minRemainingMs` of life left as stale (default:
 * anything older than an hour), so it is refetched and written through to the real store.
 * Reads from the request path keep using the unwrapped store.
 */
export const refreshingCacheView = (
  store: TariffCacheStore,
  opts: { now: () => Date; minRemainingMs?: number },
): TariffCacheStore => {
  const minRemaining = opts.minRemainingMs ?? TARIFF_CACHE_TTL_MS - 60 * 60 * 1000;
  return {
    async get(code) {
      const hit = await store.get(code);
      if (!hit) return null;
      const remaining = hit.expiresAt.getTime() - opts.now().getTime();
      return remaining >= minRemaining ? hit : null;
    },
    set: (code, value, fetchedAt, expiresAt) => store.set(code, value, fetchedAt, expiresAt),
  };
};
