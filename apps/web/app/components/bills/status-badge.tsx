import { BILL_STATUS_CLASS, BILL_STATUS_LABELS, type BillStatusValue } from '../../validators/bill';

/** Draft / Posted / Paid pill (M8). */
export function BillStatusBadge({ status }: { status: BillStatusValue }) {
  return (
    <span className={`status-pill ${BILL_STATUS_CLASS[status]}`}>{BILL_STATUS_LABELS[status]}</span>
  );
}

/**
 * A signed GBP variance for display: "+£12.30" is unfavourable (actual above estimate), "−£4.00"
 * favourable, "£0.00" on the nose. String-only: no float round trip (ADR-0003).
 */
export const signedGbp = (decimal: string): string => {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [int = '0', frac] = unsigned.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `£${grouped}${frac !== undefined ? `.${frac}` : ''}`;
  if (/^0*(\.0*)?$/.test(unsigned)) return body;
  return negative ? `−${body}` : `+${body}`;
};

/** CSS modifier for a variance: over (unfavourable), under (favourable) or level. */
export const varianceClass = (decimal: string): string =>
  /^-?0*(\.0*)?$/.test(decimal)
    ? 'variance-level'
    : decimal.startsWith('-')
      ? 'variance-under'
      : 'variance-over';
