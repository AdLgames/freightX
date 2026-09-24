import { InMemoryFxStore, type FxRateRecord } from '@harbour/adapters';
import { describe, expect, it } from 'vitest';
import { computeTreasuryPair, loadTreasury } from './fx-treasury.server';

const NOW = new Date('2026-09-24T12:00:00Z');
const ecb = (currency: string, rateToGbp: string, validFrom: string): FxRateRecord => ({
  source: 'ECB',
  currency,
  rateToGbp,
  validFrom,
  validTo: validFrom,
});

describe('computeTreasuryPair', () => {
  it('inverts GBP-per-unit into units-per-pound and compares with the rate a week earlier', () => {
    const rows = [
      ecb('USD', '0.760000', '2026-09-15'),
      ecb('USD', '0.755000', '2026-09-17'), // ≤ 2026-09-17 target: the newest on or before it
      ecb('USD', '0.750000', '2026-09-22'),
      ecb('USD', '0.740000', '2026-09-23'),
    ];
    const p = computeTreasuryPair('USD', rows, NOW)!;
    expect(p.pair).toBe('GBP/USD');
    expect(p.rate).toBe('1.3514'); // 1 / 0.74
    expect(p.asOf).toBe('2026-09-23');
    expect(p.previous).toEqual({ rate: '1.3245', asOf: '2026-09-17' }); // 1 / 0.755
    expect(p.changePct).toBe('+2.03');
    expect(p.direction).toBe('stronger');
  });

  it('flags a weaker pound and a flat week', () => {
    const weaker = computeTreasuryPair(
      'EUR',
      [ecb('EUR', '0.850000', '2026-09-10'), ecb('EUR', '0.870000', '2026-09-24')],
      NOW,
    )!;
    expect(weaker.direction).toBe('weaker');
    expect(weaker.changePct?.startsWith('-')).toBe(true);
    const flat = computeTreasuryPair(
      'EUR',
      [ecb('EUR', '0.860000', '2026-09-10'), ecb('EUR', '0.860001', '2026-09-24')],
      NOW,
    )!;
    expect(flat.direction).toBe('flat');
  });

  it('shows the rate without a trend when the history is too short', () => {
    const p = computeTreasuryPair('USD', [ecb('USD', '0.75', '2026-09-23')], NOW)!;
    expect(p.rate).toBe('1.3333');
    expect(p.previous).toBeNull();
    expect(p.changePct).toBeNull();
    expect(p.direction).toBeNull();
    expect(computeTreasuryPair('USD', [], NOW)).toBeNull();
  });
});

describe('loadTreasury', () => {
  it('reads ECB rows only and reports the newest date', async () => {
    const store = new InMemoryFxStore();
    await store.upsert([
      ecb('USD', '0.76', '2026-09-15'),
      ecb('USD', '0.74', '2026-09-23'),
      ecb('EUR', '0.87', '2026-09-15'),
      ecb('EUR', '0.86', '2026-09-22'),
      {
        source: 'HMRC_MONTHLY',
        currency: 'USD',
        rateToGbp: '0.7',
        validFrom: '2026-09-01',
        validTo: '2026-09-30',
      },
    ]);
    const t = await loadTreasury(store, NOW);
    expect(t.source).toBe('ECB');
    expect(t.asOf).toBe('2026-09-23');
    expect(t.pairs.map((p) => p.pair)).toEqual(['GBP/USD', 'GBP/EUR']);
    expect(t.pairs[1]?.asOf).toBe('2026-09-22');
  });

  it('is empty when the refresh has never run', async () => {
    const t = await loadTreasury(new InMemoryFxStore(), NOW);
    expect(t.asOf).toBeNull();
    expect(t.pairs).toEqual([]);
  });
});
