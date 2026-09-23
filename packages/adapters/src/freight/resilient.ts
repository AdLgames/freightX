import { createBreaker, type BreakerOptions } from '../resilience.js';
import type { FreightRateProvider, FreightRequest, FreightResult } from './provider.js';

/**
 * Phase 1 composition (§5.8): a primary provider (e.g. SeaRates) behind a circuit breaker, with
 * the rate sheet as fallback. When the breaker is open or the primary fails, the fallback quote
 * is returned with `isFallback: true` (engine → FREIGHT_FALLBACK) and, when the primary answers,
 * the rate-sheet figure is attached as `benchmarkToBorderGbp` for outlier detection.
 */
export class ResilientFreightProvider implements FreightRateProvider {
  readonly name: string;
  private readonly breaker;

  constructor(
    private readonly primary: FreightRateProvider,
    private readonly fallback: FreightRateProvider,
    breakerOpts: Partial<BreakerOptions> = {},
  ) {
    this.name = `${primary.name}+${fallback.name}`;
    this.breaker = createBreaker((req: FreightRequest) => primary.quote(req), {
      name: primary.name,
      ...breakerOpts,
    });
  }

  get breakerState(): 'open' | 'halfOpen' | 'closed' {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'halfOpen';
    return 'closed';
  }

  onStateChange(listener: (state: 'open' | 'halfOpen' | 'closed') => void): void {
    this.breaker.on('open', () => listener('open'));
    this.breaker.on('halfOpen', () => listener('halfOpen'));
    this.breaker.on('close', () => listener('closed'));
  }

  async quote(req: FreightRequest): Promise<FreightResult> {
    const fallbackResult = await this.fallback.quote(req);
    const benchmark = fallbackResult.ok ? fallbackResult.quote.freight.toBorderGbp : null;

    let primaryResult: FreightResult | null = null;
    try {
      primaryResult = await this.breaker.fire(req);
    } catch {
      primaryResult = null; // breaker open, timeout, or provider threw
    }

    if (primaryResult?.ok) {
      const freight = { ...primaryResult.quote.freight, benchmarkToBorderGbp: benchmark };
      return { ok: true, quote: { ...primaryResult.quote, freight } };
    }
    if (fallbackResult.ok) {
      return {
        ok: true,
        quote: {
          ...fallbackResult.quote,
          assumptions: [
            ...fallbackResult.quote.assumptions,
            `${this.primary.name} unavailable; ${this.fallback.name} used.`,
          ],
          freight: { ...fallbackResult.quote.freight, isFallback: true },
        },
      };
    }
    return primaryResult ?? fallbackResult;
  }
}
