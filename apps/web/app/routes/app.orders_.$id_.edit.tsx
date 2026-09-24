import { redirect } from 'react-router';
import type { Route } from './+types/app.orders_.$id_.edit';
import { OrderEditor } from '../components/orders/order-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { applyIntent, editorReply, loadEditorOptions } from '../services/orders/editor.server';
import { totalsView } from '../services/orders/totals';
import {
  getOrder,
  orderErrorMessage,
  updateOrder,
  type OrderRecord,
} from '../services/orders/orders.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { orderIdParam, parseOrderForm, type OrderFormValues } from '../validators/order';

/**
 * Edit a DRAFT purchase order (M7). Any other status redirects to the detail page: issued
 * orders are frozen (the 0012 trigger is the backstop, rendered as a friendly message).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Edit purchase order — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const notFound = () =>
  pageError(
    404,
    'Purchase order not found',
    'This purchase order does not exist in your organisation.',
  );

const loadDraft = async (request: Request, rawId: string | undefined) => {
  const ctx = await requireOrgContext(request, { permission: 'order.edit' });
  const id = orderIdParam.safeParse(rawId);
  if (!id.success) throw notFound();
  const row = await withOrg(ctx, (tx) => getOrder(tx, id.data));
  if (!row) throw notFound();
  if (row.status !== 'DRAFT') throw redirect(`/app/orders/${row.id}`);
  return { ctx, row };
};

/** The stored draft as form values. */
const valuesOf = (row: OrderRecord): OrderFormValues => ({
  scalars: {
    supplierId: row.supplierId,
    pickupLocationId: row.pickupLocationId ?? '',
    currency: row.currency,
    incoterm: row.incoterm,
    expectedShipMonth: row.expectedShipMonth ? row.expectedShipMonth.toISOString().slice(0, 7) : '',
    notes: row.notes ?? '',
    poNumber: '',
    addProductId: '',
    addQuantity: '',
  },
  items: row.items.map((i) => ({
    productId: i.productId,
    quantity: String(i.quantity),
    unitCost: i.unitCost.toFixed(4),
  })),
});

const optionsFor = (ctx: Parameters<typeof loadEditorOptions>[0], row: OrderRecord) =>
  loadEditorOptions(ctx, {
    productIds: row.items.map((i) => i.productId),
    supplierId: row.supplierId,
  });

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { ctx, row } = await loadDraft(request, params.id);
  const options = await optionsFor(ctx, row);
  const values = valuesOf(row);
  return { id: row.id, poNumber: row.poNumber, options, values, totals: totalsView(values) };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { ctx, row } = await loadDraft(request, params.id);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const options = await optionsFor(ctx, row);
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
  const result = await withOrg(ctx, (tx) => updateOrder(tx, actor, row.id, parsed.input));
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  if (!result.ok) {
    if (result.error === 'NOT_FOUND') throw notFound();
    log.info('order.update_refused', {
      userId: ctx.user.id,
      orgId: ctx.org.id,
      orderId: row.id,
      error: result.error,
    });
    const message = orderErrorMessage(result, 'edited');
    return editorReply(
      { values, errors: result.field ? { [result.field]: message } : {}, formError: message },
      result.error === 'FROZEN' ? 409 : 400,
    );
  }
  log.info('order.updated', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    orderId: row.id,
    items: parsed.input.items.length,
    currency: parsed.input.currency,
  });
  return redirect(`/app/orders/${row.id}?notice=saved`);
};

export default function EditOrder({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values ?? loaderData.values;
  return (
    <OrderEditor
      action={`/app/orders/${loaderData.id}/edit`}
      options={loaderData.options}
      values={values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      totals={totalsView(values)}
      title="Edit purchase order"
      poNumber={loaderData.poNumber}
    />
  );
}
