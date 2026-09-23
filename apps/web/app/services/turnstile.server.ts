import type { Logger } from './logger.server';

/**
 * Cloudflare Turnstile verification (§7.5 "public calculator: 20 calcs/hour/IP + Turnstile").
 * Enabled only when TURNSTILE_SECRET_KEY is set; otherwise every submission passes and a
 * single warning is logged at startup — acceptable in development, not in production.
 */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_FIELD = 'cf-turnstile-response';

export type TurnstileResult =
  { ok: true } | { ok: false; reason: 'MISSING' | 'REJECTED' | 'UNAVAILABLE' };

export interface TurnstileVerifier {
  readonly enabled: boolean;
  readonly siteKey: string | null;
  verify(token: string | null | undefined): Promise<TurnstileResult>;
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface TurnstileOptions {
  siteKey: string | undefined;
  secretKey: string | undefined;
  logger: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  production?: boolean;
}

export const createTurnstile = (opts: TurnstileOptions): TurnstileVerifier => {
  const { logger } = opts;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  if (!opts.secretKey) {
    const level = opts.production ? 'error' : 'warn';
    logger[level]('turnstile.disabled', {
      message:
        'TURNSTILE_SECRET_KEY is unset: bot verification is OFF for the public calculator (dev only).',
    });
    return { enabled: false, siteKey: null, verify: async () => ({ ok: true }) };
  }
  if (!opts.siteKey) {
    logger.error('turnstile.misconfigured', {
      message: 'TURNSTILE_SECRET_KEY set but TURNSTILE_SITE_KEY missing; widget cannot render.',
    });
  }

  const secret = opts.secretKey;
  return {
    enabled: true,
    siteKey: opts.siteKey ?? null,
    async verify(token) {
      if (!token || token.length > 4096) return { ok: false, reason: 'MISSING' };
      const body = new URLSearchParams({ secret, response: token });
      try {
        const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          logger.warn('turnstile.http_error', { status: res.status });
          return { ok: false, reason: 'UNAVAILABLE' };
        }
        const json: unknown = await res.json();
        const success =
          typeof json === 'object' &&
          json !== null &&
          (json as { success?: unknown }).success === true;
        return success ? { ok: true } : { ok: false, reason: 'REJECTED' };
      } catch (err) {
        // Fail closed (§1): a bot check we cannot perform is a failed bot check.
        logger.warn('turnstile.unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, reason: 'UNAVAILABLE' };
      }
    },
  };
};
