import { describe, expect, it } from 'vitest';
import {
  cbmFromCarton,
  formStrings,
  productFormSchema,
  productIntent,
  productSearchSchema,
  resolveProductVolume,
  sku,
} from './product';

const valid = {
  sku: 'TOY-001',
  name: 'Wooden train set',
  supplierId: '',
  originCountry: 'cn',
  unitValue: '4.5',
  currency: 'USD',
  weightKg: '0.8',
  volumeCbm: '0.004',
  cartonLengthCm: '',
  cartonWidthCm: '',
  cartonHeightCm: '',
  unitsPerCarton: '',
  hsCode: '9503.00.41.00',
};

describe('productFormSchema', () => {
  it('accepts a complete product and normalises the code and country', () => {
    const r = productFormSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.hsCode).toBe('9503004100');
    expect(r.data.originCountry).toBe('CN');
    expect(r.data.supplierId).toBeUndefined();
    expect(r.data.unitValue).toBe('4.5');
  });

  it.each([
    ['950300', true],
    ['95030041', true],
    ['9503004100', true],
    ['9503 00 41 00', true],
    ['95030', false],
    ['950300410', false],
    ['95030041001', false],
    ['9503ABCD00', false],
    ['', false],
  ])('HS code %s → %s', (code, ok) => {
    const r = productFormSchema.safeParse({ ...valid, hsCode: code });
    expect(r.success).toBe(ok);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['hsCode']);
  });

  it('accepts JPY and any ISO country from the full list', () => {
    const r = productFormSchema.safeParse({ ...valid, currency: 'JPY', originCountry: 'JP' });
    expect(r.success).toBe(true);
    expect(productFormSchema.safeParse({ ...valid, originCountry: 'ZZ' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...valid, currency: 'KRW' }).success).toBe(false);
  });

  it('bounds the decimals: 4 dp value, 3 dp weight, positive only', () => {
    expect(productFormSchema.safeParse({ ...valid, unitValue: '1.23456' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...valid, unitValue: '0' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...valid, weightKg: '0.1234' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...valid, weightKg: '-1' }).success).toBe(false);
  });

  it('needs either a CBM or all four carton fields', () => {
    const none = productFormSchema.safeParse({ ...valid, volumeCbm: '' });
    expect(none.success).toBe(false);
    if (!none.success) expect(none.error.issues[0]?.path).toEqual(['volumeCbm']);

    const partial = productFormSchema.safeParse({
      ...valid,
      volumeCbm: '',
      cartonLengthCm: '40',
      cartonWidthCm: '30',
    });
    expect(partial.success).toBe(false);
    if (!partial.success) expect(partial.error.issues[0]?.message).toContain('all three');

    const carton = productFormSchema.safeParse({
      ...valid,
      volumeCbm: '',
      cartonLengthCm: '40',
      cartonWidthCm: '30',
      cartonHeightCm: '25',
      unitsPerCarton: '12',
    });
    expect(carton.success).toBe(true);
  });

  it('rejects HTML in the name and a supplier id that is not a UUID', () => {
    expect(productFormSchema.safeParse({ ...valid, name: '<b>x</b>' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...valid, supplierId: 'abc' }).success).toBe(false);
  });
});

describe('sku', () => {
  it.each(['A', 'TOY-001', 'sku_1.2/3', 'x'.repeat(64)])('accepts %s', (s) => {
    expect(sku.safeParse(s).success).toBe(true);
  });
  it.each(['', '-lead', 'has space', 'x'.repeat(65), 'a<b'])('rejects %j', (s) => {
    expect(sku.safeParse(s).success).toBe(false);
  });
});

describe('cbmFromCarton / resolveProductVolume', () => {
  it('40×30×25 cm and 12 per carton → 0.0025 CBM per unit', () => {
    expect(cbmFromCarton('40', '30', '25', 12)).toBe('0.0025');
  });

  it('rounds half-up to 4 dp and never returns zero', () => {
    expect(cbmFromCarton('10', '10', '10', 7)).toBe('0.0001'); // 0.001/7 = 0.000142… → 0.0001
    expect(cbmFromCarton('1', '1', '1', 1)).toBe('0.0001'); // 0.000001 → rounds to 0 → minimum
    expect(cbmFromCarton('50', '40', '30', 8)).toBe('0.0075');
  });

  it('rejects a non-positive units per carton', () => {
    expect(() => cbmFromCarton('40', '30', '25', 0)).toThrow(RangeError);
  });

  it('an entered CBM wins over carton dimensions', () => {
    expect(
      resolveProductVolume({
        volumeCbm: '0.01',
        cartonLengthCm: '40',
        cartonWidthCm: '30',
        cartonHeightCm: '25',
        unitsPerCarton: 12,
      }),
    ).toEqual({ volumeCbm: '0.0100', source: 'ENTERED' });
    expect(
      resolveProductVolume({
        volumeCbm: undefined,
        cartonLengthCm: '40',
        cartonWidthCm: '30',
        cartonHeightCm: '25',
        unitsPerCarton: 12,
      }),
    ).toEqual({ volumeCbm: '0.0025', source: 'CARTON', cartonCbm: '0.0300' });
  });
});

describe('search, intents and form reading', () => {
  it('parses the list filters', () => {
    expect(productSearchSchema.parse({ q: '  train ', archived: 'on' })).toEqual({
      q: 'train',
      archived: true,
    });
    expect(productSearchSchema.parse({ q: '', archived: '' })).toEqual({
      q: undefined,
      archived: false,
    });
  });

  it('unknown intents fall back to save', () => {
    expect(productIntent.parse('archive')).toBe('archive');
    expect(productIntent.parse('drop-table')).toBe('save');
    expect(productIntent.parse(null)).toBe('save');
  });

  it('formStrings reads only strings', () => {
    const form = new FormData();
    form.set('sku', 'A');
    form.set('name', new Blob(['x']));
    expect(formStrings(form, ['sku', 'name', 'missing'])).toEqual({
      sku: 'A',
      name: '',
      missing: '',
    });
    expect(formStrings(null, ['sku'])).toEqual({ sku: '' });
  });
});
