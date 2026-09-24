import { redirect } from 'react-router';
import type { Route } from './+types/app.bills_.new';
import { BillEditor } from '../components/bills/bill-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { billErrorMessage, createBill } from '../services/bills/bills.server';
import {
  applyBillIntent,
  billEditorReply,
  defaultBillValues,
  loadBillEditorOptions,
} from '../services/bills/editor.server';
import { billTotalsView } from '../services/bills/totals';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { readForm } from '../services/request.server';
import { parseBillForm } from '../validators/bill';
import { UUID_PATTERN } from '../validators/quote';

/**
 * Record a bill (M8). Needs `bill.edit`. `?order=<id>` starts the bill from a purchase order
 * (its supplier, currency and a first GOODS line). Bills are not plan-gated.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Record a bill — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const today = () => new Date().toISOString().slice(0, 10);

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.edit' });
  const url = new URL(request.url);
  const options = await loadBillEditorOptions(ctx);
  const order = url.searchParams.get('order');
  const values = defaultBillValues(
    options,
    order && UUID_PATTERN.test(order) ? order : null,
    today(),
  );
  return { options, values, totals: billTotalsView(values) };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const options = await loadBillEditorOptions(ctx);
  const { intent, values } = applyBillIntent(form);
  if (intent !== 'save') return billEditorReply({ values });
  const parsed = parseBillForm(values);
  if (!parsed.ok) {
    return billEditorReply(
      {
        values,
        errors: parsed.errors,
        formError: parsed.errors.lines ?? 'Check the highlighted fields and try again.',
      },
      400,
    );
  }
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const result = await withOrg(ctx, (tx) => createBill(tx, actor, parsed.input));
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  if (!result.ok) {
    log.info('bill.create_refused', {
      userId: ctx.user.id,
      orgId: ctx.org.id,
      error: result.error,
    });
    const message = billErrorMessage(result, 'created');
    return billEditorReply(
      { values, errors: result.field ? { [result.field]: message } : {}, formError: message },
      400,
    );
  }
  log.info('bill.created', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    billId: result.id,
    vendorType: parsed.input.vendorType,
    billType: parsed.input.billType,
    currency: parsed.input.currency,
    lines: parsed.input.lines.length,
    orders: options.orders.filter((o) => parsed.input.lines.some((l) => l.purchaseOrderId === o.id))
      .length,
  });
  return redirect(`/app/bills/${result.id}?notice=created`);
};

export default function NewBill({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values ?? loaderData.values;
  return (
    <BillEditor
      action="/app/bills/new"
      options={loaderData.options}
      values={values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      totals={billTotalsView(values)}
      title="Record a bill"
      reference={null}
    />
  );
}
