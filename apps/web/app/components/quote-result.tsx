import type { QuoteWarning, WarningCode } from '@harbour/engine';
import { DISCLAIMER } from '../root';
import type { PipelineOutcome } from '../services/quote-pipeline.server';
import { count, gbp, isZeroAmount, isoDateTime, pad2, pct } from './format';

export type QuoteOutcome = Extract<PipelineOutcome, { kind: 'QUOTE' }>;

const FX_SOURCE_LABEL: Record<string, string> = {
  HMRC_MONTHLY: 'HMRC monthly rate',
  ECB: 'ECB daily reference rate (fallback)',
  MANUAL: 'entered manually',
};

/** Plain-English explanations shown alongside the engine's message for newer warnings. */
const WARNING_EXPLAINED: Partial<Record<WarningCode, string>> = {
  ASSISTS_INCLUDED:
    'Tooling, moulds or design you paid for separately count towards the customs value, so duty and import VAT are charged on them too.',
  PVA_REQUIRES_VAT_REGISTRATION:
    'Postponed VAT accounting is only open to VAT-registered businesses, so import VAT is shown as payable at the border. Tick "VAT registered" if your business is.',
  BROKER_DEFERMENT_FEE:
    'Your forwarder pays duty and import VAT to HMRC for you and charges a fee for advancing the money. The fee is included in your landed cost.',
  INLAND_VAT_ADJUSTMENT:
    'The freight quote did not include UK delivery, so an estimate was added to the amount import VAT is charged on. UK delivery itself is not in the landed cost.',
};

export const DAN_REMINDER =
  'Under CDS your forwarder cannot use your DAN until you add their EORI in your CDS account authorisations.';

