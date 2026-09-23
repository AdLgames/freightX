import type { RateSheetFreightProvider, UkTradeTariffClient } from '@harbour/adapters';
import { CALC_VERSION } from '@harbour/engine';
import { createStores, getPrisma, type Stores } from './db.server';
import {
  loadEnv,
  pricingConfigFromEnv,
  tariffApiKeyFromEnv,
  type Env,
  type PricingConfig,
} from './env.server';
import { seedFxStore, type FxSeedSummary } from './fx.server';
import { loadFreightProvider, type LaneOption, type RateSheetMeta } from './freight.server';
import { createLogger, type Logger } from './logger.server';
import { createRateLimiter, type RateLimiter } from './rate-limit.server';
import { createRedisClient } from './redis.server';
import { createTariffClient } from './tariff.server';
import { createTurnstile, type TurnstileVerifier } from './turnstile.server';
import { createAuthServices, type AuthServices } from './workspace.server';
// M6
import { createBillingServices, type BillingServices } from './billing/billing.server';
// end M6

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
  /** Deferment fee defaults and inland VAT adjustments from env (not user input). */
  pricing: PricingConfig;
  calcVersion: string;
  startedAt: Date;
  /** Sign-in, sessions and the workspace's database access (M1). See workspace.server.ts. */
  auth: AuthServices;
  // M6: Stripe Billing (gateway, webhook queue, plan prices). See billing/billing.server.ts.
  billing: BillingServices;
  // end M6
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
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  // One Redis connection shared by the rate limiter and the session store.
  const redis = env.REDIS_URL
    ? await createRedisClient(env.REDIS_URL, (err) =>
        logger.error('redis.error', { error: errorText(err) }),
      )
    : null;
  const { limiter, backend } = createRateLimiter(redis, (err) =>
    logger.error('rate_limit.backend_error', { error: errorText(err) }),
  );
  const auth = createAuthServices({
    env,
    logger,
    redis,
    prisma: env.DATABASE_URL ? getPrisma(env.DATABASE_URL) : null,
  });
  const turnstile = createTurnstile({
    siteKey: env.TURNSTILE_SITE_KEY,
    secretKey: env.TURNSTILE_SECRET_KEY,
    logger,
    production: env.NODE_ENV === 'production',
  });
  const tariffApiKey = tariffApiKeyFromEnv(env);
  const tariff = createTariffClient({ cache: stores.tariffCache, apiKey: tariffApiKey });
  const pricing = pricingConfigFromEnv(env);
  const { provider, meta, lanes } = loadFreightProvider({
    rateSheetPath: env.RATE_SHEET_PATH,
    logger,
    now,
  });
  const fx = await seedFxStore({ store: stores.fxStore, csvPath: env.FX_SEED_CSV, logger, now });
  // M6
  const billing = await createBillingServices({
    env,
    logger,
    prisma: auth.prisma,
    email: auth.email,
    appUrl: auth.appUrl,
    now,
  });
  // end M6

  logger.info('app.started', {
    nodeEnv: env.NODE_ENV,
    calcVersion: CALC_VERSION,
    rateSheet: meta.version,
    rateLimitBackend: backend,
    turnstile: turnstile.enabled,
    fxSource: fx.source,
    stores: stores.backend,
    // Presence only — the key itself is never logged.
    tariffApiKey: tariffApiKey !== null,
    brokerDefermentDefaults:
      pricing.brokerDefermentDefaults.feePct !== null ||
      pricing.brokerDefermentDefaults.minimumGbp !== null,
    inlandVatAdjustmentModes: Object.keys(pricing.inlandVatAdjustmentGbp),
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
    pricing,
    calcVersion: CALC_VERSION,
    startedAt,
    auth,
    // M6
    billing,
    // end M6
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
