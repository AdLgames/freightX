import { storageEnvSchema } from '@harbour/adapters'; // M5
import { z } from 'zod';
import { decimalString } from '../validators/common';
import type { CalculatorMode } from '../validators/calculator';
import { parseLogLevel } from './logger.server';

/**
 * Process environment, validated once (§3 "zod at every boundary"). Everything is optional in
 * Phase 0 so the calculator runs with zero configuration; missing pieces are logged loudly at
 * startup (see app.server.ts) rather than failing.
 */
const pctEnv = decimalString({ dp: 4, max: '100' });
const gbpEnv = decimalString({ dp: 2, max: '100000' });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),
    TURNSTILE_SITE_KEY: z.string().max(200).optional(),
    TURNSTILE_SECRET_KEY: z.string().max(200).optional(),
    FX_SEED_CSV: z.string().max(1024).optional(),
    RATE_SHEET_PATH: z.string().max(1024).optional(),
    /**
     * Unused: session ids are 32 random bytes stored server-side (hashed), so the cookie needs no
     * signature. Kept (validated when set) so existing deployments that set it do not break.
     */
    SESSION_SECRET: z.string().min(32).optional(),
    /**
     * Public origin of the app, e.g. `https://app.example.co.uk`. Used for magic links and as the
     * expected `Origin` of workspace POSTs (CSRF second layer). Required for sign-in in
     * production; in development/test the request's own origin is used when unset.
     */
    APP_URL: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'APP_URL must be http(s).')
      .transform((u) => new URL(u).origin)
      .optional(),
    /**
     * Transactional email (magic links). `console` logs the link (development/test only);
     * `resend` posts to the Resend API. Unset → console outside production, none in production
     * (sign-in then fails closed).
     */
    EMAIL_TRANSPORT: z.enum(['console', 'resend']).optional(),
    RESEND_API_KEY: z.string().min(1).max(1024).optional(),
    /** Sender, e.g. `Harbour <sign-in@example.co.uk>`. */
    EMAIL_FROM: z
      .string()
      .max(320)
      .regex(
        /^[^<>@\s]+@[^<>@\s]+$|^[^<>]*<[^<>@\s]+@[^<>@\s]+>$/,
        'EMAIL_FROM must be an address.',
      )
      .optional(),
    /**
     * UK Trade Tariff API key and the header it is sent in. Both or neither. The header name must
     * be confirmed from the Trade Tariff developer portal; it is config, not code. Never logged.
     */
    TRADE_TARIFF_API_KEY: z.string().min(1).max(1024).optional(),
    TRADE_TARIFF_API_KEY_HEADER: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'Must be an HTTP header name.')
      .optional(),
    /** Default broker deferment fee terms shown in the calculator. No default when unset. */
    BROKER_DEFERMENT_FEE_PCT: pctEnv.optional(),
    BROKER_DEFERMENT_MIN_GBP: gbpEnv.optional(),
    /**
     * VAT-base padding for UK inland costs, by mode, used only when the freight source did not
     * give the UK post-border leg. Unverified figures must not be hard-coded; unset → none.
     */
    INLAND_VAT_ADJUSTMENT_LCL_GBP: gbpEnv.optional(),
    INLAND_VAT_ADJUSTMENT_FCL_GBP: gbpEnv.optional(),
    INLAND_VAT_ADJUSTMENT_AIR_GBP: gbpEnv.optional(),
    // M6: Stripe Billing (services/billing/). All optional: unset → the billing page says
    // "Billing is not configured" and nothing else changes. Secrets are never logged. Plan names
    // and prices live in Stripe; the two price ids are the only link between a Stripe price and
    // our Plan enum (STARTER / PRO).
    STRIPE_SECRET_KEY: z.string().min(1).max(1024).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).max(1024).optional(),
    STRIPE_PRICE_STARTER: z
      .string()
      .regex(/^price_[A-Za-z0-9]+$/, 'STRIPE_PRICE_STARTER must be a Stripe price id (price_…).')
      .optional(),
    STRIPE_PRICE_PRO: z
      .string()
      .regex(/^price_[A-Za-z0-9]+$/, 'STRIPE_PRICE_PRO must be a Stripe price id (price_…).')
      .optional(),
    // end M6
    // M5: document vault — object storage (STORAGE_*: S3/R2, or a local directory outside
    // production) and the ClamAV daemon (CLAMD_*). Schema shared with the worker via @harbour/adapters.
    ...storageEnvSchema.shape,
  })
  .refine(
    (e) => (e.TRADE_TARIFF_API_KEY === undefined) === (e.TRADE_TARIFF_API_KEY_HEADER === undefined),
    {
      message: 'Set both TRADE_TARIFF_API_KEY and TRADE_TARIFF_API_KEY_HEADER, or neither.',
      path: ['TRADE_TARIFF_API_KEY_HEADER'],
    },
  );

export type Env = z.infer<typeof envSchema> & { logLevel: ReturnType<typeof parseLogLevel> };

