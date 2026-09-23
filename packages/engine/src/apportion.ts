import { D, type Decimal, max } from './money.js';
import type { ApportionmentBasis, Mode } from './types.js';

/** Air volumetric divisor: 1 CBM = 1,000,000 cm³ / 6000 = 166.667 kg (§5.4). */
const AIR_KG_PER_CBM = D('1000000').div(6000);

export const apportionmentBasisFor = (mode: Mode): ApportionmentBasis =>
  mode === 'AIR' ? 'AIR_VOLUMETRIC_6000' : 'SEA_WEIGHT_OR_MEASURE';

/**
 * Chargeable weight for allocation (§5.4):
 * - sea/road/rail: greater of tonnes and CBM (weight-or-measure revenue tons)
 * - air: greater of actual kg and volumetric kg at 1:6000
 */
export const chargeableWeight = (mode: Mode, weightKg: Decimal, volumeCbm: Decimal): Decimal => {
  if (mode === 'AIR') return max(weightKg, volumeCbm.times(AIR_KG_PER_CBM));
  return max(weightKg.div(1000), volumeCbm);
};
