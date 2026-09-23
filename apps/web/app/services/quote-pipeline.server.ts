import {
  resolveFx,
  type FreightRateProvider,
  type FxRateStore,
  type TariffLookup,
} from '@harbour/adapters';
import {
  computeQuote,
  normaliseHsCode,
  warn,
  type HsCandidate,
  type LineInput,
  type QuoteInput,
  type QuoteResult,
  type SupplierFreightInput,
  type TariffInput,
} from '@harbour/engine';
import { Decimal } from 'decimal.js';
import { DOOR_INCOTERMS, parseLaneKey, type CalculatorInput } from '../validators/calculator';

/**
 * §5.1 pipeline for the public calculator:
 *   resolveProducts → resolveFx → resolveFreight → resolveTariff → compute
 * Every stage degrades to a warning/INDICATIVE result. The only non-quote outcomes are
 * (a) the user must pick between 10-digit codes (never guessed, §5.2) and (b) an input we
 * genuinely cannot price (no FX rate at all) — both rendered as form feedback, never a 500.
 */

export interface TariffLookupClient {
  lookupCommodity(code: string): Promise<TariffLookup>;
  headingCandidates(code: string): Promise<HsCandidate[]>;
}

export interface PipelineDeps {
  tariff: TariffLookupClient;
  fxStore: FxRateStore;
  freight: FreightRateProvider;
  now?: () => Date;
}

export type StageName =
  'resolveProducts' | 'resolveFx' | 'resolveFreight' | 'resolveTariff' | 'compute';

export interface StageReport {
  stage: StageName;
  ok: boolean;
  note: string;
}

export interface TariffSummary {
  /** Code actually used (10 digits when verified). */
  code: string;
  description: string | null;
  verified: boolean;
  normalisedFrom: string | null;
}

export type PipelineOutcome =
  | {
      kind: 'HS_CHOICE_REQUIRED';
      enteredCode: string;
      candidates: HsCandidate[];
      stages: StageReport[];
    }
  | { kind: 'FAILED'; stage: StageName; message: string; stages: StageReport[] }
  | {
      kind: 'QUOTE';
      quote: QuoteResult;
      stages: StageReport[];
      freight: { transitDays: number | null; assumptions: string[] };
      tariff: TariffSummary;
      line: { unitVolumeCbm: string; totalWeightKg: string; totalVolumeCbm: string };
    };

const D = (s: string): Decimal => new Decimal(s);
const CM3_PER_CBM = new Decimal(1_000_000);
const MIN_CBM = '0.0001';

/** Unit volume from the form: explicit CBM or carton L×W×H (cm) ÷ units per carton, 4 dp. */
export const resolveUnitVolumeCbm = (input: CalculatorInput): { cbm: string; note: string } => {
  if (input.unitVolumeCbm !== undefined) {
    return { cbm: D(input.unitVolumeCbm).toFixed(4), note: 'Volume per unit taken as entered.' };
  }
  const l = input.cartonLengthCm;
  const w = input.cartonWidthCm;
  const h = input.cartonHeightCm;
  const per = input.unitsPerCarton;
  if (l === undefined || w === undefined || h === undefined || per === undefined) {
    // Unreachable after zod's superRefine; kept so the type narrows without a throw.
    return { cbm: MIN_CBM, note: 'No volume given; minimum 0.0001 CBM assumed.' };
  }
  const cartonCbm = D(l).times(D(w)).times(D(h)).div(CM3_PER_CBM);
  let unit = cartonCbm.div(per).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (unit.lte(0)) unit = D(MIN_CBM);
  return {
    cbm: unit.toFixed(4),
    note: `Carton ${l}×${w}×${h} cm = ${cartonCbm.toDecimalPlaces(4).toFixed(4)} CBM ÷ ${per} units = ${unit.toFixed(4)} CBM per unit.`,
  };
};

type TariffStage =
  | { kind: 'CHOICE'; candidates: HsCandidate[] }
  | { kind: 'DONE'; tariff: TariffInput; summary: TariffSummary; note: string };

const unavailable = (reason: string, code: string, normalisedFrom: string | null): TariffStage => ({
  kind: 'DONE',
  tariff: { kind: 'UNAVAILABLE', reason },
  summary: { code, description: null, verified: false, normalisedFrom },
  note: `Tariff lookup failed: ${reason}`,
});

