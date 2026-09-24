import {
  D,
  ZERO,
  allocate,
  fixed2,
  round2,
  sum,
  type ActualCostInput,
  type CostCategory,
  type Decimal,
  type EstimateByCategory,
  type LineResult,
  type UnplannedReason,
} from '@harbour/engine';

/**
 * Pure glue between the ledger (posted bills, M8) and the engine's `absorbActuals` (ADR-0014).
 * No I/O, no Prisma: the server module loads rows and rates, this file turns them into engine
 * input. Everything is `Decimal` in and canonical decimal strings out (§3).
 *
 * GBP conversion of a bill (ADR-0014 "exchange rates live on payments"):
 *   - a GBP bill is its total;
 *   - the paid part of a foreign-currency bill is the sum of the payments' GBP amounts (what the
 *     bank actually took);
 *   - the unpaid remainder is converted at the latest HMRC monthly rate for today and labelled an
 *     ESTIMATE; when no rate is loaded the quote's own snapshot rate is used (still an estimate),
 *     and when there is no rate at all the bill is left out of the actuals with a warning rather
 *     than guessed.
 * The bill's GBP total is then split across its lines by largest remainder in proportion to the
 * line amounts, so the lines add up to the bill to the penny. A credit note reverses the sign.
 */

export interface BillLineForActuals {
  id: string;
  costCategory: CostCategory;
  unplannedReason: UnplannedReason | null;
  description: string;
  /** Bill currency, 2 dp; may be negative for a discount line. */
  amount: string;
  purchaseOrderId: string;
  /** The SKU the line was booked to (the PO item's product id), or null for a shared cost. */
  lineRef: string | null;
}

export interface BillForActuals {
  id: string;
  referenceNumber: string;
  vendorLabel: string;
  currency: string;
  isCreditNote: boolean;
  totalAmount: string;
  lines: readonly BillLineForActuals[];
  payments: ReadonlyArray<{ amount: string; amountGbp: string }>;
}

export type FxBasis =
  /** GBP bill: no conversion. */
  | 'GBP'
  /** Fully paid: the payments' GBP amounts. */
  | 'PAYMENTS'
  /** Partly paid: payments for the paid part, an HMRC/quote rate for the rest (estimate). */
  | 'PAYMENTS_AND_RATE'
  /** Unpaid: converted at an HMRC/quote rate (estimate). */
  | 'RATE'
  /** No payments and no rate: excluded from the actuals. */
  | 'UNKNOWN';

export interface BillGbp {
  billId: string;
  referenceNumber: string;
  vendorLabel: string;
  currency: string;
  isCreditNote: boolean;
  totalAmount: string;
  paidAmount: string;
  /** Signed: negative for a credit note. Null when UNKNOWN. */
  totalGbp: string | null;
  basis: FxBasis;
  /** GBP per 1 unit of the bill currency used for the unpaid part, when one was. */
  estimateRate: string | null;
  estimateRateSource: 'HMRC_MONTHLY' | 'QUOTE' | null;
}

/** GBP per 1 unit of `currency` for today, or null when nothing is loaded. */
export type RateLookup = (currency: string) => string | null;

/** An engine actual that remembers which bill line it came from. */
export interface TaggedActual extends ActualCostInput {
  billId: string;
  billLineId: string;
  purchaseOrderId: string;
}

export interface ActualsFromBills {
  actuals: TaggedActual[];
  bills: BillGbp[];
  /** True when any bill's GBP figure rests on an estimated rate. */
  hasEstimatedFx: boolean;
  warnings: string[];
}

const isGbp = (currency: string): boolean => currency.toUpperCase() === 'GBP';

/** Splits `totalGbp` across the lines in proportion to their amounts (largest remainder). */
const splitAcrossLines = (
  totalGbp: Decimal,
  lines: readonly BillLineForActuals[],
  totalAmount: Decimal,
): Decimal[] => {
  const amounts = lines.map((l) => D(l.amount));
  if (lines.length === 0) return [];
  if (amounts.every((a) => a.gte(0)) && totalAmount.gt(0)) {
    return allocate(totalGbp, amounts);
  }
  // A discount line makes the weights signed: scale each line by the bill's own factor. The
  // penny drift this can leave is confined to the odd bill with negative lines.
  if (totalAmount.isZero()) return amounts.map(() => ZERO);
  const factor = totalGbp.div(totalAmount);
  return amounts.map((a) => round2(a.times(factor)));
};

/**
 * Converts posted bills to engine `ActualCostInput` rows in GBP. `quoteRates` are the accepted
 * quote's FX snapshots (GBP per unit, keyed by currency), the fallback when no HMRC rate is loaded.
 */
