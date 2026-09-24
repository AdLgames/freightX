import type { OrderFormValues } from '../../validators/order';
import { orderTotals } from './schedule';

/**
 * Line totals shown next to the purchase-order editor, computed from the RAW form values so the
 * page can render them before (and without) JavaScript. Pure and free of Prisma, so route
 * components may import it (a `.server` module would be stripped from the client bundle).
 */
/** '—' (null) for a line that does not parse yet. */
export interface TotalsView {
  lines: Array<string | null>;
  totalGoodsValue: string;
  /** Every line parsed; otherwise the total covers the valid lines only. */
  complete: boolean;
}

const QTY = /^\d{1,7}$/;
const COST = /^\d{1,15}(\.\d{1,4})?$/;

export const totalsView = (values: OrderFormValues): TotalsView => {
  const valid: Array<{ quantity: number; unitCost: string }> = [];
  const index: number[] = [];
  values.items.forEach((l, i) => {
    const q = l.quantity.trim();
    const c = l.unitCost.trim();
    if (QTY.test(q) && Number(q) >= 1 && COST.test(c)) {
      valid.push({ quantity: Number(q), unitCost: c });
      index.push(i);
    }
  });
  const totals = orderTotals(valid);
  const lines: Array<string | null> = values.items.map(() => null);
  index.forEach((i, k) => {
    lines[i] = totals.lines[k]?.lineTotal ?? null;
  });
  return {
    lines,
    totalGoodsValue: totals.totalGoodsValue,
    complete: valid.length === values.items.length,
  };
};
