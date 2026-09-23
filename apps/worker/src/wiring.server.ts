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
import { z } from 'zod';
import { ConsoleAlertSink, WebhookAlertSink } from './alerts.js';
import { runFxRefresh, type FxRefreshSummary } from './jobs/fx-refresh.js';
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
  // M5: document-scan. Storage (STORAGE_*), scanner (CLAMD_*) and the database the scan store
  // writes to. All optional: without them the document-scan queue fails loudly per job.
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  ...storageEnvSchema.shape,
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
  /** `data` is the BullMQ job payload; only on-demand queues (M5 document-scan) read it. */
  runJob: (queue: QueueName, data?: unknown) => Promise<JobSummary>;
}

export type JobSummary =
  FxRefreshSummary | TariffRefreshSummary | QuoteExpirySummary | DocumentScanSummary; // M5

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
    }
  };

  return { ports, tariffCache, runJob };
};
