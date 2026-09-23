import { z } from 'zod';
import { parseLogLevel } from './logger.server';

/**
 * Process environment, validated once (§3 "zod at every boundary"). Everything is optional in
 * Phase 0 so the calculator runs with zero configuration; missing pieces are logged loudly at
 * startup (see app.server.ts) rather than failing.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  TURNSTILE_SITE_KEY: z.string().max(200).optional(),
  TURNSTILE_SECRET_KEY: z.string().max(200).optional(),
  FX_SEED_CSV: z.string().max(1024).optional(),
  RATE_SHEET_PATH: z.string().max(1024).optional(),
  /** Unused in Phase 0 (no sessions); listed so Phase 1 has a home for it. */
  SESSION_SECRET: z.string().min(32).optional(),
});

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
  });
  return {
    ...parsed,
    logLevel: parseLogLevel(parsed.LOG_LEVEL, parsed.NODE_ENV === 'production' ? 'info' : 'debug'),
  };
};
