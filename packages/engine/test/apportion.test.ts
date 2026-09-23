import { describe, expect, it } from 'vitest';
import { apportionmentBasisFor, chargeableWeight } from '../src/apportion.js';
import { D } from '../src/money.js';

describe('chargeableWeight (§5.4)', () => {
  it('sea: greater of tonnes and CBM', () => {
    expect(chargeableWeight('SEA_LCL', D('500'), D('2')).toString()).toBe('2');
    expect(chargeableWeight('SEA_FCL', D('3000'), D('2')).toString()).toBe('3');
    expect(chargeableWeight('ROAD', D('3000'), D('2')).toString()).toBe('3');
  });
  it('air: greater of actual kg and volumetric at 1:6000', () => {
    // 0.6 CBM = 600,000 cm³ / 6000 = 100 kg volumetric
    expect(chargeableWeight('AIR', D('20'), D('0.6')).toFixed(4)).toBe('100.0000');
    expect(chargeableWeight('AIR', D('200'), D('0.1')).toFixed(4)).toBe('200.0000');
  });
  it('records the basis', () => {
    expect(apportionmentBasisFor('AIR')).toBe('AIR_VOLUMETRIC_6000');
    expect(apportionmentBasisFor('SEA_LCL')).toBe('SEA_WEIGHT_OR_MEASURE');
  });
});
