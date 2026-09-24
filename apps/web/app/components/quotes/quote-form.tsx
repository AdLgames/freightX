import { useEffect, useRef } from 'react';
import { Form, Link, useFetcher } from 'react-router';
import type { BuilderActionData, BuilderOptions } from '../../services/quotes/builder.server';
import type { PurchaseOrderContext } from '../../services/orders/freight-quote.server'; // M7
import type { QuoteView } from '../../services/quotes/view';
import { INCOTERMS } from '../../validators/calculator';
import { CURRENCIES } from '../../validators/common';
import {
  INCOTERM_LABELS,
  QUOTE_DUTY_PAYMENT_LABELS,
  QUOTE_DUTY_PAYMENT_METHODS,
  lineFieldName,
  type QuoteFormValues,
} from '../../validators/quote';
import { CheckboxInput, Field, TextInput } from '../catalogue/fields';
import { CsrfInput } from '../csrf';
import { PlanNotice } from '../plan-notice';
import { attachLivePreview } from './live-preview-client';
import { QuoteBreakdown } from './quote-breakdown';

/**
 * The quote builder (M4, UX spec "Quote builder"): inputs on the left, the sticky "True cost"
 * breakdown on the right. Server-rendered and fully usable without JavaScript — every button is a
 * submit with an `intent` (`recalculate`, `add-line`, `apply-supplier`, `save`) or a `removeLine`
 * index, and the page re-renders with the echoed values. After hydration `attachLivePreview`
 * debounces changes and posts the same form to `?preview=1` through a fetcher; the JSON view it
 * returns replaces the breakdown.
 */
