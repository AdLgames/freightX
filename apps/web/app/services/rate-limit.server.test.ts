import { describe, expect, it } from 'vitest';
import {
  InMemoryRateLimiter,
  RedisRateLimiter,
  bucketKey,
  failOpen,
  type RateLimitPolicy,
  type RedisEvalClient,
} from './rate-limit.server';

const POLICY: RateLimitPolicy = { name: 'test', capacity: 3, windowMs: 3_000 }; // 1 token / second

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('InMemoryRateLimiter (token bucket)', () => {
  it('allows a burst of `capacity` then denies with a retry-after', async () => {
    const c = clock();
    const rl = new InMemoryRateLimiter(c.now);
    expect(await rl.consume('1.2.3.4', POLICY)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    expect(await rl.consume('1.2.3.4', POLICY)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    });
    expect(await rl.consume('1.2.3.4', POLICY)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    });
    const denied = await rl.consume('1.2.3.4', POLICY);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
  });
  it('refills continuously with the injected clock', async () => {
    const c = clock();
    const rl = new InMemoryRateLimiter(c.now);
    for (let i = 0; i < 3; i += 1) await rl.consume('ip', POLICY);
    expect((await rl.consume('ip', POLICY)).allowed).toBe(false);
    c.advance(999);
    expect((await rl.consume('ip', POLICY)).allowed).toBe(false);
    c.advance(1);
    expect((await rl.consume('ip', POLICY)).allowed).toBe(true);
    expect((await rl.consume('ip', POLICY)).allowed).toBe(false);
    c.advance(60_000); // never refills above capacity
    for (let i = 0; i < 3; i += 1) expect((await rl.consume('ip', POLICY)).allowed).toBe(true);
    expect((await rl.consume('ip', POLICY)).allowed).toBe(false);
  });
  it('retry-after reflects the deficit when several tokens are owed', async () => {
    const c = clock();
    const rl = new InMemoryRateLimiter(c.now);
    for (let i = 0; i < 3; i += 1) await rl.consume('ip', POLICY);
    c.advance(400); // 0.4 tokens → need 0.6 s → ceil → 1
    expect((await rl.consume('ip', POLICY)).retryAfterSeconds).toBe(1);
    const slow: RateLimitPolicy = { name: 'slow', capacity: 1, windowMs: 3_600_000 };
    await rl.consume('ip', slow);
    expect((await rl.consume('ip', slow)).retryAfterSeconds).toBe(3600);
  });
  it('keeps subjects and policies independent', async () => {
    const c = clock();
    const rl = new InMemoryRateLimiter(c.now);
    for (let i = 0; i < 3; i += 1) await rl.consume('a', POLICY);
    expect((await rl.consume('a', POLICY)).allowed).toBe(false);
    expect((await rl.consume('b', POLICY)).allowed).toBe(true);
    expect((await rl.consume('a', { ...POLICY, name: 'other' })).allowed).toBe(true);
  });
  it('sweeps fully-refilled buckets', async () => {
    const c = clock();
    const rl = new InMemoryRateLimiter(c.now);
    await rl.consume('a', POLICY);
    await rl.consume('b', POLICY);
    expect(rl.size).toBe(2);
    c.advance(POLICY.windowMs);
    await rl.consume('c', POLICY);
    expect(rl.size).toBe(1);
  });
  it('never stores the raw subject', () => {
    const key = bucketKey(POLICY, '203.0.113.9');
    expect(key).not.toContain('203.0.113.9');
    expect(key).toMatch(/^rl:test:[0-9a-f]{32}$/);
    expect(bucketKey(POLICY, '203.0.113.9')).toBe(key);
  });
});

describe('RedisRateLimiter', () => {
  it('interprets the Lua script reply', async () => {
    const calls: unknown[][] = [];
    const replies: unknown[] = [
      [1, 2000],
      [0, 400],
    ];
    const fake: RedisEvalClient = {
      eval: async (...args) => {
        calls.push(args);
        return replies.shift();
      },
    };
    const rl = new RedisRateLimiter(fake, () => 5_000);
    expect(await rl.consume('ip', POLICY)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    expect(await rl.consume('ip', POLICY)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1,
    });
    expect(calls[0]?.slice(1)).toEqual([1, bucketKey(POLICY, 'ip'), 3, 3_000, 5_000]);
  });
  it('failOpen allows the request and reports the error when the backend throws', async () => {
    const errors: unknown[] = [];
    const rl = failOpen({ consume: async () => Promise.reject(new Error('ECONNREFUSED')) }, (e) =>
      errors.push(e),
    );
    expect((await rl.consume('ip', POLICY)).allowed).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
