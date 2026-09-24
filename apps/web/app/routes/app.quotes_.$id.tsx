import { can } from '@harbour/db';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.quotes_.$id';
import { CsrfInput } from '../components/csrf';
import { isoDateTime } from '../components/format';
import { QuoteBreakdown } from '../components/quotes/quote-breakdown';
import { QuoteStatusBadge } from '../components/quotes/status-badge';
import { modeName, portName } from '../data/ports';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { pageError } from '../services/page-error';
import { QUOTE_LIMIT } from '../services/quotes/builder.server';
import {
  QUOTE_IMMUTABLE_MESSAGE,
  acceptQuote,
  cancelQuote,
  getQuote,
  quoteRowToView,
  reopenQuote,
} from '../services/quotes/quotes.server';
import { recomputeQuote } from '../services/quotes/recompute.server';
import { quoteReference } from '../services/quotes/view';
import { readForm } from '../services/request.server';
import { REQUIRED_QUOTE_DOCUMENT_TYPES } from '../validators/documents';
import { quoteAction, quoteIdParam, quoteNotice } from '../validators/quote';
import { DOCUMENT_TYPE_LABELS } from '../components/document-labels';

/**
 * Quote detail (M4): the full breakdown, warnings and snapshot sources, plus the actions:
 *   finalise / update / edit (DRAFT, `quote.edit`), reopen (INDICATIVE/READY, `quote.edit`),
 *   accept (READY only, `quote.accept`), cancel (`quote.edit`; an ACCEPTED quote needs
 *   `quote.accept`). Accepted quotes list the documents still missing (M5, §6.1).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Quote — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  saved: 'Draft saved.',
  accepted: 'Quote accepted. It is now a fixed snapshot: it can be cancelled but not changed.',
  cancelled: 'Quote cancelled.',
  reopened: 'Reopened as a draft. Edit it, then finalise again.',
  finalised: 'Quote finalised with current catalogue, exchange and freight values.',
  recomputed: 'Draft updated to current catalogue, exchange and freight values.',
  'not-found': '',
} as const;

const notFound = () =>
  pageError(404, 'Quote not found', 'This quote does not exist in your organisation.');

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.view' });
  const id = quoteIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const url = new URL(request.url);
  const notice = quoteNotice.parse(url.searchParams.get('notice') ?? undefined);
  const result = await withOrg(ctx, async (tx) => {
    const row = await getQuote(tx, id.data);
    if (!row) return null;
    const documents =
      row.status === 'ACCEPTED'
        ? await tx.document.findMany({
            where: { quoteId: row.id, deletedAt: null },
            select: { type: true, status: true },
          })
        : [];
    return { row, documents };
  });
  if (!result) throw notFound();
  const { row, documents } = result;
  const missing = REQUIRED_QUOTE_DOCUMENT_TYPES.filter(
    (type) => !documents.some((d) => d.type === type && d.status !== 'REJECTED'),
  );
  const edit = can(ctx.role, 'quote.edit');
  const accept = can(ctx.role, 'quote.accept');
  return {
    id: row.id,
    reference: quoteReference(row.id),
    status: row.status,
    lane: `${row.originPort ? portName(row.originPort) : row.originCountry} → ${
      row.destinationPort ? portName(row.destinationPort) : 'UK'
    } · ${modeName(row.mode)}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    view: quoteRowToView(row),
    hasBuilderInput: row.builderInput !== null,
    missing: missing.map((type) => ({ type, label: DOCUMENT_TYPE_LABELS[type] })),
    documentCount: documents.length,
    canEdit: edit,
    can: {
      edit: edit && row.status === 'DRAFT',
      finalise: edit && row.status === 'DRAFT' && row.builderInput !== null,
      recompute: edit && row.status === 'DRAFT' && row.builderInput !== null,
      reopen: edit && (row.status === 'INDICATIVE' || row.status === 'READY'),
      accept: accept && row.status === 'READY',
      cancel:
        row.status === 'ACCEPTED'
          ? accept
          : edit && row.status !== 'CANCELLED' && row.status !== 'EXPIRED',
    },
    notice: notice ? NOTICE_TEXT[notice] || null : null,
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.view' });
  const id = quoteIdParam.safeParse(params.id);
  if (!id.success) throw notFound();
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const parsed = quoteAction.safeParse(form?.get('intent'));
  if (!parsed.success) return data({ error: 'Unknown action.' }, { status: 400 });
  const intent = parsed.data;
  const app = await getApp();
  const log = requestLogger(app.logger, request);

  const limit = await app.rateLimiter.consume(ctx.user.id, QUOTE_LIMIT);
  if (!limit.allowed) {
    return data(
      { error: `Too many quote requests. Try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const row = await withOrg(ctx, (tx) => getQuote(tx, id.data));
  if (!row) throw notFound();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const forbid = () =>
    pageError(
      403,
      'You do not have access to this',
      'Your role in this organisation does not allow it. Ask an owner or admin if you need access.',
    );

  let result: Awaited<ReturnType<typeof recomputeQuote>>;
  let notice: string;
  switch (intent) {
    case 'accept': {
      if (!can(ctx.role, 'quote.accept')) throw forbid();
      result = await withOrg(ctx, (tx) => acceptQuote(tx, actor, row.id, new Date()));
      notice = 'accepted';
      break;
    }
    case 'cancel': {
      const needed = row.status === 'ACCEPTED' ? 'quote.accept' : 'quote.edit';
      if (!can(ctx.role, needed)) throw forbid();
      result = await withOrg(ctx, (tx) => cancelQuote(tx, actor, row.id));
      notice = 'cancelled';
      break;
    }
    case 'reopen': {
      if (!can(ctx.role, 'quote.edit')) throw forbid();
      result = await withOrg(ctx, (tx) => reopenQuote(tx, actor, row.id));
      notice = 'reopened';
      break;
    }
    case 'finalise':
    case 'recompute': {
      if (!can(ctx.role, 'quote.edit')) throw forbid();
      result = await recomputeQuote(ctx, row, intent === 'finalise' ? 'finalise' : 'draft');
      notice = intent === 'finalise' ? 'finalised' : 'recomputed';
      break;
    }
  }
  log.info(`quote.${intent}`, {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    quoteId: row.id,
    from: row.status,
    ok: result.ok,
    to: result.ok ? result.status : null,
    error: result.ok ? null : result.error,
  });
  if (result.ok) return redirect(`/app/quotes/${row.id}?notice=${notice}`);
  if (result.error === 'NOT_FOUND') throw notFound();
  const message =
    result.error === 'IMMUTABLE'
      ? QUOTE_IMMUTABLE_MESSAGE
      : result.error === 'WRONG_STATUS'
        ? `This quote is ${result.status?.toLowerCase() ?? 'in a state that'} and cannot be ${intent === 'accept' ? 'accepted: only READY quotes can be' : intent + 'd'}.`
        : 'message' in result
          ? result.message
          : 'The quote could not be updated.';
  return data({ error: message }, { status: 409 });
};

export default function QuoteDetail({ loaderData, actionData }: Route.ComponentProps) {
  const d = loaderData;
  const error = actionData?.error ?? null;
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
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {d.reference} <QuoteStatusBadge status={d.status} />
          </h1>
          <p className="muted">
            {d.lane} · {d.view.quote.incoterm} · created {isoDateTime(d.createdAt)} · updated{' '}
            {isoDateTime(d.updatedAt)}
            {d.acceptedAt ? ` · accepted ${isoDateTime(d.acceptedAt)}` : ''}
          </p>
        </div>
        <Link to="/app/quotes" className="button ghost small">
          All quotes
        </Link>
      </div>

      {d.notice ? (
        <div className="banner ready" role="status">
          <p>{d.notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="banner error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="quote-actions" aria-label="Quote actions">
        {d.can.edit ? (
          <Link to={`/app/quotes/${d.id}/edit`} className="button">
            Edit draft
          </Link>
        ) : null}
        {d.can.recompute ? (
          <ActionButton intent="recompute" label="Update to current catalogue values" />
        ) : null}
        {d.can.finalise ? (
          <ActionButton intent="finalise" label="Finalise quote" className="button lime" />
        ) : null}
        {d.can.reopen ? <ActionButton intent="reopen" label="Reopen as draft" /> : null}
        {d.can.accept ? (
          <ActionButton intent="accept" label="Accept quote" className="button lime" />
        ) : null}
        {d.status === 'INDICATIVE' ? (
          <p className="hint">
            Indicative quotes cannot be accepted: resolve the blocking warnings, reopen and finalise
            again.
          </p>
        ) : null}
        {d.status === 'DRAFT' && !d.hasBuilderInput ? (
          <p className="hint">This draft has no stored builder inputs, so it cannot be edited.</p>
        ) : null}
        {d.can.cancel ? (
          <ActionButton intent="cancel" label="Cancel quote" className="button danger" />
        ) : null}
        <Link to={`/app/documents/new?quoteId=${d.id}`} className="button ghost">
          Documents
        </Link>
      </div>

      {d.status === 'ACCEPTED' ? (
        <section className="card missing-files" aria-labelledby="missing-title">
          <h2 id="missing-title">Documents</h2>
          {d.missing.length === 0 ? (
            <p className="muted">
              Commercial invoice and packing list are on file ({d.documentCount} document
              {d.documentCount === 1 ? '' : 's'}).
            </p>
          ) : (
            <ul>
              {d.missing.map((m) => (
                <li key={m.type}>
                  Awaiting {m.label.toLowerCase()} —{' '}
                  <Link to={`/app/documents/new?quoteId=${d.id}&type=${m.type}`}>upload</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <QuoteBreakdown view={d.view} heading="Landed cost" />
    </>
  );
}
