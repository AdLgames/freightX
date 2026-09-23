import { describe, expect, it } from 'vitest';
import { computeQuote } from '../src/compute.js';
import type { QuoteInput } from '../src/types.js';

const good: QuoteInput = {
  incoterm: 'EXW',
  mode: 'SEA_LCL',
  originCountry: 'CN',
  lines: [
    {
      ref: 'A',
      hsCode: '9503004100',
      hsCodeVerified: true,
      originCountry: 'CN',
      quantity: 10,
      unitValue: '5',
      currency: 'USD',
      unitWeightKg: '1',
      unitVolumeCbm: '0.01',
      tariff: { kind: 'MANUAL', dutyRatePct: '8', vatRatePct: '20' },
    },
  ],
  fx: { rates: { USD: { rateToGbp: '0.78', source: 'HMRC_MONTHLY', date: '2026-09-01' } } },
  freight: {
    source: 'RATE_SHEET_V1',
    fetchedAt: '2026-09-10T10:00:00Z',
    toBorderGbp: '100',
    postBorderGbp: '10',
    originFeesGbp: '5',
    destinationFeesGbp: '5',
  },
  vatRegistered: true,
};

describe('computeQuote — validation failures are structured, never thrown', () => {
  it('rejects an empty quote', () => {
    expect(computeQuote({ ...good, lines: [] })).toMatchObject({
      ok: false,
      stage: 'validate',
      code: 'NO_LINES',
    });
  });
  it('rejects negative money and bad quantities', () => {
    expect(
      computeQuote({ ...good, lines: [{ ...good.lines[0]!, unitValue: '-1' }] }),
    ).toMatchObject({ ok: false, code: 'NEGATIVE_VALUE' });
    expect(computeQuote({ ...good, lines: [{ ...good.lines[0]!, quantity: 0 }] })).toMatchObject({
      ok: false,
      code: 'BAD_QUANTITY',
    });
    expect(computeQuote({ ...good, lines: [{ ...good.lines[0]!, quantity: 1.5 }] })).toMatchObject({
      ok: false,
      code: 'BAD_QUANTITY',
    });
    expect(
      computeQuote({ ...good, lines: [{ ...good.lines[0]!, quantity: 1_000_001 }] }),
    ).toMatchObject({ ok: false, code: 'BAD_QUANTITY' });
  });
  it('rejects malformed decimals and HS codes', () => {
    expect(
      computeQuote({ ...good, lines: [{ ...good.lines[0]!, unitValue: '1,000' }] }),
    ).toMatchObject({ ok: false, code: 'BAD_DECIMAL' });
    expect(computeQuote({ ...good, lines: [{ ...good.lines[0]!, hsCode: '95' }] })).toMatchObject({
      ok: false,
      code: 'BAD_HS_CODE',
    });
  });
  it('fails at resolveFx when a currency has no rate', () => {
    expect(computeQuote({ ...good, fx: { rates: {} } })).toMatchObject({
      ok: false,
      stage: 'resolveFx',
      code: 'FX_MISSING',
    });
  });
  it('honours provider expiry when earlier than fetchedAt + 7 days', () => {
    const r = computeQuote({
      ...good,
      freight: { ...good.freight!, providerValidUntil: '2026-09-12T00:00:00Z' },
    });
    expect(r.ok && r.quote.validUntil).toBe('2026-09-12T00:00:00.000Z');
    const r2 = computeQuote({
      ...good,
      freight: { ...good.freight!, providerValidUntil: '2026-10-12T00:00:00Z' },
    });
    expect(r2.ok && r2.quote.validUntil).toBe('2026-09-17T10:00:00.000Z');
  });
  it('stamps the engine version', () => {
    const r = computeQuote(good);
    expect(r.ok && r.quote.calcVersion).toMatch(/^\d+\.\d+$/);
  });
});