const blank = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === '' ? undefined : v;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = envSchema.parse({
    NODE_ENV: blank(source.NODE_ENV),
    LOG_LEVEL: blank(source.LOG_LEVEL),
    DATABASE_URL: blank(source.DATABASE_URL),
    REDIS_URL: blank(source.REDIS_URL),
    TURNSTILE_SITE_KEY: blank(source.TURNSTILE_SITE_KEY),
    TURNSTILE_SECRET_KEY: blank(source.TURNSTILE_SECRET_KEY),
    FX_SEED_CSV: blank(source.FX_SEED_CSV),
    RATE_SHEET_PATH: blank(source.RATE_SHEET_PATH),
    SESSION_SECRET: blank(source.SESSION_SECRET),
    APP_URL: blank(source.APP_URL),
    EMAIL_TRANSPORT: blank(source.EMAIL_TRANSPORT),
    RESEND_API_KEY: blank(source.RESEND_API_KEY),
    EMAIL_FROM: blank(source.EMAIL_FROM),
    TRADE_TARIFF_API_KEY: blank(source.TRADE_TARIFF_API_KEY),
    TRADE_TARIFF_API_KEY_HEADER: blank(source.TRADE_TARIFF_API_KEY_HEADER),
    BROKER_DEFERMENT_FEE_PCT: blank(source.BROKER_DEFERMENT_FEE_PCT),
    BROKER_DEFERMENT_MIN_GBP: blank(source.BROKER_DEFERMENT_MIN_GBP),
    INLAND_VAT_ADJUSTMENT_LCL_GBP: blank(source.INLAND_VAT_ADJUSTMENT_LCL_GBP),
    INLAND_VAT_ADJUSTMENT_FCL_GBP: blank(source.INLAND_VAT_ADJUSTMENT_FCL_GBP),
    INLAND_VAT_ADJUSTMENT_AIR_GBP: blank(source.INLAND_VAT_ADJUSTMENT_AIR_GBP),
    // M6
    STRIPE_SECRET_KEY: blank(source.STRIPE_SECRET_KEY),
    STRIPE_WEBHOOK_SECRET: blank(source.STRIPE_WEBHOOK_SECRET),
    STRIPE_PRICE_STARTER: blank(source.STRIPE_PRICE_STARTER),
    STRIPE_PRICE_PRO: blank(source.STRIPE_PRICE_PRO),
    // end M6
    // M5 (storageEnvSchema blanks its own values)
    STORAGE_ENDPOINT: source.STORAGE_ENDPOINT,
    STORAGE_REGION: source.STORAGE_REGION,
    STORAGE_BUCKET: source.STORAGE_BUCKET,
    STORAGE_ACCESS_KEY_ID: source.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: source.STORAGE_SECRET_ACCESS_KEY,
    STORAGE_FORCE_PATH_STYLE: source.STORAGE_FORCE_PATH_STYLE,
    STORAGE_LOCAL_DIR: source.STORAGE_LOCAL_DIR,
    STORAGE_LOCAL_SECRET: source.STORAGE_LOCAL_SECRET,
    CLAMD_HOST: source.CLAMD_HOST,
    CLAMD_PORT: source.CLAMD_PORT,
  });
  return {
    ...parsed,
    logLevel: parseLogLevel(parsed.LOG_LEVEL, parsed.NODE_ENV === 'production' ? 'info' : 'debug'),
  };
};

/** Server-side pricing config for the quote pipeline (never user input). */
export interface PricingConfig {
  /** Configured default broker deferment terms; either may be absent. */
  brokerDefermentDefaults: { feePct: string | null; minimumGbp: string | null };
  /** VAT-base padding by mode, applied by the engine only when the UK leg is unknown. */
  inlandVatAdjustmentGbp: Partial<Record<CalculatorMode, string>>;
}

export const pricingConfigFromEnv = (env: Env): PricingConfig => {
  const inland: Partial<Record<CalculatorMode, string>> = {};
  if (env.INLAND_VAT_ADJUSTMENT_LCL_GBP) inland.SEA_LCL = env.INLAND_VAT_ADJUSTMENT_LCL_GBP;
  if (env.INLAND_VAT_ADJUSTMENT_FCL_GBP) inland.SEA_FCL = env.INLAND_VAT_ADJUSTMENT_FCL_GBP;
  if (env.INLAND_VAT_ADJUSTMENT_AIR_GBP) inland.AIR = env.INLAND_VAT_ADJUSTMENT_AIR_GBP;
  return {
    brokerDefermentDefaults: {
      feePct: env.BROKER_DEFERMENT_FEE_PCT ?? null,
      minimumGbp: env.BROKER_DEFERMENT_MIN_GBP ?? null,
    },
    inlandVatAdjustmentGbp: inland,
  };
};

/** Tariff API credentials, or null. Callers must never log the key. */
export const tariffApiKeyFromEnv = (env: Env): { header: string; key: string } | null =>
  env.TRADE_TARIFF_API_KEY && env.TRADE_TARIFF_API_KEY_HEADER
    ? { header: env.TRADE_TARIFF_API_KEY_HEADER, key: env.TRADE_TARIFF_API_KEY }
    : null;
