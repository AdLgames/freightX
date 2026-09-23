import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { ORIGIN_COUNTRY_CODES } from '../data/countries';
import {
  checkbox,
  currency,
  danNumber,
  decimalString,
  hsCode,
  isoCountry,
  blankToUndefined,
  optionalField,
  positiveDecimalString,
  quantity,
  safeString,
} from './common';

/**
 * Public calculator form (§5.6). Hard bounds here are generous "this cannot be real" limits;
 * the brief's sanity bounds (30,000 kg / 100 CBM per line) are *allowed* and produce the
 * engine's SANITY_BOUND warning rather than a validation error.
 */

export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP'] as const;
export type IncotermCode = (typeof INCOTERMS)[number];

/** Modes the Phase 0 rate sheet covers. ROAD/RAIL exist in the engine but have no rates yet. */
export const CALCULATOR_MODES = ['SEA_LCL', 'SEA_FCL', 'AIR'] as const;
export type CalculatorMode = (typeof CALCULATOR_MODES)[number];

/** Incoterms where the supplier price includes delivery, so we ask for their freight breakdown. */
export const DOOR_INCOTERMS: readonly IncotermCode[] = ['DAP', 'DPU', 'DDP'];

export const laneKey = (origin: string, destination: string, mode: string): string =>
  `${origin}:${destination}:${mode}`;

export const parseLaneKey = (
  key: string,
): { origin: string; destination: string; mode: CalculatorMode } | null => {
  const m = /^([A-Z]{2}[A-Z2-9]{3}):([A-Z]{2}[A-Z2-9]{3}):(SEA_LCL|SEA_FCL|AIR)$/.exec(key);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { origin: m[1], destination: m[2], mode: m[3] as CalculatorMode };
};

const SANITY_MAX_UNIT_WEIGHT_KG = '100000';
const SANITY_MAX_UNIT_CBM = '1000';
const SANITY_MAX_CARTON_CM = '1000';
const SANITY_MAX_MONEY = '100000000';
/** Lifetime production runs the supplier quotes a mould over; generous upper bound. */
const MAX_ASSIST_UNITS = 1_000_000_000;

/** How the importer pays duty and import VAT at the border (CDS). */
export const DUTY_PAYMENT_METHODS = ['BROKER_DEFERMENT', 'OWN_DAN', 'CDS_CASH'] as const;
export type DutyPaymentMethod = (typeof DUTY_PAYMENT_METHODS)[number];

export const DUTY_PAYMENT_LABELS: Record<DutyPaymentMethod, string> = {
  BROKER_DEFERMENT: 'Through the forwarder (broker deferment)',
  OWN_DAN: 'My own duty deferment account (DAN)',
  CDS_CASH: 'My CDS cash account',
};

/**
 * Apportion a one-off assist (mould, tooling, design) to this shipment:
 * cost × shipment quantity ÷ lifetime units, Decimal throughout, 2 dp half-up.
 */
export const apportionAssist = (
  totalCostGbp: string,
  shipmentQuantity: number,
  lifetimeUnits: number,
): string =>
  new Decimal(totalCostGbp)
    .times(shipmentQuantity)
    .div(lifetimeUnits)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);

/** The assist figure passed to the engine, and how it was arrived at (shown in the result). */
export type AssistResolution =
  | { method: 'DIRECT'; amountGbp: string }
  | {
      method: 'HELPER';
      amountGbp: string;
      totalCostGbp: string;
      lifetimeUnits: number;
      shipmentQuantity: number;
    };

const pctString = decimalString({ dp: 4, max: '1000' });

const originCountries = new Set(ORIGIN_COUNTRY_CODES);

