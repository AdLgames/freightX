import { D, ZERO, round2, sum, type Decimal } from '@harbour/engine';
import type { OrderStatusValue, PaymentKind } from '../../validators/order';

/**
 * Pure money rules of a purchase order (M7, ADR-0013). Everything is `Decimal` in the PO
 * currency (§3); results are canonical decimal strings for the boundary. No I/O, no Prisma, so
 * this file is unit-tested without a database and may be imported by components.
 */

export interface ItemAmounts {
  quantity: number;
  unitCost: string;
}

export interface ItemTotal {
  /** round2(quantity × unitCost), 2 dp. */
  lineTotal: string;
}

/** Line totals (2 dp, half-up) and their sum. */
export const orderTotals = (
  items: readonly ItemAmounts[],
): { lines: ItemTotal[]; totalGoodsValue: string } => {
  const totals: Decimal[] = items.map((i) => round2(D(i.unitCost).times(i.quantity)));
  return {
    lines: totals.map((t) => ({ lineTotal: t.toFixed(2) })),
    totalGoodsValue: sum(totals).toFixed(2),
  };
};

/** The supplier's `PaymentTerms` row as the schedule needs it. */
export interface TermsLike {
  termType: 'PREPAID' | 'NET' | 'DEPOSIT_BALANCE';
  /** Percent convention: "30.00" = 30%. */
  depositPct: string | null;
  balanceTrigger: 'ON_SHIPMENT' | 'AGAINST_BILL_OF_LADING' | 'ON_ARRIVAL' | null;
  netDays: number | null;
}

export interface PaymentSchedule {
  depositPct: string;
  depositAmount: string;
  /** Deposits are due on issue (decisions-needed (ag)). */
  depositDueAt: Date | null;
  balanceAmount: string;
  balanceTrigger: TermsLike['balanceTrigger'];
  /** NET terms: issue date + netDays. DEPOSIT_BALANCE: set when the trigger event is recorded. */
  balanceDueAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deposit and balance from the supplier's terms at the moment of issue (frozen with the PO):
 *   PREPAID          → deposit 100%, balance 0
 *   NET              → deposit 0, balance 100%, balanceDueAt = issuedAt + netDays
 *   DEPOSIT_BALANCE  → deposit = round2(total × pct / 100), balance = total − deposit,
 *                      balanceTrigger copied; balanceDueAt unknown until the trigger event
 * The balance is the remainder, never a second rounding, so the two add up to the total exactly
 * (the database CHECK `purchase_orders_split_adds_up` insists on it).
 */
export const paymentSchedule = (
  totalGoodsValue: string,
  terms: TermsLike,
  issuedAt: Date,
): PaymentSchedule => {
  const total = round2(D(totalGoodsValue));
  switch (terms.termType) {
    case 'PREPAID':
      return {
        depositPct: '100.00',
        depositAmount: total.toFixed(2),
        depositDueAt: issuedAt,
        balanceAmount: '0.00',
        balanceTrigger: null,
        balanceDueAt: null,
      };
    case 'NET': {
      const days = terms.netDays ?? 0;
      return {
        depositPct: '0.00',
        depositAmount: '0.00',
        depositDueAt: null,
        balanceAmount: total.toFixed(2),
        balanceTrigger: null,
        balanceDueAt: new Date(issuedAt.getTime() + days * DAY_MS),
      };
    }
    case 'DEPOSIT_BALANCE': {
      const pct = D(terms.depositPct ?? '0');
      const deposit = round2(total.times(pct).div(100));
      const balance = total.minus(deposit);
      return {
        depositPct: pct.toFixed(2),
        depositAmount: deposit.toFixed(2),
        depositDueAt: deposit.isZero() ? null : issuedAt,
        balanceAmount: balance.toFixed(2),
        balanceTrigger: terms.balanceTrigger,
        balanceDueAt: null,
      };
    }
  }
};

/** A payment shown on Home ("Payments due") or on the PO's schedule card. */
export interface PaymentDue {
  orderId: string;
  poNumber: string;
  supplierName: string;
  kind: PaymentKind;
  /** Decimal string in `currency` — never converted (no FX on the dashboard, ADR-0013). */
  amount: string;
  currency: string;
  /** ISO instant, or null when the due date depends on an event not yet recorded. */
  dueAt: string | null;
}

export interface PaymentSource {
  id: string;
  poNumber: string;
  supplierName: string;
  status: OrderStatusValue;
  currency: string;
  depositAmount: string | null;
  depositDueAt: string | null;
  depositPaidAt: string | null;
  balanceAmount: string | null;
  balanceDueAt: string | null;
  balancePaidAt: string | null;
}

const isPositive = (amount: string | null): amount is string =>
  amount !== null && D(amount).gt(ZERO);

/**
 * Unpaid deposits and balances of open orders, soonest due first; payments whose due date is not
 * yet known (balance awaiting its trigger) come last, then by PO number.
 */
export const paymentsDue = (orders: readonly PaymentSource[], take?: number): PaymentDue[] => {
  const out: PaymentDue[] = [];
  for (const o of orders) {
    if (o.status === 'DRAFT' || o.status === 'CLOSED' || o.status === 'CANCELLED') continue;
    if (o.depositPaidAt === null && isPositive(o.depositAmount)) {
      out.push({
        orderId: o.id,
        poNumber: o.poNumber,
        supplierName: o.supplierName,
        kind: 'DEPOSIT',
        amount: o.depositAmount,
        currency: o.currency,
        dueAt: o.depositDueAt,
      });
    }
    if (o.balancePaidAt === null && isPositive(o.balanceAmount)) {
      out.push({
        orderId: o.id,
        poNumber: o.poNumber,
        supplierName: o.supplierName,
        kind: 'BALANCE',
        amount: o.balanceAmount,
        currency: o.currency,
        dueAt: o.balanceDueAt,
      });
    }
  }
  out.sort((a, b) => {
    if (a.dueAt === null && b.dueAt !== null) return 1;
    if (a.dueAt !== null && b.dueAt === null) return -1;
    if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) {
      return a.dueAt < b.dueAt ? -1 : 1;
    }
    return a.poNumber.localeCompare(b.poNumber) || a.kind.localeCompare(b.kind);
  });
  return take === undefined ? out : out.slice(0, take);
};

/** `PO-YYYY-NNN` (NNN zero-padded to at least three digits). */
export const formatPoNumber = (year: number, n: number): string =>
  `PO-${year}-${String(n).padStart(3, '0')}`;
