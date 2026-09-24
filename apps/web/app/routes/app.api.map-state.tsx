import { randomUUID } from 'node:crypto';
import type { Route } from './+types/app.api.map-state';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { pageError } from '../services/page-error';
import type { RateLimitPolicy } from '../services/rate-limit.server';
import { applySecurityHeaders } from '../services/security-headers.server';
import { advanceDemoFleet } from '../services/tracking/demo-fleet.server';
import { loadMapState } from '../services/tracking/queries.server';
import { mapStateQuerySchema } from '../validators/tracking';

/**
 * M9 (ADR-0017) — GET /app/api/map-state[?shipmentId=]: JSON for the map, org-scoped through the
 * session (never a URL parameter), rate-limited 60/min per user. Returns each active container's
 * last real ping plus a server-side dead-reckoned position, uncertainty radius, cap flag and the
 * actual/expected paths. See services/tracking/map-state.ts for the contract.
 */
export const MAP_STATE_LIMIT: RateLimitPolicy = {
  name: 'map-state',
  capacity: 60,
  windowMs: 60_000,
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const decision = await app.rateLimiter.consume(`${ctx.org.id}:${ctx.user.id}`, MAP_STATE_LIMIT);
  if (!decision.allowed) {
    throw new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(decision.retryAfterSeconds),
        'cache-control': 'no-store',
      },
    });
  }
  const url = new URL(request.url);
  const query = mapStateQuerySchema.safeParse({
    shipmentId: url.searchParams.get('shipmentId') ?? undefined,
  });
  if (!query.success) throw pageError(400, 'Bad request', 'shipmentId must be a UUID.');

  const now = new Date();
  const state = await withOrg(ctx, async (tx) => {
    // Demo fleet: simulated vessels move on read (no worker needed); a no-op when the flag is off.
    if (app.tracking.demoFleetEnabled) await advanceDemoFleet(tx, { now, log: app.logger });
    return loadMapState(tx, { shipmentId: query.data.shipmentId, now });
  });
  const headers = new Headers(ctx.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  applySecurityHeaders(headers, randomUUID(), { hsts: app.env.NODE_ENV === 'production' });
  return new Response(JSON.stringify(state), { status: 200, headers });
};
