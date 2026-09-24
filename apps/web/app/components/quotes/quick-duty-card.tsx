import type { QuoteWarning } from '@harbour/engine';
import { Form } from 'react-router';
import { COUNTRIES_BY_NAME } from '../../data/countries-all';
import type { QuickDutyResult } from '../../services/quotes/quick-duty.server';
import { CsrfInput } from '../csrf';
import { gbp, pct } from '../format';
import { WARNING_EXPLAINED } from '../quote-result';

/**
 * Home "Quick duty check" card (M4, UX spec Home): HS code + invoice value + origin → duty and
 * VAT rates, without saving a quote. Posts to Home itself (`intent=quick-duty`) so it works
 * without JavaScript; `/app/api/quick-duty` serves the same check as JSON.
 */
export function QuickDutyCard({
  values,
  errors,
  result,
}: {
  values: Record<string, string>;
  errors: Record<string, string>;
  result: QuickDutyResult | null;
}) {
  const err = (name: string) => errors[name];
  return (
    <section className="card quick-duty" aria-labelledby="quick-duty-title">
      <h2 id="quick-duty-title">Quick duty check</h2>
      <p className="muted small">
        Duty and VAT rates from the UK tariff for a code and origin. Nothing is saved.
      </p>
      {/* `?index`: Home is the /app index route, so a plain POST to /app would hit the layout. */}
      <Form method="post" action="/app?index" noValidate className="quick-duty-form">
        <CsrfInput />
        <input type="hidden" name="intent" value="quick-duty" />
        <div className={`field${err('hsCode') ? ' has-error' : ''}`}>
          <label htmlFor="qd-hsCode">HS code</label>
          {err('hsCode') ? (
            <span className="field-error" id="qd-hsCode-error">
              {err('hsCode')}
            </span>
          ) : null}
          <input
            id="qd-hsCode"
            name="hsCode"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="9503004100"
            defaultValue={values.hsCode ?? ''}
            aria-invalid={Boolean(err('hsCode'))}
            aria-describedby={err('hsCode') ? 'qd-hsCode-error' : undefined}
          />
        </div>
        <div className={`field${err('invoiceValueGbp') ? ' has-error' : ''}`}>
          <label htmlFor="qd-invoiceValueGbp">Invoice value (GBP)</label>
          {err('invoiceValueGbp') ? (
            <span className="field-error" id="qd-invoiceValueGbp-error">
              {err('invoiceValueGbp')}
            </span>
          ) : null}
          <input
            id="qd-invoiceValueGbp"
            name="invoiceValueGbp"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="2500.00"
            defaultValue={values.invoiceValueGbp ?? ''}
            aria-invalid={Boolean(err('invoiceValueGbp'))}
            aria-describedby={err('invoiceValueGbp') ? 'qd-invoiceValueGbp-error' : undefined}
          />
        </div>
        <div className={`field${err('originCountry') ? ' has-error' : ''}`}>
          <label htmlFor="qd-originCountry">Country of origin</label>
          {err('originCountry') ? (
            <span className="field-error" id="qd-originCountry-error">
              {err('originCountry')}
            </span>
          ) : null}
          <select
            id="qd-originCountry"
            name="originCountry"
            defaultValue={values.originCountry ?? 'CN'}
            aria-invalid={Boolean(err('originCountry'))}
          >
            {COUNTRIES_BY_NAME.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="check">
          <input
            type="checkbox"
            id="qd-preferenceClaimed"
            name="preferenceClaimed"
            defaultChecked={values.preferenceClaimed === 'on'}
          />
          <label htmlFor="qd-preferenceClaimed">I hold proof of preferential origin</label>
        </div>
        <button type="submit" className="button secondary">
          Check duty
        </button>
      </Form>
      {result ? <QuickDutyOutcome result={result} /> : null}
    </section>
  );
}

function QuickDutyOutcome({ result }: { result: QuickDutyResult }) {
  switch (result.kind) {
    case 'invalid':
      return null;
    case 'rate-limited':
      return (
        <p className="hs-message" data-status="warn" role="status">
          Too many tariff lookups in the last minute. Try again in {result.retryAfterSeconds}{' '}
          seconds.
        </p>
      );
    case 'unavailable':
      return (
        <p className="hs-message" data-status="warn" role="status">
          {result.message}
        </p>
      );
    case 'not-found':
      return (
        <p className="hs-message" data-status="error" role="status">
          {result.code} is not in the UK tariff. Check it on trade-tariff.service.gov.uk.
        </p>
      );
    case 'candidates':
      return (
        <div className="hs-candidates" role="status">
          <p className="hint">
            {result.code} covers{' '}
            {result.candidates.length === 1
              ? 'one 10-digit code'
              : `${result.candidates.length} 10-digit codes`}
            . Enter the one that describes your goods — we never pick for you.
          </p>
          <ul className="hs-candidate-list">
            {result.candidates.map((c) => (
              <li key={c.code}>
                <span className="code">{c.code}</span>
                {c.description ? ` — ${c.description}` : ''}
                {c.thirdCountryDuty ? ` (duty ${c.thirdCountryDuty})` : ''}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'ambiguous':
      return (
        <div role="status">
          <p className="hs-message" data-status="warn">
            <strong>No rate applied.</strong> {result.code}: {result.reason}. The tariff needs
            review before this can be priced (we never default to 0%).
          </p>
          <WarningList warnings={result.warnings} />
        </div>
      );
    case 'result':
      return (
        <div className="quick-duty-result" role="status">
          <p className="hs-description">
            <span className="code">{result.code}</span> — {result.description}
          </p>
          <dl className="meta">
            <dt>Duty rate</dt>
            <dd>
              {result.dutySpecific ?? pct(result.dutyRatePct)}
              {result.preferenceClaimed ? ' (preference claimed)' : ''}
            </dd>
            {result.addRatePct ? (
              <>
                <dt>Anti-dumping</dt>
                <dd>{pct(result.addRatePct)}</dd>
              </>
            ) : null}
            <dt>VAT rate</dt>
            <dd>{pct(result.vatRatePct)}</dd>
            <dt>Duty on {gbp(result.invoiceValueGbp)}</dt>
            <dd>{gbp(result.dutyGbp)}</dd>
            <dt>Import VAT</dt>
            <dd>{gbp(result.vatGbp)}</dd>
          </dl>
          <p className="hint">
            A rough guide: the real customs value also includes freight and insurance to the UK
            border (§5.3), so a full quote will be higher.
            {result.dutySpecific ? ' Specific (per-weight) duty is not included here.' : ''}
          </p>
          <WarningList warnings={result.warnings} />
        </div>
      );
  }
}

function WarningList({ warnings }: { warnings: QuoteWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="warnings small">
      {warnings.map((w) => (
        <li key={w.code}>
          {WARNING_EXPLAINED[w.code] ?? w.message} <span className="muted code">({w.code})</span>
        </li>
      ))}
    </ul>
  );
}
