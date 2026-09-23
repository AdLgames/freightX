import {
  InMemoryFxStore,
  InMemoryTariffCache,
  type FxRateStore,
  type TariffCacheStore,
} from '@harbour/adapters';
import type { Env } from './env.server';
import type { Logger } from './logger.server';
import {
  InMemoryEmailSignupRepository,
  type EmailSignupRepository,
} from './signup-repository.server';

/**
 * Persistence seam. Everything the web app persists goes through these three interfaces.
 *
 * TODO(db): wire the Prisma-backed implementations from `@harbour/db` here, and nowhere else:
 *   - `TariffCacheStore`  → Prisma model `TariffCache` (§5.2, 24h TTL)
 *   - `FxRateStore`       → Prisma model `FxRate` (§5.7, read-only in the request path)
 *   - `EmailSignupRepository` → Prisma model `EmailSignup`
 * When `DATABASE_URL` is set, construct `createPrismaClient()` and return the Prisma stores;
 * `@harbour/db` must NOT be imported until then so this app typechecks/builds without it.
 * Keep the in-memory branch for tests and for `DATABASE_URL`-less local runs.
 */
export interface Stores {
  backend: 'memory' | 'postgres';
  tariffCache: TariffCacheStore;
  fxStore: FxRateStore;
  signups: EmailSignupRepository;
}

export const createStores = (env: Env, logger: Logger): Stores => {
  if (env.DATABASE_URL) {
    logger.warn('db.not_wired', {
      message:
        'DATABASE_URL is set but the Prisma stores are not wired yet (app/services/db.server.ts); using in-memory stores.',
    });
  } else {
    logger.info('db.memory', {
      message:
        'DATABASE_URL unset: using in-memory tariff cache, FX store and signup list (lost on restart).',
    });
  }
  return {
    backend: 'memory',
    tariffCache: new InMemoryTariffCache(),
    fxStore: new InMemoryFxStore(),
    signups: new InMemoryEmailSignupRepository(),
  };
};
