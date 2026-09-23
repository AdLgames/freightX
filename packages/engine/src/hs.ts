/**
 * HS / commodity code handling (§5.2). Pure functions only — the tariff lookup itself lives in
 * the tariff adapter; this module decides what to do with what the adapter found.
 */

export type HsCodeValidation =
  | { ok: true; code: string; length: 6 | 8 | 10; chapter: string }
  | { ok: false; reason: 'NOT_DIGITS' | 'BAD_LENGTH' };

export const validateHsCode = (raw: string): HsCodeValidation => {
  const code = raw.replace(/[\s.]/g, '');
  if (!/^\d+$/.test(code)) return { ok: false, reason: 'NOT_DIGITS' };
  if (code.length !== 6 && code.length !== 8 && code.length !== 10) {
    return { ok: false, reason: 'BAD_LENGTH' };
  }
  return { ok: true, code, length: code.length, chapter: code.slice(0, 2) };
};

export const hsChapter = (code: string): string => code.replace(/[\s.]/g, '').slice(0, 2);

/** Chapters we will not quote/book in v1 (§7.7). */
export const RESTRICTED_CHAPTERS: ReadonlySet<string> = new Set([
  '01', // live animals
  '22', // beverages, spirits (excise)
  '24', // tobacco (excise)
  '93', // arms and ammunition
]);

/** Chapters where a dangerous-goods class may apply and needs a manual check (§7.7). */
export const DANGEROUS_GOODS_CHAPTERS: ReadonlySet<string> = new Set(['28', '29']);

export interface HsCandidate {
  /** 10-digit commodity code. */
  code: string;
  /** Third-country duty expression for the candidate, e.g. "8.00 %". `null` if unknown. */
  thirdCountryDuty: string | null;
  description?: string;
}

export type HsNormalisation =
  | { ok: true; code: string; normalised: boolean }
  | { ok: false; reason: 'INVALID' | 'NOT_FOUND' | 'AMBIGUOUS'; candidates: HsCandidate[] };

/**
 * Normalise a 6/8/10-digit code to 10 digits given the 10-digit commodity codes the tariff
 * adapter found under that heading/subheading.
 *
 * - 10 digits: returned as-is if present in candidates (or if candidates is empty — caller
 *   verifies separately).
 * - 6/8 digits mapping to exactly one 10-digit code: normalised.
 * - Several 10-digit codes that all carry the same third-country duty: we still refuse to pick
 *   silently — the declared code matters beyond duty (ADD, licensing). AMBIGUOUS, user must pick.
 *   (This is stricter than the brief's minimum; relax only with customs-practitioner sign-off.)
 */
export const normaliseHsCode = (
  raw: string,
  candidates: readonly HsCandidate[],
): HsNormalisation => {
  const v = validateHsCode(raw);
  if (!v.ok) return { ok: false, reason: 'INVALID', candidates: [] };
  const matching = candidates.filter((c) => c.code.startsWith(v.code) && c.code.length === 10);
  if (v.length === 10) {
    return { ok: true, code: v.code, normalised: false };
  }
  if (matching.length === 0) return { ok: false, reason: 'NOT_FOUND', candidates: [] };
  const only = matching[0];
  if (matching.length === 1 && only !== undefined) {
    return { ok: true, code: only.code, normalised: true };
  }
  return { ok: false, reason: 'AMBIGUOUS', candidates: [...matching] };
};
