import {
  runIdentityVerify,
  type IdentityVerifyDeps,
  type IdentityVerifySummary,
} from './identity-verify.js';

/**
 * M2 — `eori-verify` queue: HMRC "Check an EORI number" for one organisation
 * (`{ organizationId }`), enqueued by apps/web when the EORI is saved. See identity-verify.ts.
 */
export type EoriVerifyDeps = Omit<IdentityVerifyDeps, 'field'>;
export type EoriVerifySummary = IdentityVerifySummary;

export const runEoriVerify = (payload: unknown, deps: EoriVerifyDeps): Promise<EoriVerifySummary> =>
  runIdentityVerify(payload, { ...deps, field: 'eori' });
