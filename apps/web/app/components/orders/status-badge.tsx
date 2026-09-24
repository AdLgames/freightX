import {
  ORDER_STATUS_CLASS,
  ORDER_STATUS_LABELS,
  type OrderStatusValue,
} from '../../validators/order';

/** Draft / Issued / In production / Ready to ship / Shipped / Closed / Cancelled pill (M7). */
export function OrderStatusBadge({ status }: { status: OrderStatusValue }) {
  return (
    <span className={`status-pill ${ORDER_STATUS_CLASS[status]}`}>
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}

/** "1,234.50 USD" — amount and currency code, never converted (ADR-0013: no FX on the dashboard). */
export const money = (amount: string, currency: string): string => {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [int = '0', frac] = unsigned.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''} ${currency}`;
};

/** `YYYY-MM-DD` of an ISO instant (dates on the schedule are calendar days). */
export const isoDate = (iso: string): string => iso.slice(0, 10);
