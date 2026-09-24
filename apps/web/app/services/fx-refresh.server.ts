import {
  ECB_HISTORY_90D_URL,
  ecbRecordsToLoad,
  parseEcbHistoryXml,
  type FxRateStore,
} from '@harbour/adapters';
import type { Logger } from './logger.server';

/**
 * ECB reference-rate refresh for the web app's cron route (`/api/cron/fx-refresh`). The worker's
 * `fx-refresh` job is the real thing (HMRC monthly first, then ECB); this is the ECB half only,
 * so the Home treasury widget and the `FX_FALLBACK` path have daily rates while the worker has no
 * production host (docs/runbooks/production-env.md, decision (k)). Once the worker runs, both
 * write the same idempotent rows; remove the cron or keep it as belt and braces.
 *
 * Loads the days the store lacks plus the two newest (`ecbRecordsToLoad`), so a daily run is a
 * handful of upserts, not ~2,000. Never runs in a user request: only the cron route calls it.
 */
export interface EcbRefreshSummary {
  daysInFile: number;
  newestDate: string | null;
  recordsWritten: number;
}

export const FX_REFRESH_TIMEOUT_MS = 10_000;

export const refreshEcbHistory = async (deps: {
  store: FxRateStore;
  fetch: typeof fetch;
  logger: Logger;
  now: Date;
  timeoutMs?: number;
}): Promise<EcbRefreshSummary> => {
  const res = await deps.fetch(ECB_HISTORY_90D_URL, {
    headers: { accept: 'application/xml' },
    signal: AbortSignal.timeout(deps.timeoutMs ?? FX_REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ECB history fetch failed: HTTP ${res.status}`);
  const parsed = parseEcbHistoryXml(await res.text());
  const first = parsed.days[0]?.date ?? deps.now.toISOString().slice(0, 10);
  const existing = await deps.store.history('ECB', 'USD', new Date(`${first}T00:00:00Z`), deps.now);
  const records = ecbRecordsToLoad(parsed, new Set(existing.map((r) => r.validFrom)));
  await deps.store.upsert(records);
  const summary: EcbRefreshSummary = {
    daysInFile: parsed.days.length,
    newestDate: parsed.days.at(-1)?.date ?? null,
    recordsWritten: records.length,
  };
  deps.logger.info('fx.ecb_refreshed', { ...summary });
  return summary;
};
