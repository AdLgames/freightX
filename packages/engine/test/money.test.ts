import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { D, allocate, round2, sum } from '../src/money.js';

describe('D()', () => {
  it('rejects numbers — money is never a number', () => {
    expect(() => D(5 as unknown as string)).toThrow(TypeError);
  });
  it('rejects non-decimal strings', () => {
    expect(() => D('1,000')).toThrow(TypeError);
    expect(() => D('£5')).toThrow(TypeError);
    expect(() => D('1e3')).toThrow(TypeError);
  });
  it('accepts plain decimals', () => {
    expect(D('1234.5678').toString()).toBe('1234.5678');
    expect(D(' -3 ').toString()).toBe('-3');
  });
});

describe('round2', () => {
  it('rounds half up', () => {
    expect(round2(D('0.125')).toString()).toBe('0.13');
    expect(round2(D('0.115')).toString()).toBe('0.12');
  });
});

describe('allocate() — §5.4 apportionment', () => {
  it('splits 100 three ways with the penny remainder on the largest (first) line', () => {
    const out = allocate(D('100'), [D('1'), D('1'), D('1')]).map((d) => d.toString());
    expect(out).toEqual(['33.34', '33.33', '33.33']);
  });
  it('puts the remainder on the largest weight', () => {
    const out = allocate(D('100'), [D('1'), D('2'), D('1')]).map((d) => d.toString());
    expect(out).toEqual(['25', '50', '25']);
    const out2 = allocate(D('10'), [D('1'), D('1'), D('1')]).map((d) => d.toString());
    expect(out2).toEqual(['3.34', '3.33', '3.33']);
  });
  it('splits equally when all weights are zero', () => {
    const out = allocate(D('9'), [D('0'), D('0')]).map((d) => d.toString());
    expect(out).toEqual(['4.5', '4.5']);
  });
  it('returns zeros for a zero total', () => {
    expect(allocate(D('0'), [D('3'), D('5')]).map((d) => d.toString())).toEqual(['0', '0']);
  });

  const money = fc.integer({ min: 0, max: 10_000_000 }).map((n) => D((n / 100).toFixed(2)));
  const weight = fc.integer({ min: 0, max: 1_000_000 }).map((n) => D((n / 1000).toFixed(3)));

  it('always sums to the total, to the penny, with no negative shares', () => {
    fc.assert(
      fc.property(money, fc.array(weight, { minLength: 1, maxLength: 12 }), (total, weights) => {
        const shares = allocate(total, weights);
        expect(shares).toHaveLength(weights.length);
        expect(sum(shares).eq(total)).toBe(true);
        for (const s of shares) {
          expect(s.isNegative()).toBe(false);
          expect(s.decimalPlaces()).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 500 },
    );
  });
});
