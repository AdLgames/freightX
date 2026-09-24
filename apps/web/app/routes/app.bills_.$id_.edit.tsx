import { redirect } from 'react-router';
import type { Route } from './+types/app.bills_.$id_.edit';
import { BillEditor } from '../components/bills/bill-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import {
  billErrorMessage,
  getBill,
  updateBill,
  type BillRecord,
} from '../services/bills/bills.server';
import {
  applyBillIntent,
  billEditorReply,
  loadBillEditorOptions,
} from '../services/bills/editor.server';
import { billTotalsView } from '../services/bills/totals';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { getApp } from '../services/app.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { billIdParam, parseBillForm, type BillFormValues } from '../validators/bill';

/**
 * Edit a DRAFT bill (M8). Any other status redirects to the detail page: posted bills are
 * frozen (the 0013 trigger is the backstop, rendered as a friendly message).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Edit bill — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const notFound = () =>
  pageError(404, 'Bill not found', 'This bill does not exist in your organisation.');

const loadDraft = async (request: Request, rawId: string | undefined) => {
  const ctx = await requireOrgContext(request, { permission: 'bill.edit' });
  const id = billIdParam.safeParse(rawId);
  if (!id.success) throw notFound();
  const row = await withOrg(ctx, (tx) => getBill(tx, id.data));
  if (!row) throw notFound();
  if (row.status !== 'DRAFT') throw redirect(`/app/bills/${row.id}`);
  return { ctx, row };
};

/** The stored draft as form values. */
const valuesOf = (row: BillRecord): BillFormValues => ({
  scalars: {
    vendorType: row.vendorType,
    supplierId: row.supplierId ?? '',
    vendorName: row.vendorName ?? '',
    billType: row.billType,
    referenceNumber: row.referenceNumber,
    isCreditNote: row.isCreditNote ? 'on' : '',
    currency: row.currency,
    totalAmount: row.totalAmount.toFixed(2),
    issuedOn: row.issuedOn.toISOString().slice(0, 10),
    dueOn: row.dueOn ? row.dueOn.toISOString().slice(0, 10) : '',
    notes: row.notes ?? '',
  },
  lines: row.lines.map((l) => ({
    purchaseOrderId: l.purchaseOrderId,
    purchaseOrderItemId: l.purchaseOrderItemId ?? '',
    costCategory: l.costCategory,
    unplannedReason: l.unplannedReason ?? '',
    description: l.description,
    amount: l.amount.toFixed(2),
  })),
});

const optionsFor = (ctx: Parameters<typeof loadBillEditorOptions>[0], row: BillRecord) =>
  loadBillEditorOptions(ctx, {
    supplierId: row.supplierId,
    orderIds: row.lines.map((l) => l.purchaseOrderId),
  });

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { ctx, row } = await loadDraft(request, params.id);
  const options = await optionsFor(ctx, row);
  const values = valuesOf(row);
  return {
    id: row.id,
    reference: row.referenceNumber,
    options,
    values,
    totals: billTotalsView(values),
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { ctx, row } = await loadDraft(request, params.id);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
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
  const result = await withOrg(ctx, (tx) => updateBill(tx, actor, row.id, parsed.input));
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  if (!result.ok) {
    if (result.error === 'NOT_FOUND') throw notFound();
    log.info('bill.update_refused', {
      userId: ctx.user.id,
      orgId: ctx.org.id,
      billId: row.id,
      error: result.error,
    });
    const message = billErrorMessage(result, 'edited');
    return billEditorReply(
      { values, errors: result.field ? { [result.field]: message } : {}, formError: message },
      result.error === 'FROZEN' ? 409 : 400,
    );
  }
  log.info('bill.updated', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    billId: row.id,
    lines: parsed.input.lines.length,
    currency: parsed.input.currency,
  });
  return redirect(`/app/bills/${row.id}?notice=saved`);
};

export default function EditBill({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values ?? loaderData.values;
  return (
    <BillEditor
      action={`/app/bills/${loaderData.id}/edit`}
      options={loaderData.options}
      values={values}
      errors={actionData?.errors ?? {}}
      formError={actionData?.formError ?? null}
      totals={billTotalsView(values)}
      title="Edit bill"
      reference={loaderData.reference}
    />
  );
}
