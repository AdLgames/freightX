import { can } from '@harbour/db';
import { Link, data, redirect } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.suppliers.$supplierId';
import { Drawer } from '../components/catalogue/drawer';
import { valuesFrom, type Errors, type Values } from '../components/catalogue/fields';
import {
  PaymentTermsForm,
  PickupLocationForms,
  SupplierIdentityForm,
} from '../components/catalogue/supplier-forms';
import { requireOrgContext, withOrg } from '../services/auth.server';
import {
  addPickupLocation,
  archiveSupplier,
  getSupplier,
  removePickupLocation,
  restoreSupplier,
  setDefaultPickupLocation,
  toSupplierView,
  updatePickupLocation,
  updateSupplier,
  upsertPaymentTerms,
} from '../services/catalogue/suppliers.server';
import { requireCsrf } from '../services/csrf.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { fieldErrors } from '../validators/common';
import { formStrings } from '../validators/product';
import {
  PAYMENT_TERMS_FIELDS,
  PICKUP_FIELDS,
  SUPPLIER_FIELDS,
  paymentTermsFormSchema,
  pickupLocationFormSchema,
  supplierFormSchema,
  supplierIntent,
} from '../validators/supplier';

/**
 * Supplier page (ADR-0012): legal identity, sourcing defaults, payment terms and pickup
 * locations. Several forms post to this one action with an `intent`; each re-renders only its own
 * errors. Viewing needs membership; every mutation needs `catalogue.edit`.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Supplier — Harbour' }];

const idParam = z.uuid();

const notFound = () =>
  pageError(
    404,
    'Supplier not found',
    'It may have been removed, or it belongs to another organisation.',
  );

const NOTICE_TEXT: Record<string, string> = {
  created: 'Supplier added. Now add where the goods are collected and how the supplier is paid.',
  'terms-saved': 'Payment terms saved.',
  'pickup-added': 'Pickup location added.',
  'pickup-saved': 'Pickup location saved.',
  'pickup-removed': 'Pickup location removed.',
  'pickup-default': 'Default pickup location changed.',
  'pickup-missing': 'That pickup location no longer exists.',
};

/** Which form re-renders with errors. */
export type SupplierActionData =
  | { form: 'supplier'; values: Values; errors: Errors }
  | { form: 'terms'; values: Values; errors: Errors }
  | { form: 'pickup-add'; values: Values; errors: Errors }
  | { form: 'pickup-edit'; pickupId: string; values: Values; errors: Errors };

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const id = idParam.safeParse(params.supplierId);
  if (!id.success) throw notFound();
  const supplier = await withOrg(ctx, (tx) => getSupplier(tx, id.data));
  if (!supplier) throw notFound();
  const notice = new URL(request.url).searchParams.get('notice');
  return {
    supplier: toSupplierView(supplier),
    canEdit: can(ctx.role, 'catalogue.edit'),
    notice: notice ? (NOTICE_TEXT[notice] ?? null) : null,
  };
};

