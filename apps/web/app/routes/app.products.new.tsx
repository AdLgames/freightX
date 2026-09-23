import { data, redirect } from 'react-router';
import type { Route } from './+types/app.products.new';
import { Drawer } from '../components/catalogue/drawer';
import { ProductForm } from '../components/catalogue/product-form';
import { requireOrgContext, withOrg } from '../services/auth.server';
import {
  checkHsIntent,
  invalidForm,
  parseProductForm,
  readProductForm,
  toProductWrite,
  unverifiedReason,
  verifyForSave,
  type ProductActionData,
} from '../services/catalogue/product-form.server';
import { createProduct } from '../services/catalogue/products.server';
import { supplierOptions } from '../services/catalogue/suppliers.server';
import { requireCsrf } from '../services/csrf.server';
import { readForm } from '../services/request.server';
import { productIntent } from '../validators/product';

/** Add a product (drawer beside the list). Needs `catalogue.edit`. */

export const meta: Route.MetaFunction = () => [{ title: 'Add product — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'catalogue.edit' });
  const url = new URL(request.url);
  const suppliers = await withOrg(ctx, (tx) => supplierOptions(tx));
  // `?supplier=<id>` from the supplier page pre-selects it and its invoice currency.
  const preset = suppliers.find((s) => s.id === url.searchParams.get('supplier'));
  return {
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })),
    initial: {
      supplierId: preset?.id ?? '',
      currency: preset?.defaultCurrency ?? '',
    },
  };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'catalogue.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const intent = productIntent.parse(form?.get('intent'));
  const values = readProductForm(form);
  if (intent === 'check-hs') return checkHsIntent(ctx, request, values);

  const parsed = parseProductForm(values);
  if (!parsed.ok) return invalidForm(values, parsed.errors);

  const decision = await verifyForSave(ctx, request, parsed.input.hsCode, null);
  if (decision.kind === 'choose') {
    return data<ProductActionData>(
      {
        values,
        errors: { hsCode: 'Choose the 10-digit commodity code below, then save again.' },
        hs: decision.state,
        notice: null,
      },
      { status: 400 },
    );
  }
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const result = await withOrg(ctx, (tx) =>
    createProduct(tx, actor, toProductWrite(parsed.input, decision.hs)),
  );
  if (!result.ok) {
    if (result.error === 'SKU_TAKEN') {
      return invalidForm(
        values,
        { sku: 'That SKU is already used by another product in this organisation.' },
        decision.state,
      );
    }
    return invalidForm(values, { supplierId: 'Choose a supplier from the list.' }, decision.state);
  }
  const query = new URLSearchParams({ product: result.id });
  if (decision.notice) {
    query.set('notice', 'saved-unverified');
    query.set('reason', unverifiedReason(decision.state));
  } else {
    query.set('notice', 'saved');
  }
  return redirect(`/app/products?${query.toString()}`);
};

export default function NewProduct({ loaderData, actionData }: Route.ComponentProps) {
  const values = actionData?.values ?? { ...loaderData.initial };
  return (
    <Drawer title="Add product" closeTo="/app/products">
      <ProductForm
        values={values}
        errors={actionData?.errors ?? {}}
        hs={actionData?.hs ?? { kind: 'idle' }}
        suppliers={loaderData.suppliers}
        notice={actionData?.notice ?? null}
        product={null}
      />
    </Drawer>
  );
}
