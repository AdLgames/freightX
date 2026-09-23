import {
  FieldCryptoError,
  ORGANIZATION_ENCRYPTED_FIELDS,
  isCiphertext,
  last4,
  orgFieldCipher,
  prismaDataKeyStore,
  recordAudit,
  type KeyProvider,
  type OrgFieldCipher,
  type TenantTransactionClient,
  type VerificationStatus,
} from '@harbour/db';
import type { JobQueue } from './jobs.server';

/**
 * M2 — organisation identity (UX spec steps 1 and 2; brief §5.6, §7.3).
 *
 * `Organization.eoriNumber` / `vatNumber` hold ciphertext under the organisation's data key
 * (packages/db crypto.ts). On save: encrypt, keep the last four characters for display, set the
 * verification status to PENDING and hand the caller the jobs to enqueue (`eori-verify`,
 * `vat-verify`) once the transaction has committed. Audit rows carry the last four only.
 *
 * Nothing in this module logs; the plaintext exists only inside `saveIdentity`.
 */
export interface IdentityFieldView {
  set: boolean;
  last4: string | null;
  status: VerificationStatus;
  verifiedAt: string | null;
}

export interface IdentityView {
  eori: IdentityFieldView;
  vat: IdentityFieldView & { registered: boolean };
}

const fieldView = (
  value: string | null,
  suffix: string | null,
  status: VerificationStatus,
  verifiedAt: Date | null,
): IdentityFieldView => ({
  // A pre-encryption plaintext (test data) counts as "not set": it is never shown or verified.
  set: isCiphertext(value),
  last4: isCiphertext(value) ? suffix : null,
  status: isCiphertext(value) ? status : 'UNVERIFIED',
  verifiedAt: verifiedAt?.toISOString() ?? null,
});

export const readIdentity = async (
  tx: TenantTransactionClient,
  organizationId: string,
): Promise<IdentityView> => {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      eoriNumber: true,
      eoriLast4: true,
      eoriVerificationStatus: true,
      eoriVerifiedAt: true,
      vatNumber: true,
      vatLast4: true,
      vatVerificationStatus: true,
      vatVerifiedAt: true,
      vatRegistered: true,
    },
  });
  return {
    eori: fieldView(org.eoriNumber, org.eoriLast4, org.eoriVerificationStatus, org.eoriVerifiedAt),
    vat: {
      ...fieldView(org.vatNumber, org.vatLast4, org.vatVerificationStatus, org.vatVerifiedAt),
      registered: org.vatRegistered,
    },
  };
};

export interface SaveIdentityContext {
  organizationId: string;
  userId: string;
  keyProvider: KeyProvider;
  now: Date;
}

/** What to change. An absent key leaves that part untouched. */
export interface IdentityPatch {
  /** null clears the EORI. */
  eoriNumber?: string | null;
  /** `number: undefined` keeps the stored number (only meaningful while registered). */
  vat?: { registered: boolean; number: string | null | undefined };
}

export type SaveIdentityResult =
  | { ok: true; changed: { eori: boolean; vat: boolean }; jobs: JobQueue[] }
  | { ok: false; errors: Record<string, string> };

export const PVA_BLOCKS_VAT_CHANGE =
  'Your customs profile uses postponed VAT accounting, which needs a VAT registration. Turn PVA off in Customs profile first.';
export const VAT_NUMBER_REQUIRED =
  'Enter your VAT registration number, or choose "No" if you are not VAT registered.';

/** Decrypts the stored value for comparison; an unreadable value (rotated key, plaintext) counts as "not set". */
const currentPlaintext = async (
  cipher: OrgFieldCipher,
  field: string,
  stored: string | null,
): Promise<string | null> => {
  if (!isCiphertext(stored)) return null;
  try {
    return await cipher.decrypt(field, stored);
  } catch (err) {
    if (err instanceof FieldCryptoError) return null;
    throw err;
  }
};

