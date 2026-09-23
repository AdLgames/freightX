import { Form, Link } from 'react-router';
import { COUNTRIES_BY_NAME, anyCountryName } from '../../data/countries-all';
import { PORT_NAMES, portName } from '../../data/ports';
import type { PickupLocationRecord } from '../../services/catalogue/suppliers.server';
import { INCOTERMS } from '../../validators/calculator';
import { CURRENCIES } from '../../validators/common';
import {
  BALANCE_TRIGGERS,
  BALANCE_TRIGGER_LABELS,
  INCOTERM_LABELS,
  PAYMENT_TERM_LABELS,
  PAYMENT_TERM_TYPES,
} from '../../validators/supplier';
import { CsrfInput } from '../csrf';
import { CheckboxInput, SelectInput, TextInput, type Errors, type Values } from './fields';

/**
 * Supplier page forms (ADR-0012): legal identity + sourcing defaults, payment terms, and one
 * form per pickup location plus an "add" form. Each posts `intent` to the same action; without
 * JavaScript every button is a normal submit.
 */

const COUNTRY_OPTIONS = COUNTRIES_BY_NAME.map((c) => ({
  value: c.code,
  label: `${c.name} (${c.code})`,
}));
const CURRENCY_OPTIONS = CURRENCIES.map((c) => ({ value: c, label: c }));
const INCOTERM_OPTIONS = INCOTERMS.map((i) => ({ value: i, label: INCOTERM_LABELS[i] }));
const TERM_OPTIONS = PAYMENT_TERM_TYPES.map((t) => ({ value: t, label: PAYMENT_TERM_LABELS[t] }));
const TRIGGER_OPTIONS = BALANCE_TRIGGERS.map((t) => ({
  value: t,
  label: BALANCE_TRIGGER_LABELS[t],
}));

export function SupplierIdentityForm({
  values,
  errors,
  notice,
  supplier,
}: {
  values: Values;
  errors: Errors;
  notice: string | null;
  supplier: { id: string; archivedAt: string | null; productCount: number } | null;
}) {
  return (
    <Form method="post" noValidate className="catalogue-form" aria-label="Supplier">
      <CsrfInput />
      {notice ? (
        <div className="banner indicative" role="status">
          <p>{notice}</p>
        </div>
      ) : null}
      {supplier?.archivedAt ? (
        <div className="banner notice" role="status">
          <p>
            This supplier is archived. Its products keep it, but it cannot be picked for new ones.
          </p>
        </div>
      ) : null}
      <fieldset>
        <legend>Legal identity</legend>
        <span className="hint">
          The registered business that invoices you. A payments partner screens these details, so
          use the name and number exactly as registered.
        </span>
        <TextInput
          name="legalName"
          label="Registered (legal) name"
          values={values}
          errors={errors}
          required
          maxLength={200}
        />
        <TextInput
          name="tradingName"
          label="Trading name (optional)"
          hint="Shown in lists when it differs from the legal name."
          values={values}
          errors={errors}
          maxLength={200}
        />
        <TextInput
          name="registrationNumber"
          label="Registration number (optional)"
          hint="For example a company number or China's Unified Social Credit Code."
          values={values}
          errors={errors}
          className="narrow"
          maxLength={64}
        />
        <SelectInput
          name="countryOfIncorporation"
          label="Country of incorporation"
          hint="Where the company is registered — not necessarily where the goods are made or collected."
          values={values}
          errors={errors}
          options={COUNTRY_OPTIONS}
          blankLabel="Choose a country"
        />
      </fieldset>
      <fieldset>
        <legend>Sourcing defaults</legend>
        <div className="inline-fields">
          <SelectInput
            name="defaultCurrency"
            label="Invoice currency"
            values={values}
            errors={errors}
            options={CURRENCY_OPTIONS}
            blankLabel="Not set"
            className="narrow"
          />
        </div>
        <SelectInput
          name="defaultIncoterm"
          label="Usual incoterm"
          values={values}
          errors={errors}
          options={INCOTERM_OPTIONS}
          blankLabel="Not set"
        />
      </fieldset>
      <div className="form-actions">
        <button type="submit" name="intent" value="save" className="button">
          {supplier ? 'Save changes' : 'Add supplier'}
        </button>
        {supplier ? (
          supplier.archivedAt ? (
            <button type="submit" name="intent" value="restore" className="button secondary">
              Restore
            </button>
          ) : (
            <button type="submit" name="intent" value="archive" className="button secondary">
              Archive
            </button>
          )
        ) : null}
        <Link to="/app/suppliers">Cancel</Link>
      </div>
    </Form>
  );
}

export function PaymentTermsForm({ values, errors }: { values: Values; errors: Errors }) {
  return (
    <Form method="post" noValidate className="catalogue-form" aria-labelledby="payment-terms-title">
      <CsrfInput />
      <fieldset>
        <legend id="payment-terms-title">Payment terms</legend>
        <span className="hint">
          When this supplier expects to be paid. Quotes and purchase orders will use these to work
          out when cash is needed.
        </span>
        <SelectInput
          name="termType"
          label="Terms"
          values={values}
          errors={errors}
          options={TERM_OPTIONS}
          blankLabel="Choose the terms"
        />
        <div className="inline-fields">
          <TextInput
            name="depositPct"
            label="Deposit (%)"
            hint="Deposit-and-balance terms only, e.g. 30."
            values={values}
            errors={errors}
            inputMode="decimal"
            className="narrow"
          />
          <TextInput
            name="netDays"
            label="Days until due"
            hint="Net terms: days after invoice. Deposit terms: days after the trigger (optional)."
            values={values}
            errors={errors}
            inputMode="numeric"
            className="narrow"
          />
        </div>
        <SelectInput
          name="balanceTrigger"
          label="Balance is due"
          hint="Deposit-and-balance terms only."
          values={values}
          errors={errors}
          options={TRIGGER_OPTIONS}
          blankLabel="Choose what releases the balance"
        />
      </fieldset>
      <div className="form-actions">
        <button type="submit" name="intent" value="payment-terms" className="button secondary">
          Save payment terms
        </button>
      </div>
    </Form>
  );
}

