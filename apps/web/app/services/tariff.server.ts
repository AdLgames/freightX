import { UkTradeTariffClient, type TariffCacheStore } from '@harbour/adapters';

/**
 * UK Trade Tariff client for the request path: 5s timeout, 2 retries, 24h cache (§5.2).
 * The cache store comes from db.server.ts (in-memory until Prisma `TariffCache` is wired).
 */
export const createTariffClient = (opts: {
  cache: TariffCacheStore;
  baseUrl?: string;
}): UkTradeTariffClient =>
  new UkTradeTariffClient({
    cache: opts.cache,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