const invalid = (payload: SupplierActionData) => data<SupplierActionData>(payload, { status: 400 });

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'catalogue.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const id = idParam.safeParse(params.supplierId);
  if (!id.success) throw notFound();
  const supplierId = id.data;
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const intent = supplierIntent.parse(form?.get('intent'));
  const here = (notice: string) => redirect(`/app/suppliers/${supplierId}?notice=${notice}`);

  switch (intent) {
    case 'save': {
      const values = formStrings(form, SUPPLIER_FIELDS);
      const parsed = supplierFormSchema.safeParse(values);
      if (!parsed.success) {
        return invalid({ form: 'supplier', values, errors: fieldErrors(parsed.error.issues) });
      }
      const result = await withOrg(ctx, (tx) => updateSupplier(tx, actor, supplierId, parsed.data));
      if (!result.ok) return redirect('/app/suppliers?notice=not-found');
      return redirect('/app/suppliers?notice=saved');
    }
    case 'archive':
    case 'restore': {
      const result = await withOrg(ctx, (tx) =>
        intent === 'archive'
          ? archiveSupplier(tx, actor, supplierId)
          : restoreSupplier(tx, actor, supplierId),
      );
      if (!result.ok) return redirect('/app/suppliers?notice=not-found');
      return redirect(
        `/app/suppliers?notice=${intent === 'archive' ? 'archived&archived=on' : 'restored'}`,
      );
    }
    case 'payment-terms': {
      const values = formStrings(form, PAYMENT_TERMS_FIELDS);
      const parsed = paymentTermsFormSchema.safeParse(values);
      if (!parsed.success) {
        return invalid({ form: 'terms', values, errors: fieldErrors(parsed.error.issues) });
      }
      const result = await withOrg(ctx, (tx) =>
        upsertPaymentTerms(tx, actor, supplierId, parsed.data),
      );
      if (!result.ok) throw notFound();
      return here('terms-saved');
    }
    case 'pickup-add': {
      const values = formStrings(form, PICKUP_FIELDS);
      const parsed = pickupLocationFormSchema.safeParse(values);
      if (!parsed.success) {
        return invalid({ form: 'pickup-add', values, errors: fieldErrors(parsed.error.issues) });
      }
      const result = await withOrg(ctx, (tx) =>
        addPickupLocation(tx, actor, supplierId, parsed.data),
      );
      if (!result.ok) throw notFound();
      return here('pickup-added');
    }
    case 'pickup-update':
    case 'pickup-remove':
    case 'pickup-default': {
      const pickupId = idParam.safeParse(form?.get('pickupId'));
      if (!pickupId.success) return here('pickup-missing');
      if (intent === 'pickup-remove') {
        const result = await withOrg(ctx, (tx) =>
          removePickupLocation(tx, actor, supplierId, pickupId.data),
        );
        return here(result.ok ? 'pickup-removed' : 'pickup-missing');
      }
      if (intent === 'pickup-default') {
        const result = await withOrg(ctx, (tx) =>
          setDefaultPickupLocation(tx, actor, supplierId, pickupId.data),
        );
        return here(result.ok ? 'pickup-default' : 'pickup-missing');
      }
      const values = formStrings(form, PICKUP_FIELDS);
      const parsed = pickupLocationFormSchema.safeParse(values);
      if (!parsed.success) {
        return invalid({
          form: 'pickup-edit',
          pickupId: pickupId.data,
          values,
          errors: fieldErrors(parsed.error.issues),
        });
      }
      const result = await withOrg(ctx, (tx) =>
        updatePickupLocation(tx, actor, supplierId, pickupId.data, parsed.data),
      );
      return here(result.ok ? 'pickup-saved' : 'pickup-missing');
    }
  }
};

export default function EditSupplier({ loaderData, actionData }: Route.ComponentProps) {
  const { supplier, canEdit, notice } = loaderData;
  const supplierValues =
    actionData?.form === 'supplier'
      ? actionData.values
      : valuesFrom({
          legalName: supplier.legalName,
          tradingName: supplier.tradingName,
          registrationNumber: supplier.registrationNumber,
          countryOfIncorporation: supplier.countryOfIncorporation,
          defaultCurrency: supplier.defaultCurrency,
          defaultIncoterm: supplier.defaultIncoterm,
        });
  const termsValues =
    actionData?.form === 'terms'
      ? actionData.values
      : valuesFrom({
          termType: supplier.paymentTerms?.termType,
          depositPct: supplier.paymentTerms?.depositPct,
          balanceTrigger: supplier.paymentTerms?.balanceTrigger,
          netDays: supplier.paymentTerms?.netDays,
        });
  const body = (
    <>
      <SupplierIdentityForm
        values={supplierValues}
        errors={actionData?.form === 'supplier' ? actionData.errors : {}}
        notice={notice}
        supplier={supplier}
      />
      <PickupLocationForms
        locations={supplier.pickupLocations}
        addValues={actionData?.form === 'pickup-add' ? actionData.values : {}}
        addErrors={actionData?.form === 'pickup-add' ? actionData.errors : {}}
        editing={
          actionData?.form === 'pickup-edit'
            ? { id: actionData.pickupId, values: actionData.values, errors: actionData.errors }
            : null
        }
      />
      <PaymentTermsForm
        values={termsValues}
        errors={actionData?.form === 'terms' ? actionData.errors : {}}
      />
      <p>
        <Link to={`/app/products/new?supplier=${supplier.id}`}>
          Add a product from this supplier
        </Link>
        {supplier.productCount > 0 ? (
          <>
            {' '}
            · {supplier.productCount} product{supplier.productCount === 1 ? '' : 's'} in the
            catalogue
          </>
        ) : null}
      </p>
    </>
  );
  return (
    <Drawer title={supplier.name} closeTo="/app/suppliers">
      {canEdit ? (
        body
      ) : (
        <>
          <p className="hint">Your role can view suppliers but not change them.</p>
          <fieldset disabled className="readonly">
            {body}
          </fieldset>
        </>
      )}
    </Drawer>
  );
}
