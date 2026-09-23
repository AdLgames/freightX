import { can } from '@harbour/db';
import { data, redirect } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.products.$productId';
import { Drawer } from '../components/catalogue/drawer';
import { valuesFrom } from '../components/catalogue/fields';
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
import {
  archiveProduct,
  getProduct,
  restoreProduct,
  toProductView,
  updateProduct,
} from '../services/catalogue/products.server';
import { supplierOptions } from '../services/catalogue/suppliers.server';
import { requireCsrf } from '../services/csrf.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { productIntent } from '../validators/product';

/**
 * Edit / archive / restore a product (drawer beside the list). Viewing needs membership only;
 * every mutation needs `catalogue.edit`. The id comes from the URL but the row is read through
 * the organisation scope, so another tenant's id is simply "not found".
 */

export const meta: Route.MetaFunction = () => [{ title: 'Edit product — Harbour' }];

const idParam = z.uuid();

const notFound = () =>
  pageError(
    404,
    'Product not found',
    'It may have been removed, or it belongs to another organisation.',
  );

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const id = idParam.safeParse(params.productId);
  if (!id.success) throw notFound();
  const { product, suppliers } = await withOrg(ctx, async (tx) => ({
    product: await getProduct(tx, id.data),
    suppliers: await supplierOptions(tx),
  }));
  if (!product) throw notFound();
  const view = toProductView(product);
  // An archived supplier is still offered so the form round-trips without silently dropping it.
  const options = suppliers.map((s) => ({ id: s.id, name: s.name }));
  if (view.supplier && !options.some((s) => s.id === view.supplier?.id)) {
    options.push({ id: view.supplier.id, name: `${view.supplier.name} (archived)` });
  }
  return { product: view, suppliers: options, canEdit: can(ctx.role, 'catalogue.edit') };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'catalogue.edit' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const id = idParam.safeParse(params.productId);
  if (!id.success) throw notFound();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id };
  const intent = productIntent.parse(form?.get('intent'));

  if (intent === 'archive' || intent === 'restore') {
    const result = await withOrg(ctx, (tx) =>
      intent === 'archive'
        ? archiveProduct(tx, actor, id.data)
        : restoreProduct(tx, actor, id.data),
    );
    const notice = result.ok ? (intent === 'archive' ? 'archived' : 'restored') : 'not-found';
    return redirect(
      `/app/products?notice=${notice}${intent === 'archive' && result.ok ? '&archived=on' : ''}`,
    );
  }

  const values = readProductForm(form);
  if (intent === 'check-hs') return checkHsIntent(ctx, request, values);

  const parsed = parseProductForm(values);
  if (!parsed.ok) return invalidForm(values, parsed.errors);

  const existing = await withOrg(ctx, (tx) => getProduct(tx, id.data));
  if (!existing) throw notFound();

  const decision = await verifyForSave(ctx, request, parsed.input.hsCode, existing);
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
  const result = await withOrg(ctx, (tx) =>
    updateProduct(tx, actor, id.data, toProductWrite(parsed.input, decision.hs)),
  );
  if (!result.ok) {
    if (result.error === 'SKU_TAKEN') {
      return invalidForm(
        values,
        { sku: 'That SKU is already used by another product in this organisation.' },
        decision.state,
      );
    }
    if (result.error === 'SUPPLIER_NOT_FOUND') {
      return invalidForm(
        values,
        { supplierId: 'Choose a supplier from the list.' },
        decision.state,
      );
    }
    throw notFound();
  }
  const query = new URLSearchParams({ product: id.data });
  if (decision.notice) {
    query.set('notice', 'saved-unverified');
    query.set('reason', unverifiedReason(decision.state));
  } else {
    query.set('notice', 'saved');
  }
  if (existing.archivedAt) query.set('archived', 'on');
  return redirect(`/app/products?${query.toString()}`);
};

export default function EditProduct({ loaderData, actionData }: Route.ComponentProps) {
  const { product, suppliers, canEdit } = loaderData;
  const values =
    actionData?.values ??
    valuesFrom({
      sku: product.sku,
      name: product.name,
      supplierId: product.supplier?.id ?? '',
      originCountry: product.originCountry,
      unitValue: product.unitValue,
      currency: product.currency,
      weightKg: product.weightKg,
      // Carton dimensions round-trip when they were the source; otherwise the stored CBM does.
      volumeCbm: product.cartonLengthCm ? '' : product.volumeCbm,
      cartonLengthCm: product.cartonLengthCm,
      cartonWidthCm: product.cartonWidthCm,
      cartonHeightCm: product.cartonHeightCm,
      unitsPerCarton: product.unitsPerCarton,
      hsCode: product.hsCode,
    });
  const form = (
    <ProductForm
      values={values}
      errors={actionData?.errors ?? {}}
      hs={actionData?.hs ?? { kind: 'idle' }}
      suppliers={suppliers}
      notice={actionData?.notice ?? null}
      product={product}
    />
  );
  return (
    <Drawer title={`${product.sku} — ${product.name}`} closeTo="/app/products">
      {canEdit ? (
        form
      ) : (
        <>
          <p className="hint">Your role can view products but not change them.</p>
          <fieldset disabled className="readonly">
            {form}
          </fieldset>
        </>
      )}
    </Drawer>
  );
}
