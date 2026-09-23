import type { FreightRateProvider, FreightRequest, FreightResult } from './provider.js';

/**
 * Phase 1 SeaRates adapter — INTENTIONALLY A STUB.
 *
 * The SeaRates request/response contract must be implemented from their API documentation and
 * sandbox once decision #1 (§10) is taken and credentials exist. Until then this provider reports
 * UNAVAILABLE so `ResilientFreightProvider` falls back to the rate sheet with FREIGHT_FALLBACK.
 * Requirements when implemented (§5.8): 5s timeout, 2 retries with jitter, zod-validated
 * response, 6h cache keyed on (origin, destination, mode, weight band, CBM band).
 */
export class SeaRatesFreightProvider implements FreightRateProvider {
  readonly name = 'SEARATES';

  constructor(private readonly apiKey: string | undefined) {}

  async quote(_req: FreightRequest): Promise<FreightResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        reason: 'UNAVAILABLE',
        message: 'SeaRates not configured (SEARATES_API_KEY missing).',
      };
    }
    return {
      ok: false,
      reason: 'UNAVAILABLE',
      message: 'SeaRates adapter not implemented yet (Phase 1).',
    };
  }
}
