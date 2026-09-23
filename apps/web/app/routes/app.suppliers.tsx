import { can } from '@harbour/db';
import { Form, Link, Outlet } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.suppliers';
import { anyCountryName } from '../data/countries-all';
import { portName } from '../data/ports';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { listSuppliers, toSupplierView } from '../services/catalogue/suppliers.server';
import { checkbox } from '../validators/common';
import { PAYMENT_TERM_LABELS, type PaymentTermTypeCode } from '../validators/supplier';

/**
 * Suppliers — M3 (ADR-0012). List layout with the create/edit drawer as a child route. Every
 * role may view; editing needs `catalogue.edit` (checked by the child routes).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Suppliers — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const NOTICE_TEXT = {
  created: 'Supplier added. Add a pickup location and payment terms below.',
  saved: 'Supplier saved.',
  archived: 'Supplier archived. Its products keep it.',
  restored: 'Supplier restored.',
  'not-found': 'That supplier no longer exists in this organisation.',
} as const;

const noticeParam = z
  .enum(['created', 'saved', 'archived', 'restored', 'not-found'])
  .optional()
  .catch(undefined);

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const url = new URL(request.url);
  const archived = checkbox.parse(url.searchParams.get('archived') ?? '');
  const notice = noticeParam.parse(url.searchParams.get('notice') ?? undefined);
  const rows = await withOrg(ctx, (tx) => listSuppliers(tx, { archived }));
  return {
    suppliers: rows.map(toSupplierView),
    archived,
    canEdit: can(ctx.role, 'catalogue.edit'),
    notice: notice ? NOTICE_TEXT[notice] : null,
  };
};

export default function SuppliersPage({ loaderData }: Route.ComponentProps) {
  const { suppliers, archived, canEdit, notice } = loaderData;
  return (
    <div className="catalogue">
      <section className="catalogue-main" aria-labelledby="suppliers-title">
        <div className="catalogue-head">
          <h1 id="suppliers-title">Suppliers</h1>
          {canEdit ? (
            <Link to="/app/suppliers/new" className="button">
              Add supplier
            </Link>
          ) : null}
        </div>
        <p className="lede">
          The legal entity that invoices you, where the goods are collected, and how the supplier
          expects to be paid. Products pick a supplier; quotes take the origin port from its default
          pickup location.
        </p>
        {notice ? (
          <div className="banner ready" role="status">
            <p>{notice}</p>
          </div>
        ) : null}
        <Form method="get" className="catalogue-filter" aria-label="Filter suppliers">
          <div className="inline-fields">
            <div className="check">
              <input type="checkbox" id="archived" name="archived" defaultChecked={archived} />
              <label htmlFor="archived">Archived only</label>
            </div>
            <button type="submit" className="button secondary">
              Filter
            </button>
          </div>
        </Form>
        {suppliers.length === 0 ? (
          <p className="muted">
            {archived
              ? 'No archived suppliers.'
              : 'No suppliers yet. Add the first one to start building your catalogue.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="stack dense" aria-label="Suppliers">
              <thead>
                <tr>
                  <th scope="col">Supplier</th>
                  <th scope="col">Registered name</th>
                  <th scope="col">Incorporated in</th>
                  <th scope="col">Default pickup</th>
                  <th scope="col">Payment terms</th>
                  <th scope="col" className="num">
                    Products
                  </th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => {
                  const pickup = s.pickupLocations.find((p) => p.isDefault) ?? s.pickupLocations[0];
                  return (
                    <tr key={s.id}>
                      <td data-label="Supplier">
                        <Link to={`/app/suppliers/${s.id}`}>{s.name}</Link>
                      </td>
                      <td data-label="Registered name">{s.legalName}</td>
                      <td
                        data-label="Incorporated in"
                        title={anyCountryName(s.countryOfIncorporation)}
                      >
                        {s.countryOfIncorporation}
                      </td>
                      <td data-label="Default pickup">
                        {pickup ? (
                          <>
                            {pickup.name} — {portName(pickup.closestPortCode)}{' '}
                            <span className="code">({pickup.closestPortCode})</span>
                          </>
                        ) : (
                          <span className="muted">none yet</span>
                        )}
                      </td>
                      <td data-label="Payment terms">
                        {s.paymentTerms ? (
                          termSummary(s.paymentTerms)
                        ) : (
                          <span className="muted">not set</span>
                        )}
                      </td>
                      <td data-label="Products" className="num">
                        {s.productCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Outlet />
    </div>
  );
}

const termSummary = (t: {
  termType: string;
  depositPct: string | null;
  netDays: number | null;
}): string => {
  const label = PAYMENT_TERM_LABELS[t.termType as PaymentTermTypeCode] ?? t.termType;
  if (t.termType === 'DEPOSIT_BALANCE' && t.depositPct)
    return `${t.depositPct}% deposit, balance later`;
  if (t.termType === 'NET' && t.netDays !== null) return `Net ${t.netDays} days`;
  return label;
};
