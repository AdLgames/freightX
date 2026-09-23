import type { Redis } from 'ioredis';

/**
 * One Redis connection per process, shared by the rate limiter (§7.5) and the session store
 * (§7.1). Created only when `REDIS_URL` is set.
 *
 * - The connection is opened at startup (not on the first command), so the first request after a
 *   cold start does not fail with "Stream isn't writeable".
 * - Commands issued while (re)connecting wait in the offline queue, bounded by `commandTimeout`, so
 *   a Redis outage turns into a fast error instead of a hung request. Each caller decides what an
 *   error means: the rate limiter fails OPEN (public calculator stays up), the session store fails
 *   CLOSED (workspace shows "temporarily unavailable").
 * - The URL (which may carry a password) is never logged; `onError` receives the error only.
 */
export type RedisClient = Redis;

export interface RedisClientOptions {
  /** Per-command timeout in ms (default 2000). */
  commandTimeoutMs?: number;
}

export const createRedisClient = async (
  url: string,
  onError: (err: unknown) => void,
  opts: RedisClientOptions = {},
): Promise<RedisClient> => {
  const { default: IORedis } = await import('ioredis');
  const client = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    commandTimeout: opts.commandTimeoutMs ?? 2_000,
    connectTimeout: 5_000,
  });
  client.on('error', onError);
  // Fire and forget: a failure here is reported through `onError` and ioredis keeps retrying.
  client.connect().catch(onError);
  return client;
};
