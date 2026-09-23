import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeQuote } from '../src/compute.js';
import { D, sum } from '../src/money.js';
import type { Incoterm, LineInput, Mode, QuoteInput, QuoteResult } from '../src/types.js';

const money2 = (max: number) =>
  fc.integer({ min: 0, max: max * 100 }).map((n) => (n / 100).toFixed(2));
const money3 = (max: number) =>
  fc.integer({ min: 0, max: max * 1000 }).map((n) => (n / 1000).toFixed(3));

const measures = fc.constantFrom(
  [
    { sid: 't', measureTypeId: '103', dutyExpression: '8.00 %', geographicalAreaId: '1011' },
    { sid: 'v', measureTypeId: '305', dutyExpression: '20.00 %', geographicalAreaId: '1011' },
  ],
  [
    { sid: 't', measureTypeId: '103', dutyExpression: '0.00 %', geographicalAreaId: '1011' },
    { sid: 'v', measureTypeId: '305', dutyExpression: '5.00 %', geographicalAreaId: '1011' },
  ],
  [
    {
      sid: 't',
      measureTypeId: '103',
      dutyExpression: '12.80 % + £ 121.00 / 100 kg',
      geographicalAreaId: '1011',
    },
    { sid: 'v', measureTypeId: '305', dutyExpression: '20.00 %', geographicalAreaId: '1011' },
  ],
  [
    {
      sid: 't',
      measureTypeId: '103',
      dutyExpression: '£ 339.00 / 1000 kg',
      geographicalAreaId: '1011',
    },
    { sid: 'v', measureTypeId: '305', dutyExpression: '0.00 %', geographicalAreaId: '1011' },
  ],
);

const lineArb: fc.Arbitrary<LineInput> = fc.record({
  ref: fc.string({ minLength: 1, maxLength: 8 }),
  hsCode: fc.constant('9503004100'),
  hsCodeVerified: fc.boolean(),
  originCountry: fc.constant('CN'),
  quantity: fc.integer({ min: 1, max: 50_000 }),
  unitValue: money2(500),
  currency: fc.constantFrom('USD', 'GBP', 'EUR'),
  unitWeightKg: money3(20),
  unitVolumeCbm: money3(0.5),
  preferenceClaimed: fc.boolean(),
  tariff: measures.map((ms) => ({
    kind: 'MEASURES' as const,
    verifiedAt: '2026-09-01T00:00:00Z',
    measures: ms,
  })),
});

const incoterms: Incoterm[] = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP'];
const modes: Mode[] = ['SEA_LCL', 'SEA_FCL', 'AIR', 'ROAD', 'RAIL'];

const quoteArb: fc.Arbitrary<QuoteInput> = fc.record({
  incoterm: fc.constantFrom(...incoterms),
  mode: fc.constantFrom(...modes),
  originCountry: fc.constant('CN'),
  lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
  fx: fc.constant({
    rates: {
      USD: { rateToGbp: '0.78', source: 'HMRC_MONTHLY' as const, date: '2026-09-01' },
      EUR: { rateToGbp: '0.86', source: 'HMRC_MONTHLY' as const, date: '2026-09-01' },
    },
  }),
  freight: fc.record({
    source: fc.constant('RATE_SHEET_V1'),
    fetchedAt: fc.constant('2026-09-10T10:00:00Z'),
    toBorderGbp: money2(5000),
    postBorderGbp: fc.option(money2(1000), { nil: null }),
    originFeesGbp: money2(500),
    destinationFeesGbp: money2(500),
    clearanceFeeGbp: money2(100),
  }),
  supplierFreight: fc.option(
    fc.record({ totalGbp: money2(200), postBorderGbp: fc.option(money2(50), { nil: null }) }),
    { nil: null },
  ),
  includeOriginFees: fc.boolean(),
  insurance: fc.option(fc.record({ premiumGbp: money2(100) }), { nil: null }),
  vatRegistered: fc.boolean(),
  platformFeeGbp: money2(50),
});

const okQuote = (input: QuoteInput): QuoteResult => {
  const r = computeQuote(input);
  if (!r.ok) throw new Error(`unexpected failure: ${r.code} ${r.message}`);
  return r.quote;
};

const isNonNegativeMoney = (s: string): boolean => /^\d+\.\d{2,4}$/.test(s);

