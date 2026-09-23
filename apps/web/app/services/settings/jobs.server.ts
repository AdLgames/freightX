import type { Logger } from '../logger.server';

/**
 * M2 — the web app's port for handing work to apps/worker. Today: the on-demand identity checks
 * (`eori-verify`, `vat-verify`, payload `{ organizationId }`), enqueued after an EORI / VAT number
 * is saved.
 *
 * - `REDIS_URL` set → `BullmqJobEnqueuer`: `Queue.add` on a dedicated ioredis connection (BullMQ
 *   wants `maxRetriesPerRequest: null`; the shared rate-limit/session client is configured
 *   differently). Job options mirror the worker's defaults (5 attempts, exponential backoff).
 * - Otherwise → `MemoryJobEnqueuer`: records the job and logs `jobs.enqueue_skipped` at warn. The
 *   status stays PENDING until a worker exists; the settings page says so.
 *
 * `enqueue` never throws: a queue outage must not fail the save that triggered it (the status is
 * PENDING either way and the next save re-enqueues). Payloads carry ids only.
 */
export const JOB_QUEUES = ['eori-verify', 'vat-verify'] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

export interface JobPayload {
  organizationId: string;
}

export interface JobEnqueuer {
  readonly backend: 'bullmq' | 'memory';
  /** Resolves true when the job was accepted by the backend. */
  enqueue(queue: JobQueue, payload: JobPayload): Promise<boolean>;
}

/** Same shape as apps/worker `DEFAULT_JOB_OPTIONS` (kept in step by hand; the packages do not share code). */
export const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
} as const;

export class MemoryJobEnqueuer implements JobEnqueuer {
  readonly backend = 'memory' as const;
  readonly enqueued: Array<{ queue: JobQueue; payload: JobPayload }> = [];
  constructor(private readonly logger: Logger) {}

  async enqueue(queue: JobQueue, payload: JobPayload): Promise<boolean> {
    this.enqueued.push({ queue, payload });
    this.logger.warn('jobs.enqueue_skipped', {
      queue,
      orgId: payload.organizationId,
      message: 'REDIS_URL is unset: no worker will run this job; the status stays PENDING.',
    });
    return false;
  }
}

/** The slice of `bullmq.Queue` used, so tests can pass a fake. */
export interface AddableQueue {
  add(name: string, data: JobPayload, opts?: object): Promise<unknown>;
}

export class BullmqJobEnqueuer implements JobEnqueuer {
  readonly backend = 'bullmq' as const;
  private readonly queues = new Map<JobQueue, Promise<AddableQueue>>();

  constructor(
    private readonly openQueue: (name: JobQueue) => Promise<AddableQueue>,
    private readonly logger: Logger,
  ) {}

  async enqueue(queue: JobQueue, payload: JobPayload): Promise<boolean> {
    try {
      let pending = this.queues.get(queue);
      if (!pending) {
        pending = this.openQueue(queue);
        this.queues.set(queue, pending);
      }
      const q = await pending;
      await q.add(queue, payload, JOB_OPTIONS);
      this.logger.info('jobs.enqueued', { queue, orgId: payload.organizationId });
      return true;
    } catch (err) {
      this.queues.delete(queue);
      this.logger.error('jobs.enqueue_failed', {
        queue,
        orgId: payload.organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/** Opens a BullMQ queue on its own ioredis connection (lazily, on first use). */
export const bullmqQueueOpener =
  (redisUrl: string) =>
  async (name: JobQueue): Promise<AddableQueue> => {
    const [{ Queue }, { default: IORedis }] = await Promise.all([
      import('bullmq'),
      import('ioredis'),
    ]);
    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 5_000,
    });
    // Reported through the enqueue result; the URL (which may carry a password) is never logged.
    connection.on('error', () => {});
    return new Queue(name, { connection });
  };

export const createJobEnqueuer = (redisUrl: string | undefined, logger: Logger): JobEnqueuer =>
  redisUrl
    ? new BullmqJobEnqueuer(bullmqQueueOpener(redisUrl), logger)
    : new MemoryJobEnqueuer(logger);
