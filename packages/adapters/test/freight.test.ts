import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeQuote } from '@harbour/engine';
import {
  RateSheetFreightProvider,
  ResilientFreightProvider,
  SeaRatesFreightProvider,
  loadRateSheet,
  rateSheetSchema,
} from '../src/index.js';
import type { FreightRateProvider, FreightRequest, FreightResult } from '../src/index.js';

const sheet = loadRateSheet(join(import.meta.dirname, '..', 'rate-sheets', 'v1.json'));
const now = () => new Date('2026-09-23T09:00:00Z');
const provider = new RateSheetFreightProvider(sheet, now);

describe('rate sheet v1', () => {
  it('validates and covers the brief’s top lanes', () => {
    expect(rateSheetSchema.safeParse(sheet).success).toBe(true);
    expect(sheet.placeholder).toBe(true);
    const lanes = provider.lanes();
    for (const o of ['CNSHA', 'CNNGB', 'CNSZX', 'INNSA', 'TRIST']) {
      for (const d of ['GBFXT', 'GBSOU', 'GBLGP']) {
        expect(
          lanes.some((l) => l.origin === o && l.destination === d && l.mode === 'SEA_LCL'),
        ).toBe(true);
        expect(
          lanes.some((l) => l.origin === o && l.destination === d && l.mode === 'SEA_FCL'),
        ).toBe(true);
      }
    }
    expect(
      lanes.some((l) => l.origin === 'CNPVG' && l.destination === 'GBLHR' && l.mode === 'AIR'),
    ).toBe(true);
  });
  it('quotes LCL on weight-or-measure with a minimum', async () => {
    const r = await provider.quote({
      origin: 'CNSHA',
      destination: 'GBFXT',
      mode: 'SEA_LCL',
      weightKg: '500',
      volumeCbm: '2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.freight).toMatchObject({
      source: 'RATE_SHEET_V1',
      toBorderGbp: '92.00',
      postBorderGbp: '150.00',
      originFeesGbp: '85.00',
      destinationFeesGbp: '144.00',
      clearanceFeeGbp: '55.00',
      benchmarkToBorderGbp: '92.00',
    });
    expect(r.quote.freight.providerValidUntil).toBe('2026-10-07T23:59:59.000Z');
    const small = await provider.quote({
      origin: 'CNSHA',
      destination: 'GBFXT',
      mode: 'SEA_LCL',
      weightKg: '10',
      volumeCbm: '0.1',
    });
    expect(small.ok && small.quote.freight.toBorderGbp).toBe('92.00');
    expect(small.ok && small.quote.assumptions.join(' ')).toMatch(/minimum/);
  });
  it('quotes FCL per container, inferring containers when none are given', async () => {
    const r = await provider.quote({
      origin: 'CNNGB',
      destination: 'GBLGP',
      mode: 'SEA_FCL',
      weightKg: '8000',
      volumeCbm: '40',
    });
    expect(r.ok && r.quote.freight.toBorderGbp).toBe('2300.00');
    expect(r.ok && r.quote.assumptions.join(' ')).toMatch(/1×40ft/);
    const two = await provider.quote({
      origin: 'CNNGB',
      destination: 'GBLGP',
      mode: 'SEA_FCL',
      weightKg: '8000',
      volumeCbm: '40',
      containers: [{ size: '20', count: 2 }],
    });
    expect(two.ok && two.quote.freight.toBorderGbp).toBe('3200.00');
  });
  it('quotes air on chargeable weight', async () => {
    const r = await provider.quote({
      origin: 'CNPVG',
      destination: 'GBLHR',
      mode: 'AIR',
      weightKg: '100',
      volumeCbm: '1.2',
    }); // volumetric 200 kg
    expect(r.ok && r.quote.freight.toBorderGbp).toBe('640.00');
    expect(r.ok && r.quote.freight.destinationFeesGbp).toBe('70.00');
  });
  it('returns NO_LANE for unknown lanes and INVALID for bad numbers', async () => {
    expect(
      await provider.quote({
        origin: 'USNYC',
        destination: 'GBFXT',
        mode: 'SEA_LCL',
        weightKg: '1',
        volumeCbm: '1',
      }),
    ).toMatchObject({ ok: false, reason: 'NO_LANE' });
    expect(
      await provider.quote({
        origin: 'CNSHA',
        destination: 'GBFXT',
        mode: 'SEA_LCL',
        weightKg: 'x',
        volumeCbm: '1',
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID' });
  });
  it('produces engine-ready input end to end', async () => {
    const r = await provider.quote({
      origin: 'CNSHA',
      destination: 'GBFXT',
      mode: 'SEA_LCL',
      weightKg: '500',
      volumeCbm: '2',
    });
    if (!r.ok) throw new Error('no quote');
    const q = computeQuote({
      incoterm: 'FOB',
      mode: 'SEA_LCL',
      originCountry: 'CN',
      lines: [
        {
          ref: 'A',
          hsCode: '9503004100',
          hsCodeVerified: true,
          originCountry: 'CN',
          quantity: 1000,
          unitValue: '5',
          currency: 'USD',
          unitWeightKg: '0.5',
          unitVolumeCbm: '0.002',
          tariff: { kind: 'MANUAL', dutyRatePct: '0', vatRatePct: '20' },
        },
      ],
      fx: { rates: { USD: { rateToGbp: '0.78', source: 'HMRC_MONTHLY', date: '2026-09-01' } } },
      freight: r.quote.freight,
      vatRegistered: true,
    });
    expect(q.ok && q.quote.totals.freightCost).toBe('242.00');
    expect(q.ok && q.quote.validUntil).toBe('2026-09-30T09:00:00.000Z');
  });
});

describe('ResilientFreightProvider', () => {
  const flaky = (fail: () => boolean): FreightRateProvider => ({
    name: 'PRIMARY',
    quote: async (_req: FreightRequest): Promise<FreightResult> => {
      if (fail()) throw new Error('primary down');
      return {
        ok: true,
        quote: {
          transitDays: 30,
          assumptions: [],
          freight: {
            source: 'PRIMARY',
            fetchedAt: '2026-09-23T09:00:00Z',
            toBorderGbp: '80.00',
            postBorderGbp: '100.00',
            originFeesGbp: '50.00',
            destinationFeesGbp: '60.00',
            clearanceFeeGbp: '55.00',
          },
        },
      };
    },
  });
  const req: FreightRequest = {
    origin: 'CNSHA',
    destination: 'GBFXT',
    mode: 'SEA_LCL',
    weightKg: '500',
    volumeCbm: '2',
  };

  it('uses the primary and attaches the rate-sheet benchmark', async () => {
    const p = new ResilientFreightProvider(
      flaky(() => false),
      provider,
    );
    const r = await p.quote(req);
    expect(r.ok && r.quote.freight).toMatchObject({
      source: 'PRIMARY',
      toBorderGbp: '80.00',
      benchmarkToBorderGbp: '92.00',
    });
    expect(r.ok && r.quote.freight.isFallback).toBeUndefined();
  });
  it('falls back with isFallback when the primary fails, and opens the breaker after repeated failures', async () => {
    let failing = true;
    const p = new ResilientFreightProvider(
      flaky(() => failing),
      provider,
      { volumeThreshold: 3, resetTimeoutMs: 60_000 },
    );
    for (let i = 0; i < 4; i += 1) {
      const r = await p.quote(req);
      expect(r.ok && r.quote.freight).toMatchObject({ source: 'RATE_SHEET_V1', isFallback: true });
    }
    expect(p.breakerState).toBe('open');
    failing = false;
    const r = await p.quote(req); // breaker still open → fallback even though primary would work
    expect(r.ok && r.quote.freight.isFallback).toBe(true);
  });
  it('SeaRates stub is unavailable until implemented', async () => {
    expect(await new SeaRatesFreightProvider(undefined).quote(req)).toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
    expect(await new SeaRatesFreightProvider('key').quote(req)).toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
  });
});
