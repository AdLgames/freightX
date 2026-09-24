import { Activity } from 'lucide-react';
import { Link } from 'react-router';
import type { MarginWatch } from '../../services/bills/margin-watch.server';
import { gbp } from '../format';

/**
 * Home "Margin watch" KPI card (M8 surfaced): the open purchase order furthest over its accepted
 * quote's landed-cost estimate, with the cost category driving it, linking to the order's costs
 * page. Neutral when every checked order is within budget, quiet when no posted bill exists yet.
 */
export function MarginWatchCard({ watch }: { watch: MarginWatch }) {
  const worst = watch.items[0];
  if (!worst) {
    return (
      <div className="card stat margin-card ok">
        <p className="stat-label">Margin watch</p>
        <p className="stat-value small">
          {watch.checked === 0 ? 'No bills posted yet' : 'Within budget'}
        </p>
        <p className="stat-sub">
          {watch.checked === 0
            ? 'Post freight and supplier bills to compare them with the quote.'
            : `${watch.checked} open order${watch.checked === 1 ? '' : 's'} checked against their quotes.`}
        </p>
      </div>
    );
  }
  return (
    <div className="card stat margin-card over">
      <Activity className="margin-card-bg" aria-hidden="true" />
      <p className="stat-label">Margin warning</p>
      <p className="stat-value small">
        <Link to={`/app/orders/${worst.orderId}/costs`}>{worst.poNumber}</Link>
      </p>
      <p className="stat-sub">
        Trending <strong>{worst.variancePct}%</strong> over budget ({gbp(worst.varianceGbp)})
        {worst.driver ? `, mostly ${worst.driver.label.toLowerCase()}` : ''}
        {worst.incomplete ? '; some categories still unbilled' : ''}.
        {watch.items.length > 1
          ? ` ${watch.items.length - 1} more order${watch.items.length === 2 ? '' : 's'} over.`
          : ''}
      </p>
    </div>
  );
}
