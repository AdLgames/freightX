import type { TenantTransactionClient } from '@harbour/db';
import {
  absorbActuals,
  type ActualsInput,
  type ActualsLineInput,
  type ActualsResult,
  type CostCategory,
  type Mode,
} from '@harbour/engine';
import type { FxRateStore } from '@harbour/adapters';
import { getOrder } from '../orders/orders.server';
import { getQuote, quoteRowToResult } from '../quotes/quotes.server';
import { quoteReference } from '../quotes/view';
import {
  actualsByCategory,
  billsToActuals,
  estimateFromQuoteLine,
  perUnit,
  type BillForActuals,
  type BillGbp,
} from './actuals';
import { listPostedBillsForOrder, vendorLabel } from './bills.server';

/**
 * "Costs and variance" for one purchase order (M8, ADR-0014): the accepted quote's snapshot is
 * the estimate, the posted bills booked to the order are the actuals, and the engine's
 * `absorbActuals` does the maths — variance by category and actual landed cost per SKU. Nothing
 * is stored: every view is recomputed from the ledger, so posting a bill changes it at once.
 *
 * Without an accepted quote there is nothing to compare against; the screen then shows the
 * actuals by category and says so.
 */

export interface OrderCostsView {
  order: { id: string; poNumber: string; status: string; currency: string };
  quote: {
    id: string;
    reference: string;
    mode: Mode;
    vatRecoverable: boolean;
    calcVersion: string;
    acceptedAt: string | null;
  } | null;
  /** Every posted bill with a line on this order, with how its GBP figure was reached. */
  bills: BillGbp[];
  postedBillCount: number;
  /** At least one bill's GBP figure rests on an estimated rate (unpaid foreign-currency part). */
  hasEstimatedFx: boolean;
  warnings: string[];
  /** The engine result, when there is an accepted quote. */
  result: ActualsResult | null;
  /** Actuals by category, when there is no accepted quote. */
  actualsOnly: Partial<Record<CostCategory, string>> | null;
}

/** HMRC monthly rate for today (ECB as fallback) for every currency the bills use. */
const ratesFor = async (
  fxStore: FxRateStore,
  currencies: Iterable<string>,
  now: Date,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const raw of new Set(currencies)) {
    const ccy = raw.toUpperCase();
    if (ccy === 'GBP') continue;
    const hmrc = await fxStore.find('HMRC_MONTHLY', ccy, now);
    const record = hmrc ?? (await fxStore.find('ECB', ccy, now));
    if (record) out.set(ccy, record.rateToGbp);
  }
  return out;
};

export const loadOrderCosts = async (
  tx: TenantTransactionClient,
  deps: { fxStore: FxRateStore; now: Date },
  orderId: string,
): Promise<OrderCostsView | null> => {
  const order = await getOrder(tx, orderId);
  if (!order) return null;
  const acceptedRef = order.quotes.find((q) => q.status === 'ACCEPTED') ?? null;
  const quoteRow = acceptedRef ? await getQuote(tx, acceptedRef.id) : null;
  const quote = quoteRow ? quoteRowToResult(quoteRow) : null;

  const rows = await listPostedBillsForOrder(tx, order.id);
  const bills: BillForActuals[] = rows.map((b) => ({
    id: b.id,
    referenceNumber: b.referenceNumber,
    vendorLabel: vendorLabel(b),
    currency: b.currency,
    isCreditNote: b.isCreditNote,
    totalAmount: b.totalAmount.toFixed(2),
    lines: b.lines.map((l) => ({
      id: l.id,
      costCategory: l.costCategory,
      unplannedReason: l.unplannedReason,
      description: l.description,
      amount: l.amount.toFixed(2),
      purchaseOrderId: l.purchaseOrderId,
      lineRef: l.purchaseOrderItem?.productId ?? null,
    })),
    payments: b.payments.map((p) => ({
      amount: p.amount.toFixed(2),
      amountGbp: p.amountGbp.toFixed(2),
    })),
  }));
  const rates = await ratesFor(
    deps.fxStore,
    bills.map((b) => b.currency),
    deps.now,
  );
  const quoteRates: Record<string, string> = quote
    ? Object.fromEntries(
        Object.entries(quote.fxSnapshots).map(([ccy, snap]) => [ccy.toUpperCase(), snap.rateToGbp]),
      )
    : {};
  const converted = billsToActuals(bills, (ccy) => rates.get(ccy) ?? null, quoteRates);
  // Only this order's lines count towards this order (a forwarder invoice may span two orders).
  const actuals = converted.actuals
    .filter((a) => a.purchaseOrderId === order.id)
    .map(({ billId: _b, billLineId: _l, purchaseOrderId: _o, ...engineInput }) => engineInput);

  const base = {
    order: {
      id: order.id,
      poNumber: order.poNumber,
      status: order.status,
      currency: order.currency,
    },
    bills: converted.bills,
    postedBillCount: rows.length,
    hasEstimatedFx: converted.hasEstimatedFx,
  };

  if (!quote || !quoteRow) {
    return {
      ...base,
      quote: null,
      warnings: converted.warnings,
      result: null,
      actualsOnly: actualsByCategory(actuals),
    };
  }

  const labels = new Map(order.items.map((i) => [i.productId, { sku: i.sku, name: i.name }]));
  const lines: ActualsLineInput[] = quote.lines.map((l) => ({
    ref: l.ref,
    ...(labels.has(l.ref) ? { sku: labels.get(l.ref)!.sku, name: labels.get(l.ref)!.name } : {}),
    quantity: l.quantity,
    unitWeightKg: perUnit(l.lineWeightKg, l.quantity),
    unitVolumeCbm: perUnit(l.lineVolumeCbm, l.quantity),
    estimate: estimateFromQuoteLine(l),
    estimatedCustomsValueGbp: l.lineCustomsValueGbp,
  }));
  const input: ActualsInput = {
    mode: quote.mode,
    vatRecoverable: quote.totals.vatRecoverable,
    lines,
    actuals,
  };
  const result = lines.length > 0 ? absorbActuals(input) : null;
  return {
    ...base,
    quote: {
      id: quoteRow.id,
      reference: quoteReference(quoteRow.id),
      mode: quote.mode,
      vatRecoverable: quote.totals.vatRecoverable,
      calcVersion: quote.calcVersion,
      acceptedAt: quoteRow.acceptedAt?.toISOString() ?? null,
    },
    warnings: [...converted.warnings, ...(result?.warnings ?? [])],
    result,
    actualsOnly: result ? null : actualsByCategory(actuals),
  };
};
