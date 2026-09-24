import { Link } from 'react-router';
import type { PaymentDue } from '../../services/orders/schedule';
import { isoDate, money } from './status-badge';

/**
 * Home "Payments due" (M7, ADR-0013): the next unpaid deposits and balances of open purchase
 * orders, each in its own currency. Until the payments partner is live (ADR-0015/16) this only
 * shows what is due and when; the user records the payment on the order.
 */
export function PaymentsDueCard({ payments }: { payments: readonly PaymentDue[] }) {
  return (
    <section className="card payments-due" aria-labelledby="payments-due-title">
      <h2 id="payments-due-title">Payments due</h2>
      {payments.length === 0 ? (
        <p className="muted">
          Nothing due. Issued <Link to="/app/orders">purchase orders</Link> list their deposits and
          balances here.
        </p>
      ) : (
        <ul>
          {payments.map((p) => (
            <li key={`${p.orderId}-${p.kind}`}>
              <Link to={`/app/orders/${p.orderId}`} className="draft-row">
                <span>
                  <span className="draft-route">
                    {p.poNumber} · {p.kind === 'DEPOSIT' ? 'Deposit' : 'Balance'}
                  </span>
                  <span className="muted small">
                    {p.supplierName} ·{' '}
                    {p.dueAt ? `due ${isoDate(p.dueAt)}` : 'due when the balance is triggered'}
                  </span>
                </span>
                <span className="draft-total">
                  {money(p.amount, p.currency)}
                  <span className="draft-cta">Record payment →</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