export function QuoteBuilder({
  action,
  options,
  values,
  errors,
  formError,
  serverView,
  planNotice,
  title,
  reference,
  purchaseOrder = null, // M7
  rateMonth = null, // M7
}: {
  action: string;
  options: BuilderOptions;
  values: QuoteFormValues;
  errors: Record<string, string>;
  formError: string | null;
  serverView: QuoteView | null;
  planNotice: BuilderActionData['planNotice'];
  title: string;
  /** Existing quote's reference (edit) — null for a new quote. */
  reference: string | null;
  /** M7: the purchase order this quote is built from (`?po=`), for the banner. */
  purchaseOrder?: PurchaseOrderContext | null;
  /** M7: `YYYY-MM` the pipeline converts at (HMRC monthly rate for today). */
  rateMonth?: string | null;
}) {
  const fetcher = useFetcher<BuilderActionData>();
  const formRef = useRef<HTMLFormElement>(null);
  // The latest submit function, read at call time so the listener is attached once per action
  // (re-attaching on every render would drop pending debounces).
  const submitRef = useRef(fetcher.submit);
  submitRef.current = fetcher.submit;
  const previewAction = `${action}?preview=1`;
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    return attachLivePreview(form, {
      submit: (f) => {
        void submitRef.current(f, { method: 'post', action: previewAction });
      },
    });
  }, [previewAction]);

  const live = fetcher.data;
  const view = live?.view ?? (live?.formError ? null : serverView);
  const liveError = live?.formError ?? null;
  const pending = fetcher.state !== 'idle';
  const scalars = values.scalars;
  const productsById = new Map(options.products.map((p) => [p.id, p]));
  const activeProducts = options.products.filter((p) => !p.archived);

  return (
    <div className="quote-builder">
      <div className="quote-inputs">
        <div className="page-head">
          <div>
            <h1>{title}</h1>
            {reference ? <p className="muted">{reference} · draft</p> : null}
          </div>
          <Link to={reference ? `/app/quotes` : '/app/quotes'} className="button ghost small">
            Back to quotes
          </Link>
        </div>

        {options.rateSheet.placeholder ? (
          <div className="banner notice">
            <p>
              <strong>Preview rates.</strong> Freight uses rate sheet {options.rateSheet.version},
              which holds placeholder figures until it is refreshed from market indices and
              forwarder quotes.
            </p>
          </div>
        ) : null}

        {planNotice ? (
          <PlanNotice
            feature={planNotice.feature}
            requiredPlan={planNotice.requiredPlan}
            canManageBilling={planNotice.canManageBilling}
          />
        ) : null}

        {/* M7 */}
        {purchaseOrder ? (
          <div className="banner notice" data-testid="po-banner">
            <p>
              <strong>
                Pricing <Link to={`/app/orders/${purchaseOrder.id}`}>{purchaseOrder.poNumber}</Link>
                .
              </strong>{' '}
              Quantities and unit costs come from the purchase order, in {purchaseOrder.currency};
              weight, volume, HS code and origin from the catalogue.
              {rateMonth
                ? ` Duty and VAT convert at the HMRC monthly rate for ${rateMonth} (the quote's date)`
                : ''}
              {purchaseOrder.expectedShipMonth &&
              rateMonth &&
              purchaseOrder.expectedShipMonth > rateMonth
                ? `; HMRC has not published ${purchaseOrder.expectedShipMonth} yet, so update the draft to current values once it is.`
                : rateMonth
                  ? '.'
                  : ''}
              {purchaseOrder.laneMissingFor
                ? ` Our rate sheet has no route from ${purchaseOrder.laneMissingFor}; the nearest lane is pre-selected — check it.`
                : ''}
            </p>
          </div>
        ) : null}
        {/* end M7 */}

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
          className="calc-form quote-form"
          aria-label="Quote builder"
          ref={formRef}
        >
          <CsrfInput />
          {scalars.purchaseOrderId ? (
            <input type="hidden" name="purchaseOrderId" value={scalars.purchaseOrderId} />
          ) : null}

          <fieldset>
            <legend>Supplier and route</legend>
            <Field
              name="supplierId"
              label="Supplier (optional)"
              hint="Pre-fills the incoterm and the origin port from the supplier's default pickup location. Duty origin comes from each product."
              errors={errors}
            >
              {(aria) => (
                <div className="inline-fields supplier-row">
                  <select {...aria} name="supplierId" defaultValue={scalars.supplierId ?? ''}>
                    <option value="">No supplier</option>
                    {options.suppliers.map((s) => (
                      <option
                        key={s.id}
                        value={s.id}
                        data-incoterm={s.defaultIncoterm ?? undefined}
                        data-port={s.defaultPort ?? undefined}
                      >
                        {s.name}
                        {s.defaultPort ? ` · ${s.defaultPort}` : ''}
                        {s.defaultIncoterm ? ` · ${s.defaultIncoterm}` : ''}
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

            <Field
              name="lane"
              label="Route and mode"
              hint="Origin port, UK port and mode from our current rate sheet."
              errors={errors}
            >
              {(aria) => (
                <select {...aria} name="lane" defaultValue={scalars.lane ?? ''}>
                  <option value="">Choose a route</option>
                  {options.lanes.map((l) => (
                    <option
                      key={l.key}
                      value={l.key}
                      data-origin={l.origin}
                      data-destination={l.destination}
                      data-mode={l.mode}
                    >
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <CheckboxInput
              name="includeOriginFees"
              label="Origin charges are not included in my FCA/FOB price (adds them)"
              values={scalars}
            />
            <div className="inline-fields">
              <TextInput
                name="supplierFreightTotalGbp"
                label="Supplier's freight in the price (GBP) — DAP/DPU/DDP"
                hint="Needed for the customs value when the price includes delivery."
                values={scalars}
                errors={errors}
                inputMode="decimal"
                className="narrow"
              />
              <TextInput
                name="supplierFreightUkGbp"
                label="Of which the UK leg (GBP)"
                hint="Blank = unknown; then all of it counts as dutiable."
                values={scalars}
                errors={errors}
                inputMode="decimal"
                className="narrow"
              />
            </div>
          </fieldset>

          <fieldset className="quote-lines" id="lines">
            <legend>Products</legend>
            {errors.lines ? (
              <span className="field-error" id="lines-error">
                {errors.lines}
              </span>
            ) : null}
            {values.lines.length === 0 ? (
              <p className="muted">No lines yet. Add a product from your catalogue below.</p>
            ) : (
              <ol className="line-list">
                {values.lines.map((line, i) => {
                  const p = productsById.get(line.productId);
                  const qtyName = lineFieldName(i, 'quantity');
                  const assistsName = lineFieldName(i, 'assistsGbp');
                  const prefName = lineFieldName(i, 'preferenceClaimed');
                  return (
                    <li className="line-card" key={`${line.productId}-${i}`}>
                      <input
                        type="hidden"
                        name={lineFieldName(i, 'productId')}
                        value={line.productId}
                      />
                      {/* M7: PO unit cost travels with the line */}
                      {line.unitCost && line.currency ? (
                        <>
                          <input type="hidden" name={`line_${i}_unitCost`} value={line.unitCost} />
                          <input type="hidden" name={`line_${i}_currency`} value={line.currency} />
                        </>
                      ) : null}
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
                              HS <span className="code">{p.hsCode}</span>{' '}
                              {p.hsVerified ? (
                                <span className="hs-mark verified" title="Verified">
                                  {'✓'}
                                </span>
                              ) : (
                                <span
                                  className="hs-mark unverified"
                                  title="Unverified: this quote will be indicative"
                                >
                                  !
                                </span>
                              )}{' '}
                              · origin {p.originCountry} ·{' '}
                              {line.unitCost && line.currency
                                ? `${line.unitCost} ${line.currency} per unit (purchase order)`
                                : `${p.unitValue} ${p.currency} per unit`}{' '}
                              · {p.weightKg} kg · {p.volumeCbm} CBM
                              {p.archived ? ' · archived' : ''} ·{' '}
                              <Link to={`/app/products/${p.id}`}>Edit product</Link>
                            </p>
                          ) : null}
                        </div>
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
                      {errors[lineFieldName(i, 'productId')] ? (
                        <span className="field-error" id={lineFieldName(i, 'productId')}>
                          {errors[lineFieldName(i, 'productId')]}
                        </span>
                      ) : null}
                      <div className="inline-fields">
                        <TextInput
                          name={qtyName}
                          label="Quantity"
                          values={{ [qtyName]: line.quantity }}
                          errors={errors}
                          inputMode="numeric"
                          className="narrow"
                        />
                        <TextInput
                          name={assistsName}
                          label="Assists for this line (GBP, optional)"
                          hint="Tooling, moulds or design paid separately, apportioned to these units."
                          values={{ [assistsName]: line.assistsGbp }}
                          errors={errors}
                          inputMode="decimal"
                          className="narrow"
                        />
                      </div>
                      <CheckboxInput
                        name={prefName}
                        label="I hold proof of preferential origin for this product"
                        values={{ [prefName]: line.preferenceClaimed }}
                      />
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="add-line subgroup">
              <p className="label">Add from catalogue</p>
              <div className="inline-fields">
                <Field name="addProductId" label="Product" errors={errors}>
                  {(aria) => (
                    <select {...aria} name="addProductId" defaultValue={scalars.addProductId ?? ''}>
                      <option value="">Choose a product</option>
                      {activeProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({p.unitValue} {p.currency}
                          {p.hsVerified ? '' : ', HS unverified'})
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
                    value="add-line"
                    className="button secondary"
                    formNoValidate
                  >
                    Add line
                  </button>
                </div>
              </div>
              {activeProducts.length === 0 ? (
                <p className="hint">
                  Your catalogue is empty. <Link to="/app/products/new">Add a product</Link> first.
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset>
            <legend>VAT and duty payment</legend>
            <CheckboxInput
              name="vatRegistered"
              label="My business is VAT registered"
              values={scalars}
            />
            <CheckboxInput
              name="vatPostponed"
              label="I use postponed VAT accounting (PVA)"
              values={scalars}
            />
            <Field
              name="dutyPayment"
              label="How will duty be paid?"
              hint="Defaulted from your customs profile."
              errors={errors}
            >
              {(aria) => (
                <select {...aria} name="dutyPayment" defaultValue={scalars.dutyPayment ?? ''}>
                  {QUOTE_DUTY_PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {QUOTE_DUTY_PAYMENT_LABELS[m]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="subgroup">
              <p className="label">Forwarder deferment fee terms (BROKER_DEFERMENT only)</p>
              <span className="hint">
                {options.defaults.feeTermsFromConfig
                  ? 'Prefilled with our default terms; your customs profile has none yet.'
                  : 'From your customs profile. Blank: no deferment fee is included.'}
              </span>
              <div className="inline-fields">
                <TextInput
                  name="brokerFeePct"
                  label="Fee (% of duty and VAT paid)"
                  values={scalars}
                  errors={errors}
                  inputMode="decimal"
                  className="narrow"
                />
                <TextInput
                  name="brokerMinimumGbp"
                  label="Minimum fee (GBP)"
                  values={scalars}
                  errors={errors}
                  inputMode="decimal"
                  className="narrow"
                />
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Options</legend>
            <TextInput
              name="insurancePremiumGbp"
              label="Cargo insurance premium (GBP, optional)"
              values={scalars}
              errors={errors}
              inputMode="decimal"
              className="narrow"
            />
            <div className="inline-fields">
              <Field
                name="manualFxCurrency"
                label="Manual exchange rate: currency"
                errors={errors}
                hint="Overrides the loaded rate for one currency."
              >
                {(aria) => (
                  <select
                    {...aria}
                    name="manualFxCurrency"
                    defaultValue={scalars.manualFxCurrency ?? ''}
                    className="narrow"
                  >
                    <option value="">None</option>
                    {CURRENCIES.filter((c) => c !== 'GBP').map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <TextInput
                name="manualFxRate"
                label="GBP per 1 unit"
                values={scalars}
                errors={errors}
                inputMode="decimal"
                className="narrow"
                placeholder="0.78"
              />
            </div>
          </fieldset>

          <div className="form-actions">
            <button type="submit" name="intent" value="recalculate" className="button secondary">
              Recalculate
            </button>
            <button type="submit" name="intent" value="save" className="button lime">
              Save draft
            </button>
          </div>
        </Form>
      </div>

      <aside className="quote-side" aria-live="polite">
        <div className="quote-sticky">
          {pending ? <p className="hint quote-pending">Recalculating…</p> : null}
          {liveError ? (
            <div className="banner error" role="alert">
              <p>{liveError}</p>
            </div>
          ) : null}
          {view ? (
            <QuoteBreakdown view={view} compact />
          ) : (
            <section className="result quote-breakdown">
              <h2>True cost</h2>
              <p className="muted">
                Add at least one product and choose a route, then recalculate to see the landed cost
                per unit.
              </p>
            </section>
          )}
          <p className="hint">
            Engine <span className="code">{options.calcVersion}</span>. Figures update as you type
            when JavaScript is on; otherwise use Recalculate.
          </p>
        </div>
      </aside>
    </div>
  );
}
