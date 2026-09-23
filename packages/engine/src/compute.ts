import { DANGEROUS_GOODS_CHAPTERS, RESTRICTED_CHAPTERS, validateHsCode } from './hs.js';
import { incotermPlan } from './incoterm.js';
import { D, type Decimal, ZERO, allocate, fixed2, fixed4, round2, round4, sum } from './money.js';
import { apportionmentBasisFor, chargeableWeight } from './apportion.js';
import { deriveStatus } from './status.js';
import { computeLineDuty, resolveTariff, type DutyComponent } from './tariff.js';
import type {
  ComputeResult,
  DutyType,
  FxSource,
  LineInput,
  LineResult,
  QuoteInput,
  QuoteResult,
  SpecificDuty,
} from './types.js';
import { CALC_VERSION } from './version.js';
import { WarningBag, type QuoteWarning } from './warnings.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINE_WEIGHT_KG = D('30000');
const MAX_LINE_CBM = D('100');
const MAX_QUANTITY = 1_000_000;
const OUTLIER_LOW = D('0.2');
const OUTLIER_HIGH = D('5');

interface LineTariff {
  measureId: string | null;
  dutyType: DutyType;
  dutyRatePct: Decimal | null;
  dutySpecific: SpecificDuty | null;
  components: DutyComponent[];
  preferenceClaimed: boolean;
  addRatePct: Decimal | null;
  vatRatePct: Decimal;
}

const fail = (
  stage: 'resolveFx' | 'validate',
  code: string,
  message: string,
  warnings: WarningBag,
): ComputeResult => ({ ok: false, stage, code, message, warnings: warnings.toArray() });

const parseIsoMs = (iso: string): number | null => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

const resolveLineTariff = (line: LineInput, asOf: Date, warnings: WarningBag): LineTariff => {
  const ambiguous = (reason: string): LineTariff => {
    warnings.add(
      'TARIFF_AMBIGUOUS',
      `Tariff could not be resolved: ${reason}. Duty shown as 0 pending review — NOT a real rate.`,
      line.ref,
    );
    return {
      measureId: null,
      dutyType: 'NONE',
      dutyRatePct: null,
      dutySpecific: null,
      components: [],
      preferenceClaimed: false,
      addRatePct: null,
      vatRatePct: D('20'),
    };
  };

  switch (line.tariff.kind) {
    case 'UNAVAILABLE':
      return ambiguous(line.tariff.reason);
    case 'MANUAL': {
      warnings.add(
        'TARIFF_MANUAL',
        'Duty and VAT rates were entered manually and have not been checked against the UK tariff.',
        line.ref,
      );
      const pct = D(line.tariff.dutyRatePct);
      const add = line.tariff.addRatePct ? D(line.tariff.addRatePct) : null;
      if (add && add.gt(0)) {
        warnings.add(
          'ADD_APPLIES',
          `Anti-dumping duty of ${add.toString()}% entered manually.`,
          line.ref,
        );
      }
      return {
        measureId: null,
        dutyType: 'AD_VALOREM',
        dutyRatePct: pct,
        dutySpecific: null,
        components: [{ kind: 'AD_VALOREM', pct }],
        preferenceClaimed: line.preferenceClaimed ?? false,
        addRatePct: add && add.gt(0) ? add : null,
        vatRatePct: D(line.tariff.vatRatePct),
      };
    }
    case 'MEASURES': {
      const res = resolveTariff(line.tariff.measures, {
        originCountry: line.originCountry,
        preferenceClaimed: line.preferenceClaimed ?? false,
        asOf,
        lineRef: line.ref,
      });
      warnings.addAll(res.warnings.toArray());
      if (!res.ok) return ambiguous(res.reason);
      return res.tariff;
    }
  }
};

/**
 * The `compute → validate` stages of the pipeline (§5.1). Pure: no I/O, no clock except the
 * optional `asOf` input. Never throws on bad money inputs — returns `{ ok: false }` instead.
 */