const resolveTariffStage = async (
  input: CalculatorInput,
  deps: PipelineDeps,
): Promise<TariffStage> => {
  const entered = input.hsCode;
  if (input.manualDuty) {
    const tariff: TariffInput = {
      kind: 'MANUAL',
      dutyRatePct: input.manualDutyRatePct ?? '0',
      vatRatePct: input.manualVatRatePct ?? '20',
      addRatePct: input.manualAddRatePct ?? null,
    };
    return {
      kind: 'DONE',
      tariff,
      summary: { code: entered, description: null, verified: false, normalisedFrom: null },
      note: 'Duty and VAT rates entered manually; the HS code was not checked against the UK tariff.',
    };
  }

  let code10 = entered;
  let normalisedFrom: string | null = null;
  if (entered.length < 10) {
    let candidates: HsCandidate[];
    try {
      candidates = await deps.tariff.headingCandidates(entered);
    } catch (err) {
      return unavailable(
        `UK Trade Tariff API unreachable (${err instanceof Error ? err.message : String(err)})`,
        entered,
        null,
      );
    }
    const n = normaliseHsCode(entered, candidates);
    if (!n.ok) {
      if (n.reason === 'AMBIGUOUS') return { kind: 'CHOICE', candidates: n.candidates };
      if (n.reason === 'NOT_FOUND')
        return unavailable(
          `no declarable 10-digit commodity found under ${entered}`,
          entered,
          null,
        );
      return unavailable(`HS code ${entered} is not valid`, entered, null);
    }
    code10 = n.code;
    normalisedFrom = n.normalised ? entered : null;
  }

  let lookup: TariffLookup;
  try {
    lookup = await deps.tariff.lookupCommodity(code10);
  } catch (err) {
    return unavailable(
      `UK Trade Tariff API unreachable (${err instanceof Error ? err.message : String(err)})`,
      code10,
      normalisedFrom,
    );
  }
  if (!lookup.ok) return unavailable(lookup.message, code10, normalisedFrom);
  return {
    kind: 'DONE',
    tariff: {
      kind: 'MEASURES',
      measures: lookup.commodity.measures,
      verifiedAt: lookup.fetchedAt.toISOString(),
    },
    summary: {
      code: code10,
      description: lookup.commodity.description,
      verified: true,
      normalisedFrom,
    },
    note: `${code10} verified against the UK tariff${lookup.fromCache ? ' (cached)' : ''}: ${lookup.commodity.measures.length} import measures.`,
  };
};

