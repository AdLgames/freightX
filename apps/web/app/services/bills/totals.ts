import { D, fixed2, sum } from '@harbour/engine';
import type { RawBillLine } from '../../validators/bill';
import type { BillFormValues } from '../../validators/bill';
import type { BillEditorOptions, BillOrderOption } from './editor.server';

/**
 * The running total shown next to the bill editor, computed from the RAW form values so the page
 * can render it before (and without) JavaScript. Pure and free of Prisma, so route components may
 * import it (a `.server` module would be stripped from the client bundle).
 */
export interface BillTotalsView {
  /** Sum of the lines that parse, 2 dp. */
  linesTotal: string;
  /** Every line parsed; otherwise the total covers the valid lines only. */
  complete: boolean;
  /** Every line parses and their sum equals the typed bill total. */
  balanced: boolean;
}

const AMOUNT = /^-?\d{1,15}(\.\d{1,2})?$/;

export const billTotalsView = (values: BillFormValues): BillTotalsView => {
  const valid = values.lines.filter((l) => AMOUNT.test(l.amount.trim()));
  const total = fixed2(sum(valid.map((l) => D(l.amount.trim()))));
  const typed = (values.scalars.totalAmount ?? '').trim();
  const complete = valid.length === values.lines.length;
  const balanced =
    complete && values.lines.length > 0 && AMOUNT.test(typed) && fixed2(D(typed)) === total;
  return { linesTotal: total, complete, balanced };
};

/** The order option a raw line points at (for the item select), if any. */
export const orderOf = (options: BillEditorOptions, line: RawBillLine): BillOrderOption | null =>
  options.orders.find((o) => o.id === line.purchaseOrderId) ?? null;
