import type { HsCandidate } from '@harbour/engine';
import { Form, data } from 'react-router';
import type { Route } from './+types/calculator';
import { QuoteResult, type QuoteOutcome } from '../components/quote-result';
import { ORIGIN_COUNTRIES } from '../data/countries';
import { getApp } from '../services/app.server';
import { requestLogger } from '../services/logger.server';
import { runQuotePipeline } from '../services/quote-pipeline.server';
import { CALCULATOR_LIMIT } from '../services/rate-limit.server';
import { clientIp, readForm } from '../services/request.server';
import { TURNSTILE_FIELD } from '../services/turnstile.server';
import { INCOTERMS, buildCalculatorSchema, formDataToRecord } from '../validators/calculator';
import { CURRENCIES, fieldErrors } from '../validators/common';

export const meta: Route.MetaFunction = () => [{ title: 'Landed-cost calculator — Harbour' }];

export const loader = async () => {
  const app = await getApp();
  return {
    lanes: app.lanes,
    currencies: CURRENCIES,
    countries: ORIGIN_COUNTRIES,
    incoterms: INCOTERMS,
    turnstileSiteKey: app.turnstile.enabled ? app.turnstile.siteKey : null,
    rateSheet: {
      version: app.rateSheet.version,
      placeholder: app.rateSheet.placeholder,
      validUntil: app.rateSheet.validUntil,
    },
    fxSource: app.fx.source,
    calcVersion: app.calcVersion,
  };
};

export interface CalculatorActionData {
  /** Raw submitted strings, echoed back so the form keeps its state without JS. */
  values: Record<string, string>;
  /** Field name → first validation message. */
  errors: Record<string, string>;
  formError: string | null;
  /** When a 6/8-digit code is ambiguous: the 10-digit codes to choose from. */
  hsCandidates: HsCandidate[] | null;
  outcome: QuoteOutcome | null;
}

const reply = (partial: Partial<CalculatorActionData>): CalculatorActionData => ({
  values: {},
  errors: {},
  formError: null,
  hsCandidates: null,
  outcome: null,
  ...partial,
});

