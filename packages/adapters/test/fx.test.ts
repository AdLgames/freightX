import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InMemoryFxStore,
  ecbRecordsToLoad,
  parseEcbDailyXml,
  parseEcbHistoryXml,
  parseHmrcMonthlyCsv,
  resolveFx,
} from '../src/index.js';

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

describe('parseEcbHistoryXml', () => {
  it('parses every dated block oldest first and keeps the daily parser on the first block', () => {
    const xml = fixture('ecb-history-sample.xml');
    const h = parseEcbHistoryXml(xml);
    expect(h.days.map((d) => d.date)).toEqual(['2026-09-15', '2026-09-19', '2026-09-22']);
    expect(h.records).toHaveLength(9); // EUR, USD, JPY × 3 days
    const usd15 = h.records.find((r) => r.currency === 'USD' && r.validFrom === '2026-09-15');
    expect(usd15?.rateToGbp).toBe('0.73913'); // 0.85 / 1.15
    expect(usd15?.validTo).toBe('2026-09-22');
    expect(parseEcbDailyXml(xml).date).toBe('2026-09-22');
  });

  it('loads missing days plus the newest two', () => {
    const h = parseEcbHistoryXml(fixture('ecb-history-sample.xml'));
    const all = ecbRecordsToLoad(h, new Set());
    expect(all).toHaveLength(9);
    const some = ecbRecordsToLoad(h, new Set(['2026-09-15', '2026-09-19', '2026-09-22']));
    expect(new Set(some.map((r) => r.validFrom))).toEqual(new Set(['2026-09-19', '2026-09-22']));
    const one = ecbRecordsToLoad(h, new Set(['2026-09-19', '2026-09-22']), 1);
    expect(new Set(one.map((r) => r.validFrom))).toEqual(new Set(['2026-09-15', '2026-09-22']));
  });

  it('throws without a dated block', () => {
    expect(() => parseEcbHistoryXml('<Cube></Cube>')).toThrow(/no <Cube time/);
  });
});

describe('InMemoryFxStore.history', () => {
  it('returns the window oldest first, by source and currency only', async () => {
    const store = new InMemoryFxStore();
    await store.upsert(parseEcbHistoryXml(fixture('ecb-history-sample.xml')).records);
    await store.upsert([
      {
        source: 'HMRC_MONTHLY',
        currency: 'USD',
        rateToGbp: '0.7',
        validFrom: '2026-09-01',
        validTo: '2026-09-30',
      },
    ]);
    const rows = await store.history(
      'ECB',
      'USD',
      new Date('2026-09-16T12:00:00Z'),
      new Date('2026-09-22T00:00:00Z'),
    );
    expect(rows.map((r) => r.validFrom)).toEqual(['2026-09-19', '2026-09-22']);
    expect(
      await store.history('ECB', 'CHF', new Date('2026-01-01'), new Date('2026-12-31')),
    ).toEqual([]);
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
