import { redirect, type ShouldRevalidateFunction } from 'react-router';
import type { Route } from './+types/app.quotes_.new';
import { QuoteBuilder } from '../components/quotes/quote-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import {
  applyIntent,
  builderReply,
  computeFromValues,
  defaultValues,
  loadBuilderOptions,
  quoteRateLimit,
  savedQuotePlanNotice,
} from '../services/quotes/builder.server';
import { saveQuote } from '../services/quotes/quotes.server';
import { readForm } from '../services/request.server';
import { UUID_PATTERN, toBuilderInput } from '../validators/quote';

/** New quote (M4). Needs `quote.edit`. `?supplier=<id>` pre-selects a supplier's defaults. */

export const meta: Route.MetaFunction = () => [{ title: 'New quote — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

/** Live previews (`?preview=1`) must not re-run the loader after every keystroke. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formAction }) =>
  !(formAction ?? '').includes('preview=1');

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
  const url = new URL(request.url);
  const { options } = await loadBuilderOptions(ctx);
  const supplier = url.searchParams.get('supplier');
  const values = defaultValues(options, supplier && UUID_PATTERN.test(supplier) ? supplier : null);
  const planNotice = await savedQuotePlanNotice(ctx);
  return { options, values, planNotice };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const url = new URL(request.url);
  const { options, products } = await loadBuilderOptions(ctx);
  const { intent, values, errors } = applyIntent(form, url, options);

  const limited = await quoteRateLimit(ctx, request, values);
  if (limited) return limited;

  if (intent === 'add-line' && Object.keys(errors).length > 0) {
    return builderReply({ values, errors }, 400);
  }
  const computed = await computeFromValues(ctx, values, products, options.lanes);
  if (!computed.ok) {
    // Structural intents re-render without complaint; recalculate/save/preview report the problem.
    const quiet = intent === 'add-line' || intent === 'remove-line' || intent === 'apply-supplier';
    return builderReply(
      quiet ? { values } : { values, errors: computed.errors, formError: computed.formError },
      quiet ? 200 : 400,
    );
  }
  const view = computed.outcome.view;
  if (intent !== 'save') return builderReply({ values, view });

  // Plan gate (M6): FREE allows 3 saved quotes; the notice is rendered instead of saving.
  const planNotice = await savedQuotePlanNotice(ctx);
  if (planNotice) {
    return builderReply(
      {
        values,
        view,
        planNotice,
        formError: 'This quote was not saved: your plan’s saved-quote limit is reached.',
      },
      402,
    );
  }
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const result = await withOrg(ctx, (tx) =>
    saveQuote(tx, actor, {
      view,
      builderInput: toBuilderInput(computed.input),
      status: 'DRAFT',
    }),
  );
  if (!result.ok)
    return builderReply({ values, view, formError: 'The quote could not be saved.' }, 409);
  const app = await getApp();
  requestLogger(app.logger, request).info('quote.saved', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    quoteId: result.id,
    status: result.status,
    computedStatus: view.quote.status,
    lines: view.quote.lines.length,
    incoterm: view.quote.incoterm,
    mode: view.quote.mode,
    warningCodes: view.quote.warnings.map((w) => w.code),
  });
  return redirect(`/app/quotes/${result.id}?notice=saved`);
};

export default function NewQuote({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <QuoteBuilder
      action="/app/quotes/new"
      options={loaderData.options}
      values={actionData?.values ?? loaderData.values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      serverView={actionData?.view ?? null}
      planNotice={actionData?.planNotice ?? loaderData.planNotice}
      title="New quote"
      reference={null}
    />
  );
}
