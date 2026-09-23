import { readFileSync } from 'node:fs';
import {
  InMemoryFxStore,
  InMemoryTariffCache,
  RateSheetFreightProvider,
  UkTradeTariffClient,
  loadRateSheet,
  parseHmrcMonthlyCsv,
  type FetchLike,
} from '@harbour/adapters';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCalculatorSchema, type CalculatorInput } from '../validators/calculator';
import { DEFAULT_RATE_SHEET, SAMPLE_FX_CSV, adaptersFile } from './paths.server';
import { resolveUnitVolumeCbm, runQuotePipeline, type PipelineDeps } from './quote-pipeline.server';

const NOW = new Date('2026-09-23T10:00:00Z');
const fixture = (name: string): unknown => {
  const path = adaptersFile('fixtures', 'tariff', name);
  if (!path) throw new Error(`fixture ${name} not found`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
};

/** Fake UK Trade Tariff API: serves recorded fixtures, or fails everything when `down`. */
const fakeTariffFetch = (opts: { down?: boolean } = {}): { fetch: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const respond = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    if (opts.down) return respond(503, {});
    if (url.endsWith('/commodities/9503004100'))
      return respond(200, fixture('commodity-9503004100.json'));
    if (url.endsWith('/headings/9503')) return respond(200, fixture('heading-9503.json'));
    return respond(404, {});
  };
  return { fetch, calls };
};

const schema = buildCalculatorSchema(['CNSHA:GBFXT:SEA_LCL', 'CNPVG:GBLHR:AIR']);
const parse = (patch: Record<string, string> = {}): CalculatorInput =>
  schema.parse({
    lane: 'CNSHA:GBFXT:SEA_LCL',
    incoterm: 'FOB',
    hsCode: '9503004100',
    originCountry: 'CN',
    quantity: '500',
    unitPrice: '4.50',
    currency: 'USD',
    unitWeightKg: '0.8',
    unitVolumeCbm: '0.004',
    ...patch,
  });

let fxStore: InMemoryFxStore;
let freight: RateSheetFreightProvider;

beforeAll(async () => {
  const csv = adaptersFile(...SAMPLE_FX_CSV);
  const sheet = adaptersFile(...DEFAULT_RATE_SHEET);
  if (!csv || !sheet) throw new Error('adapters files not found (build @harbour/adapters first)');
  fxStore = new InMemoryFxStore();
  await fxStore.upsert(parseHmrcMonthlyCsv(readFileSync(csv, 'utf8')).records);
  freight = new RateSheetFreightProvider(loadRateSheet(sheet), () => NOW);
});

const deps = (fetch: FetchLike): PipelineDeps => ({
  tariff: new UkTradeTariffClient({
    fetch,
    cache: new InMemoryTariffCache(),
    now: () => NOW,
    sleep: async () => {},
  }),
  fxStore,
  freight,
  now: () => NOW,
});

