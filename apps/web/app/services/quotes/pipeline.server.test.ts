import { readFileSync } from 'node:fs';
import {
  InMemoryFxStore,
  RateSheetFreightProvider,
  loadRateSheet,
  parseHmrcMonthlyCsv,
} from '@harbour/adapters';
import { Prisma } from '@harbour/db';
import { D } from '@harbour/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildQuoteFormSchema, type QuoteFormInput } from '../../validators/quote';
import type { ProductRecord } from '../catalogue/products.server';
import { DEFAULT_RATE_SHEET, SAMPLE_FX_CSV, adaptersFile } from '../paths.server';
import type { PipelineDeps } from '../quote-pipeline.server';
import { DOWN_COMMODITY, FIXTURE_NOW, fixtureTariff } from '../../test-support/tariff-fixtures';
import { runCatalogueQuote } from './pipeline.server';

/**
 * The catalogue quote pipeline (M4) against the recorded tariff fixtures, the sample HMRC FX CSV
 * and rate sheet v1 — no database, no network.
 */

const ids = {
  toy: '11111111-1111-4111-8111-111111111111',
  bike: '22222222-2222-4222-8222-222222222222',
  sugar: '33333333-3333-4333-8333-333333333333',
  heading: '44444444-4444-4444-8444-444444444444',
};

const product = (patch: Partial<ProductRecord> & { id: string }): ProductRecord => ({
  sku: `SKU-${patch.id.slice(0, 4)}`,
  name: 'Product',
  supplierId: null,
  supplier: null,
  originCountry: 'CN',
  unitValue: new Prisma.Decimal('4.5'),
  currency: 'USD',
  weightKg: new Prisma.Decimal('0.8'),
  volumeCbm: new Prisma.Decimal('0.004'),
  unitsPerCarton: null,
  cartonLengthCm: null,
  cartonWidthCm: null,
  cartonHeightCm: null,
  hsCode: '9503004100',
  hsCodeVerifiedAt: new Date('2026-09-01T00:00:00Z'),
  hsDescription: 'Wheeled toys',
  preferenceEligible: false,
  archivedAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...patch,
});

const products: ProductRecord[] = [
  product({ id: ids.toy }),
  product({
    id: ids.bike,
    hsCode: '8712003000',
    currency: 'EUR',
    unitValue: new Prisma.Decimal('120'),
    weightKg: new Prisma.Decimal('14'),
    volumeCbm: new Prisma.Decimal('0.2'),
  }),
  product({ id: ids.sugar, hsCode: DOWN_COMMODITY, hsCodeVerifiedAt: null, hsDescription: null }),
  product({ id: ids.heading, hsCode: '950300', hsCodeVerifiedAt: null, hsDescription: null }),
];

const schema = buildQuoteFormSchema(['CNSHA:GBFXT:SEA_LCL', 'CNPVG:GBLHR:AIR']);
const input = (patch: Record<string, unknown> = {}, lines?: unknown[]): QuoteFormInput =>
  schema.parse({
    incoterm: 'FOB',
    lane: 'CNSHA:GBFXT:SEA_LCL',
    vatRegistered: 'on',
    dutyPayment: 'BROKER_DEFERMENT',
    lines: lines ?? [{ productId: ids.toy, quantity: '500' }],
    ...patch,
  });

let deps: PipelineDeps;

beforeAll(async () => {
  const csv = adaptersFile(...SAMPLE_FX_CSV);
  const sheet = adaptersFile(...DEFAULT_RATE_SHEET);
  if (!csv || !sheet) throw new Error('adapters files not found (build @harbour/adapters first)');
  const fxStore = new InMemoryFxStore();
  await fxStore.upsert(parseHmrcMonthlyCsv(readFileSync(csv, 'utf8')).records);
  deps = {
    tariff: fixtureTariff(),
    fxStore,
    freight: new RateSheetFreightProvider(loadRateSheet(sheet), () => FIXTURE_NOW),
    now: () => FIXTURE_NOW,
  };
});

