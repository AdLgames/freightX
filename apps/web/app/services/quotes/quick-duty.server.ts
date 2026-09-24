import { HttpError, type TariffLookup } from '@harbour/adapters';
import {
  D,
  computeLineDuty,
  normaliseHsCode,
  resolveTariff,
  type HsCandidate,
  type QuoteWarning,
} from '@harbour/engine';
import { quickDutySchema, type QuickDutyInput } from '../../validators/quote';
import { fieldErrors } from '../../validators/common';
import { getApp } from '../app.server';
import type { OrgContext } from '../auth.server';
import { TARIFF_LOOKUP_LIMIT } from '../catalogue/hs-lookup.server';
import { requestLogger } from '../logger.server';

/**
 * Home "quick duty check" (UX spec, Home): HS code + invoice value (GBP) + origin → duty %, VAT %
 * and the duty/VAT on that value, with the engine's warnings (anti-dumping, preference available…).
 * Nothing is saved. Reuses the tariff client with its 24-hour cache, the engine's measure
 * resolution (§5.2, fail closed) and the tariff rate limit (10 lookups per minute per user, §7.5).
 *
 * The figures are a rough guide only: no freight, insurance or fees are in the duty base here, so
 * the real customs value (§5.3) will be higher. The card says so.
 */

export type QuickDutyResult =
  | {
      kind: 'result';
      code: string;
      description: string;
      originCountry: string;
      invoiceValueGbp: string;
      dutyRatePct: string | null;
      dutySpecific: string | null;
      addRatePct: string | null;
      vatRatePct: string;
      dutyGbp: string;
      vatGbp: string;
      preferenceClaimed: boolean;
      warnings: QuoteWarning[];
      fromCache: boolean;
    }
  | { kind: 'candidates'; code: string; candidates: HsCandidate[] }
  | { kind: 'ambiguous'; code: string; reason: string; warnings: QuoteWarning[] }
  | { kind: 'not-found'; code: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'invalid'; errors: Record<string, string> };

export const QUICK_DUTY_UNAVAILABLE =
  'The UK Trade Tariff service could not be reached, so no duty rate is available right now. Try again in a few minutes; we never guess a rate.';

export const parseQuickDuty = (
  values: Record<string, string>,
): { ok: true; input: QuickDutyInput } | { ok: false; errors: Record<string, string> } => {
  const parsed = quickDutySchema.safeParse(values);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error.issues) };
  return { ok: true, input: parsed.data };
};

export const runQuickDuty = async (
  ctx: OrgContext,
  request: Request,
  values: Record<string, string>,
): Promise<QuickDutyResult> => {
  const parsed = parseQuickDuty(values);
  if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors };
  const input = parsed.input;
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const decision = await app.rateLimiter.consume(ctx.user.id, TARIFF_LOOKUP_LIMIT);
  if (!decision.allowed) {
    log.info('quick_duty.rate_limited', { userId: ctx.user.id, orgId: ctx.org.id });
    return { kind: 'rate-limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const now = new Date();

  let code = input.hsCode;
  if (code.length < 10) {
    let candidates: HsCandidate[];
    try {
      candidates = await app.tariff.headingCandidates(code);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) candidates = [];
      else return unavailable(log, ctx, code, err);
    }
    const n = normaliseHsCode(code, candidates);
    if (!n.ok) {
      if (n.reason === 'AMBIGUOUS') {
        log.info('quick_duty.completed', {
          userId: ctx.user.id,
          orgId: ctx.org.id,
          chapter: code.slice(0, 2),
          outcome: 'candidates',
        });
        return { kind: 'candidates', code, candidates: n.candidates };
      }
      return { kind: 'not-found', code };
    }
    // One declarable child: still the user's decision (§5.2, ADR-0006).
    const only = candidates.find((c) => c.code === n.code);
    return {
      kind: 'candidates',
      code,
      candidates: only ? [only] : [{ code: n.code, thirdCountryDuty: null }],
    };
  }

  let lookup: TariffLookup;
  try {
    lookup = await app.tariff.lookupCommodity(code);
  } catch (err) {
    return unavailable(log, ctx, code, err);
  }
  if (!lookup.ok) {
    if (lookup.reason === 'NOT_FOUND' || lookup.reason === 'INVALID_CODE') {
      return { kind: 'not-found', code };
    }
    return unavailable(log, ctx, code, new Error(lookup.message));
  }
  code = lookup.commodity.code;
  const resolved = resolveTariff(lookup.commodity.measures, {
    originCountry: input.originCountry,
    preferenceClaimed: input.preferenceClaimed,
    asOf: now,
    lineRef: 'quick-duty',
  });
  const outcome = resolved.ok ? 'result' : 'ambiguous';
  log.info('quick_duty.completed', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    chapter: code.slice(0, 2),
    originCountry: input.originCountry,
    outcome,
    warningCodes: resolved.warnings.toArray().map((w) => w.code),
  });
  if (!resolved.ok) {
    return {
      kind: 'ambiguous',
      code,
      reason: resolved.reason,
      warnings: resolved.warnings.toArray(),
    };
  }
  const t = resolved.tariff;
  const value = D(input.invoiceValueGbp);
  // Specific duties need a weight; the quick check has none, so only the ad valorem parts count.
  const adValorem = t.components.filter((c) => c.kind === 'AD_VALOREM');
  const duty = computeLineDuty(adValorem, t.addRatePct, {
    customsValueGbp: value,
    weightKg: D('0'),
    quantity: 1,
  }).toDecimalPlaces(2);
  const vat = value.plus(duty).times(t.vatRatePct).div(100).toDecimalPlaces(2);
  return {
    kind: 'result',
    code,
    description: lookup.commodity.description,
    originCountry: input.originCountry,
    invoiceValueGbp: value.toFixed(2),
    dutyRatePct: t.dutyRatePct === null ? null : t.dutyRatePct.toFixed(4),
    dutySpecific: t.dutySpecific
      ? `£${t.dutySpecific.amountGbp} per ${t.dutySpecific.per} ${t.dutySpecific.unit}`
      : null,
    addRatePct: t.addRatePct === null ? null : t.addRatePct.toFixed(4),
    vatRatePct: t.vatRatePct.toFixed(2),
    dutyGbp: duty.toFixed(2),
    vatGbp: vat.toFixed(2),
    preferenceClaimed: input.preferenceClaimed,
    warnings: resolved.warnings.toArray(),
    fromCache: lookup.fromCache,
  };
};

const unavailable = (
  log: ReturnType<typeof requestLogger>,
  ctx: OrgContext,
  code: string,
  err: unknown,
): QuickDutyResult => {
  log.warn('quick_duty.unavailable', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    chapter: code.slice(0, 2),
    error: err instanceof Error ? err.message : String(err),
  });
  return { kind: 'unavailable', message: QUICK_DUTY_UNAVAILABLE };
};

/** HTTP status for the JSON endpoint. */
export const quickDutyStatus = (r: QuickDutyResult): number => {
  switch (r.kind) {
    case 'invalid':
      return 400;
    case 'not-found':
      return 404;
    case 'rate-limited':
      return 429;
    case 'unavailable':
      return 503;
    case 'result':
    case 'candidates':
    case 'ambiguous':
      return 200;
  }
};
