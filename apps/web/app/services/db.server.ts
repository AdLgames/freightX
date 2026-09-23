import {
  InMemoryFxStore,
  InMemoryTariffCache,
  type FxRateStore,
  type TariffCacheStore,
} from '@harbour/adapters';
import {
  PrismaEmailSignupRepository,
  PrismaFxRateStore,
  PrismaTariffCacheStore,
  createPrismaClient,
  type PrismaClient,
} from '@harbour/db';
import type { Env } from './env.server';
import type { Logger } from './logger.server';
import {
  InMemoryEmailSignupRepository,
  type EmailSignupRepository,
} from './signup-repository.server';

/**
 * Persistence seam. Everything the web app persists goes through these three interfaces.
 *
 * With `DATABASE_URL` set they are the Prisma-backed stores from `@harbour/db`:
 *   - `TariffCacheStore`  → `TariffCache` (§5.2; the 24h TTL is decided by the tariff client)
 *   - `FxRateStore`       → `FxRate` (§5.7; read-only in the request path, see below)
 *   - `EmailSignupRepository` → `EmailSignup`
 * Without it, in-memory stores (tests, `DATABASE_URL`-less local runs).
 *
 * The connection must be a non-superuser member of `harbour_app` (packages/db README). These three
 * tables are global (no RLS), so no tenant context is involved here.
 */
export interface Stores {
  backend: 'memory' | 'postgres';
  tariffCache: TariffCacheStore;
  fxStore: FxRateStore;
  signups: EmailSignupRepository;
}

/**
 * One Prisma client (= one connection pool) per process. `createPrismaClient` only caches on
 * globalThis outside production (dev HMR); this module-level singleton covers production too, where
 * a warm serverless instance (Vercel) re-runs route code but keeps module state.
 */
let prismaSingleton: PrismaClient | undefined;
const getPrisma = (databaseUrl: string): PrismaClient => {
  prismaSingleton ??= createPrismaClient({ databaseUrl });
  return prismaSingleton;
};

/**
 * When `FX_SEED_CSV` is unset, startup seeding (fx.server.ts) loads the adapters' SAMPLE rates,
 * labelled HMRC_MONTHLY. Those must never reach the shared `fx_rates` table: they would overwrite
 * real rates with the same (source, currency, validFrom) key on every cold start. So in that case
 * writes stay in this process and reads prefer Postgres (rates written by the FX job), falling back
 * to the in-process sample exactly as the in-memory backend would.
 */
const withProcessLocalSampleSeed = (db: FxRateStore): FxRateStore => {
  const sample = new InMemoryFxStore();
  return {
    find: async (source, currency, at) =>
      (await db.find(source, currency, at)) ?? sample.find(source, currency, at),
    upsert: (records) => sample.upsert(records),
  };
};

export const createStores = (env: Env, logger: Logger): Stores => {
  if (env.DATABASE_URL) {
    const prisma = getPrisma(env.DATABASE_URL);
    const fxStore = new PrismaFxRateStore(prisma);
    logger.info('db.postgres', {
      message: env.FX_SEED_CSV
        ? 'DATABASE_URL set: using Postgres tariff cache, FX store and signup list.'
        : 'DATABASE_URL set: using Postgres tariff cache, FX store and signup list; sample FX seed rates stay in-process and are never written to fx_rates.',
    });
    return {
      backend: 'postgres',
      tariffCache: new PrismaTariffCacheStore(prisma, {
        onCorruptRow: ({ hsCode, issues }) =>
          logger.warn('tariff_cache.corrupt_row', { hsCode, issues }),
      }),
      fxStore: env.FX_SEED_CSV ? fxStore : withProcessLocalSampleSeed(fxStore),
      signups: new PrismaEmailSignupRepository(prisma),
    };
  }

  logger.info('db.memory', {
    message:
      'DATABASE_URL unset: using in-memory tariff cache, FX store and signup list (lost on restart).',
  });
  return {
    backend: 'memory',
    tariffCache: new InMemoryTariffCache(),
    fxStore: new InMemoryFxStore(),
    signups: new InMemoryEmailSignupRepository(),
  };
};
