import { Link } from 'react-router';
import { DISCLAIMER } from '../../root';
import type { QuoteView } from '../../services/quotes/view';
import { QUOTE_DUTY_PAYMENT_LABELS } from '../../validators/quote';
import { gbp, isZeroAmount, isoDateTime, pad2, pct } from '../format';
import {
  DAN_REMINDER,
  FX_SOURCE_LABEL,
  Row,
  StatusBanner,
  WARNING_EXPLAINED,
} from '../quote-result';

/**
 * The "True cost" breakdown (M4): the calculator's result view adapted to several catalogue lines
 * and to a view that may come from a fresh computation or from a saved row. Goods; freight and
 * fees (rate source and expiry); UK duty; import VAT; cash needed at the border; total landed
 * cost; landed cost per unit ex VAT (UX spec "Quote builder"). Same banners as the calculator.
 */
export function QuoteBreakdown({
  view,
  compact = false,
  heading = 'True cost',
}: {
  view: QuoteView;
  /** Builder column: skips the calculation steps and the disclaimer (the shell shows it). */
  compact?: boolean;
  heading?: string;
}) {
  const { quote, lines, dutyPayment, freight, shipment, stages } = view;
  const t = quote.totals;
  const isDdp = quote.incoterm === 'DDP';
  const hasAssists = !isZeroAmount(t.assistsGbp);
  const feeTerms = dutyPayment.brokerFeeTerms;
  const labelOf = new Map(lines.map((l) => [l.ref, l]));

  return (
    <section aria-labelledby="breakdown-heading" className="result quote-breakdown">
      <h2 id="breakdown-heading">{heading}</h2>
      <StatusBanner status={quote.status} warnings={quote.warnings} />

      <div className="table-wrap">
        <table className="stack totals">
          <caption className="muted">All amounts in GBP.</caption>
          <tbody>
            <Row label="Goods value" value={gbp(t.goodsValueGbp)} />
            <Row label="Freight to UK border" value={gbp(t.freightToBorderGbp)} />
            <Row label="Freight after UK border (haulage)" value={gbp(t.freightPostBorderGbp)} />
            <Row label="Origin charges" value={gbp(t.originFees)} />
            <Row label="Destination charges and clearance" value={gbp(t.destinationFees)} />
            <Row label="Insurance premium" value={gbp(t.insurancePremium)} />
            {hasAssists ? (
              <Row label="Tooling, moulds and design (assists)" value={gbp(t.assistsGbp)} />
            ) : null}
            <Row label="Customs value (duty base)" value={gbp(t.customsValue)} />
            <Row
              label={isDdp ? 'Import duty (borne by supplier)' : 'Import duty'}
              value={gbp(isDdp ? t.supplierBorneDuty : t.totalDuty)}
            />
            <Row
              label={
                isDdp
                  ? 'Import VAT (borne by supplier)'
                  : `Import VAT${t.vatPostponed ? ' (postponed: on your VAT return)' : t.vatRecoverable ? ' (recoverable on your VAT return)' : ''}`
              }
              value={gbp(isDdp ? t.supplierBorneVat : t.totalVat)}
            />
            {dutyPayment.method === 'BROKER_DEFERMENT' ? (
              <Row
                label={
                  feeTerms
                    ? `Forwarder deferment fee (${pct(feeTerms.feePct)} of duty and VAT advanced, minimum ${gbp(pad2(feeTerms.minimumGbp))})`
                    : 'Forwarder deferment fee (terms depend on your forwarder — not included)'
                }
                value={feeTerms ? gbp(t.financingFee) : 'not included'}
              />
            ) : null}
            <Row label="Platform fee" value={gbp(t.platformFee)} />
            <Row
              label="Total landed cost, excluding VAT"
              value={gbp(t.totalLandedCostExVat)}
              total
            />
            <Row label="Total landed cost, including VAT" value={gbp(t.totalLandedCost)} total />
          </tbody>
        </table>
      </div>

      {!isZeroAmount(t.inlandVatAdjustment) ? (
        <p className="muted">
          Import VAT includes {gbp(t.inlandVatAdjustment)} added to the VAT base as an estimate of
          UK inland costs, because the freight quote did not include UK delivery.
        </p>
      ) : null}

      <h3>Cash needed at the border</h3>
      <div className="table-wrap">
        <table className="stack totals">
          <tbody>
            <Row label="Import duty" value={gbp(isDdp ? '0.00' : t.totalDuty)} />
            <Row
              label={
                t.vatPostponed ? 'Import VAT (postponed, not paid at the border)' : 'Import VAT'
              }
              value={gbp(isDdp || t.vatPostponed ? '0.00' : t.totalVat)}
            />
            <Row label="Cash needed at the border" value={gbp(t.borderOutlay)} total />
          </tbody>
        </table>
      </div>
      <ul className="notes">
        {t.vatPostponed ? (
          <li>
            Import VAT {gbp(t.totalVat)} is accounted for on your VAT return, not paid at the
            border.
          </li>
        ) : null}
        {isDdp ? <li>Under DDP the supplier pays duty and import VAT.</li> : null}
        <li>Duty paid: {QUOTE_DUTY_PAYMENT_LABELS[dutyPayment.method]}.</li>
        {dutyPayment.method === 'OWN_DEFERMENT' ? (
          <li>
            <strong>Reminder:</strong> {DAN_REMINDER}
          </li>
        ) : null}
      </ul>

      <h3>Per unit</h3>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Unit price
              </th>
              <th scope="col" className="num">
                Landed per unit ex VAT
              </th>
              <th scope="col" className="num">
                Landed per unit inc VAT
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => {
              const label = labelOf.get(l.ref);
              return (
                <tr key={l.ref}>
                  <td data-label="Product">
                    {label ? (
                      <>
                        <span className="code">{label.sku}</span> {label.name}
                      </>
                    ) : (
                      l.ref
                    )}
                  </td>
                  <td className="num" data-label="Quantity">
                    {l.quantity}
                  </td>
                  <td className="num" data-label="Unit price">{`${l.unitValue} ${l.currency}`}</td>
                  <td className="num" data-label="Landed per unit ex VAT">
                    <strong>{gbp(l.landedCostPerUnit)}</strong>
                  </td>
                  <td className="num" data-label="Landed per unit inc VAT">
                    {gbp(l.landedCostPerUnitIncVat)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Duty detail</h3>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th scope="col">Commodity code</th>
              <th scope="col">Origin</th>
              <th scope="col" className="num">
                Duty rate
              </th>
              <th scope="col" className="num">
                Anti-dumping
              </th>
              <th scope="col" className="num">
                VAT rate
              </th>
              <th scope="col">Preference</th>
              <th scope="col" className="num">
                Line duty
              </th>
              <th scope="col" className="num">
                Line VAT
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => {
              const label = labelOf.get(l.ref);
              return (
                <tr key={l.ref}>
                  <td data-label="Commodity code">
                    <span className="code">{l.hsCode}</span>
                    {label && !label.hsVerified ? (
                      <span className="hs-mark unverified" title="Unverified">
                        {' !'}
                      </span>
                    ) : null}
                    {label?.hsDescription ? (
                      <span className="muted"> — {label.hsDescription}</span>
                    ) : null}
                  </td>
                  <td data-label="Origin">{l.originCountry}</td>
                  <td className="num" data-label="Duty rate">
                    {l.dutySpecific
                      ? `£${l.dutySpecific.amountGbp} per ${l.dutySpecific.per} ${l.dutySpecific.unit}`
                      : pct(l.dutyRatePct)}
                  </td>
                  <td className="num" data-label="Anti-dumping">
                    {pct(l.addRatePct)}
                  </td>
                  <td className="num" data-label="VAT rate">
                    {pct(l.vatRatePct)}
                  </td>
                  <td data-label="Preference">{l.preferenceClaimed ? 'claimed' : 'not claimed'}</td>
                  <td className="num" data-label="Line duty">
                    {gbp(l.lineDutyGbp)}
                  </td>
                  <td className="num" data-label="Line VAT">
                    {gbp(l.lineVatGbp)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {quote.warnings.length > 0 ? (
        <>
          <h3>Things to know</h3>
          <ul className="warnings">
            {quote.warnings.map((w) => {
              const explained = WARNING_EXPLAINED[w.code];
              const label = w.lineRef ? labelOf.get(w.lineRef) : undefined;
              return (
                <li key={`${w.code}-${w.lineRef ?? ''}`}>
                  <strong>{w.blocking ? 'Blocking: ' : ''}</strong>
                  {label ? (
                    <>
                      <span className="code">{label.sku}</span>{' '}
                    </>
                  ) : null}
                  {explained ? (
                    <>
                      {explained} <span className="muted">{w.message}</span>
                    </>
                  ) : (
                    w.message
                  )}{' '}
                  <span className="muted code">({w.code})</span>
                  {w.code === 'HS_UNVERIFIED' && label ? (
                    <>
                      {' '}
                      <Link to={`/app/products/${label.productId}`}>Verify the code</Link>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <h3>Where these numbers come from</h3>
      <dl className="meta">
        <dt>Valid until</dt>
        <dd>{isoDateTime(quote.validUntil)}</dd>
        <dt>Freight rate source</dt>
        <dd>
          {quote.rateSource}
          {freight.transitDays !== null ? ` · about ${freight.transitDays} days transit` : ''}
          {` · fetched ${isoDateTime(quote.rateFetchedAt)}`}
        </dd>
        <dt>Exchange rate</dt>
        <dd>
          {Object.keys(quote.fxSnapshots).length === 0
            ? 'GBP, no conversion'
            : Object.entries(quote.fxSnapshots)
                .map(
                  ([ccy, s]) =>
                    `${ccy}: ${s.rateToGbp} GBP — ${FX_SOURCE_LABEL[s.source] ?? s.source} (${s.date})`,
                )
                .join('; ')}
        </dd>
        <dt>Shipment</dt>
        <dd>
          {shipment.totalWeightKg} kg · {shipment.totalVolumeCbm} CBM · apportioned by{' '}
          {quote.apportionmentBasis === 'AIR_VOLUMETRIC_6000'
            ? 'volumetric weight (1:6000)'
            : 'weight or measure'}
        </dd>
        <dt>Engine version</dt>
        <dd>
          <span className="code">{quote.calcVersion}</span>
        </dd>
      </dl>

      {freight.assumptions.length > 0 ? (
        <details>
          <summary>Freight assumptions</summary>
          <ul>
            {freight.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {!compact && stages.length > 0 ? (
        <details>
          <summary>How this was calculated</summary>
          <ol>
            {stages.map((s) => (
              <li key={s.stage}>
                <span className="code">{s.stage}</span> {s.ok ? '✓' : '✗'} — {s.note}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {!compact ? <p className="disclaimer">{DISCLAIMER}</p> : null}
    </section>
  );
}
