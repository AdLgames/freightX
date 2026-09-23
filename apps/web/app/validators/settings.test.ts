import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fieldErrors } from './common';
import {
  auditPageSchema,
  changeRoleSchema,
  companyConfirmSchema,
  companySearchSchema,
  customsProfileSchema,
  eoriFormSchema,
  inviteSchema,
  inviteTokenSchema,
  organizationDetailsSchema,
  vatFormSchema,
} from './settings';

describe('organizationDetailsSchema', () => {
  it('trims the name, bounds it and requires a supported currency', () => {
    expect(organizationDetailsSchema.parse({ name: '  Acme Ltd ', baseCurrency: 'GBP' })).toEqual({
      name: 'Acme Ltd',
      baseCurrency: 'GBP',
    });
    const bad = organizationDetailsSchema.safeParse({ name: 'A', baseCurrency: 'JPY' });
    expect(bad.success).toBe(false);
    expect(Object.keys(fieldErrors(bad.error!.issues)).sort()).toEqual(['baseCurrency', 'name']);
    expect(
      organizationDetailsSchema.safeParse({ name: '<b>x</b>', baseCurrency: 'GBP' }).success,
    ).toBe(false);
  });
});

describe('eoriFormSchema', () => {
  it('strips whitespace, upper-cases and validates GB/XI + 12 digits; blank clears', () => {
    expect(eoriFormSchema.parse({ eoriNumber: ' gb 1234 5678 9000 ' })).toEqual({
      eoriNumber: 'GB123456789000',
    });
    expect(eoriFormSchema.parse({ eoriNumber: 'XI123456789000' })).toEqual({
      eoriNumber: 'XI123456789000',
    });
    expect(eoriFormSchema.parse({ eoriNumber: '' })).toEqual({ eoriNumber: null });
    expect(eoriFormSchema.parse({ eoriNumber: '   ' })).toEqual({ eoriNumber: null });
    for (const bad of ['GB12345678900', 'FR123456789000', 'GB1234567890001', 'GBABCDEFGHIJKL']) {
      const r = eoriFormSchema.safeParse({ eoriNumber: bad });
      expect(r.success, bad).toBe(false);
      expect(fieldErrors(r.error!.issues)).toEqual({
        eoriNumber: 'EORI must be GB or XI followed by 12 digits.',
      });
    }
  });
});

describe('vatFormSchema', () => {
  it('yes/no drives the number; the check digit is enforced; blank while registered = keep', () => {
    expect(vatFormSchema.parse({ vatRegistered: 'yes', vatNumber: 'gb 123 4567 82' })).toEqual({
      registered: true,
      number: 'GB123456782',
    });
    expect(vatFormSchema.parse({ vatRegistered: 'yes', vatNumber: '' })).toEqual({
      registered: true,
      number: undefined,
    });
    // Not registered: the number is dropped even if given.
    expect(vatFormSchema.parse({ vatRegistered: 'no', vatNumber: 'GB123456782' })).toEqual({
      registered: false,
      number: null,
    });
    const wrongCheck = vatFormSchema.safeParse({ vatRegistered: 'yes', vatNumber: 'GB123456789' });
    expect(wrongCheck.success).toBe(false);
    expect(fieldErrors(wrongCheck.error!.issues)).toEqual({
      vatNumber: 'VAT number check digit is wrong.',
    });
    expect(vatFormSchema.safeParse({ vatRegistered: 'maybe', vatNumber: '' }).success).toBe(false);
    expect(vatFormSchema.safeParse({ vatRegistered: '', vatNumber: '' }).success).toBe(false);
  });
});

