import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Route } from './+types/api.cron.fx-refresh';
import { getApp } from '../services/app.server';
import { refreshEcbHistory } from '../services/fx-refresh.server';
import { requestLogger } from '../services/logger.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/**
 * GET /api/cron/fx-refresh — Vercel Cron target (apps/web/vercel.json `crons`), the interim FX
 * refresh until the worker has a host. Vercel calls it with `Authorization: Bearer <CRON_SECRET>`
 * (the project's CRON_SECRET environment variable); the same header from anywhere else is just
 * as valid, which is fine: the job is idempotent and reads a public file.
 *
 *   - CRON_SECRET unset → 503 (nothing runs; ops see it in the logs).
 *   - wrong or missing bearer → 401, constant-time compare, nothing logged about the value.
 *   - success → 200 with the summary; provider failure → 502 with the error class only.
 *
 * Writes go to `fxRefreshStore` (the Postgres store even when startup seeding keeps sample HMRC
 * rates in-process, see db.server.ts). No session, no CSRF: not a browser form.
 */
const json = (status: number, body: unknown, hsts: boolean): Response => {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  applySecurityHeaders(headers, randomUUID(), { hsts });
  return new Response(JSON.stringify(body), { status, headers });
};

const bearerMatches = (header: string | null, secret: string): boolean => {
  if (!header) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const app = await getApp();
  const hsts = app.env.NODE_ENV === 'production';
  const log = requestLogger(app.logger, request);
  const secret = app.env.CRON_SECRET;
  if (!secret) {
    log.warn('cron.not_configured', { route: 'fx-refresh' });
    return json(503, { error: 'cron_not_configured' }, hsts);
  }
  if (!bearerMatches(request.headers.get('authorization'), secret)) {
    return json(401, { error: 'unauthorized' }, hsts);
  }
  try {
    const summary = await refreshEcbHistory({
      store: app.stores.fxRefreshStore,
      fetch: globalThis.fetch,
      logger: log,
      now: new Date(),
    });
    return json(200, { ok: true, ...summary }, hsts);
  } catch (err) {
    const error = err instanceof Error ? err.name : 'Error';
    log.error('cron.fx_refresh_failed', {
      error,
      message: err instanceof Error ? err.message : String(err),
    });
    return json(502, { ok: false, error }, hsts);
  }
};
