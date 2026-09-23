import type { ReactNode } from 'react';

/**
 * Small form-field helpers for the catalogue forms (M3). Plain HTML controls with hint/error
 * wiring (`aria-describedby`, `aria-invalid`), the same markup the calculator uses, so the forms
 * work before hydration and with no JavaScript at all.
 */

export type Values = Record<string, string>;
export type Errors = Record<string, string>;

export function Field({
  name,
  label,
  hint,
  errors,
  idPrefix = '',
  className,
  children,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  errors: Errors;
  /** Distinguishes repeated forms on one page (e.g. each pickup location). */
  idPrefix?: string;
  className?: string;
  children: (aria: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}) {
  const id = `${idPrefix}${name}`;
  const error = errors[name];
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
    </div>
  );
}

export function TextInput({
  name,
  label,
  hint,
  values,
  errors,
  idPrefix,
  inputMode = 'text',
  className,
  placeholder,
  required,
  maxLength,
  autoComplete = 'off',
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  values: Values;
  errors: Errors;
  idPrefix?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
  className?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  autoComplete?: string;
}) {
  return (
    <Field name={name} label={label} hint={hint} errors={errors} idPrefix={idPrefix ?? ''}>
      {(aria) => (
        <input
          {...aria}
          type="text"
          name={name}
          inputMode={inputMode}
          autoComplete={autoComplete}
          defaultValue={values[name] ?? ''}
          className={className}
          placeholder={placeholder}
          required={required}
          maxLength={maxLength}
        />
      )}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectInput({
  name,
  label,
  hint,
  values,
  errors,
  idPrefix,
  options,
  blankLabel,
  className,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  values: Values;
  errors: Errors;
  idPrefix?: string;
  options: readonly Option[];
  /** When given, a first empty option with this label (the field is optional). */
  blankLabel?: string;
  className?: string;
}) {
  return (
    <Field name={name} label={label} hint={hint} errors={errors} idPrefix={idPrefix ?? ''}>
      {(aria) => (
        <select {...aria} name={name} defaultValue={values[name] ?? ''} className={className}>
          {blankLabel !== undefined ? <option value="">{blankLabel}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function CheckboxInput({
  name,
  label,
  values,
  idPrefix = '',
}: {
  name: string;
  label: string;
  values: Values;
  idPrefix?: string;
}) {
  const id = `${idPrefix}${name}`;
  const v = values[name];
  return (
    <div className="check">
      <input
        type="checkbox"
        id={id}
        name={name}
        defaultChecked={v === 'on' || v === 'true' || v === '1'}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** Values for a form: every named field as a string (nulls → ''). */
export const valuesFrom = (
  source: Record<string, string | number | boolean | null | undefined>,
): Values => {
  const out: Values = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v === null || v === undefined ? '' : v === true ? 'on' : v === false ? '' : String(v);
  }
  return out;
};
