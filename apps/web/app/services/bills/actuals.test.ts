import { D, sum } from '@harbour/engine';
import { describe, expect, it } from 'vitest';
import {
  actualsByCategory,
  billsToActuals,
  estimateFromQuoteLine,
  perUnit,
  type BillForActuals,
} from './actuals';

const line = (
  over: Partial<BillForActuals['lines'][number]> & { amount: string },
): BillForActuals['lines'][number] => ({
  id: over.id ?? `line-${over.amount}`,
  costCategory: 'GOODS',
  unplannedReason: null,
  description: 'Goods',
  purchaseOrderId: 'po-1',
  lineRef: null,
  ...over,
});

const bill = (over: Partial<BillForActuals>): BillForActuals => ({
  id: 'bill-1',
  referenceNumber: 'INV-1',
  vendorLabel: 'Vendor',
  currency: 'USD',
  isCreditNote: false,
  totalAmount: '100.00',
  lines: [line({ amount: '100.00' })],
  payments: [],
  ...over,
});

const noRate = () => null;

describe('billsToActuals — GBP conversion follows the payments (ADR-0014)', () => {
  it('a GBP bill needs no conversion and no rate', () => {
    const r = billsToActuals(
      [
        bill({
          currency: 'GBP',
          totalAmount: '520.00',
          lines: [line({ amount: '520.00', costCategory: 'FREIGHT_TO_BORDER' })],
        }),
      ],
      noRate,
    );
    expect(r.bills[0]).toMatchObject({ basis: 'GBP', totalGbp: '520.00', estimateRate: null });
    expect(r.actuals).toEqual([
      expect.objectContaining({
        category: 'FREIGHT_TO_BORDER',
        amountGbp: '520.00',
        lineRef: null,
      }),
    ]);
    expect(r.hasEstimatedFx).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('a fully paid foreign-currency bill is the sum of what the bank took, whatever the rate today', () => {
    const r = billsToActuals(
      [
        bill({
          totalAmount: '2250.00',
          lines: [line({ amount: '2250.00', lineRef: 'toy' })],
          payments: [
            { amount: '675.00', amountGbp: '526.50' }, // deposit at 0.78
            { amount: '1575.00', amountGbp: '1260.00' }, // balance at 0.80
          ],
        }),
      ],
      () => '0.99',
    );
    expect(r.bills[0]).toMatchObject({
      basis: 'PAYMENTS',
      totalGbp: '1786.50',
      paidAmount: '2250.00',
    });
    expect(r.actuals[0]).toMatchObject({ category: 'GOODS', amountGbp: '1786.50', lineRef: 'toy' });
    expect(r.hasEstimatedFx).toBe(false);
  });

  it('a partly paid bill: payments for the paid part, the HMRC rate for the rest, flagged as an estimate', () => {
    const r = billsToActuals(
      [
        bill({
          totalAmount: '2250.00',
          payments: [{ amount: '675.00', amountGbp: '526.50' }],
          lines: [line({ amount: '2250.00' })],
        }),
      ],
      (ccy) => (ccy === 'USD' ? '0.8' : null),
    );
    // 526.50 + 1575 × 0.8 = 526.50 + 1260.00
    expect(r.bills[0]).toMatchObject({
      basis: 'PAYMENTS_AND_RATE',
      totalGbp: '1786.50',
      estimateRate: '0.8',
      estimateRateSource: 'HMRC_MONTHLY',
    });
    expect(r.hasEstimatedFx).toBe(true);
  });

  it('an unpaid bill falls back to the quote rate when HMRC has none, and is left out with no rate at all', () => {
    const withQuoteRate = billsToActuals([bill({ totalAmount: '100.00' })], noRate, {
      USD: '0.75',
    });
    expect(withQuoteRate.bills[0]).toMatchObject({
      basis: 'RATE',
      totalGbp: '75.00',
      estimateRateSource: 'QUOTE',
    });
    const none = billsToActuals([bill({ totalAmount: '100.00' })], noRate);
    expect(none.bills[0]).toMatchObject({ basis: 'UNKNOWN', totalGbp: null });
    expect(none.actuals).toEqual([]);
    expect(none.warnings[0]).toMatch(/left out of the actuals/);
  });

  it('with payments but no published rate, the unpaid part carries the rate the payments achieved', () => {
    const r = billsToActuals(
      [bill({ totalAmount: '200.00', payments: [{ amount: '100.00', amountGbp: '78.00' }] })],
      noRate,
    );
    expect(r.bills[0]).toMatchObject({
      basis: 'PAYMENTS_AND_RATE',
      totalGbp: '156.00',
      estimateRate: '0.78',
    });
    expect(r.warnings[0]).toMatch(/rate its payments achieved/);
  });

  it('splits the GBP total across the lines by largest remainder, to the penny', () => {
    const r = billsToActuals(
      [
        bill({
          currency: 'EUR',
          totalAmount: '100.00',
          lines: [
            line({ id: 'a', amount: '33.33', lineRef: 'a' }),
            line({ id: 'b', amount: '33.33', lineRef: 'b' }),
            line({ id: 'c', amount: '33.34', lineRef: 'c' }),
          ],
          payments: [{ amount: '100.00', amountGbp: '85.55' }],
        }),
      ],
      noRate,
    );
    const parts = r.actuals.map((a) => String(a.amountGbp));
    expect(sum(parts.map((p) => D(p))).toFixed(2)).toBe('85.55');
    expect(parts.every((p) => /^\d+\.\d{2}$/.test(p))).toBe(true);
    expect(r.actuals.map((a) => a.billLineId)).toEqual(['a', 'b', 'c']);
  });

  it('a discount line keeps its sign; a credit note reverses every line', () => {
    const discounted = billsToActuals(
      [
        bill({
          currency: 'GBP',
          totalAmount: '90.00',
          lines: [
            line({ amount: '100.00' }),
            line({ id: 'disc', amount: '-10.00', description: 'Early payment discount' }),
          ],
        }),
      ],
      noRate,
    );
    expect(discounted.actuals.map((a) => a.amountGbp)).toEqual(['100.00', '-10.00']);
    const credit = billsToActuals(
      [
        bill({
          currency: 'GBP',
          isCreditNote: true,
          referenceNumber: 'CN-1',
          totalAmount: '25.00',
          lines: [line({ amount: '25.00', costCategory: 'FREIGHT_TO_BORDER' })],
        }),
      ],
      noRate,
    );
    expect(credit.bills[0]!.totalGbp).toBe('-25.00');
    expect(credit.actuals[0]).toMatchObject({ category: 'FREIGHT_TO_BORDER', amountGbp: '-25.00' });
    expect(credit.actuals[0]!.description).toBe('CN-1: Goods');
  });

  it('carries the unplanned reason and tags each actual with its bill line and order', () => {
    const r = billsToActuals(
      [
        bill({
          currency: 'GBP',
          totalAmount: '350.00',
          lines: [
            line({
              id: 'dem',
              amount: '350.00',
              costCategory: 'UNPLANNED',
              unplannedReason: 'DEMURRAGE',
              purchaseOrderId: 'po-9',
              description: 'Demurrage 4 days',
            }),
          ],
        }),
      ],
      noRate,
    );
    expect(r.actuals[0]).toEqual({
      billId: 'bill-1',
      billLineId: 'dem',
      purchaseOrderId: 'po-9',
      category: 'UNPLANNED',
      amountGbp: '350.00',
      lineRef: null,
      unplannedReason: 'DEMURRAGE',
      description: 'INV-1: Demurrage 4 days',
    });
  });
});

describe('estimateFromQuoteLine', () => {
  it('maps each stored quote total to its category; platform fee to OTHER; VAT-base padding left out', () => {
    const est = estimateFromQuoteLine({
      ref: 'p',
      hsCode: '9503004100',
      originCountry: 'CN',
      quantity: 10,
      unitValue: '1.0000',
      currency: 'USD',
      unitValueGbp: '0.7800',
      lineGoodsValueGbp: '7.80',
      lineWeightKg: '8.000',
      lineVolumeCbm: '0.0400',
      chargeableWeight: '0.0400',
      tariffMeasureId: null,
      dutyType: 'AD_VALOREM',
      dutyRatePct: '0.0000',
      dutySpecific: null,
      preferenceClaimed: false,
      addRatePct: null,
      vatRatePct: '20.00',
      allocatedFreightGbp: '3.00',
      allocatedFreightToBorderGbp: '2.00',
      allocatedFreightPostBorderGbp: '1.00',
      allocatedOriginFeesGbp: '0.50',
      allocatedDestinationFeesGbp: '0.60',
      allocatedInsuranceGbp: '0.10',
      allocatedPlatformFeeGbp: '0.20',
      assistsGbp: '0.30',
      allocatedFinancingFeeGbp: '0.40',
      allocatedInlandVatAdjustmentGbp: '9.99',
      lineCustomsValueGbp: '10.60',
      lineDutyGbp: '0.00',
      lineVatGbp: '2.12',
      supplierBorneDutyGbp: '0.00',
      supplierBorneVatGbp: '0.00',
      lineLandedCostExVatGbp: '12.90',
      lineLandedCostGbp: '15.02',
      landedCostPerUnit: '1.2900',
      landedCostPerUnitIncVat: '1.5020',
    });
    expect(est).toEqual({
      GOODS: '7.80',
      ASSISTS: '0.30',
      FREIGHT_TO_BORDER: '2.00',
      FREIGHT_POST_BORDER: '1.00',
      ORIGIN_FEES: '0.50',
      DESTINATION_FEES: '0.60',
      CLEARANCE: '0',
      INSURANCE: '0.10',
      DUTY: '0.00',
      IMPORT_VAT: '2.12',
      DEFERMENT_FEE: '0.40',
      UNPLANNED: '0',
      OTHER: '0.20',
    });
  });

  it('perUnit divides exactly and survives a zero quantity; actualsByCategory sums signed amounts', () => {
    expect(perUnit('8.000', 10)).toBe('0.8');
    expect(perUnit('0.0400', 0)).toBe('0');
    expect(
      actualsByCategory([
        { category: 'GOODS', amountGbp: '10.00' },
        { category: 'GOODS', amountGbp: '-2.50' },
        { category: 'DUTY', amountGbp: '1.00' },
      ]),
    ).toEqual({ GOODS: '7.50', DUTY: '1.00' });
  });
});
