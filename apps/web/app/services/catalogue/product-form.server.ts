import { data } from 'react-router';
import { z } from 'zod';
import { fieldErrors, hsCode as hsCodeSchema } from '../../validators/common';
import {
  PRODUCT_FIELDS,
  formStrings,
  productFormSchema,
  resolveProductVolume,
  type ProductFormInput,
} from '../../validators/product';
import type { OrgContext } from '../auth.server';
import { getApp } from '../app.server';
import { requestLogger } from '../logger.server';
import { TARIFF_LOOKUP_LIMIT, lookupHsCode, type HsLookupResult } from './hs-lookup.server';
import type { HsVerification, ProductRecord, ProductWrite } from './products.server';

/**
 * Shared server logic of the product "new" and "edit" routes (M3): reading the form, the
 * rate-limited HS lookup, and deciding what verification a save may record.
 *
 * Verification rule (§5.2, UX spec): `hsCodeVerifiedAt`/`hsDescription` are set ONLY when a
 * lookup succeeded for the exact 10-digit code being saved. A 6/8-digit code with candidates is
 * not saved — the user must pick (never guess). If the tariff service is down, or the code is not
 * found, or the user is over the lookup limit, the product saves UNVERIFIED with a clear notice.
 */

export type ProductFormValues = Record<(typeof PRODUCT_FIELDS)[number], string>;

/** The HS lookup outcome as the form re-renders it (JSON-safe, also returned by the endpoint). */
export type HsFieldState =
  | { kind: 'idle' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'result'; result: HsLookupResult };

export interface ProductActionData {
  values: ProductFormValues;
  errors: Record<string, string>;
  hs: HsFieldState;
  /** A non-field problem shown above the form. */
  notice: string | null;
}

/** Reads the posted product fields. A candidate radio (`hsCodeChoice`) overrides the typed code. */
export const readProductForm = (form: FormData | null): ProductFormValues => {
  const values = formStrings(form, PRODUCT_FIELDS);
  const choice = form?.get('hsCodeChoice');
  if (typeof choice === 'string' && choice.trim() !== '') values.hsCode = choice;
  return values;
};

export const parseProductForm = (
  values: ProductFormValues,
): { ok: true; input: ProductFormInput } | { ok: false; errors: Record<string, string> } => {
  const parsed = productFormSchema.safeParse(values);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error.issues) };
  return { ok: true, input: parsed.data };
};

