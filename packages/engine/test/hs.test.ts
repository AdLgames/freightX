import { describe, expect, it } from 'vitest';
import { normaliseHsCode, validateHsCode } from '../src/hs.js';

describe('validateHsCode', () => {
  it('accepts 6/8/10 digits and strips dots/spaces', () => {
    expect(validateHsCode('9503.00.41.00')).toEqual({
      ok: true,
      code: '9503004100',
      length: 10,
      chapter: '95',
    });
    expect(validateHsCode('950300')).toMatchObject({ ok: true, length: 6 });
    expect(validateHsCode('95030041')).toMatchObject({ ok: true, length: 8 });
  });
  it('rejects wrong lengths and non-digits', () => {
    expect(validateHsCode('9503')).toEqual({ ok: false, reason: 'BAD_LENGTH' });
    expect(validateHsCode('95030041A0')).toEqual({ ok: false, reason: 'NOT_DIGITS' });
  });
});

describe('normaliseHsCode (§5.2 — never guess)', () => {
  const candidates = [
    { code: '9503004100', thirdCountryDuty: '0.00 %' },
    { code: '9503004900', thirdCountryDuty: '4.70 %' },
    { code: '9503007000', thirdCountryDuty: '4.70 %' },
  ];
  it('returns a 10-digit code unchanged', () => {
    expect(normaliseHsCode('9503004100', candidates)).toEqual({
      ok: true,
      code: '9503004100',
      normalised: false,
    });
  });
  it('normalises when exactly one 10-digit code matches', () => {
    expect(normaliseHsCode('95030070', candidates)).toEqual({
      ok: true,
      code: '9503007000',
      normalised: true,
    });
  });
  it('refuses to pick between several children', () => {
    const r = normaliseHsCode('950300', candidates);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('AMBIGUOUS');
      expect(r.candidates).toHaveLength(3);
    }
  });
  it('refuses even when all children carry the same duty', () => {
    const r = normaliseHsCode('95030049', [
      { code: '9503004910', thirdCountryDuty: '4.70 %' },
      { code: '9503004990', thirdCountryDuty: '4.70 %' },
    ]);
    expect(r).toMatchObject({ ok: false, reason: 'AMBIGUOUS' });
  });
  it('reports NOT_FOUND and INVALID', () => {
    expect(normaliseHsCode('999999', candidates)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(normaliseHsCode('abc', candidates)).toMatchObject({ ok: false, reason: 'INVALID' });
  });
});
