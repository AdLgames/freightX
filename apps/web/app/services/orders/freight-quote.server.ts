import type { QuoteFormValues } from '../../validators/quote';
import { defaultValues, type BuilderOptions } from '../quotes/builder.server';
import type { OrderRecord } from './orders.server';

/**
 * "Get freight quote" (M7, ADR-0013): pre-fills the M4 quote builder from a purchase order so
 * nothing is retyped. The builder then runs the ordinary pipeline — catalogue weight, volume, HS
 * code and origin per product, FX through the store, freight from the rate sheet — and its save
 * stamps `Quote.purchaseOrderId`.
 *
 *   - lines: the PO items with the PO quantities and the PO unit cost in the PO currency
 *     (`line_<i>_unitCost` / `line_<i>_currency`, honoured by the pipeline instead of the
 *     catalogue value);
 *   - supplier, incoterm and the route whose origin is the pickup location's port (falling back
 *     to the supplier's default pickup location, then the first lane);
 *   - `purchaseOrderId` as a hidden field so the saved quote links back.
 *
 * FX (§5.7): the engine converts at the HMRC monthly rate for the quote's `asOf`, which the
 * pipeline sets to NOW. Rates for a future `expectedShipMonth` are not published yet, so the quote
 * uses the current month and the builder shows a note; "Update to current catalogue values" on the
 * draft picks up the new month's rate once it is loaded.
 */

export interface PurchaseOrderContext {
  id: string;
  poNumber: string;
  status: string;
  currency: string;
  /** `YYYY-MM` or null. */
  expectedShipMonth: string | null;
  /** The pickup location's port, when the rate sheet has no lane from it. */
  laneMissingFor: string | null;
}

export const builderValuesFromOrder = (
  order: OrderRecord,
  options: BuilderOptions,
): { values: QuoteFormValues; context: PurchaseOrderContext } => {
  const base = defaultValues(options, order.supplierId);
  const scalars: Record<string, string> = {
    ...base.scalars,
    supplierId: order.supplierId,
    incoterm: order.incoterm,
    purchaseOrderId: order.id,
  };
  let laneMissingFor: string | null = null;
  const port = order.pickupLocation?.closestPortCode ?? null;
  if (port) {
    const current = options.lanes.find((l) => l.key === scalars.lane);
    const lane =
      options.lanes.find(
        (l) =>
          l.origin === port &&
          (!current || (l.mode === current.mode && l.destination === current.destination)),
      ) ?? options.lanes.find((l) => l.origin === port);
    if (lane) scalars.lane = lane.key;
    else laneMissingFor = port;
  }
  return {
    values: {
      scalars,
      lines: order.items.map((i) => ({
        productId: i.productId,
        quantity: String(i.quantity),
        assistsGbp: '',
        preferenceClaimed: '',
        unitCost: i.unitCost.toFixed(4),
        currency: order.currency,
      })),
    },
    context: {
      id: order.id,
      poNumber: order.poNumber,
      status: order.status,
      currency: order.currency,
      expectedShipMonth: order.expectedShipMonth
        ? order.expectedShipMonth.toISOString().slice(0, 7)
        : null,
      laneMissingFor,
    },
  };
};

/** `YYYY-MM` of `now` (UTC), the HMRC rate month the pipeline will use. */
export const currentRateMonth = (now: Date): string => now.toISOString().slice(0, 7);
