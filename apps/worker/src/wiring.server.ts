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
// M2 — identity checks (§5.6) need the HMRC adapters, the db package (RLS-scoped store) and the
// field-encryption key provider.
import { HmrcEoriChecker, HmrcVatChecker } from '@harbour/adapters';
import { createKeyProvider, createPrismaClient, type KeyProvider } from '@harbour/db';
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
  // M2 — identity verification jobs: the database (RLS-scoped, see identity-store.server.ts) and
  // the SAME field-encryption master key as apps/web. Both optional so the FX/tariff/expiry jobs
  // keep running without them; the identity jobs then fail with a clear message.
  DATABASE_URL: z.string().min(1).optional(),
  FIELD_ENCRYPTION_KEY: z.string().min(1).optional(),
  HMRC_API_BASE_URL: z.url().optional(),
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
  /** `data` is the job payload (M2 on-demand jobs read `{ organizationId }`; the others ignore it). */
  runJob: (queue: QueueName, data?: unknown) => Promise<JobSummary>;
  /** M2: null when FIELD_ENCRYPTION_KEY is unset (identity jobs fail with a clear error). */
  keyProvider: KeyProvider | null;
}

export type JobSummary =
  FxRefreshSummary | TariffRefreshSummary | QuoteExpirySummary | IdentityVerifySummary; // M2

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

  const runJob = async (queue: QueueName, data?: unknown): Promise<JobSummary> => {
    switch (queue) {
      case 'fx-refresh':
        return runFxRefresh({ fetch: fetchImpl, store: fxStore, now, alerts });
      case 'tariff-refresh':
        return runTariffRefresh({ client: tariffClient, codes: hsCodes, now, alerts });
      case 'quote-expiry':
        return runQuoteExpiry({ port: quoteExpiry, now });
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
    }
  };

  return { ports, tariffCache, runJob, keyProvider };
};