export const billsToActuals = (
  bills: readonly BillForActuals[],
  rateFor: RateLookup,
  quoteRates: Readonly<Record<string, string>> = {},
): ActualsFromBills => {
  const actuals: TaggedActual[] = [];
  const out: BillGbp[] = [];
  const warnings: string[] = [];
  let hasEstimatedFx = false;

  for (const bill of bills) {
    const total = D(bill.totalAmount);
    const paid = sum(bill.payments.map((p) => D(p.amount)));
    const paidGbp = sum(bill.payments.map((p) => D(p.amountGbp)));
    const unpaid = total.minus(paid).gt(0) ? total.minus(paid) : ZERO;
    const ccy = bill.currency.toUpperCase();

    let totalGbp: Decimal | null = null;
    let basis: FxBasis;
    let estimateRate: string | null = null;
    let estimateRateSource: BillGbp['estimateRateSource'] = null;

    if (isGbp(ccy)) {
      totalGbp = total;
      basis = 'GBP';
    } else if (unpaid.isZero() && bill.payments.length > 0) {
      totalGbp = paidGbp;
      basis = 'PAYMENTS';
    } else {
      const hmrc = rateFor(ccy);
      const rate = hmrc ?? quoteRates[ccy] ?? null;
      if (rate !== null) {
        estimateRate = rate;
        estimateRateSource = hmrc !== null ? 'HMRC_MONTHLY' : 'QUOTE';
        totalGbp = paidGbp.plus(round2(unpaid.times(D(rate))));
        basis = bill.payments.length > 0 ? 'PAYMENTS_AND_RATE' : 'RATE';
        hasEstimatedFx = true;
      } else if (paid.gt(0)) {
        // No published rate: carry the unpaid part at the rate the payments so far achieved.
        const achieved = paidGbp.div(paid);
        estimateRate = achieved.toDecimalPlaces(6).toString();
        estimateRateSource = null;
        totalGbp = paidGbp.plus(round2(unpaid.times(achieved)));
        basis = 'PAYMENTS_AND_RATE';
        hasEstimatedFx = true;
        warnings.push(
          `No ${ccy} exchange rate is loaded; the unpaid part of bill ${bill.referenceNumber} is converted at the rate its payments achieved.`,
        );
      } else {
        basis = 'UNKNOWN';
        warnings.push(
          `Bill ${bill.referenceNumber} is in ${ccy} with no payment and no ${ccy} rate loaded; it is left out of the actuals until it is paid or a rate is loaded.`,
        );
      }
    }

    const signed = totalGbp === null ? null : bill.isCreditNote ? totalGbp.neg() : totalGbp;
    out.push({
      billId: bill.id,
      referenceNumber: bill.referenceNumber,
      vendorLabel: bill.vendorLabel,
      currency: ccy,
      isCreditNote: bill.isCreditNote,
      totalAmount: fixed2(total),
      paidAmount: fixed2(paid),
      totalGbp: signed === null ? null : fixed2(signed),
      basis,
      estimateRate,
      estimateRateSource,
    });
    if (totalGbp === null) continue;

    const parts = splitAcrossLines(totalGbp, bill.lines, total);
    bill.lines.forEach((line, i) => {
      const gbp = parts[i] ?? ZERO;
      actuals.push({
        billId: bill.id,
        billLineId: line.id,
        purchaseOrderId: line.purchaseOrderId,
        category: line.costCategory,
        amountGbp: fixed2(bill.isCreditNote ? gbp.neg() : gbp),
        lineRef: line.lineRef,
        ...(line.unplannedReason ? { unplannedReason: line.unplannedReason } : {}),
        description: `${bill.referenceNumber}: ${line.description}`,
      });
    });
  }
  return { actuals, bills: out, hasEstimatedFx, warnings };
};

/**
 * The accepted quote line's snapshot as the engine's per-category estimate (ADR-0014: one
 * category per stored total). The platform fee has no vendor bill of its own and sits in OTHER;
 * the inland VAT-base adjustment is VAT-base padding, not a cost, and is left out; unplanned
 * costs are never estimated.
 */
export const estimateFromQuoteLine = (line: LineResult): EstimateByCategory => ({
  GOODS: line.lineGoodsValueGbp,
  ASSISTS: line.assistsGbp,
  FREIGHT_TO_BORDER: line.allocatedFreightToBorderGbp,
  FREIGHT_POST_BORDER: line.allocatedFreightPostBorderGbp,
  ORIGIN_FEES: line.allocatedOriginFeesGbp,
  DESTINATION_FEES: line.allocatedDestinationFeesGbp,
  CLEARANCE: '0',
  INSURANCE: line.allocatedInsuranceGbp,
  DUTY: line.lineDutyGbp,
  IMPORT_VAT: line.lineVatGbp,
  DEFERMENT_FEE: line.allocatedFinancingFeeGbp,
  UNPLANNED: '0',
  OTHER: line.allocatedPlatformFeeGbp,
});

/** Per-unit weight/volume from the quote line's totals (the engine takes unit figures). */
export const perUnit = (lineTotal: string, quantity: number): string =>
  quantity > 0 ? D(lineTotal).div(quantity).toString() : '0';

/** Sum of the actuals per category (used when there is no accepted quote to compare against). */
export const actualsByCategory = (
  actuals: readonly ActualCostInput[],
): Partial<Record<CostCategory, string>> => {
  const totals = new Map<CostCategory, Decimal>();
  for (const a of actuals) {
    totals.set(a.category, (totals.get(a.category) ?? ZERO).plus(D(a.amountGbp)));
  }
  return Object.fromEntries([...totals].map(([c, v]) => [c, fixed2(v)]));
};
