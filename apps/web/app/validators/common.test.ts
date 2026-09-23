import { describe, expect, it } from 'vitest';
import {
  checkbox,
  currency,
  decimalString,
  eori,
  fieldErrors,
  hsCode,
  isValidUkVatCheckDigit,
  locode,
  normalisePostcode,
  positiveDecimalString,
  postcode,
  quantity,
  safeString,
  vatNumber,
} from './common';

/** Independent implementation of HMRC's mod-97 rule so the test does not trust the code under test. */
const ukVatCheckDigits = (sevenDigits: string, variant9755 = false): string => {
  const weights = [8, 7, 6, 5, 4, 3, 2];
  const sum =
    weights.reduce((acc, w, i) => acc + w * Number(sevenDigits[i]), 0) + (variant9755 ? 55 : 0);
  const rem = sum % 97;
  const check = rem === 0 ? 97 : 97 - rem;
  return String(check).padStart(2, '0');
};

describe('decimalString', () => {
  it('accepts plain decimals up to the dp limit and rejects everything else', () => {
    const s = decimalString({ dp: 4 });
    expect(s.parse(' 12 ')).toBe('12');
    expect(s.parse('0.0001')).toBe('0.0001');
    expect(s.parse('0')).toBe('0');
    for (const bad of [
      '1.23456',
      '-1',
      '+1',
      '1e3',
      '1,000',
      '',
      'abc',
      '.5',
      '5.',
      'Infinity',
      '1234567890123456',
    ]) {
      expect(s.safeParse(bad).success, bad).toBe(false);
    }
  });
  it('enforces min/max as strings without float comparison', () => {
    const s = decimalString({ dp: 2, max: '100' });
    expect(s.safeParse('100').success).toBe(true);
    expect(s.safeParse('100.01').success).toBe(false);
    expect(s.safeParse('99.99').success).toBe(true);
    expect(decimalString({ max: '1000' }).safeParse('999.9999').success).toBe(true);
    expect(decimalString({ max: '1000' }).safeParse('1000.0001').success).toBe(false);
    expect(decimalString({ max: '9' }).safeParse('10').success).toBe(false);
    expect(decimalString({ min: '0.5' }).safeParse('0.49').success).toBe(false);
  });
  it('positiveDecimalString rejects zero', () => {
    expect(positiveDecimalString().safeParse('0').success).toBe(false);
    expect(positiveDecimalString().safeParse('0.0000').success).toBe(false);
    expect(positiveDecimalString().safeParse('0.0001').success).toBe(true);
  });
});

