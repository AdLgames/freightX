import { can } from '@harbour/db';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.orders_.$id';
import { CsrfInput } from '../components/csrf';
import { gbp, isoDateTime, pct } from '../components/format';
import { OrderStatusBadge, isoDate, money } from '../components/orders/status-badge';
import { QuoteStatusBadge } from '../components/quotes/status-badge';
import { portName } from '../data/ports';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import {
  cancelOrder,
  getOrder,
  issueOrder,
  moveOrder,
  orderErrorMessage,
  orderRowToView,
  recordPayment,
  type OrderWriteResult,
} from '../services/orders/orders.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { fieldErrors } from '../validators/common';
import {
  ACTION_TARGET,
  ORDER_STATUS_LABELS,
  canTransition,
  orderAction,
  orderIdParam,
  orderNotice,
  paymentFormSchema,
  type OrderStatusValue,
} from '../validators/order';
import { INCOTERM_LABELS, type QuoteStatusValue } from '../validators/quote';
import { BALANCE_TRIGGER_LABELS, PAYMENT_TERM_LABELS } from '../validators/supplier';

/**
 * Purchase order detail (M7, ADR-0013): header with status and the next steps from the
 * transition table, the lines, the payment schedule (deposit / balance with "record paid" forms
 * taking a date), the linked quotes with "Get freight quote", and notes.
 *
 * Permissions: view `order.view`; edit / status moves / payment dates / cancel `order.edit`;
 * issue (freezes the money) `order.issue`. Cancelling an issued order also needs `order.issue`.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Purchase order — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  created:
    'Draft created. Check the lines, then issue the order to fix the totals and the payment schedule.',
  saved: 'Draft saved.',
  issued:
    'Purchase order issued. Its lines and totals are now fixed; the deposit and balance below come from the supplier’s payment terms.',
  status: 'Status updated.',
  cancelled: 'Purchase order cancelled.',
  'deposit-paid': 'Deposit recorded as paid.',
  'balance-paid': 'Balance recorded as paid.',
  'not-found': '',
} as const;

const notFound = () =>
  pageError(
    404,
    'Purchase order not found',
    'This purchase order does not exist in your organisation.',
  );

const NEXT_STEP: Array<{
  to: OrderStatusValue;
  intent: 'in-production' | 'ready-to-ship' | 'shipped' | 'close';
  label: string;
}> = [
  { to: 'IN_PRODUCTION', intent: 'in-production', label: 'Mark in production' },
  { to: 'READY_TO_SHIP', intent: 'ready-to-ship', label: 'Mark ready to ship' },
  { to: 'SHIPPED', intent: 'shipped', label: 'Mark shipped' },
  { to: 'CLOSED', intent: 'close', label: 'Close order' },
];

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.view' });
  const id = orderIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const url = new URL(request.url);
  const notice = orderNotice.parse(url.searchParams.get('notice') ?? undefined);
  const row = await withOrg(ctx, (tx) => getOrder(tx, id.data));
  if (!row) throw notFound();
  const view = orderRowToView(row);
  const edit = can(ctx.role, 'order.edit');
  const issue = can(ctx.role, 'order.issue');
  const quoteEdit = can(ctx.role, 'quote.edit');
  const open = !['DRAFT', 'CLOSED', 'CANCELLED'].includes(view.status);
  return {
    order: view,
    notice: notice ? NOTICE_TEXT[notice] || null : null,
    can: {
      edit: edit && view.status === 'DRAFT',
      issue: issue && view.status === 'DRAFT',
      steps: edit ? NEXT_STEP.filter((s) => canTransition(view.status, s.to)) : [],
      cancel: canTransition(view.status, 'CANCELLED') && (view.status === 'DRAFT' ? edit : issue),
      recordPayment: edit && open,
      getQuote: quoteEdit && view.status !== 'CANCELLED' && view.status !== 'CLOSED',
    },
    issueBlockedBy:
      view.status !== 'DRAFT'
        ? null
        : view.items.length === 0
          ? 'Add at least one product before issuing.'
          : view.paymentTerms === null
            ? 'Add payment terms to the supplier before issuing; the deposit and balance are computed from them.'
            : null,
  };
};

export interface OrderDetailActionData {
  error: string | null;
  /** Which payment form the field error belongs to. */
  paymentErrors: { kind: 'DEPOSIT' | 'BALANCE'; errors: Record<string, string> } | null;
}

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.view' });
  const id = orderIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const parsed = orderAction.safeParse(form?.get('intent'));
  if (!parsed.success) {
    return data<OrderDetailActionData>(
      { error: 'Unknown action.', paymentErrors: null },
      { status: 400 },
    );
  }
  const intent = parsed.data;
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const row = await withOrg(ctx, (tx) => getOrder(tx, id.data));
  if (!row) throw notFound();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const forbid = () =>
    pageError(
      403,
      'You do not have access to this',
      'Your role in this organisation does not allow it. Ask an owner or admin if you need access.',
    );
  const now = new Date();

  let result: OrderWriteResult;
  let notice: string;
  switch (intent) {
    case 'issue': {
      if (!can(ctx.role, 'order.issue')) throw forbid();
      result = await withOrg(ctx, (tx) => issueOrder(tx, actor, row.id, now));
      notice = 'issued';
      break;
    }
    case 'in-production':
    case 'ready-to-ship':
    case 'shipped':
    case 'close': {
      if (!can(ctx.role, 'order.edit')) throw forbid();
      const to = ACTION_TARGET[intent];
      result = await withOrg(ctx, (tx) => moveOrder(tx, actor, row.id, to, now));
      notice = 'status';
      break;
    }
    case 'cancel': {
      if (!can(ctx.role, row.status === 'DRAFT' ? 'order.edit' : 'order.issue')) throw forbid();
      result = await withOrg(ctx, (tx) => cancelOrder(tx, actor, row.id));
      notice = 'cancelled';
      break;
    }
    case 'deposit-paid':
    case 'balance-paid': {
      if (!can(ctx.role, 'order.edit')) throw forbid();
      const kind = intent === 'deposit-paid' ? 'DEPOSIT' : 'BALANCE';
      const payment = paymentFormSchema.safeParse({ paidAt: form?.get('paidAt') ?? '' });
      if (!payment.success) {
        return data<OrderDetailActionData>(
          {
            error: 'Enter the date the payment was made.',
            paymentErrors: { kind, errors: fieldErrors(payment.error.issues) },
          },
          { status: 400 },
        );
      }
      const paidAt = new Date(`${payment.data.paidAt}T00:00:00Z`);
      result = await withOrg(ctx, (tx) => recordPayment(tx, actor, row.id, kind, paidAt));
      notice = intent;
      break;
    }
  }
  log.info(`order.${intent}`, {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    orderId: row.id,
    from: row.status,
    ok: result.ok,
    to: result.ok ? result.status : null,
    error: result.ok ? null : result.error,
  });
  if (result.ok) return redirect(`/app/orders/${row.id}?notice=${notice}`);
  if (result.error === 'NOT_FOUND') throw notFound();
  return data<OrderDetailActionData>(
    {
      error: orderErrorMessage(result, intent === 'issue' ? 'issued' : 'updated'),
      paymentErrors: null,
    },
    { status: 409 },
  );
};