/** One rate-limited lookup for the signed-in user (10/min, §7.5). */
export const rateLimitedLookup = async (
  ctx: OrgContext,
  request: Request,
  code: string,
): Promise<HsFieldState> => {
  const app = await getApp();
  const decision = await app.rateLimiter.consume(ctx.user.id, TARIFF_LOOKUP_LIMIT);
  const log = requestLogger(app.logger, request);
  if (!decision.allowed) {
    log.info('hs_lookup.rate_limited', { userId: ctx.user.id, orgId: ctx.org.id });
    return { kind: 'rate-limited', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const result = await lookupHsCode(app.tariff, code);
  log.info('hs_lookup.completed', {
    userId: ctx.user.id,
    orgId: ctx.org.id,
    chapter: code.slice(0, 2),
    outcome: result.ok ? result.kind : result.reason,
  });
  return { kind: 'result', result };
};

/**
 * What a save may record for `hsCode`. Re-uses an existing verification when the code has not
 * changed (no lookup, no rate-limit token); otherwise performs one lookup.
 */
export const verifyForSave = async (
  ctx: OrgContext,
  request: Request,
  hsCode: string,
  existing: ProductRecord | null,
): Promise<
  | { kind: 'save'; hs: HsVerification; notice: string | null; state: HsFieldState }
  | { kind: 'choose'; state: HsFieldState }
> => {
  if (existing && existing.hsCode === hsCode && existing.hsCodeVerifiedAt !== null) {
    return {
      kind: 'save',
      hs: {
        verifiedAt: existing.hsCodeVerifiedAt,
        description: existing.hsDescription,
        preferenceEligible: existing.preferenceEligible,
      },
      notice: null,
      state: { kind: 'idle' },
    };
  }
  const unverified: HsVerification = {
    verifiedAt: null,
    description: null,
    preferenceEligible: false,
  };
  const state = await rateLimitedLookup(ctx, request, hsCode);
  if (state.kind !== 'result') {
    return {
      kind: 'save',
      hs: unverified,
      state,
      notice:
        state.kind === 'rate-limited'
          ? `Saved unverified: too many tariff lookups in the last minute. Open the product again in about ${state.retryAfterSeconds} seconds and use "Check code".`
          : 'Saved unverified: the code was not checked.',
    };
  }
  const { result } = state;
  if (result.ok && result.kind === 'COMMODITY' && result.code === hsCode) {
    return {
      kind: 'save',
      hs: {
        verifiedAt: new Date(),
        description: result.description,
        preferenceEligible: result.preferenceEligible,
      },
      notice: null,
      state,
    };
  }
  if (result.ok && result.kind === 'CANDIDATES') {
    // Never guess: the user picks the 10-digit code, then saves again.
    return { kind: 'choose', state };
  }
  const reason =
    !result.ok && result.reason === 'UNAVAILABLE'
      ? 'the UK Trade Tariff service could not be reached'
      : !result.ok && result.reason === 'NOT_FOUND'
        ? 'the code was not found in the UK tariff'
        : 'the code could not be verified';
  return {
    kind: 'save',
    hs: unverified,
    state,
    notice: `Saved unverified: ${reason}. Quotes using this product will be indicative until the code is verified.`,
  };
};

/** Assemble the row to write from the validated form and the verification decision. */
export const toProductWrite = (input: ProductFormInput, hs: HsVerification): ProductWrite => {
  const volume = resolveProductVolume(input);
  const carton = volume.source === 'CARTON';
  return {
    sku: input.sku,
    name: input.name,
    supplierId: input.supplierId ?? null,
    originCountry: input.originCountry,
    unitValue: input.unitValue,
    currency: input.currency,
    weightKg: input.weightKg,
    volumeCbm: volume.volumeCbm,
    cartonLengthCm: carton ? (input.cartonLengthCm ?? null) : null,
    cartonWidthCm: carton ? (input.cartonWidthCm ?? null) : null,
    cartonHeightCm: carton ? (input.cartonHeightCm ?? null) : null,
    unitsPerCarton: input.unitsPerCarton ?? null,
    hsCode: input.hsCode,
    hs,
  };
};

/** A 400 with the form re-rendered. */
export const invalidForm = (
  values: ProductFormValues,
  errors: Record<string, string>,
  hs: HsFieldState = { kind: 'idle' },
  notice: string | null = null,
) => data<ProductActionData>({ values, errors, hs, notice }, { status: 400 });

/** The "Check code" button (no-JS path): validate just the code, look it up, re-render. */
export const checkHsIntent = async (
  ctx: OrgContext,
  request: Request,
  values: ProductFormValues,
) => {
  const code = hsCodeSchema.safeParse(values.hsCode);
  if (!code.success) {
    return invalidForm(values, { hsCode: code.error.issues[0]?.message ?? 'Invalid HS code.' });
  }
  const state = await rateLimitedLookup(ctx, request, code.data);
  return data<ProductActionData>(
    { values: { ...values, hsCode: code.data }, errors: {}, hs: state, notice: null },
    { status: state.kind === 'rate-limited' ? 429 : 200 },
  );
};

/** Which reason the list banner should give for an unverified save (`?reason=`). */
export const unverifiedReason = (
  state: HsFieldState,
): 'unavailable' | 'not-found' | 'rate-limited' => {
  if (state.kind === 'rate-limited') return 'rate-limited';
  if (state.kind === 'result' && !state.result.ok && state.result.reason === 'NOT_FOUND') {
    return 'not-found';
  }
  return 'unavailable';
};

/** The `?notice=` values the list page understands after a redirect. */
export const PRODUCT_NOTICES = [
  'saved',
  'saved-unverified',
  'archived',
  'restored',
  'not-found',
] as const;
export const productNotice = z.enum(PRODUCT_NOTICES).optional().catch(undefined);
