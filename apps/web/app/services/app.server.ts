import type { RateSheetFreightProvider, UkTradeTariffClient } from '@harbour/adapters';
import { CALC_VERSION } from '@harbour/engine';
import { createStores, type Stores } from './db.server';
import { loadEnv, type Env } from './env.server';
import { seedFxStore, type FxSeedSummary } from './fx.server';
import { loadFreightProvider, type LaneOption, type RateSheetMeta } from './freight.server';
import { createLogger, type Logger } from './logger.server';
import { createRateLimiter, type RateLimiter } from './rate-limit.server';
import { createTariffClient } from './tariff.server';
import { createTurnstile, type TurnstileVerifier } from './turnstile.server';

/**
 * Composition root. Built once per process (memoised on `globalThis` so `react-router dev`
 * HMR does not rebuild it on every change) and injected into route modules via `getApp()`.
 * Tests replace it with `setAppForTests()`.
 */
export interface AppServices {
  env: Env;
  logger: Logger;
  stores: Stores;
  rateLimiter: RateLimiter;
  rateLimitBackend: 'memory' | 'redis';
  turnstile: TurnstileVerifier;
  tariff: UkTradeTariffClient;
  freight: RateSheetFreightProvider;
  rateSheet: RateSheetMeta;
  lanes: LaneOption[];
  fx: FxSeedSummary;
  calcVersion: string;
  startedAt: Date;
}

export interface AppOverrides {
  env?: Env;
  logger?: Logger;
  now?: () => Date;
}

export const createAppServices = async (overrides: AppOverrides = {}): Promise<AppServices> => {
  const env = overrides.env ?? loadEnv();
  const logger = overrides.logger ?? createLogger({ level: env.logLevel, base: { app: 'web' } });
  const now = overrides.now ?? (() => new Date());
  const startedAt = now();

  const stores = createStores(env, logger);
  const { limiter, backend } = await createRateLimiter(env.REDIS_URL, (err) =>
    logger.error('rate_limit.backend_error', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const turnstile = createTurnstile({
    siteKey: env.TURNSTILE_SITE_KEY,
    secretKey: env.TURNSTILE_SECRET_KEY,
    logger,
    production: env.NODE_ENV === 'production',
  });
  const tariff = createTariffClient({ cache: stores.tariffCache });
  const { provider, meta, lanes } = loadFreightProvider({
    rateSheetPath: env.RATE_SHEET_PATH,
    logger,
    now,
  });
  const fx = await seedFxStore({ store: stores.fxStore, csvPath: env.FX_SEED_CSV, logger, now });

  logger.info('app.started', {
    nodeEnv: env.NODE_ENV,
    calcVersion: CALC_VERSION,
    rateSheet: meta.version,
    rateLimitBackend: backend,
    turnstile: turnstile.enabled,
    fxSource: fx.source,
    stores: stores.backend,
  });

  return {
    env,
    logger,
    stores,
    rateLimiter: limiter,
    rateLimitBackend: backend,
    turnstile,
    tariff,
    freight: provider,
    rateSheet: meta,
    lanes,
    fx,
    calcVersion: CALC_VERSION,
    startedAt,
  };
};

const KEY = '__harbourApp';
type Holder = { [KEY]?: Promise<AppServices> };
const holder = globalThis as unknown as Holder;

export const getApp = (): Promise<AppServices> => {
  holder[KEY] ??= createAppServices();
  return holder[KEY];
};

export const setAppForTests = (app: AppServices | null): void => {
  if (app === null) delete holder[KEY];
  else holder[KEY] = Promise.resolve(app);
};