export default function OrderDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { order: o, notice, can: allowed, issueBlockedBy } = loaderData;
  const error = actionData?.error ?? null;
  const paymentErrors = actionData?.paymentErrors ?? null;
  const ActionButton = ({
    intent,
    label,
    className = 'button secondary',
  }: {
    intent: string;
    label: string;
    className?: string;
  }) => (
    <Form method="post" className="inline-form">
      <CsrfInput />
      <button type="submit" name="intent" value={intent} className={className}>
        {label}
      </button>
    </Form>
  );
  const PaymentRow = ({
    kind,
    label,
    amount,
    dueAt,
    paidAt,
    note,
  }: {
    kind: 'DEPOSIT' | 'BALANCE';
    label: string;
    amount: string | null;
    dueAt: string | null;
    paidAt: string | null;
    note: string | null;
  }) => {
    const errs = paymentErrors?.kind === kind ? paymentErrors.errors : {};
    const inputId = `${kind.toLowerCase()}-paidAt`;
    const due = amount !== null && amount !== '0.00';
    return (
      <div className="payment-row">
        <div>
          <p className="stat-label">{label}</p>
          <p className="amount">{amount === null ? '—' : money(amount, o.currency)}</p>
          <p className="muted small">
            {amount === null
              ? 'Set when the order is issued.'
              : !due
                ? 'Nothing due.'
                : paidAt
                  ? `Paid ${isoDate(paidAt)}`
                  : dueAt
                    ? `Due ${isoDate(dueAt)}`
                    : (note ?? 'Due date not yet known.')}
          </p>
        </div>
        <div>
          {due && paidAt ? (
            <span className="paid-mark">Paid</span>
          ) : due && allowed.recordPayment ? (
            <Form method="post">
              <CsrfInput />
              <div className={`field${errs.paidAt ? ' has-error' : ''}`}>
                <label htmlFor={inputId}>Date paid</label>
                {errs.paidAt ? (
                  <span className="field-error" id={`${inputId}-error`}>
                    {errs.paidAt}
                  </span>
                ) : null}
                <input
                  id={inputId}
                  type="date"
                  name="paidAt"
                  className="narrow"
                  aria-invalid={Boolean(errs.paidAt)}
                  aria-describedby={errs.paidAt ? `${inputId}-error` : undefined}
                />
              </div>
              <button
                type="submit"
                name="intent"
                value={kind === 'DEPOSIT' ? 'deposit-paid' : 'balance-paid'}
                className="button secondary small"
              >
                Record {kind === 'DEPOSIT' ? 'deposit' : 'balance'} paid
              </button>
            </Form>
          ) : due ? (
            <span className="due-mark">Due</span>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {o.poNumber} <OrderStatusBadge status={o.status} />
          </h1>
          <p className="muted">
            <Link to={`/app/suppliers/${o.supplier.id}`}>{o.supplier.name}</Link> · {o.incoterm} ·{' '}
            {o.currency} · created {isoDateTime(o.createdAt)}
            {o.issuedAt ? ` · issued ${isoDateTime(o.issuedAt)}` : ''}
          </p>
        </div>
        <Link to="/app/orders" className="button ghost small">
          All orders
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

      <div className="quote-actions" aria-label="Order actions">
        {allowed.edit ? (
          <Link to={`/app/orders/${o.id}/edit`} className="button">
            Edit draft
          </Link>
        ) : null}
        {allowed.issue && issueBlockedBy === null ? (
          <ActionButton intent="issue" label="Issue order" className="button lime" />
        ) : null}
        {allowed.issue && issueBlockedBy ? <p className="hint">{issueBlockedBy}</p> : null}
        {allowed.steps.map((s) => (
          <ActionButton key={s.intent} intent={s.intent} label={s.label} />
        ))}
        {allowed.getQuote ? (
          <Link to={`/app/quotes/new?po=${o.id}`} className="button">
            Get freight quote
          </Link>
        ) : null}
        {allowed.cancel ? (
          <ActionButton intent="cancel" label="Cancel order" className="button danger" />
        ) : null}
      </div>

      <div className="order-grid">
        <section className="card" aria-labelledby="terms-title">
          <h2 id="terms-title">Terms</h2>
          <dl className="meta">
            <dt>Incoterm</dt>
            <dd>{INCOTERM_LABELS[o.incoterm as keyof typeof INCOTERM_LABELS] ?? o.incoterm}</dd>
            <dt>Pickup location</dt>
            <dd>
              {o.pickupLocation
                ? `${o.pickupLocation.name} · ${portName(o.pickupLocation.port)} (${o.pickupLocation.port})`
                : 'None chosen'}
            </dd>
            <dt>Expected ship month</dt>
            <dd>{o.expectedShipMonth ?? 'Not set'}</dd>
            <dt>Supplier payment terms</dt>
            <dd>
              {o.paymentTerms
                ? `${PAYMENT_TERM_LABELS[o.paymentTerms.termType as keyof typeof PAYMENT_TERM_LABELS] ?? o.paymentTerms.termType}${
                    o.paymentTerms.depositPct ? ` · ${pct(o.paymentTerms.depositPct)} deposit` : ''
                  }${
                    o.paymentTerms.balanceTrigger
                      ? ` · balance ${(BALANCE_TRIGGER_LABELS[o.paymentTerms.balanceTrigger as keyof typeof BALANCE_TRIGGER_LABELS] ?? o.paymentTerms.balanceTrigger).toLowerCase()}`
                      : ''
                  }${o.paymentTerms.netDays !== null ? ` · net ${o.paymentTerms.netDays} days` : ''}`
                : 'None on the supplier'}
            </dd>
          </dl>
        </section>

        <section className="card payment-schedule" aria-labelledby="schedule-title">
          <h2 id="schedule-title">Payment schedule</h2>
          {o.status === 'DRAFT' ? (
            <p className="muted small">
              Computed from the supplier’s payment terms when the order is issued and fixed with it.
              Until the payments partner is connected you record each payment here.
            </p>
          ) : null}
          <PaymentRow
            kind="DEPOSIT"
            label={`Deposit${o.depositPct ? ` (${pct(o.depositPct)})` : ''}`}
            amount={o.depositAmount}
            dueAt={o.depositDueAt}
            paidAt={o.depositPaidAt}
            note={null}
          />
          <PaymentRow
            kind="BALANCE"
            label="Balance"
            amount={o.balanceAmount}
            dueAt={o.balanceDueAt}
            paidAt={o.balancePaidAt}
            note={
              o.balanceTrigger
                ? `Due ${(BALANCE_TRIGGER_LABELS[o.balanceTrigger as keyof typeof BALANCE_TRIGGER_LABELS] ?? o.balanceTrigger).toLowerCase()}.`
                : null
            }
          />
        </section>
      </div>

      <section className="card" aria-labelledby="lines-title">
        <h2 id="lines-title">Lines</h2>
        {o.items.length === 0 ? (
          <p className="muted">No products on this order yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Order lines">
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Product</th>
                  <th scope="col" className="num">
                    Quantity
                  </th>
                  <th scope="col" className="num">
                    Unit cost ({o.currency})
                  </th>
                  <th scope="col" className="num">
                    Line total ({o.currency})
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <td data-label="SKU">
                      <Link to={`/app/products/${i.productId}`} className="code">
                        {i.sku}
                      </Link>
                    </td>
                    <td data-label="Product">
                      {i.name}
                      {i.productArchived ? <span className="muted small"> · archived</span> : null}
                    </td>
                    <td data-label="Quantity" className="num">
                      {i.quantity.toLocaleString('en-GB')}
                    </td>
                    <td data-label="Unit cost" className="num">
                      {i.unitCost}
                    </td>
                    <td data-label="Line total" className="num">
                      {money(i.lineTotal, o.currency)}
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <th scope="row" colSpan={4}>
                    Goods total
                  </th>
                  <td className="num">{money(o.totalGoodsValue, o.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="quotes-title">
        <h2 id="quotes-title">Freight quotes</h2>
        {o.quotes.length === 0 ? (
          <p className="muted">
            No quotes yet.{' '}
            {allowed.getQuote
              ? 'Get a freight quote to price duty, VAT and freight for these lines.'
              : ''}
          </p>
        ) : (
          <ul className="card-list">
            {o.quotes.map((q) => (
              <li key={q.id}>
                <Link to={`/app/quotes/${q.id}`} className="code">
                  {q.reference}
                </Link>{' '}
                <QuoteStatusBadge status={q.status as QuoteStatusValue} /> ·{' '}
                {gbp(q.totalLandedCostExVat)} ex VAT · valid until {isoDate(q.validUntil)}
                {o.acceptedQuote?.id === q.id ? (
                  <span className="paid-mark"> · the accepted quote</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {o.acceptedQuote === null && allowed.getQuote && o.quotes.length > 0 ? (
          <p className="hint">
            Several quotes may price one order; at most one can be accepted.{' '}
            <Link to={`/app/quotes/new?po=${o.id}`}>Get another freight quote</Link>.
          </p>
        ) : null}
      </section>

      {o.notes ? (
        <section className="card" aria-labelledby="notes-title">
          <h2 id="notes-title">Notes</h2>
          <p className="notes">{o.notes}</p>
        </section>
      ) : null}
      <p className="hint">
        Status {ORDER_STATUS_LABELS[o.status].toLowerCase()} · updated {isoDateTime(o.updatedAt)}.
      </p>
    </>
  );
}
