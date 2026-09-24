import { redirect } from 'react-router';
import type { Route } from './+types/app.orders_.new';
import { OrderEditor } from '../components/orders/order-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import {
  applyIntent,
  defaultValues,
  editorReply,
  loadEditorOptions,
  totalsView,
} from '../services/orders/editor.server';
import { createOrder, orderErrorMessage } from '../services/orders/orders.server';
import { readForm } from '../services/request.server';
import { parseOrderForm } from '../validators/order';
import { UUID_PATTERN } from '../validators/quote';

/**
 * New purchase order (M7). Needs `order.edit`. `?supplier=<id>` pre-selects a supplier's
 * defaults (currency, incoterm, default pickup location). Purchase orders are not plan-gated:
 * `PLAN_LIMITS` has no slot for them (decisions-needed (ag)).
 */

export const meta: Route.MetaFunction = () => [{ title: 'New purchase order — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.edit' });
  const url = new URL(request.url);
  const options = await loadEditorOptions(ctx);
  const supplier = url.searchParams.get('supplier');
  const values = defaultValues(options, supplier && UUID_PATTERN.test(supplier) ? supplier : null);
  return { options, values, totals: totalsView(values) };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'order.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const options = await loadEditorOptions(ctx);
  const { intent, values, errors } = applyIntent(form, options);
  if (intent !== 'save') {
    return editorReply({ values, errors }, Object.keys(errors).length > 0 ? 400 : 200);
  }
  const parsed = parseOrderForm(values);
  if (!parsed.ok) {
    return editorReply(
      {
        values,
        errors: parsed.errors,
        formError: parsed.errors.items ?? 'Check the highlighted fields and try again.',
      },
      400,
    );
  }
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const result = await withOrg(ctx, (tx) => createOrder(tx, actor, parsed.input, new Date()));
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  if (!result.ok) {
    log.info('order.create_refused', {
      userId: ctx.user.id,
      orgId: ctx.org.id,
      error: result.error,
    });
    const message = orderErrorMessage(result, 'created');
    return editorReply(
      { values, errors: result.field ? { [result.field]: message } : {}, formError: message },
      400,
    );
  }
  log.info('order.created', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    orderId: result.id,
    items: parsed.input.items.length,
    currency: parsed.input.currency,
    incoterm: parsed.input.incoterm,
  });
  return redirect(`/app/orders/${result.id}?notice=created`);
};

export default function NewOrder({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values ?? loaderData.values;
  return (
    <OrderEditor
      action="/app/orders/new"
      options={loaderData.options}
      values={values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      totals={totalsView(values)}
      title="New purchase order"
      poNumber={null}
    />
  );
}
