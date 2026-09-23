import { HttpError, type NormalisedCommodity, type TariffLookup } from '@harbour/adapters';
import {
  ERGA_OMNES,
  MEASURE_TYPES,
  normaliseHsCode,
  validateHsCode,
  type HsCandidate,
  type RawTariffMeasure,
} from '@harbour/engine';
import type { RateLimitPolicy } from '../rate-limit.server';

/**
 * HS code lookup for the catalogue (§5.2, ADR-0006, UX spec "HS code field"). Pure with respect to
 * the tariff client: it takes the app's cached `UkTradeTariffClient` (24 h cache) and returns a
 * JSON-safe result the endpoint, the no-JS "Check code" action and the save path all share.
 *
 *   10 digits → `lookupCommodity`: official description, third-country duty, VAT rate and a
 *               "preference exists" hint (any 142 measure). Verification happens ONLY here.
 *   6/8 digits → `headingCandidates` + `normaliseHsCode`: the declarable 10-digit children with
 *               their descriptions and duties for the USER to pick. A single child is still a
 *               candidate, never an automatic choice (the declared code matters beyond duty).
 *   9/11 digits, letters → INVALID.
 */

/** §7.5: 10 tariff lookups per minute per user. Subject = user id (hashed by the limiter). */
export const TARIFF_LOOKUP_LIMIT: RateLimitPolicy = {
  name: 'tariff-lookup',
  capacity: 10,
  windowMs: 60 * 1000,
};

export interface CommoditySummary {
  code: string;
  description: string;
  /** e.g. "8.00 %"; null when no ERGA OMNES third-country measure is in force (engine: TARIFF_AMBIGUOUS). */
  thirdCountryDuty: string | null;
  /** e.g. "20.00 %"; null when no VAT measure (engine assumes 20%, VAT_ASSUMED_STANDARD). */
  vatRate: string | null;
  /** Informational: at least one preferential (142) measure exists for SOME origin. */
  preferenceEligible: boolean;
}

export type HsLookupResult =
  | ({ ok: true; kind: 'COMMODITY'; fetchedAt: string; fromCache: boolean } & CommoditySummary)
  | { ok: true; kind: 'CANDIDATES'; code: string; candidates: HsCandidate[] }
  | { ok: false; reason: 'INVALID' | 'NOT_FOUND' | 'UNAVAILABLE'; message: string };

export const HS_INVALID_MESSAGE = 'Enter 6, 8 or 10 digits (spaces and dots are ignored).';

const isActive = (m: RawTariffMeasure, asOf: Date): boolean => {
  if (m.effectiveStartDate) {
    const start = new Date(m.effectiveStartDate);
    if (!Number.isNaN(start.getTime()) && start > asOf) return false;
  }
  if (m.effectiveEndDate) {
    const end = new Date(m.effectiveEndDate);
    if (!Number.isNaN(end.getTime()) && end < asOf) return false;
  }
  return true;
};

/** Headline figures from a normalised commodity; the engine does the real per-origin resolution. */
export const summariseCommodity = (
  commodity: NormalisedCommodity,
  asOf: Date = new Date(),
): CommoditySummary => {
  const active = commodity.measures.filter((m) => isActive(m, asOf));
  const thirdCountry = active.find(
    (m) =>
      m.measureTypeId === MEASURE_TYPES.THIRD_COUNTRY_DUTY && m.geographicalAreaId === ERGA_OMNES,
  );
  const vat = active.find((m) => m.measureTypeId === MEASURE_TYPES.VAT);
  const preference = active.some(
    (m) => m.measureTypeId === MEASURE_TYPES.PREFERENCE && m.geographicalAreaId !== ERGA_OMNES,
  );
  return {
    code: commodity.code,
    description: commodity.description,
    thirdCountryDuty: thirdCountry?.dutyExpression || null,
    vatRate: vat?.dutyExpression || null,
    preferenceEligible: preference,
  };
};

export interface HsLookupClient {
  lookupCommodity(code: string): Promise<TariffLookup>;
  headingCandidates(code: string): Promise<HsCandidate[]>;
}

const unavailable = (err: unknown): HsLookupResult => ({
  ok: false,
  reason: 'UNAVAILABLE',
  message: `The UK Trade Tariff service could not be reached (${err instanceof Error ? err.message : String(err)}). You can save the product unverified and check the code later.`,
});

export const lookupHsCode = async (
  tariff: HsLookupClient,
  raw: string,
  now: () => Date = () => new Date(),
): Promise<HsLookupResult> => {
  const v = validateHsCode(raw);
  if (!v.ok) return { ok: false, reason: 'INVALID', message: HS_INVALID_MESSAGE };

  if (v.length !== 10) {
    let candidates: HsCandidate[];
    try {
      candidates = await tariff.headingCandidates(v.code);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) candidates = [];
      else return unavailable(err);
    }
    const n = normaliseHsCode(v.code, candidates);
    if (n.ok) {
      // Exactly one child: still the user's decision (ADR-0006, UX spec "never guesses").
      const only = candidates.find((c) => c.code === n.code);
      return {
        ok: true,
        kind: 'CANDIDATES',
        code: v.code,
        candidates: only ? [only] : [{ code: n.code, thirdCountryDuty: null }],
      };
    }
    if (n.reason === 'AMBIGUOUS') {
      return { ok: true, kind: 'CANDIDATES', code: v.code, candidates: n.candidates };
    }
    return {
      ok: false,
      reason: 'NOT_FOUND',
      message: `No declarable 10-digit commodity code was found under ${v.code} in the UK tariff. Check the code on trade-tariff.service.gov.uk.`,
    };
  }

  let lookup: TariffLookup;
  try {
    lookup = await tariff.lookupCommodity(v.code);
  } catch (err) {
    return unavailable(err);
  }
  if (!lookup.ok) {
    if (lookup.reason === 'NOT_FOUND') {
      return {
        ok: false,
        reason: 'NOT_FOUND',
        message: `${v.code} is not in the UK tariff. Check the code on trade-tariff.service.gov.uk.`,
      };
    }
    if (lookup.reason === 'INVALID_CODE') {
      return { ok: false, reason: 'INVALID', message: HS_INVALID_MESSAGE };
    }
    return unavailable(new Error(lookup.message));
  }
  return {
    ok: true,
    kind: 'COMMODITY',
    fetchedAt: lookup.fetchedAt.toISOString(),
    fromCache: lookup.fromCache,
    ...summariseCommodity(lookup.commodity, now()),
  };
};

/** HTTP status for a lookup result (the JSON endpoint and the no-JS action agree). */
export const hsLookupStatus = (result: HsLookupResult): number => {
  if (result.ok) return 200;
  switch (result.reason) {
    case 'INVALID':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'UNAVAILABLE':
      return 503;
  }
};
