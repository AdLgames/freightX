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
  runJob: (queue: QueueName) => Promise<JobSummary>;
}

export type JobSummary = FxRefreshSummary | TariffRefreshSummary | QuoteExpirySummary;

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

  const runJob = async (queue: QueueName): Promise<JobSummary> => {
    switch (queue) {
      case 'fx-refresh':
        return runFxRefresh({ fetch: fetchImpl, store: fxStore, now, alerts });
      case 'tariff-refresh':
        return runTariffRefresh({ client: tariffClient, codes: hsCodes, now, alerts });
      case 'quote-expiry':
        return runQuoteExpiry({ port: quoteExpiry, now });
    }
  };

  return { ports, tariffCache, runJob };
};