export const saveIdentity = async (
  tx: TenantTransactionClient,
  ctx: SaveIdentityContext,
  patch: IdentityPatch,
): Promise<SaveIdentityResult> => {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: {
      eoriNumber: true,
      vatNumber: true,
      vatRegistered: true,
      customsProfile: { select: { usePva: true } },
    },
  });
  const cipher = orgFieldCipher(ctx.keyProvider, prismaDataKeyStore(tx), ctx.organizationId);
  const F = ORGANIZATION_ENCRYPTED_FIELDS;

  const data: Parameters<typeof tx.organization.update>[0]['data'] = {};
  const jobs: JobQueue[] = [];
  let eoriChanged = false;
  let vatChanged = false;
  let newEori: string | null = null;
  let newVat: string | null = null;
  let newRegistered = org.vatRegistered;

  if (patch.eoriNumber !== undefined) {
    const current = await currentPlaintext(cipher, F.eoriNumber, org.eoriNumber);
    newEori = patch.eoriNumber;
    eoriChanged = current !== newEori;
    if (eoriChanged) {
      data.eoriNumber = newEori === null ? null : await cipher.encrypt(F.eoriNumber, newEori);
      data.eoriLast4 = newEori === null ? null : last4(newEori);
      data.eoriVerificationStatus = newEori === null ? 'UNVERIFIED' : 'PENDING';
      data.eoriVerifiedAt = null;
      if (newEori !== null) jobs.push('eori-verify');
    }
  }

  if (patch.vat !== undefined) {
    const current = await currentPlaintext(cipher, F.vatNumber, org.vatNumber);
    newRegistered = patch.vat.registered;
    newVat = !newRegistered ? null : patch.vat.number === undefined ? current : patch.vat.number;
    if (newRegistered && newVat === null) {
      return { ok: false, errors: { vatNumber: VAT_NUMBER_REQUIRED } };
    }
    // Pre-check the invariant the database trigger enforces, so the user gets a field message
    // instead of a failed transaction (the trigger is still the backstop, see the route).
    if (org.customsProfile?.usePva && (!newRegistered || newVat === null)) {
      return { ok: false, errors: { vatRegistered: PVA_BLOCKS_VAT_CHANGE } };
    }
    const numberChanged = current !== newVat;
    vatChanged = numberChanged || org.vatRegistered !== newRegistered;
    if (vatChanged) data.vatRegistered = newRegistered;
    if (numberChanged) {
      data.vatNumber = newVat === null ? null : await cipher.encrypt(F.vatNumber, newVat);
      data.vatLast4 = newVat === null ? null : last4(newVat);
      data.vatVerificationStatus = newVat === null ? 'UNVERIFIED' : 'PENDING';
      data.vatVerifiedAt = null;
      if (newVat !== null) jobs.push('vat-verify');
    }
  }

  if (!eoriChanged && !vatChanged) return { ok: true, changed: { eori: false, vat: false }, jobs };

  await tx.organization.update({ where: { id: ctx.organizationId }, data });

  if (eoriChanged) {
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'org.eori.update',
      targetType: 'Organization',
      targetId: ctx.organizationId,
      metadata: { eoriLast4: newEori === null ? null : last4(newEori) },
    });
  }
  if (vatChanged) {
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'org.vat.update',
      targetType: 'Organization',
      targetId: ctx.organizationId,
      metadata: {
        vatRegistered: newRegistered,
        vatLast4: newVat === null ? null : last4(newVat),
      },
    });
  }
  return { ok: true, changed: { eori: eoriChanged, vat: vatChanged }, jobs };
};

/** Maps the 0003 organisation trigger failure to a field message; anything else → null. */
export const identityDbError = (err: unknown): Record<string, string> | null => {
  const message = err instanceof Error ? err.message : '';
  if (/uses postponed VAT accounting/.test(message)) {
    return { vatRegistered: PVA_BLOCKS_VAT_CHANGE };
  }
  return null;
};
