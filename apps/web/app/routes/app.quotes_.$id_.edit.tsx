import { redirect, type ShouldRevalidateFunction } from 'react-router';
import type { Route } from './+types/app.quotes_.$id_.edit';
import { QuoteBuilder } from '../components/quotes/quote-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { pageError } from '../services/page-error';
import {
  applyIntent,
  builderReply,
  computeFromValues,
  loadBuilderOptions,
  quoteRateLimit,
} from '../services/quotes/builder.server';
import {
  QUOTE_IMMUTABLE_MESSAGE,
  builderInputOf,
  getQuote,
  replaceQuote,
} from '../services/quotes/quotes.server';
import { quoteReference } from '../services/quotes/view';
import { readForm } from '../services/request.server';
import { builderInputToValues, quoteIdParam, toBuilderInput } from '../validators/quote';

/**
 * Edit a DRAFT quote in the builder (M4). Any other status redirects to the detail page: an
 * INDICATIVE/READY quote must be reopened first, an ACCEPTED one is immutable (the database
 * trigger is the backstop, rendered as a friendly message if anything slips through).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Edit quote — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const shouldRevalidate: ShouldRevalidateFunction = ({ formAction }) =>
  !(formAction ?? '').includes('preview=1');

const notFound = () =>
  pageError(404, 'Quote not found', 'This quote does not exist in your organisation.');

const loadDraft = async (request: Request, rawId: string | undefined) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
  const id = quoteIdParam.safeParse(rawId);
  if (!id.success) throw notFound();
  const row = await withOrg(ctx, (tx) => getQuote(tx, id.data));
  if (!row) throw notFound();
  if (row.status !== 'DRAFT') throw redirect(`/app/quotes/${row.id}`);
  const builderInput = builderInputOf(row);
  if (!builderInput) throw redirect(`/app/quotes/${row.id}`);
  return { ctx, row, builderInput };
};

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { ctx, row, builderInput } = await loadDraft(request, params.id);
  const { options } = await loadBuilderOptions(
    ctx,
    builderInput.lines.map((l) => l.productId),
  );
  return {
    id: row.id,
    reference: quoteReference(row.id),
    options,
    values: builderInputToValues(builderInput),
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { ctx, row, builderInput } = await loadDraft(request, params.id);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const url = new URL(request.url);
  const { options, products } = await loadBuilderOptions(
    ctx,
    builderInput.lines.map((l) => l.productId),
  );
  const { intent, values, errors } = applyIntent(form, url, options);

  const limited = await quoteRateLimit(ctx, request, values);
  if (limited) return limited;

  if (intent === 'add-line' && Object.keys(errors).length > 0) {
    return builderReply({ values, errors }, 400);
  }
  const computed = await computeFromValues(ctx, values, products, options.lanes);
  if (!computed.ok) {
    const quiet = intent === 'add-line' || intent === 'remove-line' || intent === 'apply-supplier';
    return builderReply(
      quiet ? { values } : { values, errors: computed.errors, formError: computed.formError },
      quiet ? 200 : 400,
    );
  }
  const view = computed.outcome.view;
  if (intent !== 'save') return builderReply({ values, view });

  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const result = await withOrg(ctx, (tx) =>
    replaceQuote(
      tx,
      actor,
      row.id,
      { view, builderInput: toBuilderInput(computed.input), status: 'DRAFT' },
      { from: ['DRAFT'] },
    ),
  );
  if (!result.ok) {
    if (result.error === 'NOT_FOUND') throw notFound();
    return builderReply(
      {
        values,
        view,
        formError:
          result.error === 'IMMUTABLE'
            ? QUOTE_IMMUTABLE_MESSAGE
            : 'This quote is no longer a draft, so it cannot be edited here.',
      },
      409,
    );
  }
  const app = await getApp();
  requestLogger(app.logger, request).info('quote.saved', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    quoteId: row.id,
    status: result.status,
    computedStatus: view.quote.status,
    lines: view.quote.lines.length,
    warningCodes: view.quote.warnings.map((w) => w.code),
  });
  return redirect(`/app/quotes/${row.id}?notice=saved`);
};

export default function EditQuote({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <QuoteBuilder
      action={`/app/quotes/${loaderData.id}/edit`}
      options={loaderData.options}
      values={actionData?.values ?? loaderData.values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      serverView={actionData?.view ?? null}
      planNotice={actionData?.planNotice ?? null}
      title="Edit quote"
      reference={loaderData.reference}
    />
  );
}
