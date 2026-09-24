/**
 * Composition root for the worker process. Everything environment-specific happens here so the
 * jobs stay pure and testable.
 *
 * TODO(db): plug in the Prisma-backed implementations from `@harbour/db` once it ships:
 *   - `fxStore`      → `FxRate` (unique on (source, currency, validFrom); `rateToGbp` Decimal(14,6))
 *   - `quoteExpiry`  → `prisma.quote.updateMany({ where: { validUntil: { lt: now },
 *                       status: { in: ['READY', 'INDICATIVE', 'DRAFT'] } }, data: { status: 'EXPIRED' } })`
 *                       — never ACCEPTED (see `QuoteExpiryPort` in ports.ts). Must run with a
 *                       service-role connection that bypasses tenant RLS (this is a cross-org sweep).
 *   - `hsCodes`      → `SELECT DISTINCT hs_code FROM products` (Phase 1); until then
 *                       `TARIFF_REFRESH_CODES`.
 *   - `tariffCache`  → `TariffCache` rows (keyed hsCode + originCountry in the schema; the
 *                       adapter's `TariffCacheStore` is keyed by code only — the DB adapter
 *                       should use a fixed origin key such as '*' for the unfiltered payload).
 */
import {
  InMemoryFxStore,
  InMemoryTariffCache,
  UkTradeTariffClient,
  type FetchLike,
  type TariffCacheStore,
} from '@harbour/adapters';
import { z } from 'zod';
import { ConsoleAlertSink, WebhookAlertSink } from './alerts.js';
import { runFxRefresh, type FxRefreshSummary } from './jobs/fx-refresh.js';
import { runQuoteExpiry, type QuoteExpirySummary } from './jobs/quote-expiry.js';
import {
  refreshingCacheView,
  runTariffRefresh,
  type TariffRefreshSummary,
} from './jobs/tariff-refresh.js';
import {
  CompositeAlertSink,
  InMemoryQuoteExpiryPort,
  StaticHsCodeSource,
  type WorkerPorts,
} from './ports.js';
import type { QueueName } from './queues.js';
// M9 (ADR-0017): tracking jobs and their Prisma-backed stores (only when DATABASE_URL is set).
import { createMilestoneProvider, createPositionProvider } from '@harbour/adapters';
import {
  PrismaTrackingStore,
  PrismaVesselPollStore,
  createPrismaClient,
  withOrgTransaction,
  withTrackingSweep,
  type PrismaClient,
} from '@harbour/db';
import { log as workerLog } from './log.js';
import {
  runTrackingEvents,
  runTrackingPoll,
  type TrackingEventsSummary,
  type TrackingPollSummary,
} from './jobs/tracking-events.js';
import { runVesselPoll, type VesselPollSummary } from './jobs/vessel-poll.js';

const csvList = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c !== ''),
  );

export const envSchema = z.object({
  REDIS_URL: z.string().min(1).optional(),
  ALERT_WEBHOOK_URL: z.url().optional(),
  WORKER_PORT: z.coerce.number().int().min(0).max(65535).default(9090),
  TARIFF_REFRESH_CODES: csvList,
  UK_TRADE_TARIFF_BASE_URL: z.url().optional(),
  // M9 (ADR-0017). Unset DATABASE_URL → the tracking jobs log and exit; keys are never logged.
  DATABASE_URL: z.string().min(1).optional(),
  TRACKING_MILESTONE_PROVIDER: z.enum(['terminal49', 'none']).default('none'),
  TRACKING_POSITION_PROVIDER: z.enum(['spire', 'marinetraffic', 'none']).default('none'),
  TERMINAL49_API_KEY: z.string().min(1).optional(),
  SPIRE_API_TOKEN: z.string().min(1).optional(),
  MARINETRAFFIC_API_KEY: z.string().min(1).optional(),
});
export type WorkerEnv = z.infer<typeof envSchema>;

