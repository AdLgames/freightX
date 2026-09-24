import { randomUUID } from 'node:crypto';
import type { Route } from './+types/app.api.ais';
import type { AisSnapshotResponse } from '../lib/ais-client';
import { getApp } from '../services/app.server';
import { requireOrgContext } from '../services/auth.server';
import type { RateLimitPolicy } from '../services/rate-limit.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/**
 * GET /app/api/ais[?since=<ms>] — the live AIS picture around the UK for the Home map, relayed
 * from aisstream.io by the server (services/tracking/ais-relay.server.ts). Members only, rate
 * limited 30/min per user; the response is the compact tuple list in lib/ais-client.ts. Without
 * `AISSTREAM_API_KEY` the route answers 404 so the map shows no AIS legend at all.
 */
export const AIS_LIMIT: RateLimitPolicy = { name: 'ais', capacity: 30, windowMs: 60_000 };

const json = (body: unknown, status: number, headers: Headers, production: boolean) => {
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  applySecurityHeaders(headers, randomUUID(), { hsts: production });
  return new Response(JSON.stringify(body), { status, headers });
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const production = app.env.NODE_ENV === 'production';
  const headers = new Headers(ctx.headers);
  if (!app.tracking.ais) return json({ error: 'ais_off' }, 404, headers, production);
  const decision = await app.rateLimiter.consume(`${ctx.org.id}:${ctx.user.id}`, AIS_LIMIT);
  if (!decision.allowed) {
    headers.set('retry-after', String(decision.retryAfterSeconds));
    return json({ error: 'rate_limited' }, 429, headers, production);
  }
  const sinceRaw = Number(new URL(request.url).searchParams.get('since') ?? '0');
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const body: AisSnapshotResponse = await app.tracking.ais.snapshot(since);
  return json(body, 200, headers, production);
};
