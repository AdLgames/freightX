import { randomUUID } from 'node:crypto';
import { getApp } from '../services/app.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/** Liveness + which engine/rate sheet this instance runs. No secrets, no config echo. */
export const loader = async () => {
  const app = await getApp();
  const body = {
    ok: true,
    calcVersion: app.calcVersion,
    rateSheet: app.rateSheet.version,
    rateSheetPlaceholder: app.rateSheet.placeholder,
    rateSheetValidUntil: app.rateSheet.validUntil,
    fxSource: app.fx.source,
    turnstile: app.turnstile.enabled,
    uptimeSeconds: Math.floor((Date.now() - app.startedAt.getTime()) / 1000),
  };
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  applySecurityHeaders(headers, randomUUID(), { hsts: app.env.NODE_ENV === 'production' });
  return new Response(JSON.stringify(body), { status: 200, headers });
};
