import { can } from '@harbour/db';
import { Plus } from 'lucide-react';
import { Form, Link } from 'react-router';
import type { Route } from './+types/app.quotes';
import { gbp, isoDateTime } from '../components/format';
import { QuoteStatusBadge } from '../components/quotes/status-badge';
import { modeName, portName } from '../data/ports';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { listQuotes } from '../services/quotes/quotes.server';
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  quoteListSchema,
  quoteNotice,
} from '../validators/quote';

/**
 * Quotes list (M4). Every role may view (`quote.view`); creating needs `quote.edit` (the builder
 * checks it). Reference = `Q-` + the first 8 characters of the id (decisions-needed (af)).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Quotes — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  saved: 'Quote saved as a draft.',
  accepted: 'Quote accepted. It is now a fixed snapshot: it can be cancelled but not changed.',
  cancelled: 'Quote cancelled.',
  reopened: 'Quote reopened as a draft.',
  finalised: 'Quote finalised.',
  recomputed: 'Quote updated to current catalogue, exchange and freight values.',
  'not-found': 'That quote no longer exists in this organisation.',
} as const;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.view' });
  const url = new URL(request.url);
  const filter = quoteListSchema.parse({
    status: url.searchParams.get('status') ?? undefined,
    page: url.searchParams.get('page') ?? '1',
  });
  const notice = quoteNotice.parse(url.searchParams.get('notice') ?? undefined);
  const list = await withOrg(ctx, (tx) => listQuotes(tx, filter));
  return {
    ...list,
    filter,
    canEdit: can(ctx.role, 'quote.edit'),
    notice: notice ? NOTICE_TEXT[notice] : null,
  };
};

const laneOf = (q: {
  originPort: string | null;
  destinationPort: string | null;
  originCountry: string;
}) =>
  `${q.originPort ? portName(q.originPort) : q.originCountry} → ${q.destinationPort ? portName(q.destinationPort) : 'UK'}`;

export default function QuotesPage({ loaderData }: Route.ComponentProps) {
  const { rows, count, page, pages, filter, canEdit, notice } = loaderData;
  const pageLink = (p: number) => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    q.set('page', String(p));
    return `/app/quotes?${q.toString()}`;
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quotes</h1>
          <p className="muted">
            {count === 0 ? 'No quotes yet' : `${count} quote${count === 1 ? '' : 's'}`}
            {filter.status ? ` · ${QUOTE_STATUS_LABELS[filter.status].toLowerCase()}` : ''}
          </p>
        </div>
        {canEdit ? (
          <Link to="/app/quotes/new" className="button lime">
            <Plus className="icon" aria-hidden="true" /> New quote
          </Link>
        ) : null}
      </div>

      {notice ? (
        <div className="banner ready" role="status">
          <p>{notice}</p>
        </div>
      ) : null}

      <Form method="get" className="catalogue-filter" aria-label="Filter quotes">
        <div className="inline-fields">
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={filter.status ?? ''}>
              <option value="">All</option>
              {QUOTE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {QUOTE_STATUS_LABELS[s]}
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
            ? 'No quotes with that status.'
            : 'No quotes yet. Build your first landed-cost quote from the catalogue.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="stack dense" aria-label="Quotes">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Lane</th>
                <th scope="col">Incoterm</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Per unit ex VAT
                </th>
                <th scope="col" className="num">
                  Total ex VAT
                </th>
                <th scope="col">Valid until</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id}>
                  <td data-label="Reference">
                    <Link to={`/app/quotes/${q.id}`} className="code">
                      {q.reference}
                    </Link>
                  </td>
                  <td data-label="Lane">
                    {laneOf(q)}
                    <span className="muted small"> · {modeName(q.mode)}</span>
                  </td>
                  <td data-label="Incoterm">{q.incoterm}</td>
                  <td data-label="Status">
                    <QuoteStatusBadge status={q.status} />
                  </td>
                  <td data-label="Per unit ex VAT" className="num">
                    {q.landedCostPerUnit ? (
                      gbp(q.landedCostPerUnit)
                    ) : (
                      <span className="muted">{q.lineCount} lines</span>
                    )}
                  </td>
                  <td data-label="Total ex VAT" className="num">
                    {gbp(q.totalLandedCostExVat)}
                  </td>
                  <td data-label="Valid until">{isoDateTime(q.validUntil)}</td>
                  <td data-label="Updated">{isoDateTime(q.updatedAt)}</td>
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