const baseShape = {
  /** `${origin}:${destination}:${mode}` from the rate-sheet lane list. */
  lane: z.string().trim().max(30),
  incoterm: z.enum(INCOTERMS, { error: 'Choose an incoterm.' }),
  hsCode,
  originCountry: isoCountry.refine(
    (c) => originCountries.has(c),
    'Choose an origin country from the list.',
  ),
  quantity,
  unitPrice: positiveDecimalString({ dp: 4, max: SANITY_MAX_MONEY }),
  currency,
  unitWeightKg: positiveDecimalString({ dp: 4, max: SANITY_MAX_UNIT_WEIGHT_KG }),
  /** Either this… */
  unitVolumeCbm: optionalField(decimalString({ dp: 4, max: SANITY_MAX_UNIT_CBM })),
  /** …or carton dimensions (cm) and units per carton. */
  cartonLengthCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  cartonWidthCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  cartonHeightCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  unitsPerCarton: optionalField(z.coerce.number().int().min(1).max(100_000)),
  preferenceClaimed: checkbox,
  vatRegistered: checkbox,
  includeOriginFees: checkbox,
  insurancePremiumGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  /** GBP per 1 unit of `currency`. */
  manualFxRate: optionalField(positiveDecimalString({ dp: 6, max: '1000000' })),
  supplierFreightTotalGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  supplierFreightUkGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  manualDuty: checkbox,
  manualDutyRatePct: optionalField(pctString),
  manualVatRatePct: optionalField(pctString),
  manualAddRatePct: optionalField(pctString),
  /** Assists for THIS shipment in GBP, entered directly… */
  assistsGbp: optionalField(decimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  /** …or apportioned: total assist cost over the lifetime units it will be spread across. */
  assistTotalCostGbp: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_MONEY })),
  assistTotalUnits: optionalField(
    z.coerce
      .number({ error: 'Enter a whole number of units.' })
      .int('Units must be a whole number.')
      .min(1, 'Units must be at least 1.')
      .max(MAX_ASSIST_UNITS, 'Units must be 1,000,000,000 or fewer.'),
  ),
  dutyPayment: z.preprocess(
    blankToUndefined,
    z
      .enum(DUTY_PAYMENT_METHODS, { error: 'Choose how duty will be paid.' })
      .default('BROKER_DEFERMENT'),
  ),
  /** Broker deferment fee terms; blank → configured default (if any). */
  brokerFeePct: optionalField(decimalString({ dp: 4, max: '100' })),
  brokerMinimumGbp: optionalField(decimalString({ dp: 2, max: '100000' })),
  /** Own DAN: validated, never stored or logged. */
  dan: optionalField(danNumber),
  danAuthorised: checkbox,
  /** Postponed VAT accounting. Sent as ticked even without VAT registration (engine warns). */
  vatPostponed: checkbox,
  /** Optional free-text label for the line, echoed back only. */
  productLabel: optionalField(safeString(80)),
  /** Honeypot — must stay empty. */
  website: z.string().optional(),
  'cf-turnstile-response': z.string().max(4096).optional(),
};

