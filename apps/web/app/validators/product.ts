import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { ALL_COUNTRY_CODES } from '../data/countries-all';
import {
  checkbox,
  currency,
  decimalString,
  hsCode,
  isoCountry,
  optionalField,
  positiveDecimalString,
  safeString,
} from './common';

/**
 * Product (catalogue) form schema — M3 (§5.6, docs/phase-1-workspace-ux.md "Products").
 * Money and measures are decimal STRINGS (ADR-0003); the Prisma columns bound the precision:
 * unitValue Decimal(14,4), weightKg Decimal(10,3), volumeCbm Decimal(10,4), carton cm Decimal(8,2).
 * The brief's sanity bounds (30,000 kg / 100 CBM) are engine warnings, not validation errors.
 */

const SANITY_MAX_MONEY = '100000000';
const SANITY_MAX_UNIT_WEIGHT_KG = '100000';
const SANITY_MAX_UNIT_CBM = '1000';
const SANITY_MAX_CARTON_CM = '100000';
const CM3_PER_CBM = new Decimal(1_000_000);
const MIN_CBM = '0.0001';

/** Letters, digits, dot, dash, underscore, slash; starts alphanumeric; up to 64 characters. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export const sku = z
  .string()
  .trim()
  .min(1, 'Enter a SKU.')
  .max(64, 'SKU must be 64 characters or fewer.')
  .regex(SKU_PATTERN, 'SKU may contain letters, digits, dots, dashes, underscores and slashes.');

/** Any ISO 3166-1 alpha-2 code from the full list (the calculator's short list is a subset). */
export const knownCountry = isoCountry.refine(
  (c) => ALL_COUNTRY_CODES.has(c),
  'Choose a country from the list.',
);

/** Every field the product form posts, as strings (blank → undefined where optional). */
export const PRODUCT_FIELDS = [
  'sku',
  'name',
  'supplierId',
  'originCountry',
  'unitValue',
  'currency',
  'weightKg',
  'volumeCbm',
  'cartonLengthCm',
  'cartonWidthCm',
  'cartonHeightCm',
  'unitsPerCarton',
  'hsCode',
] as const;

const baseShape = {
  sku,
  name: safeString(200, 1),
  supplierId: optionalField(z.uuid({ error: 'Choose a supplier from the list.' })),
  originCountry: knownCountry,
  unitValue: positiveDecimalString({ dp: 4, max: SANITY_MAX_MONEY }),
  currency,
  weightKg: positiveDecimalString({ dp: 3, max: SANITY_MAX_UNIT_WEIGHT_KG }),
  /** Either this… */
  volumeCbm: optionalField(positiveDecimalString({ dp: 4, max: SANITY_MAX_UNIT_CBM })),
  /** …or carton dimensions (cm) and units per carton. */
  cartonLengthCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  cartonWidthCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  cartonHeightCm: optionalField(positiveDecimalString({ dp: 2, max: SANITY_MAX_CARTON_CM })),
  unitsPerCarton: optionalField(
    z.coerce
      .number({ error: 'Enter a whole number of units.' })
      .int('Units per carton must be a whole number.')
      .min(1, 'Units per carton must be at least 1.')
      .max(100_000, 'Units per carton must be 100,000 or fewer.'),
  ),
  hsCode,
};

export const productFormSchema = z.object(baseShape).superRefine((v, ctx) => {
  const hasCbm = v.volumeCbm !== undefined;
  const cartonFields = [v.cartonLengthCm, v.cartonWidthCm, v.cartonHeightCm, v.unitsPerCarton];
  const anyCarton = cartonFields.some((f) => f !== undefined);
  const allCarton = cartonFields.every((f) => f !== undefined);
  if (!hasCbm && !allCarton) {
    ctx.addIssue({
      code: 'custom',
      path: ['volumeCbm'],
      message: anyCarton
        ? 'Enter all three carton dimensions and the units per carton, or the volume per unit.'
        : 'Enter the volume per unit in CBM, or carton dimensions and units per carton.',
    });
  }
});

export type ProductFormInput = z.infer<typeof productFormSchema>;

/**
 * Carton L×W×H (cm) ÷ units per carton → CBM per unit, Decimal throughout, 4 dp half-up (same
 * rule as the calculator pipeline). 40×30×25 cm and 12 per carton → 0.0025. A result that rounds
 * to zero becomes the 0.0001 CBM minimum so a line is never volume-less.
 */
export const cbmFromCarton = (
  lengthCm: string,
  widthCm: string,
  heightCm: string,
  unitsPerCarton: number,
): string => {
  if (!Number.isInteger(unitsPerCarton) || unitsPerCarton < 1) {
    throw new RangeError('unitsPerCarton must be a positive integer');
  }
  const carton = new Decimal(lengthCm).times(widthCm).times(heightCm).div(CM3_PER_CBM);
  let unit = carton.div(unitsPerCarton).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (unit.lte(0)) unit = new Decimal(MIN_CBM);
  return unit.toFixed(4);
};

export type ResolvedVolume =
  | { volumeCbm: string; source: 'ENTERED' }
  | { volumeCbm: string; source: 'CARTON'; cartonCbm: string };

/** The volume to store: entered CBM wins; otherwise computed from the carton. */
export const resolveProductVolume = (
  v: Pick<
    ProductFormInput,
    'volumeCbm' | 'cartonLengthCm' | 'cartonWidthCm' | 'cartonHeightCm' | 'unitsPerCarton'
  >,
): ResolvedVolume => {
  if (v.volumeCbm !== undefined) {
    return { volumeCbm: new Decimal(v.volumeCbm).toFixed(4), source: 'ENTERED' };
  }
  const { cartonLengthCm: l, cartonWidthCm: w, cartonHeightCm: h, unitsPerCarton: per } = v;
  if (l === undefined || w === undefined || h === undefined || per === undefined) {
    // Unreachable after superRefine; typed fallback rather than a throw.
    return { volumeCbm: MIN_CBM, source: 'ENTERED' };
  }
  const cartonCbm = new Decimal(l).times(w).times(h).div(CM3_PER_CBM).toDecimalPlaces(4).toFixed(4);
  return { volumeCbm: cbmFromCarton(l, w, h, per), source: 'CARTON', cartonCbm };
};

/** List filters: free-text search on SKU/name and the archived toggle. */
export const productSearchSchema = z.object({
  q: optionalField(safeString(100)),
  archived: checkbox,
});

export type ProductSearch = z.infer<typeof productSearchSchema>;

/** Actions the product form posts (`intent` field). */
export const PRODUCT_INTENTS = ['save', 'check-hs', 'archive', 'restore'] as const;
export type ProductIntent = (typeof PRODUCT_INTENTS)[number];

export const productIntent = z.enum(PRODUCT_INTENTS).catch('save');

/** Read the named string fields from a form (missing / non-string → ''). */
export const formStrings = <K extends string>(
  form: FormData | null,
  names: readonly K[],
): Record<K, string> => {
  const out = {} as Record<K, string>;
  for (const name of names) {
    const v = form?.get(name);
    out[name] = typeof v === 'string' ? v : '';
  }
  return out;
};

/** Optional percentage used by suppliers' payment terms; kept here so both validators share one rule. */
export const percentString = decimalString({ dp: 2, max: '100' });