export const computeQuote = (input: QuoteInput): ComputeResult => {
  const warnings = new WarningBag();
  const plan = incotermPlan(input.incoterm);

  // ---------- validate ----------
  if (input.lines.length === 0) {
    return fail('validate', 'NO_LINES', 'A quote needs at least one line.', warnings);
  }
  const asOfIso = input.asOf ?? input.freight?.fetchedAt ?? new Date().toISOString();
  const asOfMs = parseIsoMs(asOfIso);
  if (asOfMs === null)
    return fail('validate', 'BAD_DATE', `Invalid asOf datetime "${asOfIso}".`, warnings);
  const asOf = new Date(asOfMs);

  let parsedLines: Array<{
    line: LineInput;
    unitValue: Decimal;
    unitWeightKg: Decimal;
    unitVolumeCbm: Decimal;
  }>;
  try {
    parsedLines = input.lines.map((line) => ({
      line,
      unitValue: D(line.unitValue),
      unitWeightKg: D(line.unitWeightKg),
      unitVolumeCbm: D(line.unitVolumeCbm),
    }));
  } catch (err) {
    return fail(
      'validate',
      'BAD_DECIMAL',
      err instanceof Error ? err.message : String(err),
      warnings,
    );
  }

  for (const p of parsedLines) {
    const { line } = p;
    if (!Number.isInteger(line.quantity) || line.quantity <= 0 || line.quantity > MAX_QUANTITY) {
      return fail(
        'validate',
        'BAD_QUANTITY',
        `Line ${line.ref}: quantity must be a positive integer ≤ ${MAX_QUANTITY}.`,
        warnings,
      );
    }
    if (p.unitValue.isNegative() || p.unitWeightKg.isNegative() || p.unitVolumeCbm.isNegative()) {
      return fail(
        'validate',
        'NEGATIVE_VALUE',
        `Line ${line.ref}: values must not be negative.`,
        warnings,
      );
    }
    const hs = validateHsCode(line.hsCode);
    if (!hs.ok) {
      return fail(
        'validate',
        'BAD_HS_CODE',
        `Line ${line.ref}: HS code "${line.hsCode}" is not 6, 8 or 10 digits.`,
        warnings,
      );
    }
    if (!/^[A-Z]{2}$/.test(line.originCountry)) {
      return fail(
        'validate',
        'BAD_ORIGIN',
        `Line ${line.ref}: origin must be an ISO alpha-2 country code.`,
        warnings,
      );
    }
    const lineWeight = p.unitWeightKg.times(line.quantity);
    const lineCbm = p.unitVolumeCbm.times(line.quantity);
    if (lineWeight.gt(MAX_LINE_WEIGHT_KG) || lineCbm.gt(MAX_LINE_CBM)) {
      warnings.add(
        'SANITY_BOUND',
        `Line ${line.ref}: ${lineWeight.toString()} kg / ${lineCbm.toString()} CBM exceeds sanity bounds (30,000 kg / 100 CBM).`,
        line.ref,
      );
    }
    if (!line.hsCodeVerified) {
      warnings.add(
        'HS_UNVERIFIED',
        `HS code ${hs.code} has not been verified against the UK tariff.`,
        line.ref,
      );
    }
    if (RESTRICTED_CHAPTERS.has(hs.chapter)) {
      warnings.add(
        'RESTRICTED_GOODS',
        `HS chapter ${hs.chapter} is restricted (arms, excise goods, live animals) — manual review required.`,
        line.ref,
      );
    }
    if (DANGEROUS_GOODS_CHAPTERS.has(hs.chapter)) {
      warnings.add(
        'DANGEROUS_GOODS_CHECK',
        `HS chapter ${hs.chapter}: confirm no dangerous-goods class applies.`,
        line.ref,
      );
    }
  }

  // ---------- resolveFx (snapshot) ----------
  const fxSnapshots: QuoteResult['fxSnapshots'] = {};
  const fxRates = new Map<string, Decimal>();
  fxRates.set('GBP', D('1'));
  for (const p of parsedLines) {
    const ccy = p.line.currency.toUpperCase();
    if (fxRates.has(ccy)) continue;
    const rate = input.fx.rates[ccy];
    if (!rate) {
      return fail('resolveFx', 'FX_MISSING', `No exchange rate available for ${ccy}.`, warnings);
    }
    let value: Decimal;
    try {
      value = D(rate.rateToGbp);
    } catch (err) {
      return fail(
        'resolveFx',
        'FX_INVALID',
        err instanceof Error ? err.message : String(err),
        warnings,
      );
    }
    if (value.lte(0))
      return fail(
        'resolveFx',
        'FX_INVALID',
        `Exchange rate for ${ccy} must be positive.`,
        warnings,
      );
    fxRates.set(ccy, value);
    fxSnapshots[ccy] = { rateToGbp: value.toString(), source: rate.source, date: rate.date };
    if (rate.source === 'ECB') {
      warnings.add(
        'FX_FALLBACK',
        `HMRC monthly rate unavailable for ${ccy}; ECB reference rate used.`,
      );
    } else if (rate.source === 'MANUAL') {
      warnings.add('FX_MANUAL', `A manually entered exchange rate was used for ${ccy}.`);
    }
  }
  const primaryCcy = Object.keys(fxSnapshots)[0];
  const primary = primaryCcy !== undefined ? fxSnapshots[primaryCcy] : undefined;
  const fxRate = primary ? primary.rateToGbp : '1';
  const fxSource: FxSource = primary ? primary.source : 'HMRC_MONTHLY';
  const fxDate = primary ? primary.date : asOfIso.slice(0, 10);

  // ---------- resolveFreight (already fetched; here we interpret it) ----------
  let toBorder = ZERO;
  let postBorder = ZERO;
  let originFees = ZERO;
  let destinationFees = ZERO;
  let clearanceFee = ZERO;
  let rateSource = 'NONE';
  let rateFetchedAt = asOfIso;
  let validUntilMs = asOfMs;

  const freight = input.freight;
  if (freight === null) {
    warnings.add(
      'FREIGHT_UNAVAILABLE',
      'No freight rate could be resolved for this lane; freight shown as 0.',
    );
  } else {
    try {
      toBorder = D(freight.toBorderGbp);
      originFees = D(freight.originFeesGbp);
      destinationFees = D(freight.destinationFeesGbp);
      clearanceFee = freight.clearanceFeeGbp !== undefined ? D(freight.clearanceFeeGbp) : ZERO;
      if (freight.postBorderGbp === null || freight.postBorderGbp === undefined) {
        warnings.add(
          'FREIGHT_SPLIT_ASSUMED',
          'Rate source did not split freight at the UK border; 100% treated as to-border (dutiable).',
        );
      } else {
        postBorder = D(freight.postBorderGbp);
      }
    } catch (err) {
      return fail(
        'validate',
        'BAD_DECIMAL',
        err instanceof Error ? err.message : String(err),
        warnings,
      );
    }
    if (
      [toBorder, postBorder, originFees, destinationFees, clearanceFee].some((v) => v.isNegative())
    ) {
      return fail('validate', 'NEGATIVE_VALUE', 'Freight amounts must not be negative.', warnings);
    }
    rateSource = freight.source;
    rateFetchedAt = freight.fetchedAt;
    const fetchedMs = parseIsoMs(freight.fetchedAt);
    if (fetchedMs === null)
      return fail('validate', 'BAD_DATE', 'Invalid freight.fetchedAt.', warnings);
    validUntilMs = fetchedMs + SEVEN_DAYS_MS;
    if (freight.providerValidUntil) {
      const providerMs = parseIsoMs(freight.providerValidUntil);
      if (providerMs !== null && providerMs < validUntilMs) validUntilMs = providerMs;
    }
    if (freight.isFallback) {
      warnings.add(
        'FREIGHT_FALLBACK',
        `Primary rate provider unavailable; fallback source ${freight.source} used.`,
      );
    }
    if (freight.benchmarkToBorderGbp !== null && freight.benchmarkToBorderGbp !== undefined) {
      const benchmark = D(freight.benchmarkToBorderGbp);
      if (benchmark.gt(0) && plan.buyerPaysToBorderFreight) {
        const ratio = toBorder.div(benchmark);
        if (ratio.lt(OUTLIER_LOW) || ratio.gt(OUTLIER_HIGH)) {
          warnings.add(
            'RATE_OUTLIER',
            `Freight rate £${fixed2(toBorder)} is ${ratio.times(100).toFixed(0)}% of the rate-sheet benchmark £${fixed2(benchmark)}; human review required.`,
          );
        }
      }
    }
  }

  // ---------- incoterm branching (§5.5) ----------
  const toBorderPaid = plan.buyerPaysToBorderFreight ? toBorder : ZERO;
  const postBorderPaid = plan.buyerPaysPostBorderFreight ? postBorder : ZERO;
  const originPaid =
    plan.buyerPaysOriginFees === 'ALWAYS' ||
    (plan.buyerPaysOriginFees === 'IF_STATED' && input.includeOriginFees === true)
      ? originFees
      : ZERO;
  const destinationPaid = plan.buyerPaysDestinationFees ? destinationFees : ZERO;
  const clearancePaid = plan.buyerPaysClearance ? clearanceFee : ZERO;
  const destinationTotal = destinationPaid.plus(clearancePaid);

  if (plan.supplierPriceIncludesFreight && freight !== null && toBorder.gt(0)) {
    warnings.add(
      'FREIGHT_INCLUDED_IN_PRICE',
      `${input.incoterm}: international freight is included in the supplier price and has not been added.`,
    );
  }

  let insurancePaid = ZERO;
  if (input.insurance) {
    const premium = D(input.insurance.premiumGbp);
    if (premium.isNegative())
      return fail(
        'validate',
        'NEGATIVE_VALUE',
        'Insurance premium must not be negative.',
        warnings,
      );
    if (plan.buyerInsuranceAllowed) {
      insurancePaid = premium;
    } else if (premium.gt(0)) {
      warnings.add(
        'INSURANCE_IGNORED_CIF',
        'CIF: the seller insures to the UK port; the insurance premium entered was ignored.',
      );
    }
  }

  // Supplier-included freight for door terms: customs value must exclude the post-border leg.
  let supplierPostBorder = ZERO;
  if (plan.supplierPriceIncludesToDoor) {
    const sf = input.supplierFreight;
    if (!sf) {
      if (plan.supplierBearsDutyAndVat) {
        warnings.add(
          'DDP_SUPPLIER_BEARS_DUTY',
          'DDP: the supplier is the importer of record and pays UK duty and VAT. DDP into the UK rarely works cleanly for micro-importers — confirm the supplier has a UK EORI and VAT registration.',
        );
      } else {
        warnings.add(
          'INCOTERM_FREIGHT_UNKNOWN',
          `${input.incoterm}: the supplier price includes delivery, but the freight portion is unknown, so the customs value cannot be established. Enter the supplier's freight breakdown.`,
        );
      }
    } else {
      try {
        const total = D(sf.totalGbp);
        if (total.isNegative())
          return fail(
            'validate',
            'NEGATIVE_VALUE',
            'Supplier freight must not be negative.',
            warnings,
          );
        if (sf.postBorderGbp === null || sf.postBorderGbp === undefined) {
          warnings.add(
            'FREIGHT_SPLIT_ASSUMED',
            'Supplier freight breakdown has no UK leg; the whole amount treated as to-border (dutiable).',
          );
        } else {
          supplierPostBorder = D(sf.postBorderGbp);
          if (supplierPostBorder.isNegative() || supplierPostBorder.gt(total)) {
            return fail(
              'validate',
              'BAD_SUPPLIER_FREIGHT',
              'Supplier post-border freight must be between 0 and the supplier freight total.',
              warnings,
            );
          }
        }
      } catch (err) {
        return fail(
          'validate',
          'BAD_DECIMAL',
          err instanceof Error ? err.message : String(err),
          warnings,
        );
      }
      if (plan.supplierBearsDutyAndVat) {
        warnings.add(
          'DDP_SUPPLIER_BEARS_DUTY',
          'DDP: the supplier is the importer of record and pays UK duty and VAT (shown for information only). DDP into the UK rarely works cleanly for micro-importers.',
        );
      }
    }
  }

  let platformFee = ZERO;
  if (input.platformFeeGbp !== undefined) {
    platformFee = D(input.platformFeeGbp);
    if (platformFee.isNegative())
      return fail('validate', 'NEGATIVE_VALUE', 'Platform fee must not be negative.', warnings);
  }

  // ---------- per-line goods values and tariffs ----------
  const basis = apportionmentBasisFor(input.mode);
  const lineBase = parsedLines.map((p) => {
    const rate = fxRates.get(p.line.currency.toUpperCase()) ?? D('1');
    const unitValueGbp = round4(p.unitValue.times(rate));
    const lineGoodsValueGbp = round2(unitValueGbp.times(p.line.quantity));
    const lineWeightKg = p.unitWeightKg.times(p.line.quantity);
    const lineVolumeCbm = p.unitVolumeCbm.times(p.line.quantity);
    return {
      ...p,
      unitValueGbp,
      lineGoodsValueGbp,
      lineWeightKg,
      lineVolumeCbm,
      chargeable: chargeableWeight(input.mode, lineWeightKg, lineVolumeCbm),
      tariff: resolveLineTariff(p.line, asOf, warnings),
    };
  });

  const goodsValueGbp = sum(lineBase.map((l) => l.lineGoodsValueGbp));
  if (supplierPostBorder.gt(goodsValueGbp)) {
    return fail(
      'validate',
      'BAD_SUPPLIER_FREIGHT',
      'Supplier post-border freight exceeds the goods value.',
      warnings,
    );
  }

  // ---------- apportionment (§5.4) ----------
  const chargeableWeights = lineBase.map((l) => l.chargeable);
  const valueWeights = lineBase.map((l) => l.lineGoodsValueGbp);
  const allocToBorder = allocate(toBorderPaid, chargeableWeights);
  const allocPostBorder = allocate(postBorderPaid, chargeableWeights);
  const allocOrigin = allocate(originPaid, chargeableWeights);
  const allocDestination = allocate(destinationTotal, chargeableWeights);
  // Deducted from the invoice value, so allocated by value share: keeps every line's customs
  // value >= 0 because supplierPostBorder <= goodsValue is validated above.
  const allocSupplierPostBorder = allocate(supplierPostBorder, valueWeights);
  const allocInsurance = allocate(insurancePaid, valueWeights);
  const allocPlatform = allocate(platformFee, valueWeights);

  // ---------- per-line duty and VAT (§5.3) ----------
  const lines: LineResult[] = lineBase.map((l, i) => {
    const at = (arr: Decimal[]): Decimal => arr[i] ?? ZERO;
    const customsValue = round2(
      l.lineGoodsValueGbp
        .plus(at(allocOrigin))
        .plus(at(allocToBorder))
        .plus(at(allocInsurance))
        .minus(at(allocSupplierPostBorder)),
    );
    const dutyRaw = computeLineDuty(l.tariff.components, l.tariff.addRatePct, {
      customsValueGbp: customsValue,
      weightKg: l.lineWeightKg,
      quantity: l.line.quantity,
    });
    const dutyComputed = round2(dutyRaw);
    const vatBase = customsValue
      .plus(dutyComputed)
      .plus(at(allocPostBorder))
      .plus(at(allocDestination))
      .plus(at(allocSupplierPostBorder));
    const vatComputed = round2(vatBase.times(l.tariff.vatRatePct).div(100));

    const supplierBorne = plan.supplierBearsDutyAndVat;
    const lineDuty = supplierBorne ? ZERO : dutyComputed;
    const lineVat = supplierBorne ? ZERO : vatComputed;

    const lineLandedExVat = l.lineGoodsValueGbp
      .plus(at(allocToBorder))
      .plus(at(allocPostBorder))
      .plus(at(allocOrigin))
      .plus(at(allocDestination))
      .plus(at(allocInsurance))
      .plus(lineDuty)
      .plus(at(allocPlatform));
    const lineLanded = lineLandedExVat.plus(lineVat);

    return {
      ref: l.line.ref,
      hsCode: l.line.hsCode.replace(/[\s.]/g, ''),
      originCountry: l.line.originCountry,
      quantity: l.line.quantity,
      unitValue: fixed4(l.unitValue),
      currency: l.line.currency.toUpperCase(),
      unitValueGbp: fixed4(l.unitValueGbp),
      lineGoodsValueGbp: fixed2(l.lineGoodsValueGbp),
      lineWeightKg: l.lineWeightKg.toFixed(3),
      lineVolumeCbm: l.lineVolumeCbm.toFixed(4),
      chargeableWeight: l.chargeable.toFixed(4),
      tariffMeasureId: l.tariff.measureId,
      dutyType: l.tariff.dutyType,
      dutyRatePct: l.tariff.dutyRatePct ? l.tariff.dutyRatePct.toFixed(4) : null,
      dutySpecific: l.tariff.dutySpecific,
      preferenceClaimed: l.tariff.preferenceClaimed,
      addRatePct: l.tariff.addRatePct ? l.tariff.addRatePct.toFixed(4) : null,
      vatRatePct: l.tariff.vatRatePct.toFixed(2),
      allocatedFreightGbp: fixed2(at(allocToBorder).plus(at(allocPostBorder))),
      allocatedFreightToBorderGbp: fixed2(at(allocToBorder)),
      allocatedFreightPostBorderGbp: fixed2(at(allocPostBorder)),
      allocatedOriginFeesGbp: fixed2(at(allocOrigin)),
      allocatedDestinationFeesGbp: fixed2(at(allocDestination)),
      allocatedInsuranceGbp: fixed2(at(allocInsurance)),
      allocatedPlatformFeeGbp: fixed2(at(allocPlatform)),
      lineCustomsValueGbp: fixed2(customsValue),
      lineDutyGbp: fixed2(lineDuty),
      lineVatGbp: fixed2(lineVat),
      supplierBorneDutyGbp: fixed2(supplierBorne ? dutyComputed : ZERO),
      supplierBorneVatGbp: fixed2(supplierBorne ? vatComputed : ZERO),
      lineLandedCostExVatGbp: fixed2(lineLandedExVat),
      lineLandedCostGbp: fixed2(lineLanded),
      landedCostPerUnit: fixed4(lineLandedExVat.div(l.line.quantity)),
      landedCostPerUnitIncVat: fixed4(lineLanded.div(l.line.quantity)),
    };
  });

  // ---------- totals ----------
  const totalOf = (pick: (l: LineResult) => string): Decimal => sum(lines.map((l) => D(pick(l))));
  const totalDuty = totalOf((l) => l.lineDutyGbp);
  const totalVat = totalOf((l) => l.lineVatGbp);
  const totalLandedCostExVat = totalOf((l) => l.lineLandedCostExVatGbp);
  const totalLandedCost = totalOf((l) => l.lineLandedCostGbp);

  const allWarnings: QuoteWarning[] = warnings.toArray();
  const quote: QuoteResult = {
    calcVersion: CALC_VERSION,
    status: deriveStatus(allWarnings),
    warnings: allWarnings,
    incoterm: input.incoterm,
    mode: input.mode,
    apportionmentBasis: basis,
    fxRate,
    fxSource,
    fxDate,
    fxSnapshots,
    rateSource,
    rateFetchedAt,
    validUntil: new Date(validUntilMs).toISOString(),
    totals: {
      goodsValueGbp: fixed2(goodsValueGbp),
      freightCost: fixed2(toBorderPaid.plus(postBorderPaid)),
      freightToBorderGbp: fixed2(toBorderPaid),
      freightPostBorderGbp: fixed2(postBorderPaid),
      originFees: fixed2(originPaid),
      destinationFees: fixed2(destinationTotal),
      insurancePremium: fixed2(insurancePaid),
      customsValue: fixed2(totalOf((l) => l.lineCustomsValueGbp)),
      totalDuty: fixed2(totalDuty),
      totalVat: fixed2(totalVat),
      vatRecoverable: input.vatRegistered && !plan.supplierBearsDutyAndVat,
      platformFee: fixed2(platformFee),
      totalLandedCostExVat: fixed2(totalLandedCostExVat),
      totalLandedCost: fixed2(totalLandedCost),
      supplierBorneDuty: fixed2(totalOf((l) => l.supplierBorneDutyGbp)),
      supplierBorneVat: fixed2(totalOf((l) => l.supplierBorneVatGbp)),
    },
    lines,
  };
  return { ok: true, quote };
};
