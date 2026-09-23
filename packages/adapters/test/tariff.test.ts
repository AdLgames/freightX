import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseHsCode, resolveTariff } from '@harbour/engine';
import {
  InMemoryTariffCache,
  UkTradeTariffClient,
  normaliseCommodity,
  normaliseHeadingCandidates,
} from '../src/index.js';
import type { FetchLike } from '../src/resilience.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'tariff', name), 'utf8'));
const asOf = new Date('2026-09-10T00:00:00Z');

describe('normaliseCommodity (contract with UK Trade Tariff API v2)', () => {
  it('maps measures, duty expressions and geographical areas', () => {
    const c = normaliseCommodity(fixture('commodity-9503004100.json'));
    expect(c.code).toBe('9503004100');
    expect(c.measures).toHaveLength(2);
    expect(c.measures[0]).toMatchObject({
      measureTypeId: '103',
      dutyExpression: '0.00 %',
      geographicalAreaId: '1011',
    });
    expect(c.measures[0]?.geographicalAreaMembers).toContain('CN');
    expect(c.measures[1]).toMatchObject({ measureTypeId: '305', dutyExpression: '20.00 %' });
  });
  it('carries additional codes and lets the engine pick the highest ADD rate', () => {
    const c = normaliseCommodity(fixture('commodity-8712003000.json'));
    const adds = c.measures.filter((m) => m.measureTypeId === '552');
    expect(adds.map((m) => m.additionalCode).sort()).toEqual(['C998', 'C999']);
    const r = resolveTariff(c.measures, {
      originCountry: 'CN',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.addRatePct?.toString()).toBe('48.5');
    expect(r.ok && r.tariff.dutyRatePct?.toString()).toBe('6.5');
  });
  it('preserves specific duty expressions', () => {
    const c = normaliseCommodity(fixture('commodity-1701131000.json'));
    const r = resolveTariff(c.measures, {
      originCountry: 'BR',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.dutyType).toBe('SPECIFIC');
    expect(r.ok && r.tariff.dutySpecific).toEqual({ amountGbp: '339', per: '1000', unit: 'kg' });
    expect(r.ok && r.tariff.vatRatePct.toString()).toBe('0');
  });
  it('resolves group membership and exclusions for preferences', () => {
    const c = normaliseCommodity(fixture('commodity-6403999600.json'));
    const pref = c.measures.find((m) => m.measureTypeId === '142');
    expect(pref?.geographicalAreaMembers).toContain('DE');
    expect(pref?.excludedCountries).toEqual(['XS']);
    const de = resolveTariff(c.measures, {
      originCountry: 'DE',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(de.ok && de.tariff.preferenceClaimed).toBe(true);
    const xs = resolveTariff(c.measures, {
      originCountry: 'XS',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(xs.ok && xs.tariff.preferenceClaimed).toBe(false);
  });
  it('rejects malformed responses instead of mis-pricing', () => {
    expect(() =>
      normaliseCommodity({ data: { id: '1', type: 'commodity', attributes: {} } }),
    ).toThrow();
    expect(() => normaliseCommodity({ nope: true })).toThrow();
  });
});

describe('normaliseHeadingCandidates + normaliseHsCode', () => {
  it('lists declarable leaves only and refuses to guess between children', () => {
    const candidates = normaliseHeadingCandidates(fixture('heading-9503.json'));
    expect(candidates.map((c) => c.code)).toEqual([
      '9503001000',
      '9503004100',
      '9503004900',
      '9503007000',
    ]);
    expect(candidates[3]?.thirdCountryDuty).toBe('4.70 %');
    expect(normaliseHsCode('95030070', candidates)).toEqual({
      ok: true,
      code: '9503007000',
      normalised: true,
    });
    expect(normaliseHsCode('950300', candidates)).toMatchObject({ ok: false, reason: 'AMBIGUOUS' });
  });
});

describe('UkTradeTariffClient', () => {
  const makeFetch = (
    handler: (url: string) => { status: number; body: unknown },
  ): { fetch: FetchLike; calls: string[] } => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      const { status, body } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    };
    return { fetch, calls };
  };

  it('fetches, validates, caches for 24h and serves from cache', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: fixture('commodity-9503004100.json'),
    }));
    let now = new Date('2026-09-10T00:00:00Z');
    const client = new UkTradeTariffClient({
      fetch,
      cache: new InMemoryTariffCache(),
      now: () => now,
      sleep: async () => {},
    });
    const first = await client.lookupCommodity('9503004100');
    expect(first).toMatchObject({ ok: true, fromCache: false });
    const second = await client.lookupCommodity('9503.00.41.00');
    expect(second).toMatchObject({ ok: true, fromCache: true });
    now = new Date('2026-09-11T00:00:01Z');
    const third = await client.lookupCommodity('9503004100');
    expect(third).toMatchObject({ ok: true, fromCache: false });
    expect(calls).toHaveLength(2);
  });
  it('retries 5xx with jitter, never retries 404', async () => {
    let n = 0;
    const flaky = makeFetch(() =>
      n++ < 2
        ? { status: 503, body: {} }
        : { status: 200, body: fixture('commodity-9503004100.json') },
    );
    const client = new UkTradeTariffClient({ fetch: flaky.fetch, sleep: async () => {} });
    expect(await client.lookupCommodity('9503004100')).toMatchObject({ ok: true });
    expect(flaky.calls).toHaveLength(3);

    const missing = makeFetch(() => ({ status: 404, body: {} }));
    const client2 = new UkTradeTariffClient({ fetch: missing.fetch, sleep: async () => {} });
    expect(await client2.lookupCommodity('9999999999')).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(missing.calls).toHaveLength(1);
  });
  it('reports UNAVAILABLE after retries are exhausted and MALFORMED on bad JSON', async () => {
    const down = makeFetch(() => ({ status: 500, body: {} }));
    const client = new UkTradeTariffClient({ fetch: down.fetch, sleep: async () => {} });
    expect(await client.lookupCommodity('9503004100')).toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
    expect(down.calls).toHaveLength(3);

    const bad = makeFetch(() => ({ status: 200, body: { data: 'nope' } }));
    const client2 = new UkTradeTariffClient({ fetch: bad.fetch, sleep: async () => {} });
    expect(await client2.lookupCommodity('9503004100')).toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });
  });
  it('rejects non-10-digit codes before any network call', async () => {
    const { fetch, calls } = makeFetch(() => ({ status: 200, body: {} }));
    const client = new UkTradeTariffClient({ fetch });
    expect(await client.lookupCommodity('950300')).toMatchObject({
      ok: false,
      reason: 'INVALID_CODE',
    });
    expect(calls).toHaveLength(0);
  });
});
