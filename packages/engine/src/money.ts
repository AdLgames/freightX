import { Decimal } from 'decimal.js';

/**
 * All money in the engine is `Decimal` (§3). `number` is never accepted for monetary input.
 * Inputs arrive as strings (from forms, JSON, Prisma Decimal.toString()) or Decimal instances.
 */
export type DecimalInput = string | Decimal;

// Deterministic, banker's-free rounding: HALF_UP, matching HMRC guidance for customs sums.
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const D = (v: DecimalInput): Decimal => {
  if (v instanceof Decimal) return new MoneyDecimal(v.toString());
  if (typeof v !== 'string') {
    // Defensive: a `number` sneaking in here is a bug upstream (lint rule + zod should stop it).
    throw new TypeError(`Money must be a string or Decimal, got ${typeof v}`);
  }
  const trimmed = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Invalid decimal string: "${v}"`);
  }
  return new MoneyDecimal(trimmed);
};

export const ZERO: Decimal = new MoneyDecimal(0);

/** Round to pennies (2 dp). */
export const round2 = (v: Decimal): Decimal => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Round to 4 dp — used for unit values and per-unit landed cost. */
export const round4 = (v: Decimal): Decimal => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export const sum = (values: readonly Decimal[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc.plus(v), ZERO);

export const max = (a: Decimal, b: Decimal): Decimal => (a.gte(b) ? a : b);

export const fixed2 = (v: Decimal): string => round2(v).toFixed(2);
export const fixed4 = (v: Decimal): string => round4(v).toFixed(4);

/**
 * Allocate `total` across `weights` proportionally, rounded to `dp` places, such that the
 * allocations sum to `total` exactly and no share is negative (§5.4).
 *
 * Method (largest remainder / Hamilton): every share is truncated to `dp`, then the leftover
 * pennies are handed out one at a time to the lines with the largest truncated fraction; ties go
 * to the larger weight, then to the earlier line. For the common case (e.g. 100 split three ways)
 * this is exactly the brief's "remainder to the largest line"; unlike naive half-up rounding it
 * cannot overshoot and produce a negative correction (0.03 split five ways).
 * If all weights are zero the total is split equally.
 */
export const allocate = (total: Decimal, weights: readonly Decimal[], dp = 2): Decimal[] => {
  if (weights.length === 0) return [];
  const totalRounded = total.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
  if (totalRounded.isZero()) return weights.map(() => ZERO);
  if (totalRounded.isNegative()) throw new Error('allocate: total must not be negative');
  if (weights.some((w) => w.isNegative()))
    throw new Error('allocate: weights must not be negative');

  const weightSum = sum(weights);
  const effective = weightSum.isZero() ? weights.map(() => new MoneyDecimal(1)) : [...weights];
  const effectiveSum = weightSum.isZero() ? new MoneyDecimal(weights.length) : weightSum;

  const exact = effective.map((w) => totalRounded.times(w).div(effectiveSum));
  const shares = exact.map((e) => e.toDecimalPlaces(dp, Decimal.ROUND_DOWN));
  const penny = new MoneyDecimal(1).div(new MoneyDecimal(10).pow(dp));
  let leftover = totalRounded
    .minus(sum(shares))
    .div(penny)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();

  const order = exact
    .map((e, i) => ({ i, frac: e.minus(shares[i] ?? ZERO), weight: effective[i] ?? ZERO }))
    .sort((a, b) => {
      const byFrac = b.frac.comparedTo(a.frac);
      if (byFrac !== 0) return byFrac;
      const byWeight = b.weight.comparedTo(a.weight);
      if (byWeight !== 0) return byWeight;
      return a.i - b.i;
    });
  for (let k = 0; leftover > 0 && k < order.length; k += 1) {
    const idx = order[k]?.i;
    if (idx === undefined) break;
    const current = shares[idx];
    if (current === undefined) break;
    shares[idx] = current.plus(penny);
    leftover -= 1;
  }

  const check = sum(shares);
  if (!check.eq(totalRounded) || leftover !== 0) {
    throw new Error(
      `allocate: invariant violated (${check.toString()} != ${totalRounded.toString()})`,
    );
  }
  return shares;
};

export { Decimal };
