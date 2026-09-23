import { createHash } from 'node:crypto';

/**
 * Token-bucket rate limiting (§7.5). Public calculator: 20 calcs/hour/IP; signup: 5/hour/IP.
 *
 * One interface, two implementations: in-memory (single process, dev/tests) and Redis (Lua
 * script, atomic, shared across instances) selected by `REDIS_URL`. Keys are hashed so raw IPs
 * never reach Redis or logs.
 */

export interface RateLimitPolicy {
  /** Namespace, e.g. "calculator". */
  name: string;
  /** Bucket size = burst allowance = sustained allowance per window. */
  capacity: number;
  /** Window over which `capacity` tokens refill. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** Seconds until one token is available (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(subject: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

export const CALCULATOR_LIMIT: RateLimitPolicy = {
  name: 'calculator',
  capacity: 20,
  windowMs: 60 * 60 * 1000,
};
export const SIGNUP_LIMIT: RateLimitPolicy = {
  name: 'signup',
  capacity: 5,
  windowMs: 60 * 60 * 1000,
};

/** Stable, non-reversible bucket key: never store or log the raw subject (an IP). */
export const bucketKey = (policy: RateLimitPolicy, subject: string): string =>
  `rl:${policy.name}:${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const refill = (bucket: Bucket, policy: RateLimitPolicy, nowMs: number): number => {
  const elapsed = Math.max(0, nowMs - bucket.updatedAt);
  const refilled = (elapsed * policy.capacity) / policy.windowMs;
  return Math.min(policy.capacity, bucket.tokens + refilled);
};

const decide = (
  tokens: number,
  policy: RateLimitPolicy,
): { next: number; decision: RateLimitDecision } => {
  if (tokens >= 1) {
    const next = tokens - 1;
    return { next, decision: { allowed: true, remaining: Math.floor(next), retryAfterSeconds: 0 } };
  }
  const msPerToken = policy.windowMs / policy.capacity;
  const retryAfterSeconds = Math.max(1, Math.ceil(((1 - tokens) * msPerToken) / 1000));
  return { next: tokens, decision: { allowed: false, remaining: 0, retryAfterSeconds } };
};

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxBuckets = 50_000,
  ) {
    this.lastSweep = now();
  }

  async consume(subject: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const nowMs = this.now();
    this.sweep(nowMs, policy.windowMs);
    const key = bucketKey(policy, subject);
    const bucket = this.buckets.get(key) ?? { tokens: policy.capacity, updatedAt: nowMs };
    const tokens = refill(bucket, policy, nowMs);
    const { next, decision } = decide(tokens, policy);
    this.buckets.set(key, { tokens: next, updatedAt: nowMs });
    return decision;
  }

  /** Drop buckets that have fully refilled (they are indistinguishable from absent ones). */
  private sweep(nowMs: number, windowMs: number): void {
    if (nowMs - this.lastSweep < windowMs && this.buckets.size < this.maxBuckets) return;
    this.lastSweep = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAt >= windowMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

// ---------- Redis ----------

/** The slice of ioredis we use, so the class can be unit-tested with a stub. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

// KEYS[1] bucket hash; ARGV: capacity, windowMs, nowMs. Returns {allowedFlag, tokensAfter*1000}.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(data[1])
local updatedAt = tonumber(data[2])
if tokens == nil then tokens = capacity; updatedAt = now end
local elapsed = math.max(0, now - updatedAt)
tokens = math.min(capacity, tokens + (elapsed * capacity) / window)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], window * 2)
return { allowed, math.floor(tokens * 1000) }
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async consume(subject: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const key = bucketKey(policy, subject);
    const raw = await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      policy.capacity,
      policy.windowMs,
      this.now(),
    );
    const [allowedFlag, tokensMilli] = Array.isArray(raw) ? (raw as unknown[]) : [0, 0];
    const tokensAfter = Number(tokensMilli) / 1000;
    if (Number(allowedFlag) === 1) {
      return { allowed: true, remaining: Math.floor(tokensAfter), retryAfterSeconds: 0 };
    }
    // Not allowed: the script left the bucket untouched, so `tokensAfter` is the current level.
    return decide(tokensAfter, policy).decision;
  }
}

/**
 * Wrap a limiter so an infrastructure failure (Redis down) fails OPEN for the calculator —
 * losing a rate limit for a few minutes is preferable to taking the public page down. The
 * failure is logged by the caller via `onError`.
 */
export const failOpen = (inner: RateLimiter, onError: (err: unknown) => void): RateLimiter => ({
  async consume(subject, policy) {
    try {
      return await inner.consume(subject, policy);
    } catch (err) {
      onError(err);
      return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    }
  },
});

/**
 * Magic-link requests (§7.1): 5 per hour per email address and 20 per hour per IP. The subjects
 * are already hashed by the caller (sha256 of the lower-cased email / of the IP) and `bucketKey`
 * hashes again, so neither ever reaches Redis or a log in clear.
 */
export const LOGIN_EMAIL_LIMIT: RateLimitPolicy = {
  name: 'login-email',
  capacity: 5,
  windowMs: 60 * 60 * 1000,
};
export const LOGIN_IP_LIMIT: RateLimitPolicy = {
  name: 'login-ip',
  capacity: 20,
  windowMs: 60 * 60 * 1000,
};

/** Build the limiter on the shared Redis connection (`redis.server.ts`), or in memory without one. */
export const createRateLimiter = (
  redis: RedisEvalClient | null,
  onError: (err: unknown) => void,
): { limiter: RateLimiter; backend: 'memory' | 'redis' } => {
  if (!redis) return { limiter: new InMemoryRateLimiter(), backend: 'memory' };
  return { limiter: failOpen(new RedisRateLimiter(redis), onError), backend: 'redis' };
};