const refineCalculator = (
  v: z.infer<z.ZodObject<typeof baseShape>>,
  ctx: z.RefinementCtx,
): void => {
  const hasCbm = v.unitVolumeCbm !== undefined;
  const cartonFields = [v.cartonLengthCm, v.cartonWidthCm, v.cartonHeightCm, v.unitsPerCarton];
  const anyCarton = cartonFields.some((f) => f !== undefined);
  const allCarton = cartonFields.every((f) => f !== undefined);
  if (!hasCbm && !allCarton) {
    ctx.addIssue({
      code: 'custom',
      path: ['unitVolumeCbm'],
      message: anyCarton
        ? 'Enter all three carton dimensions and the units per carton, or the volume per unit.'
        : 'Enter the volume per unit in CBM, or carton dimensions and units per carton.',
    });
  }
  if (v.manualDuty) {
    if (v.manualDutyRatePct === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['manualDutyRatePct'],
        message: 'Enter the duty rate (%).',
      });
    }
    if (v.manualVatRatePct === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['manualVatRatePct'],
        message: 'Enter the VAT rate (%).',
      });
    }
  }
  if (v.supplierFreightUkGbp !== undefined && v.supplierFreightTotalGbp === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['supplierFreightTotalGbp'],
      message: 'Enter the supplier freight total as well as the UK portion.',
    });
  }
  const helperGiven = v.assistTotalCostGbp !== undefined || v.assistTotalUnits !== undefined;
  if (v.assistsGbp !== undefined && helperGiven) {
    ctx.addIssue({
      code: 'custom',
      path: ['assistsGbp'],
      message:
        'Enter either the assist amount for this shipment, or the total cost and units to spread it over — not both.',
    });
  } else if (helperGiven) {
    if (v.assistTotalCostGbp === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['assistTotalCostGbp'],
        message: 'Enter the total tooling or mould cost (GBP).',
      });
    }
    if (v.assistTotalUnits === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['assistTotalUnits'],
        message: 'Enter the total number of units the cost is spread over.',
      });
    } else if (v.assistTotalUnits < v.quantity) {
      ctx.addIssue({
        code: 'custom',
        path: ['assistTotalUnits'],
        message: 'The units the cost is spread over cannot be fewer than this shipment’s quantity.',
      });
    }
  }
  if (v.dutyPayment === 'OWN_DAN') {
    if (v.dan === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dan'],
        message: 'Enter your 7-digit deferment account number (DAN).',
      });
    }
    if (!v.danAuthorised) {
      ctx.addIssue({
        code: 'custom',
        path: ['danAuthorised'],
        message:
          'Confirm you have authorised your forwarder’s EORI to use your DAN in your CDS account.',
      });
    }
  }
  if (v.website !== undefined && v.website !== '') {
    ctx.addIssue({ code: 'custom', path: ['website'], message: 'Unexpected value.' });
  }
};

const resolveAssists = (
  v: Pick<
    z.infer<z.ZodObject<typeof baseShape>>,
    'assistsGbp' | 'assistTotalCostGbp' | 'assistTotalUnits' | 'quantity'
  >,
): AssistResolution | null => {
  if (v.assistsGbp !== undefined) {
    return { method: 'DIRECT', amountGbp: new Decimal(v.assistsGbp).toFixed(2) };
  }
  if (v.assistTotalCostGbp !== undefined && v.assistTotalUnits !== undefined) {
    return {
      method: 'HELPER',
      amountGbp: apportionAssist(v.assistTotalCostGbp, v.quantity, v.assistTotalUnits),
      totalCostGbp: new Decimal(v.assistTotalCostGbp).toFixed(2),
      lifetimeUnits: v.assistTotalUnits,
      shipmentQuantity: v.quantity,
    };
  }
  return null;
};

/**
 * Build the schema against the lanes the rate sheet actually offers (the UN/LOCODE allow-list
 * is the rate sheet, §5.6). Lanes are `laneKey(origin, destination, mode)` strings.
 */
export const buildCalculatorSchema = (allowedLanes: readonly string[]) => {
  const lanes = new Set(allowedLanes);
  return z
    .object({
      ...baseShape,
      lane: baseShape.lane.refine(
        (k) => parseLaneKey(k) !== null && lanes.has(k),
        'Choose a route from the list.',
      ),
    })
    .superRefine(refineCalculator)
    .transform(({ dan, ...rest }) => ({
      ...rest,
      // The DAN is only checked for shape; it is dropped here so it never reaches the pipeline,
      // the logs or the result (Phase 0 stores nothing).
      danProvided: dan !== undefined,
      assists: resolveAssists(rest),
    }));
};

export type CalculatorSchema = ReturnType<typeof buildCalculatorSchema>;
export type CalculatorInput = z.infer<CalculatorSchema>;

/** Form field names (used to echo raw values back into the form). */
export const CALCULATOR_FIELDS = Object.keys(baseShape) as ReadonlyArray<keyof typeof baseShape>;

/** Read raw string values off a FormData for both validation and re-rendering. */
export const formDataToRecord = (form: FormData): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CALCULATOR_FIELDS) {
    const v = form.get(name);
    if (typeof v === 'string') out[name] = v.slice(0, 4096);
  }
  return out;
};
