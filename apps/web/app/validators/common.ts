import { z } from 'zod';

/**
 * Shared zod primitives for every boundary (§5.6, §7.5). Money and quantities-with-decimals are
 * validated as decimal STRINGS and never coerced to `number` (ADR-0003).
 */

export const CURRENCIES = [
  'GBP',
  'USD',
  'EUR',
  'CNY',
  'INR',
  'TRY',
  'VND',
  'BDT',
  'PKR',
  'JPY',
] as const; // M3: JPY (HMRC publishes a monthly rate; UX spec "Data notes")
export type Currency = (typeof CURRENCIES)[number];

const HTML_CHARS = /[<>]/;

/** Trimmed, bounded, no `<`/`>` (no HTML at the boundary; React encodes on output anyway). */
export const safeString = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min, min > 0 ? 'This field is required.' : undefined)
    .max(max, `Must be ${max} characters or fewer.`)
    .refine((s) => !HTML_CHARS.test(s), 'Must not contain < or >.');

export interface DecimalStringOptions {
  /** Maximum decimal places (default 4). */
  dp?: number;
  /** Inclusive lower bound as a decimal string (default "0"). */
  min?: string;
  /** Whether the value must be strictly greater than `min` (default false). */
  exclusiveMin?: boolean;
  /** Inclusive upper bound as a decimal string. */
  max?: string;
}

const compareDecimalStrings = (a: string, b: string): number => {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const intA = ai.replace(/^0+(?=\d)/, '');
  const intB = bi.replace(/^0+(?=\d)/, '');
  if (intA.length !== intB.length) return intA.length < intB.length ? -1 : 1;
  if (intA !== intB) return intA < intB ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const fa = af.padEnd(width, '0');
  const fb = bf.padEnd(width, '0');
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
};

/**
 * Non-negative decimal as a string ("12", "12.5", "0.0001"). Leading "+", exponents, commas and
 * negative values are rejected; the engine's `D()` accepts exactly this grammar.
 */
export const decimalString = (opts: DecimalStringOptions = {}) => {
  const dp = opts.dp ?? 4;
  const min = opts.min ?? '0';
  const pattern = new RegExp(`^\\d{1,15}(\\.\\d{1,${dp}})?$`);
  let schema = z
    .string()
    .trim()
    .regex(pattern, `Enter a number with up to ${dp} decimal places.`)
    .refine(
      (s) => {
        const c = compareDecimalStrings(s, min);
        return opts.exclusiveMin ? c > 0 : c >= 0;
      },
      `Must be ${opts.exclusiveMin ? 'greater than' : 'at least'} ${min}.`,
    );
  if (opts.max !== undefined) {
    const max = opts.max;
    schema = schema.refine((s) => compareDecimalStrings(s, max) <= 0, `Must be ${max} or less.`);
  }
  return schema;
};

/** Strictly positive decimal (money, weights). */
export const positiveDecimalString = (opts: Omit<DecimalStringOptions, 'exclusiveMin'> = {}) =>
  decimalString({ ...opts, exclusiveMin: true });

/** HS / commodity code: digits only, 6, 8 or 10 long. Spaces and dots are stripped (9503.00.41.00). */
export const hsCode = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\d+$/, 'HS code must contain digits only.')
      .refine((s) => [6, 8, 10].includes(s.length), 'HS code must be 6, 8 or 10 digits.'),
  );

export const currency = z.enum(CURRENCIES, { error: 'Choose a supported currency.' });

export const quantity = z.coerce
  .number({ error: 'Enter a whole number.' })
  .int('Quantity must be a whole number.')
  .min(1, 'Quantity must be at least 1.')
  .max(1_000_000, 'Quantity must be 1,000,000 or fewer.');

/** ISO 3166-1 alpha-2. */
export const isoCountry = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Enter a two-letter country code.');

/** UN/LOCODE: 2-letter country + 3 alphanumerics (digits 2–9 only, per the standard). */
export const LOCODE_PATTERN = /^[A-Z]{2}[A-Z2-9]{3}$/;

export const locode = (allowList?: readonly string[]) => {
  const base = z.string().trim().toUpperCase().regex(LOCODE_PATTERN, 'Enter a valid UN/LOCODE.');
  if (!allowList) return base;
  const allowed = new Set(allowList);
  return base.refine((s) => allowed.has(s), 'This port is not on our rate sheet yet.');
};

/**
 * UK postcode (outward + inward), normalised to upper case with a single space:
 * "sw1a1aa" → "SW1A 1AA". Not a validity check against the PAF, just the format.
 */
export const UK_POSTCODE_PATTERN = /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/;

export const normalisePostcode = (raw: string): string => {
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  if (compact.length < 5) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
};

export const postcode = z
  .string()
  .trim()
  .transform(normalisePostcode)
  .pipe(z.string().regex(UK_POSTCODE_PATTERN, 'Enter a valid UK postcode.'));

/** EORI: GB or XI followed by 12 digits (§5.6). */
export const EORI_PATTERN = /^(GB|XI)\d{12}$/;

export const eori = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(EORI_PATTERN, 'EORI must be GB or XI followed by 12 digits.'));

/**
 * HMRC duty deferment account number (DAN): exactly 7 digits. Validated only; the calculator
 * never stores or logs it (Phase 0 persists nothing).
 */
export const DAN_PATTERN = /^\d{7}$/;

export const danNumber = z
  .string()
  .trim()
  .regex(DAN_PATTERN, 'Your deferment account number (DAN) is 7 digits.');

/**
 * UK VAT registration number check digit (HMRC "modulus 97" and "9755" algorithms).
 * Takes the 9-digit core (the first 9 digits after "GB"). The first 7 digits are weighted
 * 8,7,6,5,4,3,2 and summed; 97 is subtracted until the result is negative; the negative of that
 * result must equal the last two digits. Numbers issued after ~2010 use the same rule with 55
 * added to the sum first. Either passing means valid.
 */
export const isValidUkVatCheckDigit = (nineDigits: string): boolean => {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(nineDigits[i]), 0);
  const check = Number(nineDigits.slice(7, 9));
  const passes = (offset: number): boolean => {
    let t = sum + offset;
    while (t >= 0) t -= 97;
    return -t === check;
  };
  return passes(0) || passes(55);
};

/** VAT: GB + 9 digits, optionally + 3-digit branch suffix, with check-digit validation. */
export const VAT_PATTERN = /^GB\d{9}(\d{3})?$/;

export const vatNumber = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(
    z
      .string()
      .regex(VAT_PATTERN, 'VAT number must be GB followed by 9 or 12 digits.')
      .refine((s) => isValidUkVatCheckDigit(s.slice(2, 11)), 'VAT number check digit is wrong.'),
  );

/** HTML checkbox → boolean ("on"/"true"/"1" → true; absent/"" → false). */
export const checkbox = z.preprocess(
  (v) => v === 'on' || v === 'true' || v === '1' || v === true,
  z.boolean(),
);

/** Empty strings from blank form fields become `undefined` so `.optional()` applies. */
export const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

export const optionalField = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

/** Flatten zod issues into `{ field: firstMessage }` for form rendering. */
export const fieldErrors = (issues: readonly z.core.$ZodIssue[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_form';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
};
