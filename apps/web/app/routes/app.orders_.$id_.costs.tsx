import { can } from '@harbour/db';
import { Link } from 'react-router';
import type { Route } from './+types/app.orders_.$id_.costs';
import { signedGbp, varianceClass } from '../components/bills/status-badge';
import { gbp, isoDateTime } from '../components/format';
import { OrderStatusBadge, money } from '../components/orders/status-badge';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { loadOrderCosts } from '../services/bills/variance.server';
import { pageError } from '../services/page-error';
import { COST_CATEGORIES, COST_CATEGORY_LABELS, UNPLANNED_REASON_LABELS } from '../validators/bill';
import { orderIdParam } from '../validators/order';

/**
 * Costs and variance for one purchase order (M8, ADR-0014): the accepted quote is the estimate,
 * the posted bills are the actuals, the engine's `absorbActuals` gives variance by category and
 * actual landed cost per SKU. Recomputed on every view from the ledger; nothing is stored.
 * Needs `order.view` and `bill.view` (every role has both).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Costs and variance — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const notFound = () =>
  pageError(
    404,
    'Purchase order not found',
    'This purchase order does not exist in your organisation.',
  );

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.view' });
  if (!can(ctx.role, 'bill.view')) throw notFound();
  const id = orderIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const app = await getApp();
  const costs = await withOrg(ctx, (tx) =>
    loadOrderCosts(tx, { fxStore: app.stores.fxStore, now: new Date() }, id.data),
  );
  if (!costs) throw notFound();
  return { costs, canRecordBill: can(ctx.role, 'bill.edit') };
};

const BASIS_TEXT = {
  GBP: 'GBP bill',
  PAYMENTS: 'at the rates paid',
  PAYMENTS_AND_RATE: 'paid part at the rates paid; unpaid part at an estimated rate',
  RATE: 'unpaid: estimated rate',
  UNKNOWN: 'no rate — left out',
} as const;

export default function OrderCosts({ loaderData }: Route.ComponentProps) {
  const { costs: c, canRecordBill } = loaderData;
  const r = c.result;
  const categories = r
    ? COST_CATEGORIES.filter(
        (cat) =>
          r.byCategory[cat].hasActuals ||
          r.byCategory[cat].estimateGbp !== '0.00' ||
          r.byCategory[cat].actualGbp !== '0.00',
      )
    : [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {c.order.poNumber} · Costs and variance{' '}
            <OrderStatusBadge status={c.order.status as never} />
          </h1>
          <p className="muted">
            {c.quote ? (
              <>
                Estimate: accepted quote{' '}
                <Link to={`/app/quotes/${c.quote.id}`} className="code">
                  {c.quote.reference}
                </Link>
                {c.quote.acceptedAt ? ` (accepted ${isoDateTime(c.quote.acceptedAt)})` : ''} ·
                actuals: {c.postedBillCount} posted bill{c.postedBillCount === 1 ? '' : 's'}
              </>
            ) : (
              <>
                No accepted quote yet · {c.postedBillCount} posted bill
                {c.postedBillCount === 1 ? '' : 's'}
              </>
            )}
          </p>
        </div>
        <div className="quote-actions">
          <Link to={`/app/orders/${c.order.id}`} className="button ghost small">
            Back to the order
          </Link>
          <Link to={`/app/bills?order=${c.order.id}`} className="button secondary small">
            Bills for this order
          </Link>
          {canRecordBill ? (
            <Link to={`/app/bills/new?order=${c.order.id}`} className="button lime small">
              Record a bill
            </Link>
          ) : null}
        </div>
      </div>

      {c.warnings.length > 0 ? (
        <div className="banner warning" role="status">
          <ul>
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.hasEstimatedFx ? (
        <p className="hint">
          Some bills are not fully paid yet: their unpaid part is converted at today’s HMRC monthly
          rate (or the quote’s rate) and marked as an estimate. Figures firm up as payments are
          recorded.
        </p>
      ) : null}

      {r ? (
        <>
          <div className="order-grid">
            <section className="card" aria-labelledby="totals-title">
              <h2 id="totals-title">
                Landed cost (GBP{r.vatRecoverable ? ', ex VAT' : ', incl. import VAT'})
              </h2>
              <dl className="meta">
                <dt>Estimated (accepted quote)</dt>
                <dd>{gbp(r.totals.estimatedLandedCostGbp)}</dd>
                <dt>Actual (posted bills)</dt>
                <dd>{gbp(r.totals.actualLandedCostGbp)}</dd>
                <dt>Variance</dt>
                <dd className={varianceClass(r.totals.varianceGbp)}>
                  {signedGbp(r.totals.varianceGbp)}
                </dd>
              </dl>
              <p className="muted small">
                {r.vatRecoverable
                  ? 'Import VAT is recoverable for this organisation and is excluded from landed cost.'
                  : 'Import VAT is a real cost for this organisation and is included.'}
              </p>
            </section>
            <section className="card" aria-labelledby="missing-title">
              <h2 id="missing-title">Completeness</h2>
              {r.missingCategories.length === 0 ? (
                <p className="muted">Every estimated category has at least one posted bill.</p>
              ) : (
                <>
                  <p className="muted small">
                    Estimated but no bill posted yet — the variance is incomplete until they arrive:
                  </p>
                  <ul className="card-list">
                    {r.missingCategories.map((cat) => (
                      <li key={cat}>
                        {COST_CATEGORY_LABELS[cat]} · estimated {gbp(r.byCategory[cat].estimateGbp)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>

          <section className="card" aria-labelledby="by-category-title">
            <h2 id="by-category-title">By category</h2>
            <div className="table-wrap">
              <table className="stack dense" aria-label="Variance by category">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Estimate
                    </th>
                    <th scope="col" className="num">
                      Actual
                    </th>
                    <th scope="col" className="num">
                      Variance
                    </th>
                    <th scope="col">Bills</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((cat) => {
                    const f = r.byCategory[cat];
                    const counted = r.landedCostCategories.includes(cat);
                    return (
                      <tr key={cat} className={counted ? undefined : 'muted'}>
                        <td data-label="Category">
                          {COST_CATEGORY_LABELS[cat]}
                          {counted ? null : (
                            <span className="muted small"> · not in landed cost</span>
                          )}
                        </td>
                        <td data-label="Estimate" className="num">
                          {gbp(f.estimateGbp)}
                        </td>
                        <td data-label="Actual" className="num">
                          {gbp(f.actualGbp)}
                        </td>
                        <td data-label="Variance" className={`num ${varianceClass(f.varianceGbp)}`}>
                          {signedGbp(f.varianceGbp)}
                        </td>
                        <td data-label="Bills">
                          {f.hasActuals ? 'Posted' : <span className="due-mark">None yet</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="per-sku-title">
            <h2 id="per-sku-title">Actual landed cost per SKU</h2>
            <div className="table-wrap">
              <table className="stack dense" aria-label="Landed cost per SKU">
                <thead>
                  <tr>
                    <th scope="col">SKU</th>
                    <th scope="col" className="num">
                      Quantity
                    </th>
                    <th scope="col" className="num">
                      Quoted / unit
                    </th>
                    <th scope="col" className="num">
                      Actual / unit
                    </th>
                    <th scope="col" className="num">
                      Variance / unit
                    </th>
                    <th scope="col">Biggest drivers</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.ref}>
                      <td data-label="SKU">
                        <span className="code">{l.sku ?? l.ref.slice(0, 8)}</span>
                        {l.name ? ` ${l.name}` : ''}
                      </td>
                      <td data-label="Quantity" className="num">
                        {l.quantity.toLocaleString('en-GB')}
                      </td>
                      <td data-label="Quoted / unit" className="num">
                        {gbp(l.estimatedPerUnit)}
                      </td>
                      <td data-label="Actual / unit" className="num">
                        {gbp(l.actualPerUnit)}
                      </td>
                      <td
                        data-label="Variance / unit"
                        className={`num ${varianceClass(l.variancePerUnit)}`}
                      >
                        {signedGbp(l.variancePerUnit)}
                      </td>
                      <td data-label="Biggest drivers">
                        {l.drivers.length === 0 ? (
                          <span className="muted">On the estimate</span>
                        ) : (
                          l.drivers.slice(0, 3).map((d, i) => (
                            <span key={d.category}>
                              {i > 0 ? ' · ' : ''}
                              {COST_CATEGORY_LABELS[d.category]}{' '}
                              <span className={varianceClass(d.varianceGbp)}>
                                {signedGbp(d.varianceGbp)}
                              </span>
                              {d.unplannedReasons.length > 0
                                ? ` (${d.unplannedReasons.map((x) => UNPLANNED_REASON_LABELS[x].split(' (')[0]).join(', ')})`
                                : ''}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <section className="card" aria-labelledby="actuals-title">
          <h2 id="actuals-title">Actual costs so far</h2>
          <p className="muted">
            Variance needs an estimate: accept a freight quote for this order and the posted bills
            will be compared against it here, category by category and per SKU.
          </p>
          {c.actualsOnly && Object.keys(c.actualsOnly).length > 0 ? (
            <dl className="meta">
              {COST_CATEGORIES.filter((cat) => c.actualsOnly![cat] !== undefined).map((cat) => (
                <div key={cat} className="meta-row">
                  <dt>{COST_CATEGORY_LABELS[cat]}</dt>
                  <dd>{gbp(c.actualsOnly![cat]!)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted small">No posted bills for this order yet.</p>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="bills-title">
        <h2 id="bills-title">Posted bills counted here</h2>
        {c.bills.length === 0 ? (
          <p className="muted">
            None yet.{' '}
            {canRecordBill ? (
              <Link to={`/app/bills/new?order=${c.order.id}`}>Record the first bill</Link>
            ) : null}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Bills">
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col">Vendor</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col" className="num">
                    Paid
                  </th>
                  <th scope="col" className="num">
                    GBP
                  </th>
                  <th scope="col">How</th>
                </tr>
              </thead>
              <tbody>
                {c.bills.map((b) => (
                  <tr key={b.billId}>
                    <td data-label="Bill">
                      <Link to={`/app/bills/${b.billId}`} className="code">
                        {b.referenceNumber}
                      </Link>
                      {b.isCreditNote ? <span className="muted small"> · credit note</span> : null}
                    </td>
                    <td data-label="Vendor">{b.vendorLabel}</td>
                    <td data-label="Total" className="num">
                      {money(b.totalAmount, b.currency)}
                    </td>
                    <td data-label="Paid" className="num">
                      {money(b.paidAmount, b.currency)}
                    </td>
                    <td data-label="GBP" className="num">
                      {b.totalGbp === null ? <span className="muted">—</span> : gbp(b.totalGbp)}
                    </td>
                    <td data-label="How">
                      {BASIS_TEXT[b.basis]}
                      {b.estimateRate
                        ? ` (${b.estimateRate}${b.estimateRateSource === 'HMRC_MONTHLY' ? ', HMRC monthly' : b.estimateRateSource === 'QUOTE' ? ', quote rate' : ''})`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          Costs are split across an order’s SKUs the way the quote apportioned them: physical costs
          by chargeable weight, duty by customs value, insurance and goods by value; every split
          adds up to the bills to the penny (ADR-0014).
        </p>
      </section>
    </>
  );
}
