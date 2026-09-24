import { CONTAINER_NUMBER_RE, IMO_RE } from './types.js';

/**
 * Check digits (ADR-0017: "validated at input so a mistyped number never subscribes a
 * stranger's container").
 *
 * ISO 6346 container numbers: 4 letters (owner code + category identifier) + 6 serial digits +
 * 1 check digit. Letter values are A=10 … Z=38 skipping multiples of 11 (11, 22, 33); digits are
 * themselves. Each of the first 10 characters is weighted 2^position (position 0 = first), the
 * sum is taken modulo 11, and a result of 10 becomes 0.
 */
const LETTER_VALUES: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  let value = 10;
  for (let i = 0; i < 26; i += 1) {
    if (value % 11 === 0) value += 1; // skip 11, 22, 33
    out[String.fromCharCode(65 + i)] = value;
    value += 1;
  }
  return out;
})();

const charValue = (ch: string): number => {
  if (ch >= '0' && ch <= '9') return Number(ch);
  return LETTER_VALUES[ch] ?? Number.NaN;
};

/** Check digit for the first 10 characters of a container number (letters + 6 digits). */
export const iso6346CheckDigit = (first10: string): number => {
  if (!/^[A-Z]{4}[0-9]{6}$/.test(first10)) {
    throw new Error('iso6346CheckDigit: expected 4 letters and 6 digits');
  }
  let sum = 0;
  for (let i = 0; i < 10; i += 1) sum += charValue(first10[i]!) * 2 ** i;
  return (sum % 11) % 10;
};

/** Upper-cases and strips spaces/hyphens; does not validate. */
export const normaliseContainerNumber = (raw: string): string =>
  raw.toUpperCase().replace(/[\s-]/g, '');

export type ContainerNumberCheck =
  | { ok: true; containerNumber: string }
  | { ok: false; reason: 'FORMAT' | 'CHECK_DIGIT'; message: string };

export const checkContainerNumber = (raw: string): ContainerNumberCheck => {
  const containerNumber = normaliseContainerNumber(raw);
  if (!CONTAINER_NUMBER_RE.test(containerNumber)) {
    return {
      ok: false,
      reason: 'FORMAT',
      message: 'Container numbers are 4 letters followed by 7 digits, e.g. MSKU1234565.',
    };
  }
  const expected = iso6346CheckDigit(containerNumber.slice(0, 10));
  if (Number(containerNumber[10]) !== expected) {
    return {
      ok: false,
      reason: 'CHECK_DIGIT',
      message:
        'That container number fails its check digit — please check it against the bill of lading.',
    };
  }
  return { ok: true, containerNumber };
};

export const isValidContainerNumber = (raw: string): boolean => checkContainerNumber(raw).ok;

/**
 * IMO ship identification numbers: 7 digits; the last is a check digit = (sum of the first six
 * digits weighted 7,6,5,4,3,2) mod 10.
 */
export const imoCheckDigit = (first6: string): number => {
  if (!/^[0-9]{6}$/.test(first6)) throw new Error('imoCheckDigit: expected 6 digits');
  let sum = 0;
  for (let i = 0; i < 6; i += 1) sum += Number(first6[i]) * (7 - i);
  return sum % 10;
};

export const normaliseImo = (raw: string): string =>
  raw
    .toUpperCase()
    .replace(/^IMO\s*/, '')
    .replace(/[\s-]/g, '');

export type ImoCheck =
  { ok: true; imo: string } | { ok: false; reason: 'FORMAT' | 'CHECK_DIGIT'; message: string };

export const checkImo = (raw: string): ImoCheck => {
  const imo = normaliseImo(raw);
  if (!IMO_RE.test(imo)) {
    return { ok: false, reason: 'FORMAT', message: 'IMO numbers are 7 digits, e.g. 9074729.' };
  }
  if (Number(imo[6]) !== imoCheckDigit(imo.slice(0, 6))) {
    return { ok: false, reason: 'CHECK_DIGIT', message: 'That IMO number fails its check digit.' };
  }
  return { ok: true, imo };
};

export const isValidImo = (raw: string): boolean => checkImo(raw).ok;