describe('hsCode', () => {
  it('accepts 6/8/10 digits, strips dots and spaces', () => {
    expect(hsCode.parse('950300')).toBe('950300');
    expect(hsCode.parse('9503.00.41.00')).toBe('9503004100');
    expect(hsCode.parse(' 9503 0041 ')).toBe('95030041');
  });
  it('rejects other lengths and non-digits', () => {
    for (const bad of ['9503', '9503004', '95030041000', '9503OO41', '', '950300-4100']) {
      expect(hsCode.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('currency and quantity', () => {
  it('allow-lists currencies', () => {
    expect(currency.parse('GBP')).toBe('GBP');
    expect(currency.safeParse('JPY').success).toBe(false);
    expect(currency.safeParse('usd').success).toBe(false);
  });
  it('quantity is a positive integer up to 1,000,000', () => {
    expect(quantity.parse('250')).toBe(250);
    expect(quantity.safeParse('0').success).toBe(false);
    expect(quantity.safeParse('1.5').success).toBe(false);
    expect(quantity.safeParse('1000001').success).toBe(false);
    expect(quantity.safeParse('abc').success).toBe(false);
  });
});

describe('postcode', () => {
  it('normalises and validates UK postcodes', () => {
    expect(postcode.parse('sw1a1aa')).toBe('SW1A 1AA');
    expect(postcode.parse(' EC1A 1BB ')).toBe('EC1A 1BB');
    expect(postcode.parse('m11ae')).toBe('M1 1AE');
    expect(normalisePostcode('gir0aa')).toBe('GIR 0AA');
    expect(postcode.safeParse('12345').success).toBe(false);
    expect(postcode.safeParse('SW1A').success).toBe(false);
  });
});

describe('locode', () => {
  it('validates shape and optional allow-list', () => {
    expect(locode().parse('cnsha')).toBe('CNSHA');
    expect(locode().safeParse('CNSH').success).toBe(false);
    expect(locode().safeParse('CNSH1').success).toBe(false);
    expect(locode(['GBFXT']).safeParse('GBSOU').success).toBe(false);
    expect(locode(['GBFXT']).parse('GBFXT')).toBe('GBFXT');
  });
});

describe('eori', () => {
  it('accepts GB/XI + 12 digits', () => {
    expect(eori.parse('gb 123456789 000')).toBe('GB123456789000');
    expect(eori.parse('XI123456789000')).toBe('XI123456789000');
    expect(eori.safeParse('GB12345678900').success).toBe(false);
    expect(eori.safeParse('FR123456789000').success).toBe(false);
  });
});

describe('UK VAT number', () => {
  it('computes a genuinely valid check digit and accepts it (mod 97)', () => {
    const core = '1234567';
    const check = ukVatCheckDigits(core);
    expect(check).toBe('82'); // GB123456782 is the textbook example
    expect(isValidUkVatCheckDigit(`${core}${check}`)).toBe(true);
    expect(vatNumber.parse(`gb ${core}${check}`)).toBe(`GB${core}${check}`);
  });
  it('accepts the 9755 variant', () => {
    const core = '1234567';
    const check = ukVatCheckDigits(core, true);
    expect(check).not.toBe('82');
    expect(isValidUkVatCheckDigit(`${core}${check}`)).toBe(true);
  });
  it('rejects wrong check digits, wrong prefixes and wrong lengths', () => {
    expect(isValidUkVatCheckDigit('123456783')).toBe(false);
    expect(vatNumber.safeParse('GB123456783').success).toBe(false);
    expect(vatNumber.safeParse('GB12345678').success).toBe(false);
    expect(vatNumber.safeParse('DE123456782').success).toBe(false);
    expect(isValidUkVatCheckDigit('12345678')).toBe(false);
  });
  it('accepts a 12-digit branch trader number when the 9-digit core is valid', () => {
    expect(vatNumber.parse('GB123456782001')).toBe('GB123456782001');
    expect(vatNumber.safeParse('GB123456783001').success).toBe(false);
  });
  it('validates a sweep of generated numbers', () => {
    for (let i = 0; i < 50; i += 1) {
      const core = String(1000000 + i * 137).slice(0, 7);
      expect(isValidUkVatCheckDigit(`${core}${ukVatCheckDigits(core)}`), core).toBe(true);
    }
  });
});

describe('safeString / checkbox / fieldErrors', () => {
  it('trims, bounds and refuses angle brackets', () => {
    expect(safeString(10).parse('  hello ')).toBe('hello');
    expect(safeString(3).safeParse('hello').success).toBe(false);
    expect(safeString(50).safeParse('<script>').success).toBe(false);
    expect(safeString(10, 1).safeParse('   ').success).toBe(false);
  });
  it('checkbox maps HTML values to booleans', () => {
    expect(checkbox.parse('on')).toBe(true);
    expect(checkbox.parse(undefined)).toBe(false);
    expect(checkbox.parse('')).toBe(false);
    expect(checkbox.parse('off')).toBe(false);
  });
  it('fieldErrors keeps the first message per field', () => {
    const res = hsCode.safeParse('abc');
    expect(res.success).toBe(false);
    if (!res.success)
      expect(fieldErrors(res.error.issues)).toEqual({ _form: 'HS code must contain digits only.' });
  });
});
