import { data, redirect } from 'react-router';
import type { Route } from './+types/app.suppliers.new';
import { Drawer } from '../components/catalogue/drawer';
import { SupplierIdentityForm } from '../components/catalogue/supplier-forms';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { createSupplier } from '../services/catalogue/suppliers.server';
import { requireCsrf } from '../services/csrf.server';
import { readForm } from '../services/request.server';
import { fieldErrors } from '../validators/common';
import { formStrings } from '../validators/product';
import { SUPPLIER_FIELDS, supplierFormSchema } from '../validators/supplier';

/** Add a supplier (legal identity + sourcing defaults). Pickup locations and terms follow on the edit page. */

export const meta: Route.MetaFunction = () => [{ title: 'Add supplier — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireOrgContext(request, { permission: 'catalogue.edit' });
  return null;
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'catalogue.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const values = formStrings(form, SUPPLIER_FIELDS);
  const parsed = supplierFormSchema.safeParse(values);
  if (!parsed.success) {
    return data({ values, errors: fieldErrors(parsed.error.issues) }, { status: 400 });
  }
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const created = await withOrg(ctx, (tx) => createSupplier(tx, actor, parsed.data));
  return redirect(`/app/suppliers/${created.id}?notice=created`);
};

export default function NewSupplier({ actionData }: Route.ComponentProps) {
  return (
    <Drawer title="Add supplier" closeTo="/app/suppliers">
      <SupplierIdentityForm
        values={actionData?.values ?? {}}
        errors={actionData?.errors ?? {}}
        notice={null}
        supplier={null}
      />
    </Drawer>
  );
}
