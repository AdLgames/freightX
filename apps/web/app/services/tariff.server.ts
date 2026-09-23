import { UkTradeTariffClient, type FetchLike, type TariffCacheStore } from '@harbour/adapters';

/**
 * UK Trade Tariff client for the request path: 5s timeout, 2 retries, 24h cache (§5.2).
 * The cache store comes from db.server.ts (in-memory until Prisma `TariffCache` is wired).
 * When an API key is configured it is sent in the configured header; the key is never logged.
 */
export const createTariffClient = (opts: {
  cache: TariffCacheStore;
  baseUrl?: string;
  apiKey?: { header: string; key: string } | null;
  /** Injected in tests. */
  fetch?: FetchLike;
}): UkTradeTariffClient =>
  new UkTradeTariffClient({
    cache: opts.cache,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.apiKey ? { headers: { [opts.apiKey.header]: opts.apiKey.key } } : {}),
  });
