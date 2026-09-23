import { describe, expect, it } from 'vitest';
import {
  paymentTermsFormSchema,
  pickupLocationFormSchema,
  supplierDisplayName,
  supplierFormSchema,
  supplierIntent,
} from './supplier';

describe('supplierFormSchema', () => {
  it('accepts the legal entity and normalises the country', () => {
    const r = supplierFormSchema.safeParse({
      legalName: '  Shenzhen Widgets Co., Ltd  ',
      tradingName: '',
      registrationNumber: '91440300MA5XXXXXXX',
      countryOfIncorporation: 'hk',
      defaultCurrency: 'USD',
      defaultIncoterm: 'FOB',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.legalName).toBe('Shenzhen Widgets Co., Ltd');
    expect(r.data.tradingName).toBeUndefined();
    expect(r.data.countryOfIncorporation).toBe('HK');
  });

  it('requires a legal name and a known country', () => {
    expect(
      supplierFormSchema.safeParse({ legalName: '', countryOfIncorporation: 'CN' }).success,
    ).toBe(false);
    expect(
      supplierFormSchema.safeParse({ legalName: 'X', countryOfIncorporation: 'XX' }).success,
    ).toBe(false);
    expect(
      supplierFormSchema.safeParse({
        legalName: 'X',
        countryOfIncorporation: 'CN',
        defaultCurrency: 'KRW',
      }).success,
    ).toBe(false);
  });

  it('display name prefers the trading name', () => {
    expect(supplierDisplayName({ legalName: 'Legal Ltd', tradingName: null })).toBe('Legal Ltd');
    expect(supplierDisplayName({ legalName: 'Legal Ltd', tradingName: ' ' })).toBe('Legal Ltd');
    expect(supplierDisplayName({ legalName: 'Legal Ltd', tradingName: 'Brand' })).toBe('Brand');
  });
});

describe('paymentTermsFormSchema', () => {
  it('PREPAID drops the other fields', () => {
    expect(
      paymentTermsFormSchema.parse({ termType: 'PREPAID', depositPct: '30', netDays: '10' }),
    ).toEqual({ termType: 'PREPAID', depositPct: null, balanceTrigger: null, netDays: null });
  });

  it('NET needs the days', () => {
    const r = paymentTermsFormSchema.safeParse({ termType: 'NET', netDays: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['netDays']);
    expect(paymentTermsFormSchema.parse({ termType: 'NET', netDays: '30' })).toEqual({
      termType: 'NET',
      depositPct: null,
      balanceTrigger: null,
      netDays: 30,
    });
  });

  it('DEPOSIT_BALANCE needs the deposit percentage and the trigger', () => {
    const r = paymentTermsFormSchema.safeParse({ termType: 'DEPOSIT_BALANCE' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path[0]).sort()).toEqual(['balanceTrigger', 'depositPct']);
    }
    expect(
      paymentTermsFormSchema.parse({
        termType: 'DEPOSIT_BALANCE',
        depositPct: '30.00',
        balanceTrigger: 'AGAINST_BILL_OF_LADING',
        netDays: '',
      }),
    ).toEqual({
      termType: 'DEPOSIT_BALANCE',
      depositPct: '30.00',
      balanceTrigger: 'AGAINST_BILL_OF_LADING',
      netDays: null,
    });
  });

  it.each([
    ['0', true],
    ['100', true],
    ['100.00', true],
    ['30.5', true],
    ['100.01', false],
    ['-1', false],
    ['30.123', false],
    ['abc', false],
  ])('depositPct %s → %s', (pct, ok) => {
    const r = paymentTermsFormSchema.safeParse({
      termType: 'DEPOSIT_BALANCE',
      depositPct: pct,
      balanceTrigger: 'ON_SHIPMENT',
    });
    expect(r.success).toBe(ok);
  });

  it('bounds netDays to 0–365 whole days', () => {
    expect(paymentTermsFormSchema.safeParse({ termType: 'NET', netDays: '-1' }).success).toBe(
      false,
    );
    expect(paymentTermsFormSchema.safeParse({ termType: 'NET', netDays: '366' }).success).toBe(
      false,
    );
    expect(paymentTermsFormSchema.safeParse({ termType: 'NET', netDays: '1.5' }).success).toBe(
      false,
    );
  });
});

describe('pickupLocationFormSchema', () => {
  const base = { name: 'Shenzhen factory', country: 'CN' };

  it('takes the port from the allow-list pick', () => {
    const r = pickupLocationFormSchema.parse({ ...base, closestPortChoice: 'CNSZX' });
    expect(r.closestPortCode).toBe('CNSZX');
    expect(r.isDefault).toBe(false);
    expect(r.addressLine1).toBeUndefined();
  });

  it('a typed LOCODE overrides the pick, upper-cased', () => {
    const r = pickupLocationFormSchema.parse({
      ...base,
      closestPortChoice: 'CNSZX',
      closestPortCode: ' cnxmn ',
      isDefault: 'on',
    });
    expect(r.closestPortCode).toBe('CNXMN');
    expect(r.isDefault).toBe(true);
  });

  it.each(['CNXM', 'CNXMNN', 'C1XMN', 'CNXM1', 'cn-xm'])('rejects LOCODE %s', (code) => {
    const r = pickupLocationFormSchema.safeParse({ ...base, closestPortCode: code });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['closestPortCode']);
  });

  it('accepts LOCODE digits 2–9 in the location part', () => {
    expect(pickupLocationFormSchema.safeParse({ ...base, closestPortCode: 'US2A9' }).success).toBe(
      true,
    );
  });

  it('needs a port from one of the two fields, and a name and country', () => {
    const r = pickupLocationFormSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['closestPortCode']);
    expect(
      pickupLocationFormSchema.safeParse({ name: '', country: 'CN', closestPortCode: 'CNSHA' })
        .success,
    ).toBe(false);
    expect(
      pickupLocationFormSchema.safeParse({ name: 'X', country: 'XX', closestPortCode: 'CNSHA' })
        .success,
    ).toBe(false);
  });
});

describe('supplierIntent', () => {
  it('falls back to save', () => {
    expect(supplierIntent.parse('pickup-add')).toBe('pickup-add');
    expect(supplierIntent.parse('nope')).toBe('save');
  });
});
