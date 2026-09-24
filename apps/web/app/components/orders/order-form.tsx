import { Form, Link } from 'react-router';
import type { EditorOptions } from '../../services/orders/editor.server';
import type { TotalsView } from '../../services/orders/totals';
import { INCOTERMS } from '../../validators/calculator';
import { CURRENCIES } from '../../validators/common';
import { itemFieldName, type OrderFormValues } from '../../validators/order';
import { INCOTERM_LABELS } from '../../validators/quote';
import { Field, TextInput } from '../catalogue/fields';
import { CsrfInput } from '../csrf';
import { money } from './status-badge';

/**
 * The purchase-order editor (M7, ADR-0013): supplier (pre-fills currency, incoterm and the default
 * pickup location), lines from the catalogue with quantity and unit cost in the PO currency, and
 * the live totals. Server-rendered and fully usable without JavaScript: every button is a submit
 * with an `intent` (`recalculate`, `add-item`, `apply-supplier`, `save`) or a `removeItem` index,
 * and the page re-renders with the echoed values and recomputed totals.
 */
export function OrderEditor({
  action,
  options,
  values,
  errors,
  formError,
  totals,
  title,
  poNumber,
}: {
  action: string;
  options: EditorOptions;
  values: OrderFormValues;
  errors: Record<string, string>;
  formError: string | null;
  totals: TotalsView;
  title: string;
  /** Existing order's number (edit) — null for a new order. */
  poNumber: string | null;
}) {
  const scalars = values.scalars;
  const currency = scalars.currency || '';
  const productsById = new Map(options.products.map((p) => [p.id, p]));
  const addable = options.products.filter((p) => !p.archived && p.currency === currency);
  const pickups = options.pickups.filter((p) => p.supplierId === scalars.supplierId);
  const supplier = options.suppliers.find((s) => s.id === scalars.supplierId) ?? null;

  return (
    <div className="order-editor">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {poNumber ? <p className="muted">{poNumber} · draft</p> : null}
        </div>
        <Link to="/app/orders" className="button ghost small">
          Back to orders
        </Link>
      </div>

      {formError ? (
        <div className="banner error" role="alert">
          <h2>There is a problem</h2>
          <p>{formError}</p>
          {Object.keys(errors).length > 0 ? (
            <ul>
              {Object.entries(errors).map(([field, message]) => (
                <li key={field}>
                  <a href={`#${field}`}>{message}</a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Form
        method="post"
        action={action}
        noValidate
        className="calc-form"
        aria-label="Purchase order"
      >
        <CsrfInput />

        <fieldset>
          <legend>Supplier and terms</legend>
          <Field
            name="supplierId"
            label="Supplier"
            hint="Pre-fills the currency, incoterm and default pickup location. The deposit and balance come from the supplier's payment terms when the order is issued."
            errors={errors}
          >
            {(aria) => (
              <div className="inline-fields supplier-row">
                <select {...aria} name="supplierId" defaultValue={scalars.supplierId ?? ''}>
                  <option value="">Choose a supplier</option>
                  {options.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.defaultCurrency ? ` · ${s.defaultCurrency}` : ''}
                      {s.defaultIncoterm ? ` · ${s.defaultIncoterm}` : ''}
                      {s.archived ? ' · archived' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  name="intent"
                  value="apply-supplier"
                  className="button secondary"
                  formNoValidate
                >
                  Apply supplier defaults
                </button>
              </div>
            )}
          </Field>
          {supplier && !supplier.hasPaymentTerms ? (
            <p className="hint">
              This supplier has no payment terms yet; add them on the{' '}
              <Link to={`/app/suppliers/${supplier.id}`}>supplier page</Link> before issuing.
            </p>
          ) : null}
          {options.suppliers.length === 0 ? (
            <p className="hint">
              No suppliers yet. <Link to="/app/suppliers/new">Add a supplier</Link> first.
            </p>
          ) : null}

          <div className="inline-fields">
            <Field name="currency" label="Order currency" errors={errors}>
              {(aria) => (
                <select
                  {...aria}
                  name="currency"
                  defaultValue={scalars.currency ?? ''}
                  className="narrow"
                >
                  <option value="">Choose</option>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              name="pickupLocationId"
              label="Pickup location (optional)"
              hint="Where the goods are collected; its closest port becomes the origin of the freight quote."
              errors={errors}
            >
              {(aria) => (
                <select
                  {...aria}
                  name="pickupLocationId"
                  defaultValue={scalars.pickupLocationId ?? ''}
                >
                  <option value="">None</option>
                  {pickups.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.port}
                      {p.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <div className={`field radios${errors.incoterm ? ' has-error' : ''}`}>
            <span className="label" id="incoterm-label">
              Incoterm
            </span>
            <span className="hint">What the supplier's price already includes.</span>
            {errors.incoterm ? (
              <span className="field-error" id="incoterm-error">
                {errors.incoterm}
              </span>
            ) : null}
            {INCOTERMS.map((code) => (
              <div className="check" key={code}>
                <input
                  type="radio"
                  id={`incoterm-${code}`}
                  name="incoterm"
                  value={code}
                  defaultChecked={(scalars.incoterm || 'FOB') === code}
                  aria-describedby={errors.incoterm ? 'incoterm-error' : undefined}
                />
                <label htmlFor={`incoterm-${code}`}>{INCOTERM_LABELS[code]}</label>
              </div>
            ))}
          </div>

          <div className="inline-fields">
            <Field
              name="expectedShipMonth"
              label="Expected ship month (optional)"
              hint="The HMRC monthly rate month the freight quote should use once it is published."
              errors={errors}
            >
              {(aria) => (
                <input
                  {...aria}
                  type="month"
                  name="expectedShipMonth"
                  defaultValue={scalars.expectedShipMonth ?? ''}
                  className="narrow"
                />
              )}
            </Field>
            {poNumber ? (
              <TextInput
                name="poNumber"
                label="PO number"
                hint="Editable while the order is a draft; blank keeps the current number."
                values={scalars}
                errors={errors}
                className="narrow"
                placeholder={poNumber}
                maxLength={20}
              />
            ) : null}
          </div>
        </fieldset>

        <fieldset id="items">
          <legend>Products</legend>
          {errors.items ? (
            <span className="field-error" id="items-error">
              {errors.items}
            </span>
          ) : null}
          {values.items.length === 0 ? (
            <p className="muted">No lines yet. Add a product from your catalogue below.</p>
          ) : (
            <ol className="item-list">
              {values.items.map((item, i) => {
                const p = productsById.get(item.productId);
                const qtyName = itemFieldName(i, 'quantity');
                const costName = itemFieldName(i, 'unitCost');
                const lineTotal = totals.lines[i] ?? null;
                return (
                  <li className="line-card" key={`${item.productId}-${i}`}>
                    <input
                      type="hidden"
                      name={itemFieldName(i, 'productId')}
                      value={item.productId}
                    />
                    <div className="line-head">
                      <div>
                        <strong>
                          {p ? (
                            <>
                              <span className="code">{p.sku}</span> {p.name}
                            </>
                          ) : (
                            'Product no longer in your catalogue'
                          )}
                        </strong>
                        {p ? (
                          <p className="muted small line-facts">
                            Catalogue value {p.unitValue} {p.currency}
                            {p.currency !== currency ? ` — not ${currency || 'this currency'}` : ''}
                            {p.archived ? ' · archived' : ''} ·{' '}
                            <Link to={`/app/products/${p.id}`}>Edit product</Link>
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <span className="item-total">
                          {lineTotal !== null && currency ? money(lineTotal, currency) : '—'}
                        </span>{' '}
                        <button
                          type="submit"
                          name="removeItem"
                          value={String(i)}
                          className="button ghost small"
                          formNoValidate
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    {errors[itemFieldName(i, 'productId')] ? (
                      <span className="field-error" id={itemFieldName(i, 'productId')}>
                        {errors[itemFieldName(i, 'productId')]}
                      </span>
                    ) : null}
                    <div className="inline-fields">
                      <TextInput
                        name={qtyName}
                        label="Quantity"
                        values={{ [qtyName]: item.quantity }}
                        errors={errors}
                        inputMode="numeric"
                        className="narrow"
                      />
                      <TextInput
                        name={costName}
                        label={`Unit cost (${currency || 'order currency'})`}
                        values={{ [costName]: item.unitCost }}
                        errors={errors}
                        inputMode="decimal"
                        className="narrow"
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="add-line subgroup">
            <p className="label">Add from catalogue</p>
            <div className="inline-fields">
              <Field
                name="addProductId"
                label="Product"
                hint={
                  currency ? `Products priced in ${currency}.` : 'Choose the order currency first.'
                }
                errors={errors}
              >
                {(aria) => (
                  <select {...aria} name="addProductId" defaultValue={scalars.addProductId ?? ''}>
                    <option value="">Choose a product</option>
                    {addable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} — {p.name} ({p.unitValue} {p.currency})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <TextInput
                name="addQuantity"
                label="Quantity"
                values={scalars}
                errors={errors}
                inputMode="numeric"
                className="narrow"
                placeholder="500"
              />
              <div className="field">
                <span className="label" aria-hidden="true">
                  &nbsp;
                </span>
                <button
                  type="submit"
                  name="intent"
                  value="add-item"
                  className="button secondary"
                  formNoValidate
                >
                  Add line
                </button>
              </div>
            </div>
            {currency && addable.length === 0 ? (
              <p className="hint">
                No active products are priced in {currency}.{' '}
                <Link to="/app/products/new">Add a product</Link> or change the order currency.
              </p>
            ) : null}
          </div>

          <div className="order-totals" aria-live="polite">
            <span className="muted">Goods total{totals.complete ? '' : ' (valid lines only)'}</span>
            <strong>{currency ? money(totals.totalGoodsValue, currency) : '—'}</strong>
          </div>
        </fieldset>

        <fieldset>
          <legend>Notes</legend>
          <Field name="notes" label="Notes (optional)" errors={errors}>
            {(aria) => (
              <textarea
                {...aria}
                name="notes"
                rows={3}
                maxLength={2000}
                defaultValue={scalars.notes ?? ''}
              />
            )}
          </Field>
        </fieldset>

        <div className="form-actions">
          <button type="submit" name="intent" value="recalculate" className="button secondary">
            Recalculate
          </button>
          <button type="submit" name="intent" value="save" className="button lime">
            {poNumber ? 'Save draft' : 'Create draft'}
          </button>
        </div>
      </Form>
    </div>
  );
}
