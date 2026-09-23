import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { TARIFF_NOT_RESOLVED, productToQuoteLineSnapshot } from './snapshot.server';

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  hsCode: '9503004100',
  hsCodeVerifiedAt: new Date('2026-09-23T10:00:00Z'),
  originCountry: 'CN',
  unitValue: new Decimal('4.5000'),
  currency: 'USD',
  weightKg: new Decimal('0.800'),
  volumeCbm: new Decimal('0.0025'),
};

describe('productToQuoteLineSnapshot', () => {
  it('copies the product into the engine LineInput shape with canonical decimal strings', () => {
    const line = productToQuoteLineSnapshot(product, 500);
    expect(line).toEqual({
      ref: product.id,
      hsCode: '9503004100',
      hsCodeVerified: true,
      originCountry: 'CN',
      quantity: 500,
      unitValue: '4.5',
      currency: 'USD',
      unitWeightKg: '0.8',
      unitVolumeCbm: '0.0025',
      preferenceClaimed: false,
      tariff: TARIFF_NOT_RESOLVED,
    });
    // Nothing on the line is a live reference to the product row.
    expect(line.unitValue).toBeTypeOf('string');
    expect(line.unitWeightKg).toBeTypeOf('string');
  });

  it('an unverified code is flagged so the engine emits HS_UNVERIFIED', () => {
    expect(
      productToQuoteLineSnapshot({ ...product, hsCodeVerifiedAt: null }, 1).hsCodeVerified,
    ).toBe(false);
  });

  it('accepts plain strings (JSON-serialised rows) and passes tariff, preference and assists through', () => {
    const line = productToQuoteLineSnapshot(
      {
        ...product,
        unitValue: '12.3456',
        weightKg: '1.5',
        volumeCbm: '0.01',
        hsCodeVerifiedAt: '2026-09-23T10:00:00Z',
      },
      3,
      {
        tariff: { kind: 'MANUAL', dutyRatePct: '8', vatRatePct: '20' },
        preferenceClaimed: true,
        assistsGbp: '12.50',
      },
    );
    expect(line.unitValue).toBe('12.3456');
    expect(line.hsCodeVerified).toBe(true);
    expect(line.preferenceClaimed).toBe(true);
    expect(line.assistsGbp).toBe('12.5');
    expect(line.tariff).toEqual({ kind: 'MANUAL', dutyRatePct: '8', vatRatePct: '20' });
  });

  it('rejects impossible quantities and negative measures', () => {
    expect(() => productToQuoteLineSnapshot(product, 0)).toThrow(RangeError);
    expect(() => productToQuoteLineSnapshot(product, 1.5)).toThrow(RangeError);
    expect(() => productToQuoteLineSnapshot(product, 1_000_001)).toThrow(RangeError);
    expect(() => productToQuoteLineSnapshot({ ...product, weightKg: '-1' }, 1)).toThrow(RangeError);
  });
});
