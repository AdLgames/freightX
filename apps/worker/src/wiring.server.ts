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
// M5: document-scan job — storage, scanner and the Prisma-backed scan store
import {
  createMalwareScanner,
  createObjectStorage,
  resolveStorageConfig,
  storageEnvSchema,
} from '@harbour/adapters';
import { createPrismaClient, PrismaDocumentScanStore } from '@harbour/db';
// M2 — identity checks (§5.6) need the HMRC adapters, the db package (RLS-scoped store) and the
// field-encryption key provider.
import { HmrcEoriChecker, HmrcVatChecker } from '@harbour/adapters';
import { createKeyProvider, type KeyProvider } from '@harbour/db';
import { z } from 'zod';
import { ConsoleAlertSink, WebhookAlertSink } from './alerts.js';
import {
  PrismaIdentityVerificationStore,
  UnavailableIdentityVerificationStore,
} from './identity-store.server.js'; // M2
import { runEoriVerify } from './jobs/eori-verify.js'; // M2
import { runFxRefresh, type FxRefreshSummary } from './jobs/fx-refresh.js';
import { RepeatedErrorTracker, type IdentityVerifySummary } from './jobs/identity-verify.js'; // M2
import { runVatVerify } from './jobs/vat-verify.js'; // M2
import { runQuoteExpiry, type QuoteExpirySummary } from './jobs/quote-expiry.js';
import {
  runDocumentScanJob,
  type DocumentScanPort,
  type DocumentScanSummary,
} from './jobs/document-scan.js'; // M5
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
// M6
import {
  UnconfiguredStripeEventHandler,
  runStripeEventJob,
  type StripeEventHandlerPort,
  type StripeEventSummary,
} from './jobs/stripe-events.js';
// end M6
// M9 (ADR-0017): tracking jobs and their Prisma-backed stores (only when DATABASE_URL is set).
import { createMilestoneProvider, createPositionProvider } from '@harbour/adapters';
import {
  PrismaTrackingStore,
  PrismaVesselPollStore,
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
  // M6: who consumes the `stripe-events` queue. Unset/`web` → the web app (default today);
  // `worker` → this process, which needs a database-backed StripeEventHandlerPort (TODO(db)).
  STRIPE_EVENTS_CONSUMER: z.enum(['web', 'worker']).default('web'),
  // end M6
  // M5: document-scan. Storage (STORAGE_*), scanner (CLAMD_*) and the database the scan store
  // writes to. All optional: without them the document-scan queue fails loudly per job.
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  ...storageEnvSchema.shape,
  // M2 — identity verification jobs: the database (RLS-scoped, see identity-store.server.ts) and
  // the SAME field-encryption master key as apps/web. Both optional so the FX/tariff/expiry jobs
  // keep running without them; the identity jobs then fail with a clear message.
  // (DATABASE_URL is declared above with M5.)
  FIELD_ENCRYPTION_KEY: z.string().min(1).optional(),
  HMRC_API_BASE_URL: z.url().optional(),
  // M9 (ADR-0017). Unset DATABASE_URL (declared above) → the tracking jobs log and exit; keys are never logged.
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
  // M6
  stripeEvents: StripeEventHandlerPort;
  runStripeEvent: (data: unknown) => Promise<StripeEventSummary>;
  // end M6
  /** `data` is the BullMQ job payload; only on-demand queues (M5 document-scan, M2 identity) read it. */
  runJob: (queue: QueueName, data?: unknown) => Promise<JobSummary>;
  /** M2: null when FIELD_ENCRYPTION_KEY is unset (identity jobs fail with a clear error). */
  keyProvider: KeyProvider | null;
}

export type JobSummary =
  | FxRefreshSummary
  | TariffRefreshSummary
  | QuoteExpirySummary
  | DocumentScanSummary // M5
  | IdentityVerifySummary // M2
  | VesselPollSummary // M9
  | TrackingEventsSummary // M9
  | TrackingPollSummary; // M9

