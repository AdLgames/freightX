import { COST_CATEGORIES, type ActualsResult, type CostCategory } from '@harbour/engine';
import { describe, expect, it } from 'vitest';
import { marginWatchItem } from './margin-watch.server';

const figures = (over: Partial<Record<CostCategory, [string, string]>> = {}) =>
  Object.fromEntries(
    COST_CATEGORIES.map((c) => {
      const [estimate, actual] = over[c] ?? ['0.00', '0.00'];
      return [
        c,
        {
          estimateGbp: estimate,
          actualGbp: actual,
          varianceGbp: (Number(actual) - Number(estimate)).toFixed(2),
          hasActuals: actual !== '0.00',
        },
      ];
    }),
  ) as ActualsResult['byCategory'];

const result = (
  estimate: string,
  actual: string,
  over: Partial<Record<CostCategory, [string, string]>> = {},
  missing: CostCategory[] = [],
): ActualsResult => ({
  actualsVersion: '1.0',
  vatRecoverable: true,
  landedCostCategories: [...COST_CATEGORIES],
  byCategory: figures(over),
  totals: {
    estimatedLandedCostGbp: estimate,
    actualLandedCostGbp: actual,
    varianceGbp: (Number(actual) - Number(estimate)).toFixed(2),
  },
  missingCategories: missing,
  lines: [],
  warnings: [],
});

const order = { id: 'o1', poNumber: 'PO-2026-042' };

describe('marginWatchItem', () => {
  it('flags an order over budget by more than the threshold and names the biggest driver', () => {
    const r = result('4400.00', '4585.00', {
      DESTINATION_FEES: ['300.00', '460.00'],
      FREIGHT_TO_BORDER: ['1200.00', '1225.00'],
      DUTY: ['500.00', '500.00'],
    });
    const item = marginWatchItem(order, r)!;
    expect(item).toMatchObject({
      orderId: 'o1',
      poNumber: 'PO-2026-042',
      estimatedLandedCostGbp: '4400.00',
      actualLandedCostGbp: '4585.00',
      varianceGbp: '185.00',
      variancePct: '+4.2',
      incomplete: false,
    });
    expect(item.driver).toEqual({
      category: 'DESTINATION_FEES',
      label: expect.any(String),
      varianceGbp: '160.00',
    });
  });

  it('stays quiet within the threshold, under budget, or without an estimate', () => {
    expect(marginWatchItem(order, result('1000.00', '1015.00'))).toBeNull(); // +1.5%
    expect(marginWatchItem(order, result('1000.00', '950.00'))).toBeNull();
    expect(marginWatchItem(order, result('0.00', '50.00'))).toBeNull();
    expect(marginWatchItem(order, result('1000.00', '1015.00'), '1')).not.toBeNull();
  });

  it('marks the figure incomplete while estimated categories have no bill yet', () => {
    const item = marginWatchItem(order, result('1000.00', '1100.00', {}, ['DUTY']))!;
    expect(item.incomplete).toBe(true);
    expect(item.driver).toBeNull();
  });
});
