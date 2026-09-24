import { can } from '@harbour/db';
import { Plus } from 'lucide-react';
import { Form, Link } from 'react-router';
import type { Route } from './+types/app.orders';
import { isoDateTime } from '../components/format';
import { OrderStatusBadge, money } from '../components/orders/status-badge';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { listOrders } from '../services/orders/orders.server';
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  orderListSchema,
  orderNotice,
} from '../validators/order';

/**
 * Purchase orders list (M7, ADR-0013). Every role may view (`order.view`); creating needs
 * `order.edit` (the editor checks it). Amounts are in each order's own currency, never converted.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Orders — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  created: 'Purchase order created as a draft.',
  saved: 'Purchase order saved.',
  issued: 'Purchase order issued.',
  status: 'Purchase order updated.',
  cancelled: 'Purchase order cancelled.',
  'deposit-paid': 'Deposit recorded as paid.',
  'balance-paid': 'Balance recorded as paid.',
  'not-found': 'That purchase order no longer exists in this organisation.',
} as const;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.view' });
  const url = new URL(request.url);
  const filter = orderListSchema.parse({
    status: url.searchParams.get('status') ?? undefined,
    page: url.searchParams.get('page') ?? '1',
  });
  const notice = orderNotice.parse(url.searchParams.get('notice') ?? undefined);
  const list = await withOrg(ctx, (tx) => listOrders(tx, filter));
  return {
    ...list,
    filter,
    canEdit: can(ctx.role, 'order.edit'),
    notice: notice ? NOTICE_TEXT[notice] : null,
  };
};

export default function OrdersPage({ loaderData }: Route.ComponentProps) {
  const { rows, count, page, pages, filter, canEdit, notice } = loaderData;
  const pageLink = (p: number) => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    q.set('page', String(p));
    return `/app/orders?${q.toString()}`;
  };
  const paymentCell = (amount: string | null, paid: boolean, currency: string) =>
    amount === null ? (
      <span className="muted">—</span>
    ) : (
      <>
        {money(amount, currency)}{' '}
        {paid ? <span className="paid-mark">paid</span> : <span className="due-mark">due</span>}
      </>
    );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Purchase orders</h1>
          <p className="muted">
            {count === 0 ? 'No purchase orders yet' : `${count} order${count === 1 ? '' : 's'}`}
            {filter.status ? ` · ${ORDER_STATUS_LABELS[filter.status].toLowerCase()}` : ''}
          </p>
        </div>
        {canEdit ? (
          <Link to="/app/orders/new" className="button lime">
            <Plus className="icon" aria-hidden="true" /> New order
          </Link>
        ) : null}
      </div>

      {notice ? (
        <div className="banner ready" role="status">
          <p>{notice}</p>
        </div>
      ) : null}

      <Form method="get" className="catalogue-filter" aria-label="Filter orders">
        <div className="inline-fields">
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={filter.status ?? ''}>
              <option value="">All</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ORDER_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button secondary">
            Filter
          </button>
        </div>
      </Form>

      {rows.length === 0 ? (
        <p className="muted">
          {filter.status
            ? 'No orders with that status.'
            : 'No purchase orders yet. Record what you agreed to buy, then get a freight quote from it.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="stack dense" aria-label="Purchase orders">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Supplier</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Goods
                </th>
                <th scope="col" className="num">
                  Deposit
                </th>
                <th scope="col" className="num">
                  Balance
                </th>
                <th scope="col">Quote</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td data-label="Number">
                    <Link to={`/app/orders/${o.id}`} className="code">
                      {o.poNumber}
                    </Link>
                  </td>
                  <td data-label="Supplier">{o.supplierName}</td>
                  <td data-label="Status">
                    <OrderStatusBadge status={o.status} />
                  </td>
                  <td data-label="Goods" className="num">
                    {money(o.totalGoodsValue, o.currency)}
                  </td>
                  <td data-label="Deposit" className="num">
                    {paymentCell(o.depositAmount, o.depositPaid, o.currency)}
                  </td>
                  <td data-label="Balance" className="num">
                    {paymentCell(o.balanceAmount, o.balancePaid, o.currency)}
                  </td>
                  <td data-label="Quote">
                    {o.acceptedQuote ? (
                      <Link to={`/app/quotes/${o.acceptedQuote.id}`} className="code">
                        {o.acceptedQuote.reference}
                      </Link>
                    ) : o.quoteCount > 0 ? (
                      <span className="muted">
                        {o.quoteCount} draft{o.quoteCount === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Updated">{isoDateTime(o.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <nav className="pager" aria-label="Pages">
          {page > 1 ? <Link to={pageLink(page - 1)}>Previous</Link> : <span />}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link to={pageLink(page + 1)}>Next</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}