describe('engine invariants (§5.10 property tests)', () => {
  it('totals equal the sum of lines, to the penny', () => {
    fc.assert(
      fc.property(quoteArb, (input) => {
        // Supplier post-border may exceed tiny goods values; that is a validation failure, not a bug.
        const r = computeQuote(input);
        if (!r.ok) {
          expect(r.code).toBe('BAD_SUPPLIER_FREIGHT');
          return;
        }
        const q = r.quote;
        const col = (pick: (l: QuoteResult['lines'][number]) => string) =>
          sum(q.lines.map((l) => D(pick(l)))).toFixed(2);
        expect(col((l) => l.lineGoodsValueGbp)).toBe(q.totals.goodsValueGbp);
        expect(col((l) => l.lineCustomsValueGbp)).toBe(q.totals.customsValue);
        expect(col((l) => l.lineDutyGbp)).toBe(q.totals.totalDuty);
        expect(col((l) => l.lineVatGbp)).toBe(q.totals.totalVat);
        expect(col((l) => l.allocatedFreightGbp)).toBe(q.totals.freightCost);
        expect(col((l) => l.allocatedOriginFeesGbp)).toBe(q.totals.originFees);
        expect(col((l) => l.allocatedDestinationFeesGbp)).toBe(q.totals.destinationFees);
        expect(col((l) => l.allocatedInsuranceGbp)).toBe(q.totals.insurancePremium);
        expect(col((l) => l.allocatedPlatformFeeGbp)).toBe(q.totals.platformFee);
        expect(col((l) => l.lineLandedCostExVatGbp)).toBe(q.totals.totalLandedCostExVat);
        expect(col((l) => l.lineLandedCostGbp)).toBe(q.totals.totalLandedCost);
        // The headline number is exactly its components.
        const components = sum([
          D(q.totals.goodsValueGbp),
          D(q.totals.freightCost),
          D(q.totals.originFees),
          D(q.totals.destinationFees),
          D(q.totals.insurancePremium),
          D(q.totals.totalDuty),
          D(q.totals.platformFee),
        ]).toFixed(2);
        expect(components).toBe(q.totals.totalLandedCostExVat);
        expect(D(q.totals.totalLandedCostExVat).plus(D(q.totals.totalVat)).toFixed(2)).toBe(
          q.totals.totalLandedCost,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('never produces a negative value', () => {
    fc.assert(
      fc.property(quoteArb, (input) => {
        const r = computeQuote(input);
        if (!r.ok) return;
        const q = r.quote;
        for (const [k, v] of Object.entries(q.totals)) {
          if (typeof v === 'string') expect(isNonNegativeMoney(v), `${k}=${v}`).toBe(true);
        }
        for (const l of q.lines) {
          for (const [k, v] of Object.entries(l)) {
            if (typeof v === 'string' && /Gbp$|PerUnit|Value$|Cost$/.test(k) && k !== 'unitValue') {
              expect(isNonNegativeMoney(v), `${l.ref}.${k}=${v}`).toBe(true);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('total landed cost is monotonic non-decreasing in quantity', () => {
    fc.assert(
      fc.property(
        quoteArb,
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 1000 }),
        (input, idx, extra) => {
          const i = idx % input.lines.length;
          const target = input.lines[i];
          if (!target) return;
          const bumped: QuoteInput = {
            ...input,
            lines: input.lines.map((l, j) =>
              j === i ? { ...l, quantity: l.quantity + extra } : l,
            ),
          };
          const a = computeQuote(input);
          const b = computeQuote(bumped);
          if (!a.ok || !b.ok) return;
          expect(D(b.quote.totals.totalLandedCost).gte(D(a.quote.totals.totalLandedCost))).toBe(
            true,
          );
          expect(
            D(b.quote.totals.totalLandedCostExVat).gte(D(a.quote.totals.totalLandedCostExVat)),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('status is READY iff there are no blocking warnings; unverified HS always blocks', () => {
    fc.assert(
      fc.property(quoteArb, (input) => {
        const r = computeQuote(input);
        if (!r.ok) return;
        const blocking = r.quote.warnings.some((w) => w.blocking);
        expect(r.quote.status).toBe(blocking ? 'INDICATIVE' : 'READY');
        if (input.lines.some((l) => !l.hsCodeVerified)) expect(r.quote.status).toBe('INDICATIVE');
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(quoteArb, (input) => {
        expect(computeQuote(input)).toEqual(computeQuote(input));
      }),
      { numRuns: 50 },
    );
  });

  it('DDP never charges the buyer duty or VAT, and reports them as supplier-borne', () => {
    fc.assert(
      fc.property(quoteArb, (input) => {
        const q = okQuote({ ...input, incoterm: 'DDP', supplierFreight: null });
        expect(q.totals.totalDuty).toBe('0.00');
        expect(q.totals.totalVat).toBe('0.00');
        expect(q.totals.vatRecoverable).toBe(false);
        expect(q.totals.totalLandedCost).toBe(q.totals.totalLandedCostExVat);
      }),
      { numRuns: 100 },
    );
  });
});