function StatusBanner({
  status,
  warnings,
}: {
  status: 'READY' | 'INDICATIVE';
  warnings: QuoteWarning[];
}) {
  if (status === 'READY') {
    return (
      <div className="banner ready" role="status">
        <h2>
          <span className="status-pill ready">READY</span> All inputs verified
        </h2>
        <p>
          The commodity code was verified against the UK tariff and a rate-sheet freight rate was
          found. The figures below are still indicative until a forwarder confirms them.
        </p>
      </div>
    );
  }
  const blocking = warnings.filter((w) => w.blocking);
  return (
    <div className="banner indicative" role="status">
      <h2>
        <span className="status-pill indicative">INDICATIVE</span> Something could not be verified
      </h2>
      <p>This estimate has gaps you should resolve before relying on it:</p>
      <ul>
        {blocking.map((w) => (
          <li key={`${w.code}-${w.lineRef ?? ''}`}>
            <strong>{w.code.replace(/_/g, ' ')}</strong> — {w.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  return (
    <tr className={total ? 'total' : undefined}>
      <th scope="row">{label}</th>
      <td className="num" data-label={label}>
        {value}
      </td>
    </tr>
  );
}

export function QuoteResult({
  outcome,
  calcVersion,
}: {
  outcome: QuoteOutcome;
  calcVersion: string;
}) {
  const { quote, tariff, freight, line, stages, assists, dutyPayment } = outcome;
  const t = quote.totals;
  const lines = quote.lines;
  const isDdp = quote.incoterm === 'DDP';
  const hasAssists = !isZeroAmount(t.assistsGbp);
  const feeTerms = dutyPayment.brokerFeeTerms;

  return (
    <section aria-labelledby="result-heading" className="result">
      <h2 id="result-heading">Your landed cost</h2>
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
              <Row
                label="Tooling, moulds and design (assists), included in customs value"
                value={gbp(t.assistsGbp)}
              />
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
                    : 'Forwarder deferment fee (fee terms depend on your forwarder — not included)'
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

      {assists ? (
        <p className="muted">
          {assists.method === 'HELPER'
            ? `Assists: ${gbp(assists.totalCostGbp)} total × ${count(assists.shipmentQuantity)} units in this shipment ÷ ${count(assists.lifetimeUnits)} units = ${gbp(assists.amountGbp)}, added to the customs value.`
            : `Assists: ${gbp(assists.amountGbp)} entered for this shipment, added to the customs value.`}
        </p>
      ) : null}
      {!isZeroAmount(t.inlandVatAdjustment) ? (
        <p className="muted">
          Import VAT includes {gbp(t.inlandVatAdjustment)} added to the VAT base as an estimate of
          UK inland costs, because the freight quote did not include UK delivery. That estimate is
          not part of the landed cost.
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
        {dutyPayment.method === 'BROKER_DEFERMENT' && !isDdp ? (
          <li>
            Your forwarder pays this to HMRC for you and invoices you for it
            {feeTerms && !isZeroAmount(t.financingFee)
              ? `, plus the ${gbp(t.financingFee)} deferment fee.`
              : '.'}
          </li>
        ) : null}
        {dutyPayment.method === 'OWN_DAN' ? (
          <li>
            Charged to your own duty deferment account. <strong>Reminder:</strong> {DAN_REMINDER}
            {dutyPayment.danAuthorised ? ' You told us you have done this.' : ''}
          </li>
        ) : null}
        {dutyPayment.method === 'CDS_CASH' ? (
          <li>Paid from your CDS cash account before the goods are released.</li>
        ) : null}
      </ul>

      <h3>Per unit</h3>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th scope="col">Line</th>
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
            {lines.map((l) => (
              <tr key={l.ref}>
                <td data-label="Line">{l.ref}</td>
                <td className="num" data-label="Quantity">
                  {l.quantity}
                </td>
                <td className="num" data-label="Unit price">{`${l.unitValue} ${l.currency}`}</td>
                <td className="num" data-label="Landed per unit ex VAT">
                  {gbp(l.landedCostPerUnit)}
                </td>
                <td className="num" data-label="Landed per unit inc VAT">
                  {gbp(l.landedCostPerUnitIncVat)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Duty detail</h3>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th scope="col">Commodity code</th>
              <th scope="col">Duty type</th>
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
              <th scope="col">Measure</th>
              <th scope="col" className="num">
                Line duty
              </th>
              <th scope="col" className="num">
                Line VAT
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.ref}>
                <td data-label="Commodity code">
                  <span className="code">{l.hsCode}</span>
                  {tariff.description ? (
                    <span className="muted"> — {tariff.description}</span>
                  ) : null}
                </td>
                <td data-label="Duty type">{l.dutyType.replace('_', ' ').toLowerCase()}</td>
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
                <td data-label="Measure">{l.tariffMeasureId ?? '—'}</td>
                <td className="num" data-label="Line duty">
                  {gbp(l.lineDutyGbp)}
                </td>
                <td className="num" data-label="Line VAT">
                  {gbp(l.lineVatGbp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {quote.warnings.length > 0 ? (
        <>
          <h3>Things to know</h3>
          <ul className="warnings">
            {quote.warnings.map((w) => {
              const explained = WARNING_EXPLAINED[w.code];
              return (
                <li key={`${w.code}-${w.lineRef ?? ''}`}>
                  <strong>{w.blocking ? 'Blocking: ' : ''}</strong>
                  {explained ? (
                    <>
                      {explained} <span className="muted">{w.message}</span>
                    </>
                  ) : (
                    w.message
                  )}{' '}
                  <span className="muted code">({w.code})</span>
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
        </dd>
        <dt>Exchange rate</dt>
        <dd>
          {quote.fxRate === '1' && Object.keys(quote.fxSnapshots).length === 0
            ? 'GBP, no conversion'
            : `${quote.fxRate} GBP per unit — ${FX_SOURCE_LABEL[quote.fxSource] ?? quote.fxSource} (${quote.fxDate})`}
        </dd>
        <dt>Commodity code</dt>
        <dd>
          {tariff.code} {tariff.verified ? '(verified against the UK tariff)' : '(not verified)'}
          {tariff.normalisedFrom ? ` — normalised from ${tariff.normalisedFrom}` : ''}
        </dd>
        <dt>Shipment</dt>
        <dd>
          {line.totalWeightKg} kg · {line.totalVolumeCbm} CBM ({line.unitVolumeCbm} CBM per unit) ·
          apportioned by{' '}
          {quote.apportionmentBasis === 'AIR_VOLUMETRIC_6000'
            ? 'volumetric weight (1:6000)'
            : 'weight or measure'}
        </dd>
        <dt>Engine version</dt>
        <dd>
          <span className="code">{calcVersion}</span>
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

      <p className="disclaimer">{DISCLAIMER}</p>
    </section>
  );
}
