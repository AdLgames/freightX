import type { Route } from './+types/webhooks.tracking.$providerId';
import { getApp } from '../services/app.server';
import { requestLogger } from '../services/logger.server';

/**
 * M9 (ADR-0017, brief §6.4) — POST /webhooks/tracking/:providerId.
 *
 *   - POST only (405 otherwise); no session, no CSRF (server-to-server; the signature is the auth)
 *   - bodies over 256 KB → 413 (Content-Length first, then a capped read of the stream)
 *   - signature verified inside the provider adapter with the per-provider secret from env,
 *     constant-time; mismatch → 401; timestamp outside the 5-minute replay window → 401
 *   - malformed → 400; unknown provider → 404; provider secret unset → 503
 *   - enqueue (BullMQ with REDIS_URL, inline otherwise) and answer 200 within 2 s
 *
 * Logs carry counts and the provider id only — never the payload, signature or secret.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Reads at most `limit` bytes; returns null when the body is larger. */
export const readBodyCapped = async (request: Request, limit: number): Promise<string | null> => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const loader = () => json(405, { error: 'method_not_allowed' });

export const action = async ({ request, params }: Route.ActionArgs) => {
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const providerId = typeof params.providerId === 'string' ? params.providerId : '';
  if (!/^[a-z0-9]{1,32}$/.test(providerId)) return json(404, { error: 'unknown_provider' });

  const provider = app.tracking.webhookProvider(providerId);
  if (!provider) {
    log.warn('tracking.webhook_unknown_provider', { providerId });
    return json(404, { error: 'unknown_provider' });
  }
  const secret = app.tracking.webhookSecret(providerId);
  if (!secret) {
    log.warn('tracking.webhook_not_configured', { providerId });
    return json(503, { error: 'not_configured' });
  }

  const body = await readBodyCapped(request, MAX_WEBHOOK_BYTES);
  if (body === null) {
    log.warn('tracking.webhook_too_large', { providerId });
    return json(413, { error: 'payload_too_large' });
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const parsed = provider.parseWebhook(body, headers, secret);
  if (!parsed.ok) {
    const status =
      parsed.reason === 'MALFORMED' ? 400 : parsed.reason === 'NOT_CONFIGURED' ? 503 : 401;
    log.warn('tracking.webhook_rejected', { providerId, reason: parsed.reason });
    return json(status, { error: parsed.reason.toLowerCase() });
  }

  const result = await app.tracking.queue.enqueue({
    source: provider.id,
    events: parsed.events,
    receivedAt: new Date().toISOString(),
  });
  log.info('tracking.webhook_accepted', {
    providerId,
    events: parsed.events.length,
    queue: app.tracking.queue.backend,
    queued: result.queued,
  });
  return json(200, { ok: true, events: parsed.events.length, queued: result.queued });
};
