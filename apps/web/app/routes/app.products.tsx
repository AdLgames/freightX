import { can } from '@harbour/db';
import { Form, Link, Outlet } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.products';
import { anyCountryName } from '../data/countries-all';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { productNotice } from '../services/catalogue/product-form.server';
import { listProducts, toProductView } from '../services/catalogue/products.server';
import { productSearchSchema } from '../validators/product';

/**
 * Products (catalogue) — M3. The list is the layout; the add/edit drawer is a child route
 * rendered through <Outlet/> beside the table (UX spec "Products (catalogue)"). Every role may
 * view; editing needs `catalogue.edit` (checked by the child routes' loaders and actions).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Products — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const reasonParam = z
  .enum(['unavailable', 'not-found', 'rate-limited'])
  .optional()
  .catch(undefined);

const NOTICE_TEXT = {
  saved: 'Product saved. The HS code is verified against the UK tariff.',
  'saved-unverified': 'Product saved, but the HS code is unverified',
  archived: 'Product archived. It stays on existing quotes.',
  restored: 'Product restored.',
  'not-found': 'That product no longer exists in this organisation.',
} as const;

const REASON_TEXT = {
  unavailable: 'the UK Trade Tariff service could not be reached',
  'not-found': 'the code was not found in the UK tariff',
  'rate-limited': 'too many tariff lookups in the last minute',
} as const;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const url = new URL(request.url);
  const parsed = productSearchSchema.safeParse({
    q: url.searchParams.get('q') ?? '',
    archived: url.searchParams.get('archived') ?? '',
  });
  const filter = parsed.success ? parsed.data : { q: undefined, archived: false };
  const notice = productNotice.parse(url.searchParams.get('notice') ?? undefined);
  const reason = reasonParam.parse(url.searchParams.get('reason') ?? undefined);
  const rows = await withOrg(ctx, (tx) => listProducts(tx, filter));
  return {
    products: rows.map(toProductView),
    filter: { q: filter.q ?? '', archived: filter.archived },
    canEdit: can(ctx.role, 'catalogue.edit'),
    notice: notice
      ? notice === 'saved-unverified' && reason
        ? `${NOTICE_TEXT[notice]}: ${REASON_TEXT[reason]}. Quotes using it will be indicative until it is verified.`
        : NOTICE_TEXT[notice]
      : null,
    noticeKind: notice === 'saved-unverified' ? 'indicative' : notice ? 'ready' : null,
  };
};

export default function ProductsPage({ loaderData }: Route.ComponentProps) {
  const { products, filter, canEdit, notice, noticeKind } = loaderData;
  return (
    <div className="catalogue">
      <section className="catalogue-main" aria-labelledby="products-title">
        <div className="catalogue-head">
          <h1 id="products-title">Products</h1>
          {canEdit ? (
            <Link to="/app/products/new" className="button">
              Add product
            </Link>
          ) : null}
        </div>
        <p className="lede">
          Every saved product pre-fills the customs and freight inputs of future quotes. Codes
          marked unverified make quotes indicative until they are checked.
        </p>
        {notice ? (
          <div className={`banner ${noticeKind ?? 'notice'}`} role="status">
            <p>{notice}</p>
          </div>
        ) : null}
        <Form method="get" className="catalogue-filter" aria-label="Filter products">
          <div className="inline-fields">
            <div className="field">
              <label htmlFor="q">Search</label>
              <input
                id="q"
                name="q"
                type="text"
                defaultValue={filter.q}
                placeholder="SKU or name"
                maxLength={100}
              />
            </div>
            <div className="check">
              <input
                type="checkbox"
                id="archived"
                name="archived"
                defaultChecked={filter.archived}
              />
              <label htmlFor="archived">Archived only</label>
            </div>
            <button type="submit" className="button secondary">
              Filter
            </button>
          </div>
        </Form>
        {products.length === 0 ? (
          <p className="muted">
            {filter.q || filter.archived
              ? 'No products match.'
              : 'No products yet. Add your first product to start quoting from the catalogue.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Products">
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Name</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Origin</th>
                  <th scope="col">HS code</th>
                  <th scope="col" className="num">
                    Unit value
                  </th>
                  <th scope="col" className="num">
                    CBM / unit
                  </th>
                  <th scope="col" className="num">
                    kg / unit
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td data-label="SKU">
                      <Link to={`/app/products/${p.id}`} className="code">
                        {p.sku}
                      </Link>
                    </td>
                    <td data-label="Name">{p.name}</td>
                    <td data-label="Supplier">
                      {p.supplier ? (
                        <Link to={`/app/suppliers/${p.supplier.id}`}>{p.supplier.name}</Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="Origin" title={anyCountryName(p.originCountry)}>
                      {p.originCountry}
                    </td>
                    <td data-label="HS code">
                      <span className="code">{p.hsCode}</span>{' '}
                      {p.hsCodeVerifiedAt ? (
                        <span className="hs-mark verified" title={p.hsDescription ?? 'Verified'}>
                          {'✓'}
                          <span className="visually-hidden"> verified</span>
                        </span>
                      ) : (
                        <span
                          className="hs-mark unverified"
                          title="Unverified: quotes using this product are indicative"
                        >
                          !<span className="visually-hidden"> unverified</span>
                        </span>
                      )}
                    </td>
                    <td data-label="Unit value" className="num">
                      {p.unitValue} {p.currency}
                    </td>
                    <td data-label="CBM / unit" className="num">
                      {p.volumeCbm}
                    </td>
                    <td data-label="kg / unit" className="num">
                      {p.weightKg}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Outlet />
    </div>
  );
}
