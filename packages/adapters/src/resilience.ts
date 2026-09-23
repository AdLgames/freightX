import CircuitBreaker from 'opossum';

/**
 * Resilience primitives for every external call (§3 "assume every external API will be down,
 * slow or wrong"): timeout, retry with jitter, circuit breaker. Pure wrappers — no logging here;
 * callers observe via the breaker's events.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race settles with TimeoutError, then abort the underlying work.
      reject(new TimeoutError(ms));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Return false to stop retrying (e.g. on a 4xx). Default: retry everything. */
  shouldRetry?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter: delay = random(0, min(max, base × 2^attempt)). */
export const withRetry = async <T>(
  run: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> => {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await run(attempt);
    } catch (err) {
      lastError = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (!retryable || attempt === opts.retries) break;
      const cap = Math.min(maxDelay, opts.baseDelayMs * 2 ** attempt);
      await sleep(Math.floor(random() * cap));
    }
  }
  throw lastError;
};

export interface BreakerOptions {
  /** Consecutive/volume failures before opening. */
  volumeThreshold: number;
  /** Open when error rate exceeds this percentage within the rolling window. */
  errorThresholdPercentage: number;
  /** How long the circuit stays open before a half-open probe. */
  resetTimeoutMs: number;
  /** Rolling stats window. */
  rollingCountTimeoutMs: number;
  /** Per-call timeout enforced by the breaker. */
  timeoutMs: number;
  name: string;
}

/** §5.8 defaults: open after 5 failures / 60s, half-open probe every 30s, 5s timeout. */
export const DEFAULT_BREAKER: BreakerOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 30_000,
  rollingCountTimeoutMs: 60_000,
  timeoutMs: 5_000,
  name: 'external',
};

export type Breaker<A extends unknown[], R> = CircuitBreaker<A, R>;

export const createBreaker = <A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  opts: Partial<BreakerOptions> = {},
): CircuitBreaker<A, R> => {
  const o = { ...DEFAULT_BREAKER, ...opts };
  return new CircuitBreaker<A, R>(action, {
    name: o.name,
    timeout: o.timeoutMs,
    volumeThreshold: o.volumeThreshold,
    errorThresholdPercentage: o.errorThresholdPercentage,
    resetTimeout: o.resetTimeoutMs,
    rollingCountTimeout: o.rollingCountTimeoutMs,
  });
};

/** Minimal fetch type so adapters can be tested with an injected fetch. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }
}

/** 4xx (except 429) are not worth retrying; everything else is. */
export const isRetryableHttpError = (err: unknown): boolean => {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
};
