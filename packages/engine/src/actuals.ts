import { chargeableWeight } from './apportion.js';
import {
  D,
  Decimal,
  ZERO,
  allocate,
  fixed2,
  fixed4,
  round2,
  sum,
  type DecimalInput,
} from './money.js';
import type { Mode } from './types.js';

/**
 * Estimate-to-actual absorption (ADR-0014). Pure: takes the accepted quote's per-line snapshot
 * and posted bill lines already converted to GBP, returns actual landed cost per SKU and the
 * variance by category. Every split uses the largest-remainder `allocate`, so SKU costs add up
 * to the bills to the penny.
 */
export const ACTUALS_VERSION = '1.0';

export const COST_CATEGORIES = [
  'GOODS',
  'ASSISTS',
  'FREIGHT_TO_BORDER',
  'FREIGHT_POST_BORDER',
  'ORIGIN_FEES',
  'DESTINATION_FEES',
  'CLEARANCE',
  'INSURANCE',
  'DUTY',
  'IMPORT_VAT',
  'DEFERMENT_FEE',
  'UNPLANNED',
  'OTHER',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export type UnplannedReason =
  'DEMURRAGE' | 'DETENTION' | 'STORAGE' | 'CUSTOMS_EXAMINATION' | 'OTHER';

/** Allocation basis per category when a bill line is not tied to one SKU. */
export type AllocationBasis =
  'CHARGEABLE_WEIGHT' | 'CUSTOMS_VALUE' | 'GOODS_VALUE' | 'VAT_BASE' | 'DIRECT';

export const CATEGORY_BASIS: Readonly<Record<CostCategory, AllocationBasis>> = {
  GOODS: 'GOODS_VALUE',
  ASSISTS: 'GOODS_VALUE',
  FREIGHT_TO_BORDER: 'CHARGEABLE_WEIGHT',
  FREIGHT_POST_BORDER: 'CHARGEABLE_WEIGHT',
  ORIGIN_FEES: 'CHARGEABLE_WEIGHT',
  DESTINATION_FEES: 'CHARGEABLE_WEIGHT',
  CLEARANCE: 'CHARGEABLE_WEIGHT',
  INSURANCE: 'GOODS_VALUE',
  // Duty rates differ per SKU; volume would move duty onto low-rate goods.
  DUTY: 'CUSTOMS_VALUE',
  IMPORT_VAT: 'VAT_BASE',
  DEFERMENT_FEE: 'CUSTOMS_VALUE',
  UNPLANNED: 'CHARGEABLE_WEIGHT',
  OTHER: 'GOODS_VALUE',
};

export type EstimateByCategory = Readonly<Record<CostCategory, DecimalInput>>;

export interface ActualsLineInput {
  /** Quote line reference (product id / SKU). */
  ref: string;
  sku?: string;
  name?: string;
  quantity: number;
  unitWeightKg: DecimalInput;
  unitVolumeCbm: DecimalInput;
  /** Snapshot from the accepted quote line, in GBP. */
  estimate: EstimateByCategory;
  /** Customs value from the quote line (duty allocation basis). */
  estimatedCustomsValueGbp: DecimalInput;
}

export interface ActualCostInput {
  category: CostCategory;
  /** Already converted to GBP at the payment rate (ADR-0014). */
  amountGbp: DecimalInput;
  /** When the bill line belongs to one SKU. Null = shared, allocated by the category basis. */
  lineRef?: string | null;
  unplannedReason?: UnplannedReason;
  description?: string;
}

export interface ActualsInput {
  mode: Mode;
  /** Import VAT is a cost only when it cannot be recovered. */
  vatRecoverable: boolean;
  lines: readonly ActualsLineInput[];
  actuals: readonly ActualCostInput[];
}

export interface CategoryFigures {
  estimateGbp: string;
  actualGbp: string;
  /** actual − estimate; positive = unfavourable (cost overrun). */
  varianceGbp: string;
  /** True when at least one actual bill line exists for this category. */
  hasActuals: boolean;
}

export interface ActualsLineResult {
  ref: string;
  sku: string | null;
  name: string | null;
  quantity: number;
  chargeableWeight: string;
  byCategory: Record<CostCategory, CategoryFigures>;
  estimatedLandedCostGbp: string;
  actualLandedCostGbp: string;
  varianceGbp: string;
  estimatedPerUnit: string;
  actualPerUnit: string;
  variancePerUnit: string;
  /** Biggest unfavourable categories first, for the "explain this" view. */
  drivers: Array<{
    category: CostCategory;
    varianceGbp: string;
    unplannedReasons: UnplannedReason[];
  }>;
}

export interface ActualsResult {
  actualsVersion: string;
  vatRecoverable: boolean;
  /** Categories counted in landed cost (IMPORT_VAT excluded when recoverable). */
  landedCostCategories: CostCategory[];
  byCategory: Record<CostCategory, CategoryFigures>;
  totals: {
    estimatedLandedCostGbp: string;
    actualLandedCostGbp: string;
    varianceGbp: string;
  };
  /** Categories with an estimate but no bill yet — variance is incomplete until they arrive. */
  missingCategories: CostCategory[];
  lines: ActualsLineResult[];
  warnings: string[];
}

const emptyByCategory = (): Record<CostCategory, Decimal> =>
  Object.fromEntries(COST_CATEGORIES.map((c) => [c, ZERO])) as Record<CostCategory, Decimal>;

const positiveWeights = (ws: Decimal[]): boolean => ws.some((w) => w.gt(0));

export const absorbActuals = (input: ActualsInput): ActualsResult => {
  if (input.lines.length === 0) throw new Error('absorbActuals: at least one line is required');
  const warnings: string[] = [];
  const refs = new Set(input.lines.map((l) => l.ref));

  const landedCostCategories = COST_CATEGORIES.filter(
    (c) => !(c === 'IMPORT_VAT' && input.vatRecoverable),
  );

  // ---- allocation bases per line ----
  const lines = input.lines.map((l) => {
    const qty = new Decimal(l.quantity);
    const weightKg = D(l.unitWeightKg).times(qty);
    const volumeCbm = D(l.unitVolumeCbm).times(qty);
    const estimate = emptyByCategory();
    for (const c of COST_CATEGORIES) estimate[c] = D(l.estimate[c]);
    const customsValue = D(l.estimatedCustomsValueGbp);
    return {
      input: l,
      chargeable: chargeableWeight(input.mode, weightKg, volumeCbm),
      goodsValue: estimate.GOODS,
      customsValue,
      vatBase: customsValue.plus(estimate.DUTY),
      estimate,
      actual: emptyByCategory(),
      hasActual: Object.fromEntries(COST_CATEGORIES.map((c) => [c, false])) as Record<
        CostCategory,
        boolean
      >,
      unplanned: new Set<UnplannedReason>(),
    };
  });

  const basisWeights = (basis: AllocationBasis): Decimal[] => {
    const pick = (): Decimal[] => {
      switch (basis) {
        case 'CHARGEABLE_WEIGHT':
          return lines.map((l) => l.chargeable);
        case 'CUSTOMS_VALUE':
          return lines.map((l) => l.customsValue);
        case 'GOODS_VALUE':
          return lines.map((l) => l.goodsValue);
        case 'VAT_BASE':
          return lines.map((l) => l.vatBase);
        case 'DIRECT':
          return lines.map(() => ZERO);
      }
    };
    const primary = pick();
    if (positiveWeights(primary)) return primary;
    // Fallbacks: value share, then equal split (allocate() splits equally on all-zero weights).
    const byValue = lines.map((l) => l.goodsValue);
    if (positiveWeights(byValue)) {
      warnings.push(
        `No ${basis.toLowerCase().replace('_', ' ')} data; allocated by goods value instead.`,
      );
      return byValue;
    }
    warnings.push(`No ${basis.toLowerCase().replace('_', ' ')} or value data; allocated equally.`);
    return primary;
  };

  // ---- direct and shared actuals ----
  const shared = emptyByCategory();
  const sharedUnplanned = new Set<UnplannedReason>();
  for (const a of input.actuals) {
    const amount = D(a.amountGbp);
    if (a.lineRef !== undefined && a.lineRef !== null) {
      const line = lines.find((l) => l.input.ref === a.lineRef);
      if (!line) {
        if (!refs.has(a.lineRef))
          warnings.push(`Bill line for unknown SKU "${a.lineRef}" treated as shared.`);
        shared[a.category] = shared[a.category].plus(amount);
      } else {
        line.actual[a.category] = line.actual[a.category].plus(amount);
        line.hasActual[a.category] = true;
        if (a.unplannedReason) line.unplanned.add(a.unplannedReason);
        continue;
      }
    } else {
      shared[a.category] = shared[a.category].plus(amount);
    }
    if (a.category === 'UNPLANNED' && a.unplannedReason) sharedUnplanned.add(a.unplannedReason);
  }

  for (const c of COST_CATEGORIES) {
    const total = shared[c];
    const touched = input.actuals.some((a) => a.category === c);
    if (total.isZero() && !touched) continue;
    const weights = total.isZero() ? lines.map(() => ZERO) : basisWeights(CATEGORY_BASIS[c]);
    const parts = total.isZero() ? lines.map(() => ZERO) : allocate(total, weights);
    lines.forEach((l, i) => {
      l.actual[c] = l.actual[c].plus(parts[i] ?? ZERO);
      if (touched) l.hasActual[c] = true;
      if (c === 'UNPLANNED') for (const r of sharedUnplanned) l.unplanned.add(r);
    });
  }

  // ---- results ----
  const figures = (est: Decimal, act: Decimal, has: boolean): CategoryFigures => ({
    estimateGbp: fixed2(est),
    actualGbp: fixed2(act),
    varianceGbp: fixed2(act.minus(est)),
    hasActuals: has,
  });

  const lineResults: ActualsLineResult[] = lines.map((l) => {
    const byCategory = Object.fromEntries(
      COST_CATEGORIES.map((c) => [c, figures(l.estimate[c], round2(l.actual[c]), l.hasActual[c])]),
    ) as Record<CostCategory, CategoryFigures>;
    const estLanded = sum(landedCostCategories.map((c) => l.estimate[c]));
    const actLanded = sum(landedCostCategories.map((c) => round2(l.actual[c])));
    const qty = new Decimal(l.input.quantity);
    const drivers = landedCostCategories
      .map((c) => ({ category: c, variance: round2(l.actual[c]).minus(l.estimate[c]) }))
      .filter((d) => !d.variance.isZero())
      .sort((a, b) => b.variance.comparedTo(a.variance))
      .map((d) => ({
        category: d.category,
        varianceGbp: fixed2(d.variance),
        unplannedReasons: d.category === 'UNPLANNED' ? [...l.unplanned] : [],
      }));
    return {
      ref: l.input.ref,
      sku: l.input.sku ?? null,
      name: l.input.name ?? null,
      quantity: l.input.quantity,
      chargeableWeight: l.chargeable.toFixed(4),
      byCategory,
      estimatedLandedCostGbp: fixed2(estLanded),
      actualLandedCostGbp: fixed2(actLanded),
      varianceGbp: fixed2(actLanded.minus(estLanded)),
      estimatedPerUnit: fixed4(estLanded.div(qty)),
      actualPerUnit: fixed4(actLanded.div(qty)),
      variancePerUnit: fixed4(actLanded.minus(estLanded).div(qty)),
      drivers,
    };
  });

  const byCategory = Object.fromEntries(
    COST_CATEGORIES.map((c) => [
      c,
      figures(
        sum(lines.map((l) => l.estimate[c])),
        sum(lines.map((l) => round2(l.actual[c]))),
        lines.some((l) => l.hasActual[c]),
      ),
    ]),
  ) as Record<CostCategory, CategoryFigures>;

  const estTotal = sum(lineResults.map((l) => D(l.estimatedLandedCostGbp)));
  const actTotal = sum(lineResults.map((l) => D(l.actualLandedCostGbp)));
  const missingCategories = landedCostCategories.filter(
    (c) => !byCategory[c].hasActuals && D(byCategory[c].estimateGbp).gt(0),
  );

  return {
    actualsVersion: ACTUALS_VERSION,
    vatRecoverable: input.vatRecoverable,
    landedCostCategories,
    byCategory,
    totals: {
      estimatedLandedCostGbp: fixed2(estTotal),
      actualLandedCostGbp: fixed2(actTotal),
      varianceGbp: fixed2(actTotal.minus(estTotal)),
    },
    missingCategories,
    lines: lineResults,
    warnings,
  };
};
