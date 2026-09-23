import type { HsCandidate } from '@harbour/engine';
import { validateHsCode } from '@harbour/engine';
import {
  HttpError,
  isRetryableHttpError,
  withRetry,
  withTimeout,
  type FetchLike,
} from '../resilience.js';
import { InMemoryTariffCache, TARIFF_CACHE_TTL_MS, type TariffCacheStore } from './cache.js';
import {
  normaliseCommodity,
  normaliseHeadingCandidates,
  type NormalisedCommodity,
} from './normalise.js';

export interface UkTradeTariffClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  cache?: TariffCacheStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Extra request headers, e.g. an API key once the Trade Tariff developer portal requires one.
   * The header name is deployment config, not code (see docs/decisions-needed.md).
   */
  headers?: Readonly<Record<string, string>>;
}

export type TariffLookup =
  | { ok: true; commodity: NormalisedCommodity; fetchedAt: Date; fromCache: boolean }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'INVALID_CODE' | 'UNAVAILABLE' | 'MALFORMED';
      message: string;
    };

export class UkTradeTariffNotFound extends Error {
  constructor(public readonly code: string) {
    super(`Commodity ${code} not found`);
    this.name = 'UkTradeTariffNotFound';
  }
}

/**
 * UK Trade Tariff API v2 client. Unauthenticated, public. 5s timeout, 2 retries with jitter,
 * 24h cache. The circuit breaker is applied by the caller (see `createBreaker`) so the same
 * breaker can guard both lookups and heading searches.
 */
export class UkTradeTariffClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly cache: TariffCacheStore;
  private readonly now: () => Date;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(opts: UkTradeTariffClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://www.trade-tariff.service.gov.uk/api/v2').replace(
      /\/$/,
      '',
    );
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 2;
    this.cache = opts.cache ?? new InMemoryTariffCache();
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep;
    this.headers = opts.headers ?? {};
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const retryOpts = {
      retries: this.retries,
      baseDelayMs: 300,
      shouldRetry: isRetryableHttpError,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    };
    return withRetry(
      () =>
        withTimeout(async (signal) => {
          const res = await this.fetchImpl(url, {
            signal,
            headers: { ...this.headers, accept: 'application/json' },
          });
          if (!res.ok) throw new HttpError(res.status, url);
          return res.json();
        }, this.timeoutMs),
      retryOpts,
    );
  }

  /** Look up a 10-digit commodity, using the cache when fresh. */
  async lookupCommodity(code: string): Promise<TariffLookup> {
    const v = validateHsCode(code);
    if (!v.ok || v.length !== 10) {
      return {
        ok: false,
        reason: 'INVALID_CODE',
        message: 'Commodity lookups need a 10-digit code.',
      };
    }
    const now = this.now();
    const cached = await this.cache.get(v.code);
    if (cached && cached.expiresAt > now) {
      return { ok: true, commodity: cached.value, fetchedAt: cached.fetchedAt, fromCache: true };
    }
    let raw: unknown;
    try {
      raw = await this.getJson(`/commodities/${v.code}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return {
          ok: false,
          reason: 'NOT_FOUND',
          message: `Commodity ${v.code} does not exist in the UK tariff.`,
        };
      }
      // Stale cache beats nothing: serve it, the caller decides how to label it.
      if (cached)
        return { ok: true, commodity: cached.value, fetchedAt: cached.fetchedAt, fromCache: true };
      return {
        ok: false,
        reason: 'UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    let commodity: NormalisedCommodity;
    try {
      commodity = normaliseCommodity(raw);
    } catch (err) {
      return {
        ok: false,
        reason: 'MALFORMED',
        message: `Tariff response failed validation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const expiresAt = new Date(now.getTime() + TARIFF_CACHE_TTL_MS);
    await this.cache.set(v.code, commodity, now, expiresAt);
    return { ok: true, commodity, fetchedAt: now, fromCache: false };
  }

  /** List declarable 10-digit codes under a heading, for `normaliseHsCode`. */
  async headingCandidates(code: string): Promise<HsCandidate[]> {
    const v = validateHsCode(code);
    if (!v.ok) return [];
    const heading = v.code.slice(0, 4);
    const raw = await this.getJson(`/headings/${heading}`);
    return normaliseHeadingCandidates(raw).filter((c) => c.code.startsWith(v.code));
  }
}
