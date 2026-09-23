import { describe, expect, it } from 'vitest';
import { buildCalculatorSchema, formDataToRecord, laneKey, parseLaneKey } from './calculator';
import { fieldErrors } from './common';

const LANES = [laneKey('CNSHA', 'GBFXT', 'SEA_LCL'), laneKey('CNPVG', 'GBLHR', 'AIR')];
const schema = buildCalculatorSchema(LANES);

const valid = {
  lane: 'CNSHA:GBFXT:SEA_LCL',
  incoterm: 'FOB',
  hsCode: '9503004100',
  originCountry: 'CN',
  quantity: '500',
  unitPrice: '4.50',
  currency: 'USD',
  unitWeightKg: '0.8',
  unitVolumeCbm: '0.004',
};

describe('calculator schema', () => {
  it('parses a valid submission with checkbox defaults', () => {
    const out = schema.parse(valid);
    expect(out).toMatchObject({
      lane: 'CNSHA:GBFXT:SEA_LCL',
      quantity: 500,
      unitPrice: '4.50',
      preferenceClaimed: false,
      vatRegistered: false,
      manualDuty: false,
      includeOriginFees: false,
    });
    expect(out.insurancePremiumGbp).toBeUndefined();
  });
  it('treats blank optional fields as absent and "on" checkboxes as true', () => {
    const out = schema.parse({
      ...valid,
      insurancePremiumGbp: '',
      manualFxRate: ' ',
      vatRegistered: 'on',
      preferenceClaimed: 'on',
    });
    expect(out.insurancePremiumGbp).toBeUndefined();
    expect(out.manualFxRate).toBeUndefined();
    expect(out.vatRegistered).toBe(true);
    expect(out.preferenceClaimed).toBe(true);
  });
  it('rejects lanes outside the rate sheet and malformed lane keys', () => {
    for (const lane of ['CNSHA:GBSOU:SEA_LCL', 'CNSHA:GBFXT:ROAD', 'nonsense', '']) {
      const res = schema.safeParse({ ...valid, lane });
      expect(res.success, lane).toBe(false);
      if (!res.success)
        expect(fieldErrors(res.error.issues).lane).toBe('Choose a route from the list.');
    }
    expect(parseLaneKey('CNSHA:GBFXT:SEA_LCL')).toEqual({
      origin: 'CNSHA',
      destination: 'GBFXT',
      mode: 'SEA_LCL',
    });
    expect(parseLaneKey('CNSHA:GBFXT:RAIL')).toBeNull();
  });
  it('accepts carton dimensions instead of CBM, and requires one or the other', () => {
    const carton = {
      cartonLengthCm: '60',
      cartonWidthCm: '40',
      cartonHeightCm: '40',
      unitsPerCarton: '24',
    };
    const { unitVolumeCbm: _drop, ...noCbm } = valid;
    expect(schema.safeParse({ ...noCbm, ...carton }).success).toBe(true);
    const missing = schema.safeParse(noCbm);
    expect(missing.success).toBe(false);
    if (!missing.success)
      expect(fieldErrors(missing.error.issues).unitVolumeCbm).toMatch(/volume per unit/i);
    const partial = schema.safeParse({ ...noCbm, cartonLengthCm: '60' });
    expect(partial.success).toBe(false);
    if (!partial.success)
      expect(fieldErrors(partial.error.issues).unitVolumeCbm).toMatch(
        /all three carton dimensions/i,
      );
  });
  it('requires duty and VAT rates when manual duty is ticked', () => {
    const res = schema.safeParse({ ...valid, manualDuty: 'on' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const errs = fieldErrors(res.error.issues);
      expect(errs.manualDutyRatePct).toBeDefined();
      expect(errs.manualVatRatePct).toBeDefined();
    }
    expect(
      schema.safeParse({
        ...valid,
        manualDuty: 'on',
        manualDutyRatePct: '4.7',
        manualVatRatePct: '20',
      }).success,
    ).toBe(true);
  });
  it('requires the supplier freight total when a UK portion is given', () => {
    const res = schema.safeParse({ ...valid, incoterm: 'DAP', supplierFreightUkGbp: '150' });
    expect(res.success).toBe(false);
    if (!res.success) expect(fieldErrors(res.error.issues).supplierFreightTotalGbp).toBeDefined();
  });
  it('rejects bad HS codes, unknown countries, silly numbers and the honeypot', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ hsCode: '95030' }, 'hsCode'],
      [{ originCountry: 'ZZ' }, 'originCountry'],
      [{ quantity: '0' }, 'quantity'],
      [{ quantity: '2000000' }, 'quantity'],
      [{ unitPrice: '-5' }, 'unitPrice'],
      [{ unitPrice: '1.23456' }, 'unitPrice'],
      [{ unitWeightKg: '0' }, 'unitWeightKg'],
      [{ unitWeightKg: '100001' }, 'unitWeightKg'],
      [{ currency: 'JPY' }, 'currency'],
      [{ incoterm: 'XYZ' }, 'incoterm'],
      [{ productLabel: '<b>bold</b>' }, 'productLabel'],
      [{ website: 'http://spam.example' }, 'website'],
    ];
    for (const [patch, field] of cases) {
      const res = schema.safeParse({ ...valid, ...patch });
      expect(res.success, field).toBe(false);
      if (!res.success) expect(Object.keys(fieldErrors(res.error.issues)), field).toContain(field);
    }
  });
  it('allows out-of-sanity-bound but plausible values (engine flags SANITY_BOUND instead)', () => {
    // 100 units × 400 kg = 40,000 kg per line: allowed here, warned about by the engine.
    expect(schema.safeParse({ ...valid, quantity: '100', unitWeightKg: '400' }).success).toBe(true);
  });
  it('formDataToRecord only picks known fields and caps length', () => {
    const fd = new FormData();
    fd.set('lane', 'CNSHA:GBFXT:SEA_LCL');
    fd.set('unknownField', 'x');
    fd.set('productLabel', 'a'.repeat(5000));
    const rec = formDataToRecord(fd);
    expect(rec.lane).toBe('CNSHA:GBFXT:SEA_LCL');
    expect(rec).not.toHaveProperty('unknownField');
    expect(rec.productLabel?.length).toBe(4096);
  });
});