describe('company schemas', () => {
  it('search needs a bounded, HTML-free query; confirm needs an 8-character number', () => {
    expect(companySearchSchema.parse({ query: ' Hydro Imports ' })).toEqual({
      query: 'Hydro Imports',
    });
    expect(companySearchSchema.safeParse({ query: '' }).success).toBe(false);
    expect(companySearchSchema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(companySearchSchema.safeParse({ query: '<script>' }).success).toBe(false);
    expect(companyConfirmSchema.parse({ companyNumber: ' oc654321 ' })).toEqual({
      companyNumber: 'OC654321',
    });
    expect(companyConfirmSchema.safeParse({ companyNumber: '1234' }).success).toBe(false);
    expect(companyConfirmSchema.safeParse({ companyNumber: '../etc' }).success).toBe(false);
  });
});

describe('customsProfileSchema', () => {
  const base = {
    usePva: '',
    paymentMethod: 'BROKER_DEFERMENT',
    brokerDefermentFeePct: '',
    brokerDefermentMinimumGbp: '',
    danNumber: '',
    cdsAuthorityConfirmed: '',
  };

  it('broker deferment with optional fee terms as decimal strings', () => {
    expect(customsProfileSchema.parse(base)).toEqual({
      usePva: false,
      paymentMethod: 'BROKER_DEFERMENT',
      brokerDefermentFeePct: null,
      brokerDefermentMinimumGbp: null,
      danNumber: null,
      cdsAuthorityConfirmed: false,
    });
    expect(
      customsProfileSchema.parse({
        ...base,
        usePva: 'on',
        brokerDefermentFeePct: '2.5',
        brokerDefermentMinimumGbp: '25.00',
      }),
    ).toMatchObject({
      usePva: true,
      brokerDefermentFeePct: '2.5',
      brokerDefermentMinimumGbp: '25.00',
    });
    const bad = customsProfileSchema.safeParse({ ...base, brokerDefermentFeePct: '101' });
    expect(bad.success).toBe(false);
    expect(Object.keys(fieldErrors(bad.error!.issues))).toEqual(['brokerDefermentFeePct']);
    expect(
      customsProfileSchema.safeParse({ ...base, brokerDefermentFeePct: '2.555' }).success,
    ).toBe(false);
    expect(
      customsProfileSchema.safeParse({ ...base, brokerDefermentMinimumGbp: '-1' }).success,
    ).toBe(false);
  });

  it('own deferment needs a 7-digit DAN; the CDS tick counts only for own deferment', () => {
    const missing = customsProfileSchema.safeParse({ ...base, paymentMethod: 'OWN_DEFERMENT' });
    expect(missing.success).toBe(false);
    expect(fieldErrors(missing.error!.issues)).toEqual({
      danNumber: 'Enter your deferment account number (DAN) to use your own account.',
    });
    const shortDan = customsProfileSchema.safeParse({
      ...base,
      paymentMethod: 'OWN_DEFERMENT',
      danNumber: '12345',
    });
    expect(shortDan.success).toBe(false);
    expect(fieldErrors(shortDan.error!.issues)).toEqual({
      danNumber: 'Your deferment account number (DAN) is 7 digits.',
    });
    expect(
      customsProfileSchema.parse({
        ...base,
        paymentMethod: 'OWN_DEFERMENT',
        danNumber: ' 1234567 ',
        cdsAuthorityConfirmed: 'on',
        brokerDefermentFeePct: '2.5', // ignored: not broker deferment
      }),
    ).toEqual({
      usePva: false,
      paymentMethod: 'OWN_DEFERMENT',
      brokerDefermentFeePct: null,
      brokerDefermentMinimumGbp: null,
      danNumber: '1234567',
      cdsAuthorityConfirmed: true,
    });
    expect(
      customsProfileSchema.parse({
        ...base,
        paymentMethod: 'CDS_CASH_ACCOUNT',
        cdsAuthorityConfirmed: 'on',
      }),
    ).toMatchObject({ paymentMethod: 'CDS_CASH_ACCOUNT', cdsAuthorityConfirmed: false });
    expect(
      customsProfileSchema.safeParse({ ...base, paymentMethod: 'PLATFORM_PAYS' }).success,
    ).toBe(false);
  });
});

describe('member schemas', () => {
  it('invite lower-cases the address and needs a real role', () => {
    expect(inviteSchema.parse({ email: ' Jo@Example.COM ', role: 'VIEWER' })).toEqual({
      email: 'jo@example.com',
      role: 'VIEWER',
    });
    expect(inviteSchema.safeParse({ email: 'nope', role: 'VIEWER' }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: 'jo@example.com', role: 'ROOT' }).success).toBe(false);
    const id = randomUUID();
    expect(changeRoleSchema.parse({ membershipId: id, role: 'ADMIN' })).toEqual({
      membershipId: id,
      role: 'ADMIN',
    });
    expect(changeRoleSchema.safeParse({ membershipId: 'x', role: 'ADMIN' }).success).toBe(false);
  });
});

describe('inviteTokenSchema', () => {
  it('splits <uuid>.<43-char secret> and rejects everything else', () => {
    const org = randomUUID();
    const secret = 'A'.repeat(43);
    expect(inviteTokenSchema.parse(`${org}.${secret}`)).toEqual({ organizationId: org, secret });
    for (const bad of [
      '',
      org,
      secret,
      `${org}.short`,
      `not-a-uuid.${secret}`,
      `${org}.${secret}!`,
    ]) {
      expect(inviteTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('auditPageSchema', () => {
  it('defaults to page 1 for anything unusable', () => {
    expect(auditPageSchema.parse('3')).toBe(3);
    expect(auditPageSchema.parse('0')).toBe(1);
    expect(auditPageSchema.parse('abc')).toBe(1);
    expect(auditPageSchema.parse('2.5')).toBe(1);
    expect(auditPageSchema.parse(undefined)).toBe(1);
  });
});
