import { QUOTE_STATUS_CLASS } from '../../services/quotes/view';
import { QUOTE_STATUS_LABELS, type QuoteStatusValue } from '../../validators/quote';

/** Draft / Indicative / Ready / Accepted / Expired / Cancelled pill (styles.css `.status-pill`). */
export function QuoteStatusBadge({ status }: { status: QuoteStatusValue }) {
  return (
    <span className={`status-pill ${QUOTE_STATUS_CLASS[status]}`}>
      {QUOTE_STATUS_LABELS[status]}
    </span>
  );
}
