import { useEffect, useRef } from 'react';
import type { HsFieldState } from '../../services/catalogue/product-form.server';
import type { Errors, Values } from './fields';
import { HS_LOOKUP_ENDPOINT, attachHsLookup } from './hs-lookup-client';

/**
 * The smart HS code field (M3, UX spec "HS code field").
 *
 * Server-rendered: a text input, a "Check code" submit button (`intent=check-hs`) and the last
 * lookup result (`hs`) — the official description, the 10-digit candidates as radios named
 * `hsCodeChoice` (a pick overrides the typed code on save), or the error. That is the no-JS path.
 *
 * Enhanced: after hydration `attachHsLookup` debounces typing and fetches the JSON endpoint, so
 * the description appears as the user types. The module is imported here and bundled by React
 * Router, whose `<Scripts nonce>` carries the CSP nonce; nothing is inlined.
 */
export function HsCodeField({
  values,
  errors,
  hs,
  verified,
}: {
  values: Values;
  errors: Errors;
  hs: HsFieldState;
  /** The stored verification (edit form), shown when no fresh lookup has happened. */
  verified: { description: string | null; verifiedAt: string | null; hsCode: string } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return attachHsLookup(root, { endpoint: HS_LOOKUP_ENDPOINT });
  }, []);

  const error = errors.hsCode;
  const describedBy = ['hsCode-hint', error ? 'hsCode-error' : null].filter(Boolean).join(' ');
  const showStored =
    hs.kind === 'idle' &&
    verified !== null &&
    verified.verifiedAt !== null &&
    verified.hsCode === values.hsCode;

  return (
    <div className={`field hs-field${error ? ' has-error' : ''}`} data-hs-field ref={ref}>
      <label htmlFor="hsCode">HS or commodity code</label>
      <span className="hint" id="hsCode-hint">
        6, 8 or 10 digits. Dots and spaces are fine. A 6- or 8-digit code lists its 10-digit codes
        for you to choose from; only a checked 10-digit code is stored as verified.
      </span>
      {error ? (
        <span className="field-error" id="hsCode-error">
          {error}
        </span>
      ) : null}
      <div className="inline-fields hs-inline">
        <input
          id="hsCode"
          name="hsCode"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="narrow"
          placeholder="9503004100"
          defaultValue={values.hsCode ?? ''}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
        />
        <button
          type="submit"
          name="intent"
          value="check-hs"
          className="button secondary"
          data-hs-check
          formNoValidate
        >
          Check code
        </button>
      </div>
      <div data-hs-live aria-live="polite" className="hs-result" />
      <div data-hs-server className="hs-result">
        {showStored ? (
          <div className="hs-verified" data-status="ok">
            <p className="hs-description">
              {'✓'} {verified.description ?? 'Verified against the UK tariff'}
            </p>
            <p className="hint">
              Verified {new Date(verified.verifiedAt ?? '').toLocaleDateString('en-GB')}.
            </p>
          </div>
        ) : null}
        {hs.kind === 'rate-limited' ? (
          <p className="hs-message" data-status="warn">
            Too many tariff lookups in the last minute. Try again in {hs.retryAfterSeconds} seconds,
            or save the product unverified.
          </p>
        ) : null}
        {hs.kind === 'result' ? <LookupOutcome result={hs.result} /> : null}
      </div>
    </div>
  );
}

function LookupOutcome({
  result,
}: {
  result: Extract<HsFieldState, { kind: 'result' }>['result'];
}) {
  if (!result.ok) {
    return (
      <p className="hs-message" data-status={result.reason === 'UNAVAILABLE' ? 'warn' : 'error'}>
        {result.message}
      </p>
    );
  }
  if (result.kind === 'COMMODITY') {
    return (
      <div className="hs-verified" data-status="ok">
        <p className="hs-description">
          {'✓'} {result.description}
        </p>
        <p className="hint">
          Third-country duty: {result.thirdCountryDuty ?? 'not stated (needs review)'} · VAT:{' '}
          {result.vatRate ?? '20% assumed'}
          {result.preferenceEligible ? ' · preferential rates exist for some origins' : ''}
        </p>
      </div>
    );
  }
  return (
    <div className="hs-candidates radios" data-status="warn">
      <p className="hint" id="hsCodeChoice-hint">
        {result.code} maps to{' '}
        {result.candidates.length === 1
          ? 'one 10-digit code'
          : `${result.candidates.length} 10-digit codes`}
        . Choose the one that describes your goods, then save — we never pick for you.
      </p>
      {result.candidates.map((c) => (
        <div className="check" key={c.code}>
          <input
            type="radio"
            id={`hsCodeChoice-${c.code}`}
            name="hsCodeChoice"
            value={c.code}
            aria-describedby="hsCodeChoice-hint"
          />
          <label htmlFor={`hsCodeChoice-${c.code}`}>
            <span className="code">{c.code}</span>
            {c.description ? ` — ${c.description}` : ''}
            {c.thirdCountryDuty ? ` (third-country duty ${c.thirdCountryDuty})` : ''}
          </label>
        </div>
      ))}
    </div>
  );
}
