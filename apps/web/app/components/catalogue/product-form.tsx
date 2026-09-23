import { Form, Link } from 'react-router';
import { COUNTRIES_BY_NAME } from '../../data/countries-all';
import type { HsFieldState } from '../../services/catalogue/product-form.server';
import { CURRENCIES } from '../../validators/common';
import { CsrfInput } from '../csrf';
import { SelectInput, TextInput, type Errors, type Values } from './fields';
import { HsCodeField } from './hs-code-field';

/**
 * Add / edit product form (UX spec "Add or edit product"): three sections mapped to the Prisma
 * `Product` model — Identity, Sourcing, Logistics and compliance. One `<Form method="post">`
 * with `intent` buttons; the HS field carries its own "Check code" submit.
 */

export interface SupplierOption {
  id: string;
  name: string;
}

const COUNTRY_OPTIONS = COUNTRIES_BY_NAME.map((c) => ({
  value: c.code,
  label: `${c.name} (${c.code})`,
}));
const CURRENCY_OPTIONS = CURRENCIES.map((c) => ({ value: c, label: c }));

export function ProductForm({
  values,
  errors,
  hs,
  suppliers,
  notice,
  product,
}: {
  values: Values;
  errors: Errors;
  hs: HsFieldState;
  suppliers: readonly SupplierOption[];
  notice: string | null;
  /** The stored product when editing; null for the "new" form. */
  product: {
    id: string;
    hsCode: string;
    hsDescription: string | null;
    hsCodeVerifiedAt: string | null;
    archivedAt: string | null;
    volumeCbm: string;
  } | null;
}) {
  const formError = errors._form;
  return (
    <Form method="post" noValidate className="catalogue-form" aria-label="Product">
      <CsrfInput />
      {notice ? (
        <div className="banner indicative" role="status">
          <p>{notice}</p>
        </div>
      ) : null}
      {formError ? (
        <div className="banner error" role="alert">
          <p>{formError}</p>
        </div>
      ) : null}
      {product?.archivedAt ? (
        <div className="banner notice" role="status">
          <p>
            This product is archived. It stays on old quotes but cannot be added to new ones until
            you restore it.
          </p>
        </div>
      ) : null}

      <fieldset>
        <legend>Identity</legend>
        <TextInput
          name="sku"
          label="SKU"
          hint="Your own product code, unique in this organisation. Up to 64 letters, digits, dots, dashes or slashes."
          values={values}
          errors={errors}
          className="narrow"
          required
          maxLength={64}
        />
        <TextInput
          name="name"
          label="Product name"
          values={values}
          errors={errors}
          required
          maxLength={200}
          placeholder="e.g. Wooden toy train set"
        />
        <SelectInput
          name="supplierId"
          label="Supplier"
          hint="Optional. Pre-fills the currency and, later, the origin port from the supplier's pickup location."
          values={values}
          errors={errors}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          blankLabel="No supplier yet"
        />
        <p className="hint">
          Not listed? <Link to="/app/suppliers/new">Create a supplier</Link> first, then come back.
        </p>
      </fieldset>

      <fieldset>
        <legend>Sourcing</legend>
        <SelectInput
          name="originCountry"
          label="Country of origin"
          hint="Where the goods were made. It can differ from the supplier's country and it drives preferential duty rates."
          values={values}
          errors={errors}
          options={COUNTRY_OPTIONS}
          blankLabel="Choose a country"
        />
        <div className="inline-fields">
          <TextInput
            name="unitValue"
            label="Unit value"
            hint="Supplier price per unit, up to 4 decimal places."
            values={values}
            errors={errors}
            inputMode="decimal"
            className="narrow"
            required
          />
          <SelectInput
            name="currency"
            label="Currency"
            values={values}
            errors={errors}
            options={CURRENCY_OPTIONS}
            className="narrow"
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Logistics and compliance</legend>
        <TextInput
          name="weightKg"
          label="Weight per unit (kg)"
          hint="Gross weight per unit, up to 3 decimal places."
          values={values}
          errors={errors}
          inputMode="decimal"
          className="narrow"
          required
        />
        <TextInput
          name="volumeCbm"
          label="Volume per unit (CBM)"
          hint="Leave blank to work it out from the carton below."
          values={values}
          errors={errors}
          inputMode="decimal"
          className="narrow"
        />
        <div className="subgroup">
          <p className="label">Or carton size and units per carton</p>
          <span className="hint">
            Length × width × height in cm, divided by the units in one carton, gives the CBM per
            unit (4 decimal places).
          </span>
          <div className="inline-fields">
            <TextInput
              name="cartonLengthCm"
              label="Length (cm)"
              values={values}
              errors={errors}
              inputMode="decimal"
              className="narrow"
            />
            <TextInput
              name="cartonWidthCm"
              label="Width (cm)"
              values={values}
              errors={errors}
              inputMode="decimal"
              className="narrow"
            />
            <TextInput
              name="cartonHeightCm"
              label="Height (cm)"
              values={values}
              errors={errors}
              inputMode="decimal"
              className="narrow"
            />
            <TextInput
              name="unitsPerCarton"
              label="Units per carton"
              values={values}
              errors={errors}
              inputMode="numeric"
              className="narrow"
            />
          </div>
          {product ? (
            <p className="hint">
              Stored volume: <span className="code">{product.volumeCbm}</span> CBM per unit.
            </p>
          ) : null}
        </div>
        <HsCodeField
          values={values}
          errors={errors}
          hs={hs}
          verified={
            product
              ? {
                  hsCode: product.hsCode,
                  description: product.hsDescription,
                  verifiedAt: product.hsCodeVerifiedAt,
                }
              : null
          }
        />
      </fieldset>

      <div className="form-actions">
        <button type="submit" name="intent" value="save" className="button">
          {product ? 'Save changes' : 'Add product'}
        </button>
        {product ? (
          product.archivedAt ? (
            <button type="submit" name="intent" value="restore" className="button secondary">
              Restore
            </button>
          ) : (
            <button type="submit" name="intent" value="archive" className="button secondary">
              Archive
            </button>
          )
        ) : null}
        <Link to="/app/products">Cancel</Link>
      </div>
    </Form>
  );
}
