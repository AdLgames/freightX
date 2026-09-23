import {
  runIdentityVerify,
  type IdentityVerifyDeps,
  type IdentityVerifySummary,
} from './identity-verify.js';

/**
 * M2 — `vat-verify` queue: HMRC "Check a UK VAT number" for one organisation
 * (`{ organizationId }`), enqueued by apps/web when the VAT number is saved. A "not found" is
 * recorded as INVALID and shown as a warning (§5.6: mismatch warns, it does not block).
 */
export type VatVerifyDeps = Omit<IdentityVerifyDeps, 'field'>;
export type VatVerifySummary = IdentityVerifySummary;

export const runVatVerify = (payload: unknown, deps: VatVerifyDeps): Promise<VatVerifySummary> =>
  runIdentityVerify(payload, { ...deps, field: 'vat' });