// M5: builds the document-scan port from the environment, or explains what is missing.
export type DocumentScanWiring = { port: DocumentScanPort } | { missing: string[] };

export const buildDocumentScanWiring = (env: WorkerEnv): DocumentScanWiring => {
  const missing: string[] = [];
  const storageConfig = resolveStorageConfig(env, { production: env.NODE_ENV === 'production' });
  if (storageConfig.kind === 'unconfigured') missing.push(`storage (${storageConfig.reason})`);
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length > 0 || storageConfig.kind === 'unconfigured' || !env.DATABASE_URL) {
    return { missing };
  }
  const storage = createObjectStorage(storageConfig, {
    // The worker never presigns; these only satisfy the local backend's constructor.
    localBaseUrl: 'http://localhost',
    localFallbackSecret: env.STORAGE_LOCAL_SECRET ?? 'worker-never-signs-local-urls',
  });
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL, log: ['warn', 'error'] });
  return {
    port: {
      storage,
      scanner: createMalwareScanner(env),
      store: new PrismaDocumentScanStore(prisma),
    },
  };
};

export const buildWiring = (
  env: WorkerEnv,
  opts: { fetch?: FetchLike; now?: () => Date; documentScan?: DocumentScanPort } = {},
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

  // M5: built lazily so a worker without storage/database still runs the other queues.
  let documentScan: DocumentScanWiring | undefined = opts.documentScan
    ? { port: opts.documentScan }
    : undefined;
  const documentScanPort = (): DocumentScanPort => {
    documentScan ??= buildDocumentScanWiring(env);
    if ('missing' in documentScan) {
      throw new Error(
        `document-scan is not configured: missing ${documentScan.missing.join(', ')}`,
      );
    }
    return documentScan.port;
  };
  // M2 — identity verification (eori-verify, vat-verify). The store runs every statement inside
  // withOrgTransaction, so the worker's DB login must be a member of harbour_app (RLS applies).
  const identityStore = env.DATABASE_URL
    ? new PrismaIdentityVerificationStore(createPrismaClient({ databaseUrl: env.DATABASE_URL }))
    : new UnavailableIdentityVerificationStore();
  const keyChoice = createKeyProvider({
    masterKey: env.FIELD_ENCRYPTION_KEY,
    // The worker must share apps/web's key; an ephemeral one could never decrypt anything, so
    // treat "unset" like production (fail closed) whatever NODE_ENV says.
    nodeEnv: 'production',
  });
  const keyProvider = keyChoice.provider;
  const hmrcBase = env.HMRC_API_BASE_URL ? { baseUrl: env.HMRC_API_BASE_URL } : {};
  const eoriChecker = new HmrcEoriChecker({ fetch: fetchImpl, now, ...hmrcBase });
  const vatChecker = new HmrcVatChecker({ fetch: fetchImpl, now, ...hmrcBase });
  const identityErrors = new RepeatedErrorTracker();
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
      case 'document-scan': // M5
        return runDocumentScanJob({ port: documentScanPort(), alerts, now }, data);
      // M2
      case 'eori-verify':
        return runEoriVerify(data, {
          store: identityStore,
          keyProvider,
          checker: eoriChecker,
          now,
          alerts,
          errors: identityErrors,
        });
      case 'vat-verify':
        return runVatVerify(data, {
          store: identityStore,
          keyProvider,
          checker: vatChecker,
          now,
          alerts,
          errors: identityErrors,
        });
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

  // M6: TODO(db) replace with a Prisma-backed handler (apps/web billing/events.server.ts logic).
  const stripeEvents: StripeEventHandlerPort = new UnconfiguredStripeEventHandler();
  const runStripeEvent = (data: unknown): Promise<StripeEventSummary> =>
    runStripeEventJob(data, { handler: stripeEvents });
  // end M6

  return { ports, tariffCache, runJob, stripeEvents, runStripeEvent, keyProvider };
};