export const readEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker environment: ${issues}`);
  }
  return parsed.data;
};

export interface Wiring {
  ports: WorkerPorts;
  tariffCache: TariffCacheStore;
  /** `data` is the BullMQ job payload (M9: `tracking-events` jobs carry the events). */
  runJob: (queue: QueueName, data?: unknown) => Promise<JobSummary>;
}

export type JobSummary =
  | FxRefreshSummary
  | TariffRefreshSummary
  | QuoteExpirySummary
  | VesselPollSummary // M9
  | TrackingEventsSummary // M9
  | TrackingPollSummary; // M9

export const buildWiring = (
  env: WorkerEnv,
  opts: { fetch?: FetchLike; now?: () => Date } = {},
): Wiring => {
  const now = opts.now ?? (() => new Date());
  const fetchImpl: FetchLike = opts.fetch ?? globalThis.fetch;

  const alerts = new CompositeAlertSink([
    new ConsoleAlertSink(),
    ...(env.ALERT_WEBHOOK_URL ? [new WebhookAlertSink(env.ALERT_WEBHOOK_URL)] : []),
  ]);

  // TODO(db): replace these three with Prisma-backed implementations (see file header).
  const fxStore = new InMemoryFxStore();
  const quoteExpiry = new InMemoryQuoteExpiryPort();
  const hsCodes = new StaticHsCodeSource(env.TARIFF_REFRESH_CODES);
  const tariffCache: TariffCacheStore = new InMemoryTariffCache();

  const ports: WorkerPorts = { fxStore, quoteExpiry, hsCodes, alerts };

  const tariffClient = new UkTradeTariffClient({
    fetch: fetchImpl,
    now,
    cache: refreshingCacheView(tariffCache, { now }),
    ...(env.UK_TRADE_TARIFF_BASE_URL ? { baseUrl: env.UK_TRADE_TARIFF_BASE_URL } : {}),
  });

  // M9 (ADR-0017): tracking providers and stores. One Prisma pool per process, only with a
  // DATABASE_URL. The worker uses the same DB role as the app for now (packages/db README "0010").
  const prisma: PrismaClient | null = env.DATABASE_URL
    ? createPrismaClient({ databaseUrl: env.DATABASE_URL, log: ['warn', 'error'] })
    : null;
  const trackingStore = prisma ? new PrismaTrackingStore(prisma) : null;
  const vesselStore = prisma ? new PrismaVesselPollStore(prisma) : null;
  const milestoneProvider = createMilestoneProvider(env, { now });
  const positionProvider = createPositionProvider(env);
  const trackingLog = {
    info: (event: string, fields?: Record<string, unknown>) => workerLog(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) =>
      workerLog(event, { level: 'warn', ...fields }),
  };

  const runJob = async (queue: QueueName, data?: unknown): Promise<JobSummary> => {
    switch (queue) {
      case 'fx-refresh':
        return runFxRefresh({ fetch: fetchImpl, store: fxStore, now, alerts });
      case 'tariff-refresh':
        return runTariffRefresh({ client: tariffClient, codes: hsCodes, now, alerts });
      case 'quote-expiry':
        return runQuoteExpiry({ port: quoteExpiry, now });
      // M9
      case 'vessel-poll':
        if (!vesselStore) {
          workerLog('vessel_poll.no_database', {});
          return {
            provider: positionProvider.name,
            due: 0,
            polled: 0,
            updated: 0,
            missing: 0,
            failed: 0,
            stale: 0,
            skipped: 'NOT_CONFIGURED',
            asOf: now().toISOString(),
          };
        }
        return runVesselPoll({
          provider: positionProvider,
          store: vesselStore,
          alerts,
          now,
          log: workerLog,
        });
      case 'tracking-events':
        return runTrackingEvents({ store: trackingStore, now, log: trackingLog }, data);
      case 'tracking-poll':
        return runTrackingPoll({
          store: trackingStore,
          provider: milestoneProvider,
          now,
          log: trackingLog,
          listDue: (input) => (prisma ? withTrackingSweep(prisma, input) : Promise.resolve([])),
          markPolled: (organizationId, shipmentId, at) =>
            prisma
              ? withOrgTransaction(prisma, organizationId, async (tx) => {
                  await tx.shipment.update({
                    where: { id: shipmentId },
                    data: { lastPolledAt: at },
                  });
                })
              : Promise.resolve(),
        });
    }
  };

  return { ports, tariffCache, runJob };
};
