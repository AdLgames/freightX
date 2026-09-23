import { z } from 'zod';
import { ORIGIN_COUNTRY_CODES } from '../data/countries';
import {
  checkbox,
  currency,
  decimalString,
  hsCode,
  isoCountry,
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
  if (v.website !== undefined && v.website !== '') {
    ctx.addIssue({ code: 'custom', path: ['website'], message: 'Unexpected value.' });
  }
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
    .superRefine(refineCalculator);
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