const PORT_OPTIONS = Object.keys(PORT_NAMES).map((code) => ({
  value: code,
  label: `${portName(code)} (${code})`,
}));

function PickupFields({
  values,
  errors,
  idPrefix,
}: {
  values: Values;
  errors: Errors;
  idPrefix: string;
}) {
  return (
    <>
      <TextInput
        name="name"
        label="Location name"
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        required
        maxLength={120}
        placeholder="e.g. Shenzhen factory"
      />
      <TextInput
        name="addressLine1"
        label="Address line 1"
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        maxLength={200}
        autoComplete="address-line1"
      />
      <TextInput
        name="addressLine2"
        label="Address line 2"
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        maxLength={200}
        autoComplete="address-line2"
      />
      <div className="inline-fields">
        <TextInput
          name="city"
          label="City"
          values={values}
          errors={errors}
          idPrefix={idPrefix}
          maxLength={100}
        />
        <TextInput
          name="region"
          label="Region / province"
          values={values}
          errors={errors}
          idPrefix={idPrefix}
          maxLength={100}
        />
        <TextInput
          name="postcode"
          label="Postcode"
          values={values}
          errors={errors}
          idPrefix={idPrefix}
          className="narrow"
          maxLength={20}
        />
      </div>
      <SelectInput
        name="country"
        label="Country"
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        options={COUNTRY_OPTIONS}
        blankLabel="Choose a country"
      />
      <SelectInput
        name="closestPortChoice"
        label="Closest port"
        hint="Ports on our rate sheet. The quote builder uses it as the origin port."
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        options={PORT_OPTIONS}
        blankLabel="Choose a port"
      />
      <TextInput
        name="closestPortCode"
        label="Or another port's UN/LOCODE"
        hint="Five characters, e.g. CNXMN for Xiamen. Overrides the pick above."
        values={values}
        errors={errors}
        idPrefix={idPrefix}
        className="narrow"
        maxLength={5}
      />
      <CheckboxInput
        name="isDefault"
        label="Default pickup location for this supplier"
        values={values}
        idPrefix={idPrefix}
      />
    </>
  );
}

export function PickupLocationForms({
  locations,
  addValues,
  addErrors,
  editing,
}: {
  locations: readonly PickupLocationRecord[];
  addValues: Values;
  addErrors: Errors;
  /** Values/errors of the location form that failed validation, keyed by location id. */
  editing: { id: string; values: Values; errors: Errors } | null;
}) {
  return (
    <section className="pickup-locations" aria-labelledby="pickup-title">
      <h3 id="pickup-title">Pickup locations</h3>
      <p className="hint">
        Where the goods are collected and the nearest port. A pickup location never decides the
        goods&apos; origin for duty; that is set on each product.
      </p>
      {locations.length === 0 ? <p className="muted">No pickup locations yet.</p> : null}
      {locations.map((loc) => {
        const isEditing = editing?.id === loc.id;
        const values = isEditing
          ? editing.values
          : {
              name: loc.name,
              addressLine1: loc.addressLine1 ?? '',
              addressLine2: loc.addressLine2 ?? '',
              city: loc.city ?? '',
              region: loc.region ?? '',
              postcode: loc.postcode ?? '',
              country: loc.country,
              closestPortChoice: loc.closestPortCode in PORT_NAMES ? loc.closestPortCode : '',
              closestPortCode: loc.closestPortCode in PORT_NAMES ? '' : loc.closestPortCode,
              isDefault: loc.isDefault ? 'on' : '',
            };
        const errors = isEditing ? editing.errors : {};
        const prefix = `pickup-${loc.id}-`;
        return (
          <details key={loc.id} className="pickup-location" open={isEditing}>
            <summary>
              {loc.name}
              {loc.isDefault ? <span className="status-pill ready"> Default</span> : null}
              <span className="muted">
                {' '}
                — {anyCountryName(loc.country)}, port {portName(loc.closestPortCode)} (
                {loc.closestPortCode})
              </span>
            </summary>
            <Form
              method="post"
              noValidate
              className="catalogue-form"
              aria-label={`Pickup location ${loc.name}`}
            >
              <CsrfInput />
              <input type="hidden" name="pickupId" value={loc.id} />
              <PickupFields values={values} errors={errors} idPrefix={prefix} />
              <div className="form-actions">
                <button
                  type="submit"
                  name="intent"
                  value="pickup-update"
                  className="button secondary"
                >
                  Save location
                </button>
                {!loc.isDefault ? (
                  <button
                    type="submit"
                    name="intent"
                    value="pickup-default"
                    className="button secondary"
                  >
                    Make default
                  </button>
                ) : null}
                <button
                  type="submit"
                  name="intent"
                  value="pickup-remove"
                  className="button secondary danger"
                >
                  Remove
                </button>
              </div>
            </Form>
          </details>
        );
      })}
      <details className="pickup-location" open={Object.keys(addErrors).length > 0}>
        <summary>Add a pickup location</summary>
        <Form method="post" noValidate className="catalogue-form" aria-label="New pickup location">
          <CsrfInput />
          <PickupFields values={addValues} errors={addErrors} idPrefix="pickup-new-" />
          <div className="form-actions">
            <button type="submit" name="intent" value="pickup-add" className="button secondary">
              Add location
            </button>
          </div>
        </Form>
      </details>
    </section>
  );
}
