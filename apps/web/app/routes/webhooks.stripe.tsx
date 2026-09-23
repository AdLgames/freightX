import { createHash, randomUUID } from 'node:crypto';
import type { Route } from './+types/webhooks.stripe';
import { getApp } from '../services/app.server';
import { WebhookSignatureError, verifyStripeWebhook } from '../services/billing/stripe.server';
import { requestLogger } from '../services/logger.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/**
 * POST /webhooks/stripe — resource route (M6, brief §6.4 applied to Stripe).
 *
 *   1. POST only; body ≤ 256 KB (413 otherwise, read with a hard cap, never buffered past it).
 *   2. `Stripe-Signature` required (400). Verified with the SDK (HMAC-SHA256, constant-time
 *      compare, 300 s replay window); bad signature / stale timestamp → 400. No secret configured
 *      → 503 so Stripe keeps retrying while ops fix the config.
 *   3. Idempotency: one `stripe_events` row per event id, inserted with ON CONFLICT DO NOTHING; a
 *      duplicate delivery is acknowledged (200) and goes no further.
 *   4. Enqueue (BullMQ with REDIS_URL, inline otherwise) and return 200. Processing lives in
 *      services/billing/events.server.ts.
 *
 * No CSRF here: the request is authenticated by its signature, not a session, and Stripe sends no
 * Origin header. M1's Origin/token check is per-action (`requireCsrf`), not global, so no exemption
 * is needed — this route simply never calls it. It is outside /app on purpose (public, unauthenticated).
 * Nothing from the payload is logged: event id and type only.
 */

export const MAX_WEBHOOK_BYTES = 256 * 1024;

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** Reads the raw body up to `limit` bytes; throws once a byte more would be needed. */
export const readRawBody = async (request: Request, limit: number): Promise<Uint8Array> => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError('too large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};

const json = (status: number, body: Record<string, unknown>, extra?: Record<string, string>) => {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  applySecurityHeaders(headers, randomUUID(), { hsts: process.env.NODE_ENV === 'production' });
  return new Response(JSON.stringify(body), { status, headers });
};

export const loader = () => json(405, { error: 'method not allowed' }, { allow: 'POST' });

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST')
    return json(405, { error: 'method not allowed' }, { allow: 'POST' });
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const billing = app.billing;

  let raw: Uint8Array;
  try {
    raw = await readRawBody(request, MAX_WEBHOOK_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      log.warn('billing.webhook_rejected', { reason: 'too_large' });
      return json(413, { error: 'payload too large' });
    }
    log.warn('billing.webhook_rejected', { reason: 'unreadable' });
    return json(400, { error: 'unreadable body' });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    log.warn('billing.webhook_rejected', { reason: 'no_signature' });
    return json(400, { error: 'missing Stripe-Signature' });
  }
  if (!billing.webhookSecret) {
    log.error('billing.webhook_rejected', { reason: 'not_configured' });
    return json(503, { error: 'webhook not configured' });
  }
  if (!billing.enqueuer || !billing.repository || !app.auth.prisma) {
    log.error('billing.webhook_rejected', { reason: 'no_database' });
    return json(503, { error: 'workspace database unavailable' });
  }

  let event;
  try {
    event = verifyStripeWebhook(raw, signature, billing.webhookSecret);
  } catch (err) {
    const reason = err instanceof WebhookSignatureError ? err.reason : 'signature';
    log.warn('billing.webhook_rejected', { reason });
    return json(400, { error: 'invalid signature' });
  }

  // Claim the event id. `createMany` + skipDuplicates is one INSERT ... ON CONFLICT DO NOTHING.
  const payloadSha256 = createHash('sha256').update(raw).digest('hex');
  const claimed = await app.auth.prisma.stripeEvent.createMany({
    data: [{ id: event.id, type: event.type, payloadSha256 }],
    skipDuplicates: true,
  });
  if (claimed.count === 0) {
    log.info('billing.webhook_duplicate', { eventId: event.id, type: event.type });
    return json(200, { received: true, duplicate: true });
  }

  try {
    await billing.enqueuer.enqueue(event);
  } catch (err) {
    // Inline: the processor threw after marking the row's error (it will not be retried by a
    // queue, so a redelivery must be allowed to try again). BullMQ: the add failed, nothing was
    // recorded downstream. Either way release the claim and let Stripe redeliver.
    await app.auth.prisma.stripeEvent
      .deleteMany({ where: { id: event.id } })
      .catch(() => undefined);
    log.error('billing.webhook_enqueue_failed', {
      eventId: event.id,
      type: event.type,
      backend: billing.enqueuer.backend,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: 'event not accepted, please retry' });
  }

  log.info('billing.webhook_received', {
    eventId: event.id,
    type: event.type,
    backend: billing.enqueuer.backend,
    livemode: event.livemode,
  });
  return json(200, { received: true });
};
