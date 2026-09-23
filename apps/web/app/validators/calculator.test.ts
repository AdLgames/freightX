import { describe, expect, it } from 'vitest';
import {
  apportionAssist,
  buildCalculatorSchema,
  formDataToRecord,
  laneKey,
  parseLaneKey,
} from './calculator';
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

describe('assists (tooling, moulds, design)', () => {
  const errorsOf = (patch: Record<string, string>): Record<string, string> => {
    const res = schema.safeParse({ ...valid, ...patch });
    expect(res.success, JSON.stringify(patch)).toBe(false);
    return res.success ? {} : fieldErrors(res.error.issues);
  };

  it('is absent by default', () => {
    expect(schema.parse(valid).assists).toBeNull();
    expect(schema.parse({ ...valid, assistsGbp: '', assistTotalCostGbp: ' ' }).assists).toBeNull();
  });
  it('takes a direct amount for this shipment, normalised to 2 dp', () => {
    expect(schema.parse({ ...valid, assistsGbp: '1000' }).assists).toEqual({
      method: 'DIRECT',
      amountGbp: '1000.00',
    });
    expect(schema.parse({ ...valid, assistsGbp: '0' }).assists).toEqual({
      method: 'DIRECT',
      amountGbp: '0.00',
    });
  });
  it('helper: £1,000 mould over 1,000 lifetime units, 1,000 shipped → £1,000.00', () => {
    const out = schema.parse({
      ...valid,
      quantity: '1000',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
    });
    expect(out.assists).toEqual({
      method: 'HELPER',
      amountGbp: '1000.00',
      totalCostGbp: '1000.00',
      lifetimeUnits: 1000,
      shipmentQuantity: 1000,
    });
  });
  it('helper: 250 of 1,000 lifetime units → £250.00, using the quantity field', () => {
    const out = schema.parse({
      ...valid,
      quantity: '250',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
    });
    expect(out.assists?.amountGbp).toBe('250.00');
  });
  it('apportionAssist uses Decimal and rounds half-up to 2 dp', () => {
    expect(apportionAssist('1000', 1000, 1000)).toBe('1000.00');
    expect(apportionAssist('1000', 250, 1000)).toBe('250.00');
    expect(apportionAssist('1000', 1, 3)).toBe('333.33');
    expect(apportionAssist('100', 2, 3)).toBe('66.67');
    expect(apportionAssist('0.10', 1, 8)).toBe('0.01'); // 0.0125 → 0.01
    expect(apportionAssist('0.10', 3, 8)).toBe('0.04'); // 0.0375 → 0.04
    expect(apportionAssist('12345678.91', 999_999, 1_000_000)).toBe('12345666.56');
  });
  it('rejects the direct amount and the helper together, with a clear field error', () => {
    const errors = errorsOf({
      assistsGbp: '250',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
    });
    expect(errors.assistsGbp).toMatch(/either the assist amount .* not both/);
    expect(errorsOf({ assistsGbp: '250', assistTotalUnits: '1000' }).assistsGbp).toMatch(
      /not both/,
    );
  });
  it('requires both helper fields, and no fewer lifetime units than this shipment', () => {
    expect(errorsOf({ assistTotalCostGbp: '1000' }).assistTotalUnits).toMatch(/total number/);
    expect(errorsOf({ assistTotalUnits: '1000' }).assistTotalCostGbp).toMatch(/total tooling/);
    expect(
      errorsOf({ assistTotalCostGbp: '1000', assistTotalUnits: '499' }).assistTotalUnits,
    ).toMatch(/cannot be fewer/);
  });
  it('rejects negative amounts, too many decimal places and non-integer units', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ assistsGbp: '-1' }, 'assistsGbp'],
      [{ assistsGbp: '10.555' }, 'assistsGbp'],
      [{ assistsGbp: '1e3' }, 'assistsGbp'],
      [{ assistTotalCostGbp: '-1000', assistTotalUnits: '1000' }, 'assistTotalCostGbp'],
      [{ assistTotalCostGbp: '1000.001', assistTotalUnits: '1000' }, 'assistTotalCostGbp'],
      [{ assistTotalCostGbp: '0', assistTotalUnits: '1000' }, 'assistTotalCostGbp'],
      [{ assistTotalCostGbp: '1000', assistTotalUnits: '1000.5' }, 'assistTotalUnits'],
      [{ assistTotalCostGbp: '1000', assistTotalUnits: '0' }, 'assistTotalUnits'],
      [{ assistTotalCostGbp: '1000', assistTotalUnits: '-5' }, 'assistTotalUnits'],
    ];
    for (const [patch, field] of cases) {
      expect(Object.keys(errorsOf(patch)), JSON.stringify(patch)).toContain(field);
    }
  });
});

