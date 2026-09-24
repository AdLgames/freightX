import type { FxRateStore } from '@harbour/adapters';
import type { TenantTransactionClient } from '@harbour/db';
import { COST_CATEGORIES, D, type ActualsResult, type CostCategory } from '@harbour/engine';
import { COST_CATEGORY_LABELS } from '../../validators/bill';
import { loadOrderCosts } from './variance.server';

/**
 * Home "Margin watch" (M8 surfaced): purchase orders whose posted bills put the actual landed
 * cost above the accepted quote's estimate by more than `MARGIN_ALERT_PCT`. Reuses the costs
 * page's maths (`loadOrderCosts` → engine `absorbActuals`); nothing is stored. Candidates are
 * open orders with at least one posted bill line, newest first, capped so Home stays cheap.
 * Amounts are decimal strings (ADR-0003); the percentage is display-only.
 */
export const MARGIN_ALERT_PCT = '2';
const CANDIDATE_LIMIT = 12;
const OPEN_ORDER_STATUSES = ['ISSUED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED'] as const;

export interface MarginWatchItem {
  orderId: string;
  poNumber: string;
  estimatedLandedCostGbp: string;
  actualLandedCostGbp: string;
  /** actual − estimate, positive = over budget. */
  varianceGbp: string;
  /** Signed percentage of the estimate, 1 decimal, e.g. "+4.2". */
  variancePct: string;
  /** The category contributing most of the overrun, or null when nothing is over. */
  driver: { category: CostCategory; label: string; varianceGbp: string } | null;
  /** Some estimated categories have no bill yet: the figure will still move. */
  incomplete: boolean;
}

export interface MarginWatch {
  /** Orders over the threshold, worst first. */
  items: MarginWatchItem[];
  /** Open orders with posted bills that were checked. */
  checked: number;
}

/** Pure: one order's watch item from the engine result, or null when it is within budget. */
export const marginWatchItem = (
  order: { id: string; poNumber: string },
  result: ActualsResult,
  thresholdPct: string = MARGIN_ALERT_PCT,
): MarginWatchItem | null => {
  const estimate = D(result.totals.estimatedLandedCostGbp);
  const variance = D(result.totals.varianceGbp);
  if (estimate.lte(0) || variance.lte(0)) return null;
  const pct = variance.div(estimate).times(100);
  if (pct.lt(D(thresholdPct))) return null;
  let driver: MarginWatchItem['driver'] = null;
  for (const category of COST_CATEGORIES) {
    const figures = result.byCategory[category];
    if (!figures) continue;
    const v = D(figures.varianceGbp);
    if (v.lte(0)) continue;
    if (!driver || v.gt(D(driver.varianceGbp))) {
      driver = { category, label: COST_CATEGORY_LABELS[category], varianceGbp: v.toFixed(2) };
    }
  }
  return {
    orderId: order.id,
    poNumber: order.poNumber,
    estimatedLandedCostGbp: estimate.toFixed(2),
    actualLandedCostGbp: D(result.totals.actualLandedCostGbp).toFixed(2),
    varianceGbp: variance.toFixed(2),
    variancePct: `+${pct.toFixed(1)}`,
    driver,
    incomplete: result.missingCategories.length > 0,
  };
};

export const loadMarginWatch = async (
  tx: TenantTransactionClient,
  deps: { fxStore: FxRateStore; now: Date },
): Promise<MarginWatch> => {
  const lines = await tx.billLine.findMany({
    where: {
      bill: { status: { in: ['POSTED', 'PAID'] } },
      purchaseOrder: { status: { in: [...OPEN_ORDER_STATUSES] } },
    },
    select: { purchaseOrderId: true },
    take: 500,
  });
  const orderIds = [...new Set(lines.map((l) => l.purchaseOrderId))].slice(0, CANDIDATE_LIMIT);
  const items: MarginWatchItem[] = [];
  for (const orderId of orderIds) {
    const view = await loadOrderCosts(tx, deps, orderId);
    if (!view?.result) continue;
    const item = marginWatchItem(view.order, view.result);
    if (item) items.push(item);
  }
  items.sort((a, b) => D(b.variancePct).minus(D(a.variancePct)).toNumber());
  return { items, checked: orderIds.length };
};
