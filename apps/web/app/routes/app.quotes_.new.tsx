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
import { UUID_PATTERN, readQuoteForm, toBuilderInput } from '../validators/quote';
// M7
import { pageError } from '../services/page-error';
import { builderValuesFromOrder, currentRateMonth } from '../services/orders/freight-quote.server';
import { getOrder } from '../services/orders/orders.server';
// end M7

/**
 * New quote (M4). Needs `quote.edit`. `?supplier=<id>` pre-selects a supplier's defaults.
 * M7: `?po=<id>` pre-fills the builder from a purchase order (lines at the PO quantities and unit
 * costs, supplier, incoterm, the pickup location's port) and the saved draft links back to it.
 */

export const meta: Route.MetaFunction = () => [{ title: 'New quote — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

/** Live previews (`?preview=1`) must not re-run the loader after every keystroke. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formAction }) =>
  !(formAction ?? '').includes('preview=1');

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
  const url = new URL(request.url);
  // M7
  const po = url.searchParams.get('po');
  if (po !== null) {
    if (!UUID_PATTERN.test(po)) throw orderNotFound();
    const order = await withOrg(ctx, (tx) => getOrder(tx, po));
    if (!order) throw orderNotFound();
    const { options } = await loadBuilderOptions(
      ctx,
      order.items.map((i) => i.productId),
    );
    const { values, context } = builderValuesFromOrder(order, options);
    const planNotice = await savedQuotePlanNotice(ctx);
    return {
      options,
      values,
      planNotice,
      purchaseOrder: context,
      rateMonth: currentRateMonth(new Date()),
    };
  }
  // end M7
  const { options } = await loadBuilderOptions(ctx);
  const supplier = url.searchParams.get('supplier');
  const values = defaultValues(options, supplier && UUID_PATTERN.test(supplier) ? supplier : null);
  const planNotice = await savedQuotePlanNotice(ctx);
  return { options, values, planNotice, purchaseOrder: null, rateMonth: null };
};

// M7
const orderNotFound = () =>
  pageError(
    404,
    'Purchase order not found',
    'This purchase order does not exist in your organisation.',
  );
// end M7

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const url = new URL(request.url);
  // M7: products a purchase order references stay quotable even if archived since.
  const { options, products } = await loadBuilderOptions(
    ctx,
    readQuoteForm(form).lines.map((l) => l.productId),
  );
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
  // M7: the purchase order must exist here and still be open (the composite FK is the backstop).
  const purchaseOrderId = computed.input.purchaseOrderId ?? null;
  if (purchaseOrderId !== null) {
    const order = await withOrg(ctx, (tx) =>
      tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { status: true } }),
    );
    if (!order) throw orderNotFound();
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      return builderReply(
        {
          values,
          view,
          formError: `That purchase order is ${order.status.toLowerCase()}; a quote cannot be attached to it.`,
        },
        409,
      );
    }
  }
  // end M7
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
    purchaseOrderId, // M7
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
      purchaseOrder={loaderData.purchaseOrder} // M7
      rateMonth={loaderData.rateMonth} // M7
    />
  );
}
