import type { NormalisedCommodity } from './normalise.js';

/**
 * Cache contract for tariff lookups (§5.2: 24h). The DB-backed implementation lives in the app
 * (Prisma `TariffCache`); this package only ships an in-memory one for tests/dev.
 */
export interface TariffCacheStore {
  get(
    code: string,
  ): Promise<{ value: NormalisedCommodity; fetchedAt: Date; expiresAt: Date } | null>;
  set(code: string, value: NormalisedCommodity, fetchedAt: Date, expiresAt: Date): Promise<void>;
}

export const TARIFF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryTariffCache implements TariffCacheStore {
  private readonly map = new Map<
    string,
    { value: NormalisedCommodity; fetchedAt: Date; expiresAt: Date }
  >();

  async get(code: string) {
    return this.map.get(code) ?? null;
  }

  async set(code: string, value: NormalisedCommodity, fetchedAt: Date, expiresAt: Date) {
    this.map.set(code, { value, fetchedAt, expiresAt });
  }
}
