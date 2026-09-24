import {
  createMilestoneProvider,
  createPositionProvider,
  milestoneProviderForWebhook,
  processProviderEvents,
  type MilestoneProvider,
  type NormalisedMilestone,
  type ProcessSummary,
  type TrackingLog,
} from '@harbour/adapters';
import { PrismaTrackingStore, type PrismaClient } from '@harbour/db';
import type { Env } from '../env.server';
import type { Logger } from '../logger.server';
import type { CspAdditions } from '../security-headers.server';
import type { RedisClient } from '../redis.server';
import { AisRelay, MemoryAisCache, redisAisCache } from './ais-relay.server';
import { mapCspAdditions } from './csp.server';

/**
 * M9 (ADR-0017) — tracking composition for the web app: the milestone provider (subscribe /
 * unsubscribe / webhook parsing), the queue the webhook route hands events to, and the map's
 * configuration. Built once in app.server.ts; routes read it through `getApp().tracking`.
 *
 * Queue (brief §6.4 "enqueue immediately, return 200 within 2 s"): with REDIS_URL the events go
 * to the BullMQ queue `tracking-events` and the worker processes them; without it (development,
 * tests) they are processed inline and that is logged, so nothing is silently dropped.
 */
export const TRACKING_EVENTS_QUEUE = 'tracking-events';

export interface TrackingEventsJob {
  source: string;
  events: NormalisedMilestone[];
  receivedAt: string;
}

export interface TrackingQueue {
  readonly backend: 'bullmq' | 'inline' | 'none';
  /** Resolves once the job is accepted (BullMQ) or processed (inline). */
  enqueue(job: TrackingEventsJob): Promise<{ queued: boolean; summary?: ProcessSummary }>;
}

export interface TrackingServices {
  milestoneProvider: MilestoneProvider;
  /** Name only — for the "Tracking not configured" notice and the startup log. */
  positionProviderName: string;
  positionProviderConfigured: boolean;
  store: PrismaTrackingStore | null;
  queue: TrackingQueue;
  mapStyleUrl: string;
  /** Map CSP sources (tile hosts, blob workers, data icons), applied to every response by entry.server. */
  mapCsp: CspAdditions;
  /** `DEMO_FLEET=on`: the Home map offers a simulated fleet and advances it on every map load. */
  demoFleetEnabled: boolean;
  /** `AISSTREAM_API_KEY`: the live AIS relay behind `/app/api/ais` (the key stays server-side), or null. */
  ais: AisRelay | null;
  /** Webhook provider for `/webhooks/tracking/:providerId`, or null for an unknown id. */
  webhookProvider(providerId: string): MilestoneProvider | null;
  webhookSecret(providerId: string): string | undefined;
}

export interface TrackingDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient | null;
  now?: () => Date;
  /** Test seam: replaces the BullMQ producer. */
  queue?: TrackingQueue;
  /** Shared AIS snapshot cache across instances; without it the relay caches in-process. */
  redis?: RedisClient | null;
}

const loggerAsTrackingLog = (logger: Logger): TrackingLog => ({
  info: (event, fields) => logger.info(event, fields),
  warn: (event, fields) => logger.warn(event, fields),
});

/** Processes events in this process (no Redis). */
export const inlineQueue = (
  store: PrismaTrackingStore | null,
  logger: Logger,
  now: () => Date,
): TrackingQueue => ({
  backend: store ? 'inline' : 'none',
  async enqueue(job) {
    if (!store) {
      logger.warn('tracking.events_dropped', { reason: 'no database', count: job.events.length });
      return { queued: false };
    }
    const summary = await processProviderEvents(store, job.events, {
      source: job.source,
      now: now(),
      log: loggerAsTrackingLog(logger),
    });
    logger.info('tracking.events_processed_inline', { source: job.source, ...summary });
    return { queued: true, summary };
  },
});

/** BullMQ producer on its own connection (BullMQ wants `maxRetriesPerRequest: null`). Lazy. */
export const bullmqQueue = (redisUrl: string, logger: Logger): TrackingQueue => {
  let queuePromise: Promise<{
    add(name: string, data: unknown, opts?: object): Promise<unknown>;
  }> | null = null;
  const queue = () => {
    queuePromise ??= (async () => {
      const [{ Queue }, { default: IORedis }] = await Promise.all([
        import('bullmq'),
        import('ioredis'),
      ]);
      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
      });
      connection.on('error', (err: unknown) =>
        logger.error('tracking.queue_redis_error', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return new Queue(TRACKING_EVENTS_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      });
    })();
    return queuePromise;
  };
  return {
    backend: 'bullmq',
    async enqueue(job) {
      const q = await queue();
      await q.add(TRACKING_EVENTS_QUEUE, job);
      return { queued: true };
    },
  };
};

export const createTrackingServices = (deps: TrackingDeps): TrackingServices => {
  const { env, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const milestoneProvider = createMilestoneProvider(env, { now });
  const positionProvider = createPositionProvider(env);
  const store = deps.prisma ? new PrismaTrackingStore(deps.prisma) : null;
  const queue =
    deps.queue ??
    (env.REDIS_URL ? bullmqQueue(env.REDIS_URL, logger) : inlineQueue(store, logger, now));

  logger.info('tracking.configured', {
    milestoneProvider: milestoneProvider.name,
    positionProvider: positionProvider.name,
    // Presence only — never the values.
    webhookSecret: env.TERMINAL49_WEBHOOK_SECRET !== undefined,
    queue: queue.backend,
    mapStyleUrl: env.MAP_STYLE_URL,
    demoFleet: env.DEMO_FLEET,
    aisStream: env.AISSTREAM_API_KEY !== undefined,
  });

  return {
    milestoneProvider,
    positionProviderName: positionProvider.name,
    positionProviderConfigured: positionProvider.configured,
    store,
    queue,
    mapStyleUrl: env.MAP_STYLE_URL,
    mapCsp: mapCspAdditions(env.MAP_STYLE_URL, env.MAP_TILE_ORIGINS ?? []),
    demoFleetEnabled: env.DEMO_FLEET === 'on',
    ais: env.AISSTREAM_API_KEY
      ? new AisRelay({
          apiKey: env.AISSTREAM_API_KEY,
          cache: deps.redis ? redisAisCache(deps.redis) : new MemoryAisCache(),
          log: logger,
          now: () => now().getTime(),
        })
      : null,
    webhookProvider: (providerId) => milestoneProviderForWebhook(providerId, env, { now }),
    webhookSecret: (providerId) =>
      providerId === 'terminal49' ? env.TERMINAL49_WEBHOOK_SECRET : undefined,
  };
};
