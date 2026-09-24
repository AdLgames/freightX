import { can } from '@harbour/db';
import { Plus } from 'lucide-react';
import { Form, Link } from 'react-router';
import type { Route } from './+types/app.bills';
import { BillStatusBadge } from '../components/bills/status-badge';
import { money } from '../components/orders/status-badge';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { listBills } from '../services/bills/bills.server';
import {
  BILL_STATUSES,
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  billListSchema,
  billNotice,
} from '../validators/bill';

/**
 * Bills list (M8, ADR-0014): the accounts-payable sub-ledger. Every role may view (`bill.view`);
 * recording needs `bill.edit` (the editor checks it). Amounts are in each bill's own currency,
 * never converted; the GBP view lives on the order's "Costs and variance" page.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Bills — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  created: 'Bill recorded as a draft.',
  saved: 'Bill saved.',
  posted: 'Bill posted.',
  deleted: 'Draft bill deleted.',
  'payment-recorded': 'Payment recorded.',
  'payment-removed': 'Payment removed.',
  'not-found': 'That bill no longer exists in this organisation.',
} as const;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.view' });
  const url = new URL(request.url);
  const filter = billListSchema.parse({
    status: url.searchParams.get('status') ?? undefined,
    order: url.searchParams.get('order') ?? undefined,
    page: url.searchParams.get('page') ?? '1',
  });
  const notice = billNotice.parse(url.searchParams.get('notice') ?? undefined);
  const list = await withOrg(ctx, (tx) => listBills(tx, filter));
  return {
    ...list,
    filter,
    canEdit: can(ctx.role, 'bill.edit'),
    notice: notice ? NOTICE_TEXT[notice] : null,
  };
};

export default function BillsPage({ loaderData }: Route.ComponentProps) {
  const { rows, count, page, pages, filter, canEdit, notice } = loaderData;
  const pageLink = (p: number) => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.order) q.set('order', filter.order);
    q.set('page', String(p));
    return `/app/bills?${q.toString()}`;
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bills</h1>
          <p className="muted">
            {count === 0 ? 'No bills yet' : `${count} bill${count === 1 ? '' : 's'}`}
            {filter.status ? ` · ${BILL_STATUS_LABELS[filter.status].toLowerCase()}` : ''}
            {filter.order ? ' · for one purchase order' : ''}
          </p>
        </div>
        {canEdit ? (
          <Link
            to={filter.order ? `/app/bills/new?order=${filter.order}` : '/app/bills/new'}
            className="button lime"
          >
            <Plus className="icon" aria-hidden="true" /> Record a bill
          </Link>
        ) : null}
      </div>

      {notice ? (
        <div className="banner ready" role="status">
          <p>{notice}</p>
        </div>
      ) : null}

      <Form method="get" className="catalogue-filter" aria-label="Filter bills">
        {filter.order ? <input type="hidden" name="order" value={filter.order} /> : null}
        <div className="inline-fields">
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={filter.status ?? ''}>
              <option value="">All</option>
              {BILL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {BILL_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button secondary">
            Filter
          </button>
          {filter.order ? (
            <Link to="/app/bills" className="button ghost">
              All bills
            </Link>
          ) : null}
        </div>
      </Form>

      {rows.length === 0 ? (
        <p className="muted">
          {filter.status || filter.order
            ? 'No bills match.'
            : 'No bills yet. Record supplier invoices, freight invoices and customs charges against your purchase orders to see actual landed cost and variance.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="stack dense" aria-label="Bills">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Vendor</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col" className="num">
                  Paid
                </th>
                <th scope="col">Orders</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td data-label="Reference">
                    <Link to={`/app/bills/${b.id}`} className="code">
                      {b.referenceNumber}
                    </Link>
                    {b.isCreditNote ? <span className="muted small"> · credit note</span> : null}
                  </td>
                  <td data-label="Vendor">{b.vendor}</td>
                  <td data-label="Kind">{BILL_TYPE_LABELS[b.billType]}</td>
                  <td data-label="Status">
                    <BillStatusBadge status={b.status} />
                  </td>
                  <td data-label="Issued">
                    {b.issuedOn}
                    {b.dueOn ? <span className="muted small"> · due {b.dueOn}</span> : null}
                  </td>
                  <td data-label="Total" className="num">
                    {money(b.totalAmount, b.currency)}
                  </td>
                  <td data-label="Paid" className="num">
                    {b.status === 'DRAFT' ? (
                      <span className="muted">—</span>
                    ) : (
                      money(b.paidAmount, b.currency)
                    )}
                  </td>
                  <td data-label="Orders">
                    {b.orders.map((o, i) => (
                      <span key={o.id}>
                        {i > 0 ? ', ' : ''}
                        <Link to={`/app/orders/${o.id}/costs`} className="code">
                          {o.poNumber}
                        </Link>
                      </span>
                    ))}
                  </td>
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
