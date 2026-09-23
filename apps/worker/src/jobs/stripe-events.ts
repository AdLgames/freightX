import { z } from 'zod';

/**
 * Stripe webhook events on the `stripe-events` queue (M6, brief §6.4 "all processing in the
 * worker"). The web app's POST /webhooks/stripe verifies the signature, records the event id for
 * idempotency and enqueues `{ eventId, type, payload }` with `jobId = eventId`.
 *
 * Contract (must stay identical to apps/web/app/services/billing/queue.server.ts):
 *   queue name      stripe-events
 *   job data        stripeEventJobDataSchema below
 *   job options     attempts 5, exponential backoff from 30 s, failed jobs KEPT (dead-letter set)
 *
 * WHO CONSUMES: today the web process itself (it has Prisma and the email transport); this worker
 * only consumes when `STRIPE_EVENTS_CONSUMER=worker` is set, and then needs a
 * `StripeEventHandlerPort` backed by `@harbour/db` — the same TODO(db) as the other ports. Until
 * that is wired, `UnconfiguredStripeEventHandler` fails every job loudly so the dead-letter alert
 * fires instead of events silently disappearing.
 */
export const STRIPE_EVENTS_QUEUE = 'stripe-events' as const;

export const STRIPE_EVENT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: false,
} as const;

/** Only the envelope is checked here; the processor re-validates the object it handles. */
export const stripeEventJobDataSchema = z.object({
  eventId: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.string().min(1).max(100),
  payload: z
    .object({
      id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
      object: z.literal('event'),
      type: z.string().min(1).max(100),
      created: z.number().int().nonnegative(),
      livemode: z.boolean(),
      data: z.object({ object: z.record(z.string(), z.unknown()) }).loose(),
    })
    .loose(),
});
export type StripeEventJobData = z.infer<typeof stripeEventJobDataSchema>;

export interface StripeEventSummary {
  eventId: string;
  type: string;
  outcome: 'applied' | 'ignored' | 'unresolved';
}

/** What a consumer needs: something that applies one verified event (the web app's `handle`). */
export interface StripeEventHandlerPort {
  handle(payload: StripeEventJobData['payload']): Promise<StripeEventSummary>;
}

export class StripeEventJobDataError extends Error {
  override readonly name = 'StripeEventJobDataError';
}

/** Validates the job data, then delegates. Throws so BullMQ retries (and dead-letters after 5). */
export const runStripeEventJob = async (
  data: unknown,
  deps: { handler: StripeEventHandlerPort },
): Promise<StripeEventSummary> => {
  const parsed = stripeEventJobDataSchema.safeParse(data);
  if (!parsed.success) {
    // Never retryable: the data itself is wrong. Still throws so the job lands in `failed`.
    throw new StripeEventJobDataError(
      `invalid stripe-events job data: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  if (parsed.data.payload.id !== parsed.data.eventId) {
    throw new StripeEventJobDataError('job eventId does not match payload.id');
  }
  return deps.handler.handle(parsed.data.payload);
};

/** Placeholder port until the worker has a database: every job fails with a clear message. */
export class UnconfiguredStripeEventHandler implements StripeEventHandlerPort {
  async handle(): Promise<StripeEventSummary> {
    throw new Error(
      'stripe-events consumer is not wired in the worker yet (needs @harbour/db); leave STRIPE_EVENTS_CONSUMER unset so the web app consumes the queue',
    );
  }
}