describe('runCatalogueQuote', () => {
  it('one verified line: READY, snapshot from the product, totals = Σ lines', async () => {
    const out = await runCatalogueQuote(input(), products, deps);
    expect(out.kind).toBe('QUOTE');
    if (out.kind !== 'QUOTE') return;
    const q = out.view.quote;
    expect(q.status).toBe('READY');
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({
      ref: ids.toy,
      hsCode: '9503004100',
      originCountry: 'CN',
      quantity: 500,
      unitValue: '4.5000',
      currency: 'USD',
      lineWeightKg: '400.000',
      lineVolumeCbm: '2.0000',
      dutyType: 'AD_VALOREM',
    });
    expect(q.fxSnapshots.USD).toMatchObject({ source: 'HMRC_MONTHLY' });
    expect(q.rateSource).toBe('RATE_SHEET_V1');
    expect(out.view.lines[0]).toMatchObject({ sku: 'SKU-1111', hsVerified: true });
    expect(out.view.shipment).toEqual({ totalWeightKg: '400.000', totalVolumeCbm: '2.0000' });
    expect(out.view.stages.map((s) => s.stage)).toEqual([
      'resolveProducts',
      'resolveFx',
      'resolveFreight',
      'resolveTariff',
      'compute',
    ]);
    expect(D(q.totals.totalLandedCostExVat).equals(D(q.lines[0]!.lineLandedCostExVatGbp))).toBe(
      true,
    );
    expect(out.input.originCountry).toBe('CN');
    expect(out.input.originPort).toBe('CNSHA');
  });

  it('two lines in two currencies: both FX rates resolved, allocations sum to the totals', async () => {
    const out = await runCatalogueQuote(
      input({}, [
        { productId: ids.toy, quantity: '500' },
        { productId: ids.bike, quantity: '20', assistsGbp: '100', preferenceClaimed: 'on' },
      ]),
      products,
      deps,
    );
    if (out.kind !== 'QUOTE') throw new Error(out.message);
    const q = out.view.quote;
    expect(Object.keys(q.fxSnapshots).sort()).toEqual(['EUR', 'USD']);
    expect(q.lines).toHaveLength(2);
    // preferenceClaimed on the result reflects a preference actually applied (none for CN).
    expect(q.lines[1]).toMatchObject({ assistsGbp: '100.00', preferenceClaimed: false });
    const sum = (k: 'allocatedFreightGbp' | 'lineDutyGbp' | 'lineVatGbp') =>
      q.lines.reduce((acc, l) => acc.plus(D(l[k])), D('0'));
    expect(sum('allocatedFreightGbp').toFixed(2)).toBe(q.totals.freightCost);
    expect(sum('lineDutyGbp').toFixed(2)).toBe(q.totals.totalDuty);
    expect(sum('lineVatGbp').toFixed(2)).toBe(q.totals.totalVat);
    expect(q.totals.assistsGbp).toBe('100.00');
  });

  it('an unverified product (tariff down) makes the quote INDICATIVE with HS_UNVERIFIED', async () => {
    const out = await runCatalogueQuote(
      input({}, [{ productId: ids.sugar, quantity: '10' }]),
      products,
      deps,
    );
    if (out.kind !== 'QUOTE') throw new Error(out.message);
    expect(out.view.quote.status).toBe('INDICATIVE');
    const codes = out.view.quote.warnings.map((w) => w.code);
    expect(codes).toContain('HS_UNVERIFIED');
    expect(out.view.quote.warnings.find((w) => w.code === 'HS_UNVERIFIED')?.lineRef).toBe(
      ids.sugar,
    );
    expect(out.view.lines[0]?.hsVerified).toBe(false);
    expect(out.view.stages.find((s) => s.stage === 'resolveTariff')?.ok).toBe(false);
  });

  it('a 6-digit product code is never resolved to a 10-digit one here', async () => {
    const out = await runCatalogueQuote(
      input({}, [{ productId: ids.heading, quantity: '10' }]),
      products,
      deps,
    );
    if (out.kind !== 'QUOTE') throw new Error(out.message);
    expect(out.view.quote.status).toBe('INDICATIVE');
    expect(out.view.stages.find((s) => s.stage === 'resolveTariff')?.note).toMatch(
      /ambiguous.*pick one on the product/,
    );
  });

  it('manual FX override is honoured and recorded as MANUAL', async () => {
    const out = await runCatalogueQuote(
      input({ manualFxCurrency: 'USD', manualFxRate: '0.5' }),
      products,
      deps,
    );
    if (out.kind !== 'QUOTE') throw new Error(out.message);
    expect(out.view.quote.fxSource).toBe('MANUAL');
    expect(out.view.quote.fxRate).toBe('0.5');
    expect(out.view.quote.lines[0]?.unitValueGbp).toBe('2.2500');
  });

  it('a currency with no loaded rate fails at resolveFx with a field hint', async () => {
    const vnd = product({ id: ids.toy, currency: 'VND' });
    const out = await runCatalogueQuote(input(), [vnd], deps);
    expect(out).toMatchObject({ kind: 'FAILED', stage: 'resolveFx', field: 'manualFxRate' });
  });

  it('a product that is not in the given catalogue rows fails at resolveProducts', async () => {
    const out = await runCatalogueQuote(input(), [], deps);
    expect(out).toMatchObject({
      kind: 'FAILED',
      stage: 'resolveProducts',
      field: 'line_0_productId',
    });
  });

  it('DAP without the supplier freight breakdown is INDICATIVE (INCOTERM_FREIGHT_UNKNOWN); with it, not', async () => {
    const without = await runCatalogueQuote(input({ incoterm: 'DAP' }), products, deps);
    if (without.kind !== 'QUOTE') throw new Error(without.message);
    expect(without.view.quote.warnings.map((w) => w.code)).toContain('INCOTERM_FREIGHT_UNKNOWN');
    const withIt = await runCatalogueQuote(
      input({ incoterm: 'DAP', supplierFreightTotalGbp: '300', supplierFreightUkGbp: '50' }),
      products,
      deps,
    );
    if (withIt.kind !== 'QUOTE') throw new Error(withIt.message);
    expect(withIt.view.quote.warnings.map((w) => w.code)).not.toContain('INCOTERM_FREIGHT_UNKNOWN');
  });

  it('broker deferment fee terms from the form; PVA without VAT registration warns', async () => {
    const out = await runCatalogueQuote(
      input({ brokerFeePct: '2.5', brokerMinimumGbp: '25', vatRegistered: '', vatPostponed: 'on' }),
      products,
      deps,
    );
    if (out.kind !== 'QUOTE') throw new Error(out.message);
    expect(out.view.dutyPayment).toEqual({
      method: 'BROKER_DEFERMENT',
      brokerFeeTerms: { feePct: '2.5', minimumGbp: '25', usedDefaults: false },
    });
    expect(out.view.quote.warnings.map((w) => w.code)).toContain('PVA_REQUIRES_VAT_REGISTRATION');
    expect(out.view.quote.totals.vatPostponed).toBe(false);
    const own = await runCatalogueQuote(input({ dutyPayment: 'OWN_DEFERMENT' }), products, deps);
    if (own.kind !== 'QUOTE') throw new Error(own.message);
    expect(own.view.dutyPayment).toEqual({ method: 'OWN_DEFERMENT', brokerFeeTerms: null });
    expect(own.view.quote.totals.financingFee).toBe('0.00');
  });
});
