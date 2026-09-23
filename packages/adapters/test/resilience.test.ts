import { describe, expect, it } from 'vitest';
import {
  HttpError,
  TimeoutError,
  isRetryableHttpError,
  withRetry,
  withTimeout,
} from '../src/resilience.js';

describe('withRetry', () => {
  it('retries with jittered backoff and gives up after N retries', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('nope');
        },
        {
          retries: 2,
          baseDelayMs: 100,
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 0.5,
        },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
  });
  it('stops early when shouldRetry says no', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError(400, 'u');
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: isRetryableHttpError, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});

describe('withTimeout', () => {
  it('rejects with TimeoutError and aborts the signal', async () => {
    let aborted = false;
    await expect(
      withTimeout(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
        10,
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });
  it('passes through a fast result', async () => {
    expect(await withTimeout(async () => 42, 100)).toBe(42);
  });
});
