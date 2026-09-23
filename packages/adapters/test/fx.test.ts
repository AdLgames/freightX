import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryFxStore, parseEcbDailyXml, parseHmrcMonthlyCsv, resolveFx } from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'fx', name), 'utf8');

describe('parseHmrcMonthlyCsv', () => {
  it('inverts units-per-£1 into GBP-per-unit and skips bad rows', () => {
    const { records, skipped } = parseHmrcMonthlyCsv(fixture('hmrc-monthly-sample.csv'));
    expect(records).toHaveLength(5);
    const usd = records.find((r) => r.currency === 'USD');
    expect(usd).toMatchObject({
      source: 'HMRC_MONTHLY',
      rateToGbp: '0.780031',
      validFrom: '2026-09-01',
      validTo: '2026-09-30',
    });
    expect(skipped).toHaveLength(1);
  });
  it('throws on an unrecognised header', () => {
    expect(() => parseHmrcMonthlyCsv('a,b,c\n1,2,3\n')).toThrow(/header/);
  });
});

describe('parseEcbDailyXml', () => {
  it('crosses EUR-based rates through GBP', () => {
    const { date, records } = parseEcbDailyXml(fixture('ecb-daily-sample.xml'));
    expect(date).toBe('2026-09-22');
    const eur = records.find((r) => r.currency === 'EUR');
    const usd = records.find((r) => r.currency === 'USD');
    expect(eur?.rateToGbp).toBe('0.86');
    expect(usd?.rateToGbp).toBe('0.735043'); // 0.86 / 1.17
    expect(records.some((r) => r.currency === 'GBP')).toBe(false);
  });
});

describe('resolveFx — HMRC first, ECB fallback, manual override, never a default', () => {
  it('labels sources correctly', async () => {
    const store = new InMemoryFxStore();
    await store.upsert(parseHmrcMonthlyCsv(fixture('hmrc-monthly-sample.csv')).records);
    await store.upsert(parseEcbDailyXml(fixture('ecb-daily-sample.xml')).records);
    await store.upsert([
      {
        source: 'ECB',
        currency: 'JPY',
        rateToGbp: '0.0052',
        validFrom: '2026-09-22',
        validTo: '2026-09-29',
      },
    ]);
    const at = new Date('2026-09-23T12:00:00Z');
    const r = await resolveFx(store, ['USD', 'JPY', 'GBP', 'VND'], {
      at,
      manual: { VND: '0.00003' },
    });
    expect(r.ok).toBe(true);
    expect(r.fx.rates['USD']).toMatchObject({ source: 'HMRC_MONTHLY', rateToGbp: '0.780031' });
    expect(r.fx.rates['JPY']).toMatchObject({ source: 'ECB' });
    expect(r.fx.rates['VND']).toMatchObject({ source: 'MANUAL', rateToGbp: '0.00003' });
    expect(r.fx.rates['GBP']).toBeUndefined();
    expect(r.fallbacks).toEqual(['JPY']);
  });
  it('reports missing currencies instead of defaulting', async () => {
    const r = await resolveFx(new InMemoryFxStore(), ['USD'], { at: new Date() });
    expect(r).toMatchObject({ ok: false, missing: ['USD'] });
  });
  it('does not use a rate outside its validity window', async () => {
    const store = new InMemoryFxStore();
    await store.upsert([
      {
        source: 'HMRC_MONTHLY',
        currency: 'USD',
        rateToGbp: '0.78',
        validFrom: '2026-08-01',
        validTo: '2026-08-31',
      },
    ]);
    const r = await resolveFx(store, ['USD'], { at: new Date('2026-09-15T00:00:00Z') });
    expect(r.ok).toBe(false);
  });
});