describe('runQuotePipeline', () => {
  it('produces a READY quote end-to-end from recorded tariff, seeded FX and the rate sheet', async () => {
    const { fetch, calls } = fakeTariffFetch();
    const out = await runQuotePipeline(parse(), deps(fetch));
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    const q = out.quote;
    expect(q.status).toBe('READY');
    expect(q.warnings.filter((w) => w.blocking)).toEqual([]);
    expect(q.rateSource).toBe('RATE_SHEET_V1');
    expect(q.fxSource).toBe('HMRC_MONTHLY');
    expect(q.fxRate).toBe('0.780031'); // 1 / 1.2820 from the sample CSV
    expect(q.calcVersion).toMatch(/^\d+\.\d+$/);
    expect(out.tariff).toMatchObject({ code: '9503004100', verified: true, normalisedFrom: null });
    expect(calls).toEqual([
      'https://www.trade-tariff.service.gov.uk/api/v2/commodities/9503004100',
    ]);

    // Money is strings with 2 dp; goods = 500 × 4.50 × 0.780031 = 1755.07
    expect(q.totals.goodsValueGbp).toBe('1755.05');
    expect(q.lines[0]?.dutyRatePct).toBe('0.0000');
    expect(q.lines[0]?.vatRatePct).toBe('20.00');
    expect(q.totals.totalDuty).toBe('0.00');
    // LCL: 2 CBM (400 kg) × £46 = 92 → minimum 92 applies; haulage 150; origin fees excluded on FOB by default.
    expect(q.totals.freightToBorderGbp).toBe('92.00');
    expect(q.totals.freightPostBorderGbp).toBe('150.00');
    expect(q.totals.originFees).toBe('0.00');
    expect(q.totals.destinationFees).toBe('199.00'); // 120 + 2×12 + 55 clearance
    expect(q.totals.customsValue).toBe('1847.05');
    expect(q.totals.totalVat).toBe('439.21'); // (1847.05 + 0 + 150 + 199) × 20%
    expect(q.totals.totalLandedCostExVat).toBe('2196.05');
    expect(q.totals.totalLandedCost).toBe('2635.26');
    expect(q.lines[0]?.landedCostPerUnit).toBe('4.3921');
    expect(q.validUntil).toBe('2026-09-30T10:00:00.000Z'); // min(sheet 2026-10-07, fetchedAt + 7d)
    expect(out.stages.map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`)).toEqual([
      'resolveProducts:ok',
      'resolveFx:ok',
      'resolveFreight:ok',
      'resolveTariff:ok',
      'compute:ok',
    ]);
    for (const value of Object.values(q.totals))
      expect(typeof value === 'string' || typeof value === 'boolean').toBe(true);
  });

  it('degrades to INDICATIVE (never throws) when the tariff API is down', async () => {
    const { fetch, calls } = fakeTariffFetch({ down: true });
    const out = await runQuotePipeline(parse(), deps(fetch));
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    expect(out.quote.status).toBe('INDICATIVE');
    const codes = out.quote.warnings.map((w) => w.code);
    expect(codes).toContain('HS_UNVERIFIED');
    expect(codes).toContain('TARIFF_AMBIGUOUS');
    expect(out.tariff.verified).toBe(false);
    expect(out.quote.totals.totalDuty).toBe('0.00'); // shown as 0 pending review, flagged blocking
    expect(calls.length).toBe(3); // 1 + 2 retries
    expect(out.stages.find((s) => s.stage === 'resolveTariff')).toMatchObject({ ok: false });
    // The rest of the quote is still real:
    expect(out.quote.totals.freightToBorderGbp).toBe('92.00');
  });

  it('asks the user to pick when a 6-digit code is ambiguous, and never guesses', async () => {
    const out = await runQuotePipeline(parse({ hsCode: '950300' }), deps(fakeTariffFetch().fetch));
    expect(out.kind).toBe('HS_CHOICE_REQUIRED');
    if (out.kind !== 'HS_CHOICE_REQUIRED') return;
    expect(out.enteredCode).toBe('950300');
    expect(out.candidates.map((c) => c.code)).toEqual([
      '9503001000',
      '9503004100',
      '9503004900',
      '9503007000',
    ]);
  });

  it('normalises an unambiguous 8-digit code and records HS_NORMALISED', async () => {
    const out = await runQuotePipeline(
      parse({ hsCode: '95030041' }),
      deps(fakeTariffFetch().fetch),
    );
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    expect(out.tariff).toMatchObject({
      code: '9503004100',
      verified: true,
      normalisedFrom: '95030041',
    });
    expect(out.quote.status).toBe('READY');
    expect(out.quote.warnings.map((w) => w.code)).toContain('HS_NORMALISED');
  });

  it('manual duty entry is INDICATIVE by construction (TARIFF_MANUAL + HS_UNVERIFIED) and skips the API', async () => {
    const { fetch, calls } = fakeTariffFetch();
    const out = await runQuotePipeline(
      parse({
        manualDuty: 'on',
        manualDutyRatePct: '4.7',
        manualVatRatePct: '20',
        manualAddRatePct: '48.5',
      }),
      deps(fetch),
    );
    expect(calls).toEqual([]);
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    expect(out.quote.status).toBe('INDICATIVE');
    const codes = out.quote.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(['TARIFF_MANUAL', 'HS_UNVERIFIED', 'ADD_APPLIES']),
    );
    expect(out.quote.lines[0]?.dutyRatePct).toBe('4.7000');
    expect(out.quote.lines[0]?.addRatePct).toBe('48.5000');
    expect(out.quote.totals.totalDuty).toBe('982.63'); // 1847.05 × 53.2%
  });

  it('fails softly at resolveFx when no rate exists, and accepts a manual rate', async () => {
    const missing = await runQuotePipeline(
      parse({ currency: 'VND', unitPrice: '110000' }),
      deps(fakeTariffFetch().fetch),
    );
    expect(missing).toMatchObject({ kind: 'FAILED', stage: 'resolveFx' });
    const manual = await runQuotePipeline(
      parse({ currency: 'VND', unitPrice: '110000', manualFxRate: '0.00003' }),
      deps(fakeTariffFetch().fetch),
    );
    expect(manual.kind).toBe('QUOTE');
    if (manual.kind !== 'QUOTE') return;
    expect(manual.quote.fxSource).toBe('MANUAL');
    expect(manual.quote.status).toBe('READY');
    expect(manual.quote.warnings.map((w) => w.code)).toContain('FX_MANUAL');
  });

  it('marks FREIGHT_UNAVAILABLE when the lane has no rate, still returning a quote', async () => {
    const noLane: PipelineDeps = {
      ...deps(fakeTariffFetch().fetch),
      freight: {
        name: 'empty',
        quote: async () => ({ ok: false, reason: 'NO_LANE', message: 'nope' }),
      },
    };
    const out = await runQuotePipeline(parse(), noLane);
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    expect(out.quote.status).toBe('INDICATIVE');
    expect(out.quote.warnings.map((w) => w.code)).toContain('FREIGHT_UNAVAILABLE');
    expect(out.quote.totals.freightCost).toBe('0.00');
  });

  it('DAP without a supplier freight breakdown blocks; with one it computes', async () => {
    const blocked = await runQuotePipeline(
      parse({ incoterm: 'DAP' }),
      deps(fakeTariffFetch().fetch),
    );
    expect(blocked.kind === 'QUOTE' && blocked.quote.warnings.map((w) => w.code)).toContain(
      'INCOTERM_FREIGHT_UNKNOWN',
    );
    const ok = await runQuotePipeline(
      parse({ incoterm: 'DAP', supplierFreightTotalGbp: '300', supplierFreightUkGbp: '120' }),
      deps(fakeTariffFetch().fetch),
    );
    expect(ok.kind).toBe('QUOTE');
    if (ok.kind !== 'QUOTE') return;
    expect(ok.quote.status).toBe('READY');
    expect(ok.quote.totals.freightCost).toBe('0.00');
    expect(ok.quote.totals.customsValue).toBe('1635.05'); // goods 1755.05 − UK leg 120
  });
});

describe('resolveUnitVolumeCbm', () => {
  it('computes CBM from carton dimensions with Decimal, 4 dp, never below 0.0001', () => {
    expect(
      resolveUnitVolumeCbm(
        parse({
          unitVolumeCbm: '',
          cartonLengthCm: '60',
          cartonWidthCm: '40',
          cartonHeightCm: '40',
          unitsPerCarton: '24',
        }),
      ),
    ).toMatchObject({ cbm: '0.0040' });
    expect(
      resolveUnitVolumeCbm(
        parse({
          unitVolumeCbm: '',
          cartonLengthCm: '10',
          cartonWidthCm: '10',
          cartonHeightCm: '10',
          unitsPerCarton: '100000',
        }),
      ),
    ).toMatchObject({ cbm: '0.0001' });
    expect(resolveUnitVolumeCbm(parse({ unitVolumeCbm: '0.12' })).cbm).toBe('0.1200');
  });
});
