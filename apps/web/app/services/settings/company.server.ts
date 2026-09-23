import {
  isEligibleForFinance,
  type CompaniesHouseClient,
  type CompanyMatch,
} from '@harbour/adapters';
import { recordAudit, type TenantTransactionClient } from '@harbour/db';

/**
 * M2 — Companies House confirmation (UX spec step 1b, ADR-0015). Stores what the API said about
 * the company the user confirmed (number, status, type, name, checked-at) or, for "I'm a sole
 * trader or partnership", a check time with no number. Only data is stored; whether the finance
 * module is offered is decided later by `isEligibleForFinance` (a pure function, shown here as a
 * read-only hint).
 */
export interface CompanyView {
  checkedAt: string | null;
  companyNumber: string | null;
  status: string | null;
  type: string | null;
  name: string | null;
  /** "Sole trader or partnership" was chosen: checked, no number. */
  unincorporated: boolean;
  financeEligible: boolean;
}

export const readCompany = async (
  tx: TenantTransactionClient,
  organizationId: string,
): Promise<CompanyView> => {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      companiesHouseNumber: true,
      companiesHouseStatus: true,
      companyType: true,
      companiesHouseName: true,
      companiesHouseCheckedAt: true,
    },
  });
  return {
    checkedAt: org.companiesHouseCheckedAt?.toISOString() ?? null,
    companyNumber: org.companiesHouseNumber,
    status: org.companiesHouseStatus,
    type: org.companyType,
    name: org.companiesHouseName,
    unincorporated: org.companiesHouseCheckedAt !== null && org.companiesHouseNumber === null,
    financeEligible: isEligibleForFinance({
      status: org.companiesHouseStatus,
      type: org.companyType,
    }),
  };
};

export type CompanyConfirmResult =
  { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'UNAVAILABLE' | 'UNAUTHORISED' | 'MALFORMED' };

export interface CompanyContext {
  organizationId: string;
  userId: string;
  now: Date;
}

/** Confirms a company by number: re-read from the API (never trusted from the form), then stored. */
export const confirmCompany = async (
  tx: TenantTransactionClient,
  client: CompaniesHouseClient,
  ctx: CompanyContext,
  companyNumber: string,
): Promise<CompanyConfirmResult> => {
  const profile = await client.getCompany(companyNumber);
  if (!profile.ok) return { ok: false, reason: profile.reason };
  await storeCompany(tx, ctx, profile.company);
  return { ok: true };
};

export const storeCompany = async (
  tx: TenantTransactionClient,
  ctx: CompanyContext,
  company: CompanyMatch | null,
): Promise<void> => {
  await tx.organization.update({
    where: { id: ctx.organizationId },
    data: {
      companiesHouseNumber: company?.companyNumber ?? null,
      companiesHouseStatus: company?.status ?? null,
      companyType: company?.type ?? null,
      companiesHouseName: company?.name ?? null,
      companiesHouseCheckedAt: ctx.now,
    },
  });
  // The company number is public registry data, not PII; the name is free text and stays out.
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'org.company.confirm',
    targetType: 'Organization',
    targetId: ctx.organizationId,
    metadata: {
      companyNumber: company?.companyNumber ?? null,
      status: company?.status ?? null,
      type: company?.type ?? null,
      unincorporated: company === null,
    },
  });
};
