import { can } from '@harbour/db';
import type { ReactNode } from 'react';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.bills_.$id';
import { BillStatusBadge } from '../components/bills/status-badge';
import { CsrfInput } from '../components/csrf';
import { gbp, isoDateTime } from '../components/format';
import { money } from '../components/orders/status-badge';
import { requireOrgContext, withOrg } from '../services/auth.server';
import {
  billErrorMessage,
  billRowToView,
  deleteBill,
  getBill,
  linesTotal,
  postBill,
  recordBillPayment,
  removeBillPayment,
  type BillWriteResult,
} from '../services/bills/bills.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import {
  BILL_TYPE_LABELS,
  COST_CATEGORY_LABELS,
  UNPLANNED_REASON_LABELS,
  VENDOR_TYPE_LABELS,
  billAction,
  billIdParam,
  billNotice,
  paymentFormSchema,
  removePaymentSchema,
} from '../validators/bill';
import { fieldErrors } from '../validators/common';

/**
 * Bill detail (M8, ADR-0014): header with status, the lines booked to purchase orders, the
 * payments with the rate the bank applied and their GBP, and the actions: post (freezes the bill
 * and makes it count), delete a draft, record or remove a payment.
 *
 * Permissions: view `bill.view`; edit drafts / record payments / delete drafts `bill.edit`;
 * post `bill.post`.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Bill — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  created:
    'Draft recorded. Check the lines add up to the total, then post the bill so it counts towards the actual cost.',
  saved: 'Draft saved.',
  posted:
    'Bill posted. It is now a financial record: its lines and amounts are fixed and count towards actual landed cost. Record a credit note if something was wrong.',
  deleted: '',
  'payment-recorded': 'Payment recorded.',
  'payment-removed': 'Payment removed.',
  'not-found': '',
} as const;

const notFound = () =>
  pageError(404, 'Bill not found', 'This bill does not exist in your organisation.');

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.view' });
  const id = billIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const url = new URL(request.url);
  const notice = billNotice.parse(url.searchParams.get('notice') ?? undefined);
  const row = await withOrg(ctx, (tx) => getBill(tx, id.data));
  if (!row) throw notFound();
  const view = billRowToView(row);
  const edit = can(ctx.role, 'bill.edit');
  const post = can(ctx.role, 'bill.post');
  const draft = view.status === 'DRAFT';
  const lines = linesTotal(view.lines.map((l) => ({ amount: l.amount })));
  return {
    bill: view,
    notice: notice ? NOTICE_TEXT[notice] || null : null,
    can: {
      edit: edit && draft,
      post: post && draft,
      delete: edit && draft,
      recordPayment: edit && view.status === 'POSTED',
      removePayment: edit && !draft,
    },
    postBlockedBy: !draft
      ? null
      : view.lines.length === 0
        ? 'Add at least one line before posting.'
        : lines !== view.totalAmount
          ? `The lines add up to ${money(lines, view.currency)} but the bill total is ${money(view.totalAmount, view.currency)}. Edit the draft so they agree.`
          : null,
  };
};

export interface BillDetailActionData {
  error: string | null;
  paymentErrors: Record<string, string> | null;
}

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.view' });
  const id = billIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const parsed = billAction.safeParse(form?.get('intent'));
  if (!parsed.success) {
    return data<BillDetailActionData>(
      { error: 'Unknown action.', paymentErrors: null },
      { status: 400 },
    );
  }
  const intent = parsed.data;
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const row = await withOrg(ctx, (tx) => getBill(tx, id.data));
  if (!row) throw notFound();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const forbid = () =>
    pageError(
      403,
      'You do not have access to this',
      'Your role in this organisation does not allow it. Ask an owner or admin if you need access.',
    );

  let result: BillWriteResult;
  let notice: string;
  switch (intent) {
    case 'post': {
      if (!can(ctx.role, 'bill.post')) throw forbid();
      result = await withOrg(ctx, (tx) => postBill(tx, actor, row.id, new Date()));
      notice = 'posted';
      break;
    }
    case 'delete': {
      if (!can(ctx.role, 'bill.edit')) throw forbid();
      result = await withOrg(ctx, (tx) => deleteBill(tx, actor, row.id));
      notice = 'deleted';
      break;
    }
    case 'record-payment': {
      if (!can(ctx.role, 'bill.edit')) throw forbid();
      const payment = paymentFormSchema.safeParse({
        paidOn: form?.get('paidOn') ?? '',
        amount: form?.get('amount') ?? '',
        // GBP bills have no exchange rate to type; the service forces 1 anyway.
        fxRate: row.currency === 'GBP' ? '1' : (form?.get('fxRate') ?? ''),
        reference: form?.get('reference') ?? '',
      });
      if (!payment.success) {
        return data<BillDetailActionData>(
          {
            error: 'Check the payment details.',
            paymentErrors: fieldErrors(payment.error.issues),
          },
          { status: 400 },
        );
      }
      result = await withOrg(ctx, (tx) => recordBillPayment(tx, actor, row.id, payment.data));
      notice = 'payment-recorded';
      break;
    }
    case 'remove-payment': {
      if (!can(ctx.role, 'bill.edit')) throw forbid();
      const which = removePaymentSchema.safeParse({ paymentId: form?.get('paymentId') ?? '' });
      if (!which.success) {
        return data<BillDetailActionData>(
          { error: 'That payment is no longer on this bill.', paymentErrors: null },
          { status: 400 },
        );
      }
      result = await withOrg(ctx, (tx) =>
        removeBillPayment(tx, actor, row.id, which.data.paymentId),
      );
      notice = 'payment-removed';
      break;
    }
  }
  log.info(`bill.${intent}`, {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    billId: row.id,
    from: row.status,
    ok: result.ok,
    to: result.ok ? result.status : null,
    error: result.ok ? null : result.error,
  });
  if (result.ok) {
    return intent === 'delete'
      ? redirect('/app/bills?notice=deleted')
      : redirect(`/app/bills/${row.id}?notice=${notice}`);
  }
  if (result.error === 'NOT_FOUND') throw notFound();
  return data<BillDetailActionData>(
    {
      error: billErrorMessage(result, intent === 'post' ? 'posted' : 'updated'),
      paymentErrors: null,
    },
    { status: 409 },
  );
};

export default function BillDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { bill: b, notice, can: allowed, postBlockedBy } = loaderData;
  const error = actionData?.error ?? null;
  const paymentErrors = actionData?.paymentErrors ?? {};
  const field = (name: string, label: string, input: ReactNode) => (
    <div className={`field${paymentErrors[name] ? ' has-error' : ''}`}>
      <label htmlFor={`payment-${name}`}>{label}</label>
      {paymentErrors[name] ? (
        <span className="field-error" id={`payment-${name}-error`}>
          {paymentErrors[name]}
        </span>
      ) : null}
      {input}
    </div>
  );
  const inputProps = (name: string) => ({
    id: `payment-${name}`,
    name,
    'aria-invalid': Boolean(paymentErrors[name]),
    'aria-describedby': paymentErrors[name] ? `payment-${name}-error` : undefined,
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {b.referenceNumber} <BillStatusBadge status={b.status} />
            {b.isCreditNote ? <span className="status-pill quote-muted">Credit note</span> : null}
          </h1>
          <p className="muted">
            {b.supplier ? <Link to={`/app/suppliers/${b.supplier.id}`}>{b.vendor}</Link> : b.vendor}{' '}
            · {VENDOR_TYPE_LABELS[b.vendorType]} · {BILL_TYPE_LABELS[b.billType]} · issued{' '}
            {b.issuedOn}
            {b.dueOn ? ` · due ${b.dueOn}` : ''}
          </p>
        </div>
        <Link to="/app/bills" className="button ghost small">
          All bills
        </Link>
      </div>

      {notice ? (
        <div className="banner ready" role="status">
          <p>{notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="banner error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="quote-actions" aria-label="Bill actions">
        {allowed.edit ? (
          <Link to={`/app/bills/${b.id}/edit`} className="button">
            Edit draft
          </Link>
        ) : null}
        {allowed.post && postBlockedBy === null ? (
          <Form method="post" className="inline-form">
            <CsrfInput />
            <button type="submit" name="intent" value="post" className="button lime">
              Post bill
            </button>
          </Form>
        ) : null}
        {allowed.post && postBlockedBy ? <p className="hint">{postBlockedBy}</p> : null}
        {allowed.delete ? (
          <Form method="post" className="inline-form">
            <CsrfInput />
            <button type="submit" name="intent" value="delete" className="button danger">
              Delete draft
            </button>
          </Form>
        ) : null}
      </div>

      <div className="order-grid">
        <section className="card" aria-labelledby="amounts-title">
          <h2 id="amounts-title">Amounts</h2>
          <dl className="meta">
            <dt>Bill total</dt>
            <dd>{money(b.totalAmount, b.currency)}</dd>
            <dt>Paid</dt>
            <dd>
              {b.status === 'DRAFT' ? 'Not posted yet' : money(b.paidAmount, b.currency)}
              {b.status !== 'DRAFT' && b.currency !== 'GBP'
                ? ` · ${gbp(b.paidGbp)} at the rates paid`
                : ''}
            </dd>
            <dt>Outstanding</dt>
            <dd>{b.status === 'DRAFT' ? '—' : money(b.outstandingAmount, b.currency)}</dd>
            <dt>Posted</dt>
            <dd>{b.postedAt ? isoDateTime(b.postedAt) : 'Draft'}</dd>
            {b.paidAt ? (
              <>
                <dt>Paid in full</dt>
                <dd>{isoDateTime(b.paidAt)}</dd>
              </>
            ) : null}
          </dl>
        </section>
        <section className="card" aria-labelledby="orders-title">
          <h2 id="orders-title">Purchase orders</h2>
          {b.orders.length === 0 ? (
            <p className="muted">No lines yet.</p>
          ) : (
            <ul className="card-list">
              {b.orders.map((o) => (
                <li key={o.id}>
                  <Link to={`/app/orders/${o.id}`} className="code">
                    {o.poNumber}
                  </Link>{' '}
                  · <Link to={`/app/orders/${o.id}/costs`}>Costs and variance</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="lines-title">
        <h2 id="lines-title">Lines</h2>
        {b.lines.length === 0 ? (
          <p className="muted">No lines on this bill yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Bill lines">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Product</th>
                  <th scope="col">Category</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="num">
                    Amount ({b.currency})
                  </th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Order">
                      <Link to={`/app/orders/${l.purchaseOrder.id}`} className="code">
                        {l.purchaseOrder.poNumber}
                      </Link>
                    </td>
                    <td data-label="Product">
                      {l.item ? (
                        <>
                          <span className="code">{l.item.sku}</span> {l.item.name}
                        </>
                      ) : (
                        <span className="muted">Shared across the order</span>
                      )}
                    </td>
                    <td data-label="Category">
                      {COST_CATEGORY_LABELS[l.costCategory]}
                      {l.unplannedReason ? (
                        <span className="muted small">
                          {' '}
                          · {UNPLANNED_REASON_LABELS[l.unplannedReason]}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Description">{l.description}</td>
                    <td data-label="Amount" className="num">
                      {money(l.amount, b.currency)}
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <th scope="row" colSpan={4}>
                    Lines total
                  </th>
                  <td className="num">{money(b.linesTotal, b.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="payments-title">
        <h2 id="payments-title">Payments</h2>
        {b.status === 'DRAFT' ? (
          <p className="muted small">
            Post the bill first; payments are recorded against posted bills.
          </p>
        ) : null}
        {b.payments.length === 0 && b.status !== 'DRAFT' ? (
          <p className="muted">No payments recorded yet.</p>
        ) : null}
        {b.payments.length > 0 ? (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Payments">
              <thead>
                <tr>
                  <th scope="col">Paid on</th>
                  <th scope="col" className="num">
                    Amount ({b.currency})
                  </th>
                  <th scope="col" className="num">
                    Rate (GBP per {b.currency})
                  </th>
                  <th scope="col" className="num">
                    GBP
                  </th>
                  <th scope="col">Reference</th>
                  {allowed.removePayment ? <th scope="col" /> : null}
                </tr>
              </thead>
              <tbody>
                {b.payments.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Paid on">{p.paidOn}</td>
                    <td data-label="Amount" className="num">
                      {money(p.amount, b.currency)}
                    </td>
                    <td data-label="Rate" className="num">
                      {p.fxRate}
                    </td>
                    <td data-label="GBP" className="num">
                      {gbp(p.amountGbp)}
                    </td>
                    <td data-label="Reference">
                      {p.reference ?? <span className="muted">—</span>}
                    </td>
                    {allowed.removePayment ? (
                      <td>
                        <Form method="post" className="inline-form">
                          <CsrfInput />
                          <input type="hidden" name="paymentId" value={p.id} />
                          <button
                            type="submit"
                            name="intent"
                            value="remove-payment"
                            className="button ghost small"
                          >
                            Remove
                          </button>
                        </Form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {allowed.recordPayment ? (
          <Form method="post" className="payment-form">
            <CsrfInput />
            <div className="inline-fields">
              {field(
                'paidOn',
                'Paid on',
                <input {...inputProps('paidOn')} type="date" className="narrow" />,
              )}
              {field(
                'amount',
                `Amount (${b.currency})`,
                <input
                  {...inputProps('amount')}
                  type="text"
                  inputMode="decimal"
                  className="narrow"
                  placeholder={b.outstandingAmount}
                />,
              )}
              {b.currency !== 'GBP'
                ? field(
                    'fxRate',
                    `Rate the bank applied (GBP per 1 ${b.currency})`,
                    <input
                      {...inputProps('fxRate')}
                      type="text"
                      inputMode="decimal"
                      className="narrow"
                      placeholder="0.780000"
                    />,
                  )
                : null}
              {field(
                'reference',
                'Bank reference (optional)',
                <input {...inputProps('reference')} type="text" maxLength={120} />,
              )}
            </div>
            <p className="hint">
              The GBP amount is computed from the rate the bank actually applied, so the ledger
              reconciles with the statement (ADR-0014).
            </p>
            <button type="submit" name="intent" value="record-payment" className="button secondary">
              Record payment
            </button>
          </Form>
        ) : null}
      </section>

      {b.notes ? (
        <section className="card" aria-labelledby="notes-title">
          <h2 id="notes-title">Notes</h2>
          <p className="notes">{b.notes}</p>
        </section>
      ) : null}
      <p className="hint">Updated {isoDateTime(b.updatedAt)}.</p>
    </>
  );
}