describe('duty payment, DAN and PVA', () => {
  it('defaults to broker deferment when the field is missing or blank', () => {
    expect(schema.parse(valid).dutyPayment).toBe('BROKER_DEFERMENT');
    expect(schema.parse({ ...valid, dutyPayment: '' }).dutyPayment).toBe('BROKER_DEFERMENT');
    expect(schema.parse({ ...valid, dutyPayment: 'CDS_CASH' }).dutyPayment).toBe('CDS_CASH');
    const bad = schema.safeParse({ ...valid, dutyPayment: 'CASH_IN_HAND' });
    expect(bad.success).toBe(false);
    if (!bad.success)
      expect(fieldErrors(bad.error.issues).dutyPayment).toBe('Choose how duty will be paid.');
  });
  it('accepts optional broker fee terms within bounds', () => {
    const out = schema.parse({ ...valid, brokerFeePct: '2.5', brokerMinimumGbp: '25' });
    expect(out).toMatchObject({ brokerFeePct: '2.5', brokerMinimumGbp: '25' });
    expect(schema.parse(valid).brokerFeePct).toBeUndefined();
    for (const patch of [
      { brokerFeePct: '101' },
      { brokerFeePct: '-1' },
      { brokerMinimumGbp: '25.001' },
    ]) {
      expect(schema.safeParse({ ...valid, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
  it('own DAN needs a 7-digit DAN and the authorisation checkbox', () => {
    const missing = schema.safeParse({ ...valid, dutyPayment: 'OWN_DAN' });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const errors = fieldErrors(missing.error.issues);
      expect(errors.dan).toMatch(/7-digit/);
      expect(errors.danAuthorised).toMatch(/authorised your forwarder’s EORI/);
    }
    const badDan = schema.safeParse({
      ...valid,
      dutyPayment: 'OWN_DAN',
      dan: '123456',
      danAuthorised: 'on',
    });
    expect(badDan.success).toBe(false);
    if (!badDan.success)
      expect(fieldErrors(badDan.error.issues).dan).toBe(
        'Your deferment account number (DAN) is 7 digits.',
      );
  });
  it('drops the DAN after validation so it never reaches the pipeline', () => {
    const out = schema.parse({
      ...valid,
      dutyPayment: 'OWN_DAN',
      dan: '7654321',
      danAuthorised: 'on',
    });
    expect(out).toMatchObject({ dutyPayment: 'OWN_DAN', danAuthorised: true, danProvided: true });
    expect(out).not.toHaveProperty('dan');
    expect(JSON.stringify(out)).not.toContain('7654321');
  });
  it('passes PVA through as ticked even without VAT registration (the engine warns)', () => {
    const out = schema.parse({ ...valid, vatPostponed: 'on' });
    expect(out.vatPostponed).toBe(true);
    expect(out.vatRegistered).toBe(false);
    expect(schema.parse(valid).vatPostponed).toBe(false);
  });
  it('formDataToRecord echoes the new fields', () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      assistsGbp: '10',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
      dutyPayment: 'OWN_DAN',
      brokerFeePct: '2.5',
      brokerMinimumGbp: '25',
      dan: '1234567',
      danAuthorised: 'on',
      vatPostponed: 'on',
    }))
      fd.set(k, v);
    expect(Object.keys(formDataToRecord(fd)).sort()).toEqual(
      [
        'assistTotalCostGbp',
        'assistTotalUnits',
        'assistsGbp',
        'brokerFeePct',
        'brokerMinimumGbp',
        'dan',
        'danAuthorised',
        'dutyPayment',
        'vatPostponed',
      ].sort(),
    );
  });
});
