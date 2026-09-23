import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  absorbActuals,
  COST_CATEGORIES,
  type ActualsInput,
  type CostCategory,
  type EstimateByCategory,
} from '../src/actuals.js';
import { D, sum } from '../src/money.js';

const est = (over: Partial<Record<CostCategory, string>> = {}): EstimateByCategory =>
  Object.fromEntries(COST_CATEGORIES.map((c) => [c, over[c] ?? '0'])) as EstimateByCategory;

describe('absorbActuals — demurrage lands on the bulky SKU (ADR-0014)', () => {
  // 500 coffee drippers (0.0008 CBM, 0.4 kg each) and 50 yoga mats (0.032 CBM, 1.1 kg each), sea.
  // Volume: drippers 0.4 CBM, mats 1.6 CBM → mats carry 80% of chargeable weight.
  const input: ActualsInput = {
    mode: 'SEA_LCL',
    vatRecoverable: true,
    lines: [
      {
        ref: 'CFF-02',
        sku: 'CFF-02',
        quantity: 500,
        unitWeightKg: '0.4',
        unitVolumeCbm: '0.0008',
        estimate: est({ GOODS: '3000', FREIGHT_TO_BORDER: '100', DUTY: '150' }),
        estimatedCustomsValueGbp: '3100',
      },
      {
        ref: 'YGA-05',
        sku: 'YGA-05',
        quantity: 50,
        unitWeightKg: '1.1',
        unitVolumeCbm: '0.032',
        estimate: est({ GOODS: '2000', FREIGHT_TO_BORDER: '400', DUTY: '100' }),
        estimatedCustomsValueGbp: '2400',
      },
    ],
    actuals: [
      { category: 'GOODS', amountGbp: '3000', lineRef: 'CFF-02' },
      { category: 'GOODS', amountGbp: '2000', lineRef: 'YGA-05' },
      { category: 'FREIGHT_TO_BORDER', amountGbp: '520' },
      { category: 'DUTY', amountGbp: '250' },
      { category: 'UNPLANNED', amountGbp: '350', unplannedReason: 'DEMURRAGE' },
      { category: 'IMPORT_VAT', amountGbp: '1150' },
    ],
  };

  it('allocates physical costs by chargeable weight and duty by customs value', () => {
    const r = absorbActuals(input);
    const mats = r.lines[1]!;
    const drippers = r.lines[0]!;
    expect(mats.byCategory.UNPLANNED.actualGbp).toBe('280.00'); // 80% of 350
    expect(drippers.byCategory.UNPLANNED.actualGbp).toBe('70.00');
    expect(mats.byCategory.FREIGHT_TO_BORDER.actualGbp).toBe('416.00'); // 80% of 520
    // Duty by customs value: 3100 / 5500 of 250 = 140.91, 2400 / 5500 = 109.09
    expect(drippers.byCategory.DUTY.actualGbp).toBe('140.91');
    expect(mats.byCategory.DUTY.actualGbp).toBe('109.09');
    expect(mats.drivers[0]).toMatchObject({
      category: 'UNPLANNED',
      varianceGbp: '280.00',
      unplannedReasons: ['DEMURRAGE'],
    });
  });

  it('excludes recoverable import VAT from landed cost but still reports it', () => {
    const r = absorbActuals(input);
    expect(r.landedCostCategories).not.toContain('IMPORT_VAT');
    expect(r.byCategory.IMPORT_VAT.actualGbp).toBe('1150.00');
    expect(r.totals.actualLandedCostGbp).toBe('6120.00'); // 5000 + 520 + 250 + 350
    expect(r.totals.estimatedLandedCostGbp).toBe('5750.00');
    expect(r.totals.varianceGbp).toBe('370.00');
    const notRegistered = absorbActuals({ ...input, vatRecoverable: false });
    expect(notRegistered.totals.actualLandedCostGbp).toBe('7270.00');
  });

  it('reports categories still missing a bill', () => {
    const r = absorbActuals({
      ...input,
      actuals: input.actuals.filter((a) => a.category !== 'DUTY'),
    });
    expect(r.missingCategories).toEqual(['DUTY']);
    expect(r.byCategory.DUTY.hasActuals).toBe(false);
  });
});