export const action = async ({ request }: Route.ActionArgs) => {
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const started = Date.now();

  const form = await readForm(request);
  if (!form) {
    return data(reply({ formError: 'We could not read that submission. Please try again.' }), {
      status: 400,
    });
  }
  const values = formDataToRecord(form);

  // (a) honeypot — bots fill every field.
  if (values.website) {
    log.info('calculator.honeypot');
    return data(reply({ values, formError: 'Something went wrong. Please try again.' }), {
      status: 400,
    });
  }

  // (c) validate — cheap, and users should not burn a Turnstile token or a rate-limit slot on a typo.
  const schema = buildCalculatorSchema(app.lanes.map((l) => l.key));
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('calculator.invalid', { fields: Object.keys(errors) });
    return data(
      reply({ values, errors, formError: 'Check the highlighted fields and try again.' }),
      { status: 400 },
    );
  }

  // (a) Turnstile — only when configured.
  const turnstile = await app.turnstile.verify(values[TURNSTILE_FIELD]);
  if (!turnstile.ok) {
    log.info('calculator.turnstile_rejected', { reason: turnstile.reason });
    const formError =
      turnstile.reason === 'UNAVAILABLE'
        ? 'We could not confirm you are human right now. Please try again in a minute.'
        : 'Please complete the "I am human" check and submit again.';
    return data(reply({ values, formError }), { status: 400 });
  }

  // (b) rate limit — 20 calculations per hour per IP.
  const limit = await app.rateLimiter.consume(clientIp(request), CALCULATOR_LIMIT);
  if (!limit.allowed) {
    log.warn('calculator.rate_limited', { retryAfterSeconds: limit.retryAfterSeconds });
    const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
    return data(
      reply({
        values,
        formError: `You have reached the limit of ${CALCULATOR_LIMIT.capacity} calculations an hour. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      }),
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  // (d) pipeline.
  const outcome = await runQuotePipeline(parsed.data, {
    tariff: app.tariff,
    fxStore: app.stores.fxStore,
    freight: app.freight,
  });

  switch (outcome.kind) {
    case 'HS_CHOICE_REQUIRED':
      log.info('calculator.hs_choice_required', {
        entered: outcome.enteredCode,
        candidates: outcome.candidates.length,
      });
      return data(
        reply({
          values,
          hsCandidates: outcome.candidates,
          formError: `Code ${outcome.enteredCode} covers ${outcome.candidates.length} commodity codes. Choose the one that matches your product and calculate again.`,
        }),
        { status: 200 },
      );
    case 'FAILED':
      log.warn('calculator.failed', { stage: outcome.stage, message: outcome.message });
      return data(
        reply({
          values,
          formError: outcome.message,
          errors:
            outcome.stage === 'resolveFx' ? { manualFxRate: 'Enter a rate to continue.' } : {},
        }),
        { status: 422 },
      );
    case 'QUOTE': {
      const q = outcome.quote;
      // Phase 0 gate metric (200 completed calculations). No IP, no email, no free text (§7.3).
      log.info('calculator.completed', {
        status: q.status,
        incoterm: q.incoterm,
        mode: q.mode,
        originPort: parsed.data.lane.split(':')[0],
        destinationPort: parsed.data.lane.split(':')[1],
        originCountry: parsed.data.originCountry,
        hsChapter: outcome.tariff.code.slice(0, 2),
        hsVerified: outcome.tariff.verified,
        currency: parsed.data.currency,
        quantity: parsed.data.quantity,
        fxSource: q.fxSource,
        rateSource: q.rateSource,
        calcVersion: q.calcVersion,
        warningCodes: q.warnings.map((w) => w.code),
        blockingWarnings: q.warnings.filter((w) => w.blocking).length,
        durationMs: Date.now() - started,
      });
      return data(reply({ values, outcome }), { status: 200 });
    }
  }
};

// ---------- view ----------

type Values = Record<string, string>;
type Errors = Record<string, string>;

function Field({
  name,
  label,
  hint,
  errors,
  children,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  errors: Errors;
  children: (aria: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => React.ReactNode;
}) {
  const error = errors[name];
  const hintId = hint ? `${name}-hint` : undefined;
  const errorId = error ? `${name}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={name}>{label}</label>
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
      {children({ id: name, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
    </div>
  );
}

function Text({
  name,
  label,
  hint,
  values,
  errors,
  inputMode = 'decimal',
  className,
  placeholder,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  values: Values;
  errors: Errors;
  inputMode?: 'decimal' | 'numeric' | 'text';
  className?: string;
  placeholder?: string;
}) {
  return (
    <Field name={name} label={label} hint={hint} errors={errors}>
      {(aria) => (
        <input
          {...aria}
          type="text"
          name={name}
          inputMode={inputMode}
          autoComplete="off"
          defaultValue={values[name] ?? ''}
          className={className}
          placeholder={placeholder}
        />
      )}
    </Field>
  );
}

function Check({
  name,
  label,
  values,
  hint,
}: {
  name: string;
  label: string;
  values: Values;
  hint?: string | undefined;
}) {
  return (
    <div className="check">
      <input
        type="checkbox"
        id={name}
        name={name}
        value="on"
        defaultChecked={values[name] === 'on'}
      />
      <label htmlFor={name}>
        {label}
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
    </div>
  );
}

export default function Calculator({ loaderData, actionData }: Route.ComponentProps) {
  const values: Values = actionData?.values ?? {};
  const errors: Errors = actionData?.errors ?? {};
  const candidates = actionData?.hsCandidates ?? null;
  const outcome = actionData?.outcome ?? null;

  return (
    <>
      <h1>Landed-cost calculator</h1>
      <p className="lede">
        Enter one product and its route. You get the fully landed cost per unit — freight, UK duty
        from the live tariff, import VAT and fees — and a plain list of anything we could not
        verify. No account needed.
      </p>

      {loaderData.rateSheet.placeholder ? (
        <div className="banner notice">
          <p>
            <strong>Preview rates.</strong> Freight uses rate sheet {loaderData.rateSheet.version},
            which holds placeholder figures until it is refreshed from market indices and forwarder
            quotes.
            {loaderData.fxSource === 'sample'
              ? ' Exchange rates are sample values, not HMRC published rates.'
              : ''}
          </p>
        </div>
      ) : null}

      {actionData?.formError ? (
        <div className="banner error" role="alert">
          <h2>There is a problem</h2>
          <p>{actionData.formError}</p>
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

      {outcome ? <QuoteResult outcome={outcome} calcVersion={loaderData.calcVersion} /> : null}

      <Form method="post" noValidate className="calc-form" aria-label="Landed-cost calculator">
        <fieldset>
          <legend>Route</legend>
          <Field
            name="lane"
            label="Route and mode"
            hint="Lanes on our current rate sheet."
            errors={errors}
          >
            {(aria) => (
              <select {...aria} name="lane" defaultValue={values.lane ?? ''}>
                <option value="">Choose a route</option>
                {loaderData.lanes.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            name="incoterm"
            label="Incoterm"
            hint="What the supplier price already includes. FOB and EXW are the most common for micro-importers."
            errors={errors}
          >
            {(aria) => (
              <select
                {...aria}
                name="incoterm"
                defaultValue={values.incoterm ?? 'FOB'}
                className="narrow"
              >
                {loaderData.incoterms.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Check
            name="includeOriginFees"
            label="Origin charges are not included in my FCA/FOB price"
            hint="Only affects FCA and FOB. Adds the origin handling and export documentation fees."
            values={values}
          />
          <Text
            name="supplierFreightTotalGbp"
            label="Supplier's freight total included in the price (GBP) — DAP, DPU and DDP only"
            hint="Needed to work out the customs value when the supplier price includes delivery."
            values={values}
            errors={errors}
            className="narrow"
          />
          <Text
            name="supplierFreightUkGbp"
            label="Of which the UK leg (GBP)"
            hint="The post-border portion (UK haulage). Leave blank if unknown; we then treat it all as dutiable."
            values={values}
            errors={errors}
            className="narrow"
          />
        </fieldset>

        <fieldset>
          <legend>Product</legend>
          <Text
            name="productLabel"
            label="Product name (optional)"
            values={values}
            errors={errors}
            inputMode="text"
            placeholder="e.g. Wooden toy train set"
          />

          {candidates ? (
            <div className={`field radios${errors.hsCode ? ' has-error' : ''}`}>
              <span className="label" id="hsCode-label">
                Choose the 10-digit commodity code
              </span>
              <span className="hint">
                {values.hsCode} maps to several codes. The declared code matters beyond duty, so we
                never pick for you.
              </span>
              {candidates.map((c, i) => (
                <div className="check" key={c.code}>
                  <input
                    type="radio"
                    id={`hsCode-${c.code}`}
                    name="hsCode"
                    value={c.code}
                    defaultChecked={i === 0}
                  />
                  <label htmlFor={`hsCode-${c.code}`}>
                    <span className="code">{c.code}</span>
                    {c.description ? ` — ${c.description}` : ''}
                    {c.thirdCountryDuty ? ` (third-country duty ${c.thirdCountryDuty})` : ''}
                  </label>
                </div>
              ))}
            </div>
          ) : (
            <Text
              name="hsCode"
              label="HS or commodity code"
              hint="6, 8 or 10 digits. Find it on trade-tariff.service.gov.uk. Dots and spaces are fine."
              values={values}
              errors={errors}
              inputMode="numeric"
              className="narrow"
              placeholder="9503004100"
            />
          )}

          <Field
            name="originCountry"
            label="Country of origin"
            hint="Where the goods were made — not where they ship from, if different."
            errors={errors}
          >
            {(aria) => (
              <select
                {...aria}
                name="originCountry"
                defaultValue={values.originCountry ?? 'CN'}
                className="narrow"
              >
                {loaderData.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Check
            name="preferenceClaimed"
            label="I hold proof of preferential origin"
            hint="A statement on origin or certificate that lets you claim a trade-agreement duty rate."
            values={values}
          />

          <div className="inline-fields">
            <Text
              name="quantity"
              label="Quantity"
              values={values}
              errors={errors}
              inputMode="numeric"
              className="narrow"
            />
            <Text
              name="unitPrice"
              label="Unit price"
              values={values}
              errors={errors}
              className="narrow"
            />
            <Field name="currency" label="Currency" errors={errors}>
              {(aria) => (
                <select
                  {...aria}
                  name="currency"
                  defaultValue={values.currency ?? 'USD'}
                  className="narrow"
                >
                  {loaderData.currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div className="field" />

          <Text
            name="unitWeightKg"
            label="Weight per unit (kg)"
            hint="Gross weight, packaging included."
            values={values}
            errors={errors}
            className="narrow"
          />

          <Text
            name="unitVolumeCbm"
            label="Volume per unit (CBM)"
            hint="Cubic metres per unit, if you know it. Otherwise fill in the carton details below."
            values={values}
            errors={errors}
            className="narrow"
          />
          <div className="inline-fields">
            <Text
              name="cartonLengthCm"
              label="Carton length (cm)"
              values={values}
              errors={errors}
              className="narrow"
            />
            <Text
              name="cartonWidthCm"
              label="Carton width (cm)"
              values={values}
              errors={errors}
              className="narrow"
            />
            <Text
              name="cartonHeightCm"
              label="Carton height (cm)"
              values={values}
              errors={errors}
              className="narrow"
            />
            <Text
              name="unitsPerCarton"
              label="Units per carton"
              values={values}
              errors={errors}
              inputMode="numeric"
              className="narrow"
            />
          </div>
          <div className="field" />
        </fieldset>

        <fieldset>
          <legend>Options</legend>
          <Check
            name="vatRegistered"
            label="My business is VAT registered"
            hint="Import VAT is then usually recoverable through postponed VAT accounting."
            values={values}
          />
          <Text
            name="insurancePremiumGbp"
            label="Cargo insurance premium (GBP, optional)"
            values={values}
            errors={errors}
            className="narrow"
          />
          <Text
            name="manualFxRate"
            label="Manual exchange rate (optional)"
            hint="GBP per 1 unit of the price currency, e.g. 0.78 for USD. Overrides the loaded rate."
            values={values}
            errors={errors}
            className="narrow"
          />
          <Check
            name="manualDuty"
            label="Enter the duty rate manually instead of looking it up"
            hint="Use this if the tariff lookup is unavailable or you already know the rates. The quote will be marked indicative."
            values={values}
          />
          <div className="inline-fields">
            <Text
              name="manualDutyRatePct"
              label="Duty rate (%)"
              values={values}
              errors={errors}
              className="narrow"
            />
            <Text
              name="manualVatRatePct"
              label="VAT rate (%)"
              values={values}
              errors={errors}
              className="narrow"
              placeholder="20"
            />
            <Text
              name="manualAddRatePct"
              label="Anti-dumping (%)"
              values={values}
              errors={errors}
              className="narrow"
            />
          </div>
          <div className="field" />
        </fieldset>

        <div className="honeypot" aria-hidden="true">
          <label htmlFor="website">Leave this field empty</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        {loaderData.turnstileSiteKey ? (
          <>
            <div
              className="cf-turnstile"
              data-sitekey={loaderData.turnstileSiteKey}
              data-theme="light"
            />
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          </>
        ) : null}

        <button type="submit" className="button">
          Calculate landed cost
        </button>
      </Form>
    </>
  );
}
