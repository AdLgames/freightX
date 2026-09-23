import { Prisma, recordAudit, type PaymentMethod, type TenantTransactionClient } from '@harbour/db';
import type { CustomsProfileInput } from '../../validators/settings';

/**
 * M2 — customs profile wizard (UX spec steps 2–4; ADR-0011). Writes `CustomsProfile` for the
 * organisation; the database CHECKs and the PVA trigger (migration 0003) are the backstop and
 * their errors are translated into field messages by `customsProfileDbError`.
 *
 * The DAN is validated (7 digits) but NOT encrypted yet (packages/db README "Customs profile":
 * the 0003 CHECK must be dropped when it is). It never appears in audit metadata or logs.
 */
export interface CustomsProfileView {
  usePva: boolean;
  paymentMethod: PaymentMethod;
  brokerDefermentFeePct: string | null;
  brokerDefermentMinimumGbp: string | null;
  /** The DAN is shown back in the form (the user typed it); never elsewhere. */
  danNumber: string | null;
  cdsAuthorityGranted: boolean;
  cdsAuthorityConfirmedAt: string | null;
  vatRegistered: boolean;
  vatNumberSet: boolean;
}

export const readCustomsProfile = async (
  tx: TenantTransactionClient,
  organizationId: string,
): Promise<CustomsProfileView> => {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { vatRegistered: true, vatNumber: true, customsProfile: true },
  });
  const p = org.customsProfile;
  return {
    usePva: p?.usePva ?? false,
    paymentMethod: p?.paymentMethod ?? 'BROKER_DEFERMENT',
    brokerDefermentFeePct: p?.brokerDefermentFeePct?.toString() ?? null,
    brokerDefermentMinimumGbp: p?.brokerDefermentMinimumGbp?.toString() ?? null,
    danNumber: p?.danNumber ?? null,
    cdsAuthorityGranted: p?.cdsAuthorityGranted ?? false,
    cdsAuthorityConfirmedAt: p?.cdsAuthorityConfirmedAt?.toISOString() ?? null,
    vatRegistered: org.vatRegistered,
    vatNumberSet: org.vatNumber !== null,
  };
};

export interface CustomsProfileContext {
  organizationId: string;
  userId: string;
  now: Date;
}

export const PVA_NEEDS_VAT =
  'Postponed VAT accounting is only available to VAT-registered businesses. Add your VAT registration number in Organisation first.';
export const OWN_DEFERMENT_NEEDS_DAN =
  'Enter your deferment account number (DAN) to use your own account.';

export type SaveCustomsProfileResult =
  | { ok: true; changed: boolean; cdsConfirmed: boolean }
  | { ok: false; errors: Record<string, string> };

export const saveCustomsProfile = async (
  tx: TenantTransactionClient,
  ctx: CustomsProfileContext,
  input: CustomsProfileInput,
): Promise<SaveCustomsProfileResult> => {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { vatRegistered: true, vatNumber: true, customsProfile: true },
  });
  // Friendly pre-check of the trigger's rule (the trigger remains the backstop).
  if (input.usePva && !(org.vatRegistered && org.vatNumber !== null)) {
    return { ok: false, errors: { usePva: PVA_NEEDS_VAT } };
  }
  const existing = org.customsProfile;

  // CDS authority: granted only by an explicit, fresh confirmation for OWN_DEFERMENT; it is
  // cleared when the method changes away, and kept (with its original timestamp) otherwise.
  const keepAuthority =
    input.paymentMethod === 'OWN_DEFERMENT' && existing?.cdsAuthorityGranted === true;
  const grant = input.cdsAuthorityConfirmed && !keepAuthority;
  const cdsAuthorityGranted = keepAuthority || grant;
  const cdsAuthorityConfirmedAt = keepAuthority
    ? (existing?.cdsAuthorityConfirmedAt ?? ctx.now)
    : grant
      ? ctx.now
      : null;
  const cdsAuthorityConfirmedById = keepAuthority
    ? (existing?.cdsAuthorityConfirmedById ?? ctx.userId)
    : grant
      ? ctx.userId
      : null;

  const data = {
    usePva: input.usePva,
    paymentMethod: input.paymentMethod,
    brokerDefermentFeePct:
      input.brokerDefermentFeePct === null ? null : new Prisma.Decimal(input.brokerDefermentFeePct),
    brokerDefermentMinimumGbp:
      input.brokerDefermentMinimumGbp === null
        ? null
        : new Prisma.Decimal(input.brokerDefermentMinimumGbp),
    danNumber: input.danNumber,
    cdsAuthorityGranted,
    cdsAuthorityConfirmedAt,
    cdsAuthorityConfirmedById,
  };

  const unchanged =
    existing !== null &&
    existing.usePva === data.usePva &&
    existing.paymentMethod === data.paymentMethod &&
    (existing.brokerDefermentFeePct?.toString() ?? null) ===
      (data.brokerDefermentFeePct?.toString() ?? null) &&
    (existing.brokerDefermentMinimumGbp?.toString() ?? null) ===
      (data.brokerDefermentMinimumGbp?.toString() ?? null) &&
    existing.danNumber === data.danNumber &&
    existing.cdsAuthorityGranted === data.cdsAuthorityGranted;
  if (unchanged) return { ok: true, changed: false, cdsConfirmed: false };

  if (existing) {
    await tx.customsProfile.update({ where: { id: existing.id }, data });
  } else {
    await tx.customsProfile.create({ data: { organizationId: ctx.organizationId, ...data } });
  }
  // Never the DAN, never the fee (money is not PII but the DAN sits next to it; ids/enums/flags only).
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'org.customs_profile.update',
    targetType: 'CustomsProfile',
    targetId: existing?.id ?? ctx.organizationId,
    metadata: {
      usePva: data.usePva,
      paymentMethod: data.paymentMethod,
      danSet: data.danNumber !== null,
      feeTermsSet: data.brokerDefermentFeePct !== null || data.brokerDefermentMinimumGbp !== null,
      cdsAuthorityGranted,
    },
  });
  if (grant) {
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'org.cds_authority.confirm',
      targetType: 'CustomsProfile',
      targetId: existing?.id ?? ctx.organizationId,
    });
  }
  return { ok: true, changed: true, cdsConfirmed: grant };
};

/** Maps the 0003 CHECK / trigger failures to field messages; anything else is rethrown. */
export const customsProfileDbError = (err: unknown): Record<string, string> | null => {
  const message = err instanceof Error ? err.message : '';
  if (/postponed VAT accounting requires a VAT-registered/.test(message)) {
    return { usePva: PVA_NEEDS_VAT };
  }
  if (/customs_profiles_own_deferment_needs_dan/.test(message)) {
    return { danNumber: OWN_DEFERMENT_NEEDS_DAN };
  }
  if (/customs_profiles_dan_number_format/.test(message)) {
    return { danNumber: 'Your deferment account number (DAN) is 7 digits.' };
  }
  if (
    /customs_profiles_broker_fee_pct_range|customs_profiles_broker_minimum_nonnegative/.test(
      message,
    )
  ) {
    return {
      brokerDefermentFeePct:
        'Fee terms must be a percentage between 0 and 100 and a non-negative minimum.',
    };
  }
  return null;
};