export const runQuotePipeline = async (
  input: CalculatorInput,
  deps: PipelineDeps,
): Promise<PipelineOutcome> => {
  const now = deps.now ?? (() => new Date());
  const stages: StageReport[] = [];
  const lane = parseLaneKey(input.lane);
  if (!lane) {
    return { kind: 'FAILED', stage: 'resolveProducts', message: 'Unknown route.', stages };
  }

  // ---------- resolveProducts ----------
  const volume = resolveUnitVolumeCbm(input);
  const totalWeightKg = D(input.unitWeightKg).times(input.quantity).toFixed(3);
  const totalVolumeCbm = D(volume.cbm).times(input.quantity).toFixed(4);
  stages.push({
    stage: 'resolveProducts',
    ok: true,
    note: `${volume.note} Shipment: ${totalWeightKg} kg, ${totalVolumeCbm} CBM.`,
  });

  // ---------- resolveFx ----------
  const manual =
    input.manualFxRate !== undefined ? { [input.currency]: input.manualFxRate } : undefined;
  const fx = await resolveFx(deps.fxStore, [input.currency], {
    at: now(),
    ...(manual ? { manual } : {}),
  });
  if (!fx.ok) {
    stages.push({
      stage: 'resolveFx',
      ok: false,
      note: `No exchange rate for ${fx.missing.join(', ')}.`,
    });
    return {
      kind: 'FAILED',
      stage: 'resolveFx',
      message: `We have no ${input.currency} → GBP exchange rate loaded. Enter a manual rate (GBP per 1 ${input.currency}) to continue.`,
      stages,
    };
  }
  const fxNote =
    input.currency === 'GBP'
      ? 'Prices are in GBP; no conversion needed.'
      : `${input.currency} rate: ${String(fx.fx.rates[input.currency]?.rateToGbp ?? '?')} GBP (${fx.fx.rates[input.currency]?.source ?? '?'}).`;
  stages.push({ stage: 'resolveFx', ok: true, note: fxNote });

  // ---------- resolveFreight ----------
  let freight: QuoteInput['freight'] = null;
  let transitDays: number | null = null;
  let assumptions: string[] = [];
  try {
    const res = await deps.freight.quote({
      origin: lane.origin,
      destination: lane.destination,
      mode: lane.mode,
      weightKg: totalWeightKg,
      volumeCbm: totalVolumeCbm,
    });
    if (res.ok) {
      freight = res.quote.freight;
      transitDays = res.quote.transitDays;
      assumptions = res.quote.assumptions;
      stages.push({
        stage: 'resolveFreight',
        ok: true,
        note: `${res.quote.freight.source}: £${String(res.quote.freight.toBorderGbp)} to the UK border.`,
      });
    } else {
      stages.push({ stage: 'resolveFreight', ok: false, note: res.message });
    }
  } catch (err) {
    stages.push({
      stage: 'resolveFreight',
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    });
  }

  // ---------- resolveTariff ----------
  const tariffStage = await resolveTariffStage(input, deps);
  if (tariffStage.kind === 'CHOICE') {
    stages.push({
      stage: 'resolveTariff',
      ok: false,
      note: `${input.hsCode} maps to ${tariffStage.candidates.length} commodity codes; choose one.`,
    });
    return {
      kind: 'HS_CHOICE_REQUIRED',
      enteredCode: input.hsCode,
      candidates: tariffStage.candidates,
      stages,
    };
  }
  stages.push({ stage: 'resolveTariff', ok: tariffStage.summary.verified, note: tariffStage.note });

  // ---------- compute ----------
  const line: LineInput = {
    ref: input.productLabel ?? 'line-1',
    hsCode: tariffStage.summary.code,
    hsCodeVerified: tariffStage.summary.verified,
    originCountry: input.originCountry,
    quantity: input.quantity,
    unitValue: input.unitPrice,
    currency: input.currency,
    unitWeightKg: input.unitWeightKg,
    unitVolumeCbm: volume.cbm,
    preferenceClaimed: input.preferenceClaimed,
    tariff: tariffStage.tariff,
  };
  let supplierFreight: SupplierFreightInput | null = null;
  if (DOOR_INCOTERMS.includes(input.incoterm) && input.supplierFreightTotalGbp !== undefined) {
    supplierFreight = {
      totalGbp: input.supplierFreightTotalGbp,
      postBorderGbp: input.supplierFreightUkGbp ?? null,
    };
  }
  const quoteInput: QuoteInput = {
    incoterm: input.incoterm,
    mode: lane.mode,
    originCountry: input.originCountry,
    originPort: lane.origin,
    destinationPort: lane.destination,
    lines: [line],
    fx: fx.fx,
    freight,
    supplierFreight,
    includeOriginFees: input.includeOriginFees,
    insurance:
      input.insurancePremiumGbp !== undefined ? { premiumGbp: input.insurancePremiumGbp } : null,
    vatRegistered: input.vatRegistered,
    asOf: now().toISOString(),
  };
  const result = computeQuote(quoteInput);
  if (!result.ok) {
    stages.push({ stage: 'compute', ok: false, note: `${result.code}: ${result.message}` });
    return { kind: 'FAILED', stage: 'compute', message: result.message, stages };
  }
  const quote = result.quote;
  if (tariffStage.summary.normalisedFrom) {
    quote.warnings.push(
      warn(
        'HS_NORMALISED',
        `HS code ${tariffStage.summary.normalisedFrom} was normalised to ${tariffStage.summary.code} (the only declarable code under it).`,
        line.ref,
      ),
    );
  }
  stages.push({
    stage: 'compute',
    ok: true,
    note: `${quote.status} · calc ${quote.calcVersion} · ${quote.warnings.length} warning(s).`,
  });
  return {
    kind: 'QUOTE',
    quote,
    stages,
    freight: { transitDays, assumptions },
    tariff: tariffStage.summary,
    line: { unitVolumeCbm: volume.cbm, totalWeightKg, totalVolumeCbm },
  };
};