describe('absorbActuals — the £4.50 → £5.12 water bottle', () => {
  it('explains the per-unit variance by category', () => {
    const r = absorbActuals({
      mode: 'SEA_LCL',
      vatRecoverable: true,
      lines: [
        {
          ref: 'BTL-01',
          sku: 'BTL-01',
          name: 'Insulated water bottle',
          quantity: 1000,
          unitWeightKg: '0.4',
          unitVolumeCbm: '0.002',
          estimate: est({ GOODS: '4500', FREIGHT_TO_BORDER: '300', DUTY: '200' }),
          estimatedCustomsValueGbp: '4800',
        },
      ],
      actuals: [
        { category: 'GOODS', amountGbp: '4500', lineRef: 'BTL-01' },
        { category: 'FREIGHT_TO_BORDER', amountGbp: '300' },
        { category: 'UNPLANNED', amountGbp: '120', unplannedReason: 'DEMURRAGE' },
        { category: 'DUTY', amountGbp: '200' },
      ],
    });
    const l = r.lines[0]!;
    expect(l.estimatedPerUnit).toBe('5.0000');
    expect(l.actualPerUnit).toBe('5.1200');
    expect(l.variancePerUnit).toBe('0.1200');
    expect(l.byCategory.GOODS.varianceGbp).toBe('0.00');
    expect(l.byCategory.DUTY.varianceGbp).toBe('0.00');
    expect(l.drivers).toEqual([
      { category: 'UNPLANNED', varianceGbp: '120.00', unplannedReasons: ['DEMURRAGE'] },
    ]);
  });
});

describe('absorbActuals — fallbacks and invariants', () => {
  it('falls back to value share when no line has weight or volume, and warns', () => {
    const r = absorbActuals({
      mode: 'AIR',
      vatRecoverable: true,
      lines: [
        {
          ref: 'A',
          quantity: 1,
          unitWeightKg: '0',
          unitVolumeCbm: '0',
          estimate: est({ GOODS: '100' }),
          estimatedCustomsValueGbp: '100',
        },
        {
          ref: 'B',
          quantity: 1,
          unitWeightKg: '0',
          unitVolumeCbm: '0',
          estimate: est({ GOODS: '300' }),
          estimatedCustomsValueGbp: '300',
        },
      ],
      actuals: [{ category: 'FREIGHT_TO_BORDER', amountGbp: '40' }],
    });
    expect(r.lines.map((l) => l.byCategory.FREIGHT_TO_BORDER.actualGbp)).toEqual([
      '10.00',
      '30.00',
    ]);
    expect(r.warnings[0]).toMatch(/goods value/);
  });

  it('treats a bill line for an unknown SKU as shared, with a warning', () => {
    const r = absorbActuals({
      mode: 'SEA_FCL',
      vatRecoverable: true,
      lines: [
        {
          ref: 'A',
          quantity: 2,
          unitWeightKg: '1',
          unitVolumeCbm: '0.01',
          estimate: est({ GOODS: '10' }),
          estimatedCustomsValueGbp: '10',
        },
      ],
      actuals: [{ category: 'OTHER', amountGbp: '5', lineRef: 'ZZZ' }],
    });
    expect(r.lines[0]!.byCategory.OTHER.actualGbp).toBe('5.00');
    expect(r.warnings.join(' ')).toMatch(/unknown SKU/);
  });

  const money = (max: number) =>
    fc.integer({ min: 0, max: max * 100 }).map((n) => (n / 100).toFixed(2));
  const lineArb = fc.record({
    ref: fc.uuid(),
    quantity: fc.integer({ min: 1, max: 5000 }),
    unitWeightKg: fc.integer({ min: 0, max: 20000 }).map((n) => (n / 1000).toFixed(3)),
    unitVolumeCbm: fc.integer({ min: 0, max: 500 }).map((n) => (n / 1000).toFixed(3)),
    estimate: fc.constant(est({ GOODS: '100', DUTY: '5' })),
    estimatedCustomsValueGbp: money(500),
  });
  const actualArb = fc.record({
    category: fc.constantFrom(...COST_CATEGORIES),
    amountGbp: money(2000),
    lineRef: fc.constant(null),
  });

  it('allocated actuals always sum to the bills, to the penny, per category', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 6 }),
        fc.array(actualArb, { minLength: 0, maxLength: 12 }),
        fc.boolean(),
        fc.constantFrom('SEA_LCL', 'AIR', 'ROAD'),
        (lines, actuals, vatRecoverable, mode) => {
          const r = absorbActuals({ mode: mode, vatRecoverable, lines, actuals });
          for (const c of COST_CATEGORIES) {
            const billed = sum(
              actuals.filter((a) => a.category === c).map((a) => D(a.amountGbp)),
            ).toFixed(2);
            const allocated = sum(r.lines.map((l) => D(l.byCategory[c].actualGbp))).toFixed(2);
            expect(allocated).toBe(billed);
            expect(r.byCategory[c].actualGbp).toBe(billed);
          }
          const lineTotals = sum(r.lines.map((l) => D(l.actualLandedCostGbp))).toFixed(2);
          expect(lineTotals).toBe(r.totals.actualLandedCostGbp);
          for (const l of r.lines)
            for (const c of COST_CATEGORIES)
              expect(D(l.byCategory[c].actualGbp).isNegative()).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
