import { z } from 'zod';
import { stripeEventEnvelopeSchema, type StripeEventEnvelope } from '../../validators/billing';
import type { Logger } from '../logger.server';
import type { HandleResult } from './events.server';

/**
 * Webhook → processor hand-off (M6, §6.4 "enqueue immediately, return 200 within 2 s; all
 * processing in the worker"). The route only sees `StripeEventEnqueuer`:
 *
 * - `BullmqStripeEventEnqueuer` — with REDIS_URL: `queue.add` on the `stripe-events` queue, job id
 *   = Stripe event id (BullMQ dedupes on it), 5 attempts with exponential backoff, failed jobs
 *   kept (the dead-letter set, §6.4). The consumer runs in this web process
 *   (`startStripeEventWorker`), because it is the process that has Prisma and the email transport
 *   today; `apps/worker/src/jobs/stripe-events.ts` carries the same job contract for the day the
 *   worker gets a database (its README says so).
 * - `InlineStripeEventEnqueuer` — no REDIS_URL (development, tests): processes before responding,
 *   and says so in the log. A processing error becomes a 500 so Stripe redelivers.
 *
 * The queue name and job data shape are duplicated in the worker package on purpose (apps do not
 * import each other); keep them identical.
 */
export const STRIPE_EVENTS_QUEUE = 'stripe-events';

export const stripeEventJobDataSchema = z.object({
  eventId: z.string().regex(/^evt_/),
  type: z.string().min(1),
  payload: stripeEventEnvelopeSchema,
});
export type StripeEventJobData = z.infer<typeof stripeEventJobDataSchema>;

/** Same shape as the worker's DEFAULT_JOB_OPTIONS, but failed jobs are kept for inspection. */
export const STRIPE_EVENT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: false,
} as const;

export interface StripeEventEnqueuer {
  readonly backend: 'inline' | 'bullmq';
  enqueue(event: StripeEventEnvelope): Promise<void>;
}

export type StripeEventHandler = (event: StripeEventEnvelope) => Promise<HandleResult>;

export class InlineStripeEventEnqueuer implements StripeEventEnqueuer {
  readonly backend = 'inline' as const;
  constructor(
    private readonly handle: StripeEventHandler,
    private readonly logger: Logger,
  ) {}

  async enqueue(event: StripeEventEnvelope): Promise<void> {
    this.logger.info('billing.event_inline', { eventId: event.id, type: event.type });
    await this.handle(event);
  }
}

/** The slice of `bullmq.Queue` the enqueuer needs (stubbable in tests). */
export interface StripeEventQueue {
  add(name: string, data: StripeEventJobData, opts: Record<string, unknown>): Promise<unknown>;
}

export class BullmqStripeEventEnqueuer implements StripeEventEnqueuer {
  readonly backend = 'bullmq' as const;
  constructor(private readonly queue: StripeEventQueue) {}

  async enqueue(event: StripeEventEnvelope): Promise<void> {
    await this.queue.add(
      event.type,
      { eventId: event.id, type: event.type, payload: event },
      { ...STRIPE_EVENT_JOB_OPTIONS, jobId: event.id },
    );
  }
}

// ---------- BullMQ wiring (only with REDIS_URL) ----------

export interface StripeEventWorkerHandle {
  close(): Promise<void>;
}

/**
 * Creates the queue and starts the consumer on a dedicated ioredis connection (BullMQ needs
 * `maxRetriesPerRequest: null` for its blocking reads, unlike the shared web connection). Errors
 * go to the logger; a job that exhausts its attempts is reported as `billing.event_dead_lettered`
 * at error level — the alert of §6.4 in a log-alerting setup.
 */
export const startStripeEventQueue = async (
  redisUrl: string,
  handle: StripeEventHandler,
  logger: Logger,
): Promise<{ enqueuer: BullmqStripeEventEnqueuer; worker: StripeEventWorkerHandle }> => {
  const [{ Queue, Worker }, { default: IORedis }] = await Promise.all([
    import('bullmq'),
    import('ioredis'),
  ]);
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  connection.on('error', (err: unknown) =>
    logger.error('billing.queue_redis_error', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const queue = new Queue(STRIPE_EVENTS_QUEUE, { connection });
  const worker = new Worker(
    STRIPE_EVENTS_QUEUE,
    async (job) => {
      const data = stripeEventJobDataSchema.parse(job.data);
      return handle(data.payload);
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    const attempt = job?.attemptsMade ?? 0;
    const attempts = job?.opts.attempts ?? 1;
    const fields = { eventId: job?.id, attempt, attempts, error: err.message };
    if (attempt >= attempts) logger.error('billing.event_dead_lettered', fields);
    else logger.warn('billing.event_retry', fields);
  });
  worker.on('error', (err) => logger.error('billing.queue_worker_error', { error: err.message }));
  logger.info('billing.queue_started', { queue: STRIPE_EVENTS_QUEUE });
  return {
    enqueuer: new BullmqStripeEventEnqueuer(queue),
    worker: {
      close: async () => {
        await worker.close();
        await queue.close();
        await connection.quit();
      },
    },
  };
};
