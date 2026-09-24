import { Form, Link } from 'react-router';
import type { BillEditorOptions } from '../../services/bills/editor.server';
import { orderOf, type BillTotalsView } from '../../services/bills/totals';
import {
  BILL_TYPES,
  BILL_TYPE_LABELS,
  COST_CATEGORIES,
  COST_CATEGORY_LABELS,
  UNPLANNED_REASONS,
  UNPLANNED_REASON_LABELS,
  VENDOR_TYPES,
  VENDOR_TYPE_LABELS,
  lineFieldName,
  type BillFormValues,
} from '../../validators/bill';
import { CURRENCIES } from '../../validators/common';
import { Field, TextInput } from '../catalogue/fields';
import { CsrfInput } from '../csrf';
import { money } from '../orders/status-badge';

/**
 * The bill editor (M8, ADR-0014): who sent it, its reference, currency, total and dates, and the
 * lines — each booked to a purchase order (and optionally one of its lines) under a cost
 * category. Server-rendered and fully usable without JavaScript: every button is a submit with an
 * `intent` (`recalculate`, `add-line`, `save`) or a `removeLine` index, and the page re-renders
 * with the echoed values and the recomputed running total.
 */
export function BillEditor({
  action,
  options,
  values,
  errors,
  formError,
  totals,
  title,
  reference,
}: {
  action: string;
  options: BillEditorOptions;
  values: BillFormValues;
  errors: Record<string, string>;
  formError: string | null;
  totals: BillTotalsView;
  title: string;
  /** Existing bill's reference (edit) — null for a new bill. */
  reference: string | null;
}) {
  const scalars = values.scalars;
  const currency = scalars.currency || '';
  const isSupplier = (scalars.vendorType || 'FORWARDER') === 'SUPPLIER';

  return (
    <div className="bill-editor">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {reference ? <p className="muted">{reference} · draft</p> : null}
        </div>
        <Link to="/app/bills" className="button ghost small">
          Back to bills
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

      <Form method="post" action={action} noValidate className="calc-form" aria-label="Bill">
        <CsrfInput />

        <fieldset>
          <legend>Who sent it</legend>
          <div className={`field radios${errors.vendorType ? ' has-error' : ''}`}>
            <span className="label" id="vendorType-label">
              Vendor
            </span>
            {errors.vendorType ? (
              <span className="field-error" id="vendorType-error">
                {errors.vendorType}
              </span>
            ) : null}
            {VENDOR_TYPES.map((code) => (
              <div className="check" key={code}>
                <input
                  type="radio"
                  id={`vendorType-${code}`}
                  name="vendorType"
                  value={code}
                  defaultChecked={(scalars.vendorType || 'FORWARDER') === code}
                  aria-describedby={errors.vendorType ? 'vendorType-error' : undefined}
                />
                <label htmlFor={`vendorType-${code}`}>{VENDOR_TYPE_LABELS[code]}</label>
              </div>
            ))}
          </div>
          <div className="inline-fields">
            <Field
              name="supplierId"
              label="Supplier"
              hint={
                isSupplier
                  ? 'The supplier this invoice or credit note is from.'
                  : 'Only for supplier bills.'
              }
              errors={errors}
            >
              {(aria) => (
                <select {...aria} name="supplierId" defaultValue={scalars.supplierId ?? ''}>
                  <option value="">Choose a supplier</option>
                  {options.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.archived ? ' · archived' : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <TextInput
              name="vendorName"
              label="Vendor name"
              hint={
                isSupplier
                  ? 'Not needed for supplier bills.'
                  : 'The forwarder, broker or other company.'
              }
              values={scalars}
              errors={errors}
              maxLength={200}
            />
          </div>
          <div className="inline-fields">
            <Field name="billType" label="Kind of bill" errors={errors}>
              {(aria) => (
                <select {...aria} name="billType" defaultValue={scalars.billType ?? ''}>
                  <option value="">Choose</option>
                  {BILL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {BILL_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <TextInput
              name="referenceNumber"
              label="Vendor's reference"
              hint="Invoice, credit note or statement number, exactly as printed. The same reference from the same vendor is refused."
              values={scalars}
              errors={errors}
              className="narrow"
              maxLength={64}
            />
          </div>
          <div className="check">
            <input
              type="checkbox"
              id="isCreditNote"
              name="isCreditNote"
              defaultChecked={scalars.isCreditNote === 'on'}
            />
            <label htmlFor="isCreditNote">
              This is a credit note (its lines reduce the actual costs)
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Amount and dates</legend>
          <div className="inline-fields">
            <Field name="currency" label="Currency" errors={errors}>
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
            <TextInput
              name="totalAmount"
              label={`Bill total (${currency || 'currency'})`}
              hint="Must equal the sum of the lines before the bill can be posted."
              values={scalars}
              errors={errors}
              inputMode="decimal"
              className="narrow"
            />
          </div>
          <div className="inline-fields">
            <Field name="issuedOn" label="Issued on" errors={errors}>
              {(aria) => (
                <input
                  {...aria}
                  type="date"
                  name="issuedOn"
                  defaultValue={scalars.issuedOn ?? ''}
                  className="narrow"
                />
              )}
            </Field>
            <Field name="dueOn" label="Due on (optional)" errors={errors}>
              {(aria) => (
                <input
                  {...aria}
                  type="date"
                  name="dueOn"
                  defaultValue={scalars.dueOn ?? ''}
                  className="narrow"
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset id="lines">
          <legend>Lines</legend>
          <p className="hint">
            Every line is booked to a purchase order; pick one of its products when the cost belongs
            to that SKU, or leave it shared and it is apportioned across the order.
          </p>
          {errors.lines ? (
            <span className="field-error" id="lines-error">
              {errors.lines}
            </span>
          ) : null}
          {options.orders.length === 0 ? (
            <p className="hint">
              No purchase orders yet. <Link to="/app/orders/new">Create one</Link> before recording
              its bills.
            </p>
          ) : null}
          <ol className="item-list">
            {values.lines.map((line, i) => {
              const order = orderOf(options, line);
              const name = (f: Parameters<typeof lineFieldName>[1]) => lineFieldName(i, f);
              return (
                <li className="line-card" key={i}>
                  <div className="line-head">
                    <strong>Line {i + 1}</strong>
                    <button
                      type="submit"
                      name="removeLine"
                      value={String(i)}
                      className="button ghost small"
                      formNoValidate
                    >
                      Remove
                    </button>
                  </div>
                  <div className="inline-fields">
                    <Field
                      name={name('purchaseOrderId')}
                      label="Purchase order"
                      hint="Recalculate after changing it to list that order's products."
                      errors={errors}
                    >
                      {(aria) => (
                        <select
                          {...aria}
                          name={name('purchaseOrderId')}
                          defaultValue={line.purchaseOrderId}
                        >
                          <option value="">Choose an order</option>
                          {options.orders.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.poNumber} · {o.supplierName} ·{' '}
                              {o.status.toLowerCase().replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    <Field
                      name={name('purchaseOrderItemId')}
                      label="Product (optional)"
                      errors={errors}
                    >
                      {(aria) => (
                        <select
                          {...aria}
                          name={name('purchaseOrderItemId')}
                          defaultValue={line.purchaseOrderItemId}
                        >
                          <option value="">Shared across the order</option>
                          {(order?.items ?? []).map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.sku} — {it.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </div>
                  <div className="inline-fields">
                    <Field name={name('costCategory')} label="Cost category" errors={errors}>
                      {(aria) => (
                        <select
                          {...aria}
                          name={name('costCategory')}
                          defaultValue={line.costCategory}
                        >
                          <option value="">Choose</option>
                          {COST_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {COST_CATEGORY_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    <Field
                      name={name('unplannedReason')}
                      label="Why (unplanned costs only)"
                      errors={errors}
                    >
                      {(aria) => (
                        <select
                          {...aria}
                          name={name('unplannedReason')}
                          defaultValue={line.unplannedReason}
                        >
                          <option value="">Not an unplanned cost</option>
                          {UNPLANNED_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {UNPLANNED_REASON_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  </div>
                  <div className="inline-fields">
                    <TextInput
                      name={name('description')}
                      label="Description"
                      values={{ [name('description')]: line.description }}
                      errors={errors}
                      maxLength={200}
                    />
                    <TextInput
                      name={name('amount')}
                      label={`Amount (${currency || 'currency'})`}
                      hint="Negative for a discount line."
                      values={{ [name('amount')]: line.amount }}
                      errors={errors}
                      inputMode="decimal"
                      className="narrow"
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="form-actions">
            <button
              type="submit"
              name="intent"
              value="add-line"
              className="button secondary"
              formNoValidate
            >
              Add line
            </button>
          </div>
          <div className="order-totals" aria-live="polite">
            <span className="muted">
              Lines total{totals.complete ? '' : ' (valid lines only)'}
              {totals.balanced ? ' · matches the bill total' : ''}
            </span>
            <strong>{currency ? money(totals.linesTotal, currency) : '—'}</strong>
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
            {reference ? 'Save draft' : 'Create draft'}
          </button>
        </div>
      </Form>
    </div>
  );
}
