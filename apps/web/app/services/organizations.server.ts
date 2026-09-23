import { randomUUID } from 'node:crypto';
import {
  recordAudit,
  withOrgTransaction,
  withUserTransaction,
  type Prisma,
  type PrismaClient,
  type Role,
} from '@harbour/db';

/**
 * Organisation and membership queries used by the auth layer (§7.2). Every read of a tenant table
 * runs inside `withOrgTransaction` (organisation context) or `withUserTransaction` (the user's own
 * memberships only), so RLS applies in addition to the Prisma scope.
 */

export interface MembershipSummary {
  membershipId: string;
  role: Role;
  organization: { id: string; name: string };
}

/**
 * The user's membership in `organizationId`, re-read from the database on every request. Null when
 * there is none (removed, never existed, tampered session) or the organisation is soft-deleted.
 */
export const findMembership = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<MembershipSummary | null> => {
  const row = await withOrgTransaction(
    prisma,
    organizationId,
    (tx) =>
      tx.membership.findFirst({
        where: { userId },
        select: {
          id: true,
          role: true,
          organization: { select: { id: true, name: true, deletedAt: true } },
        },
      }),
    { userId },
  );
  if (!row || row.organization.deletedAt !== null || row.organization.id !== organizationId) {
    return null;
  }
  return {
    membershipId: row.id,
    role: row.role,
    organization: { id: row.organization.id, name: row.organization.name },
  };
};

/**
 * The user's organisations, oldest membership first. Run it inside `withUserTransaction` /
 * `withUser` (user context: under RLS only the user's own memberships are visible).
 */
export const userOrganizationsQuery = async (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<MembershipSummary[]> => {
  const rows = await tx.membership.findMany({
    where: { userId, organization: { deletedAt: null } },
    select: { id: true, role: true, organization: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    membershipId: r.id,
    role: r.role,
    organization: { id: r.organization.id, name: r.organization.name },
  }));
};

export const listUserOrganizations = (
  prisma: PrismaClient,
  userId: string,
): Promise<MembershipSummary[]> =>
  withUserTransaction(prisma, userId, (tx) => userOrganizationsQuery(tx, userId));

/** Audit `session.org_switch` in the organisation being switched TO (its own audit trail). */
export const recordOrgSwitch = (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<void> =>
  withOrgTransaction(
    prisma,
    input.organizationId,
    (tx) =>
      recordAudit(tx, {
        organizationId: input.organizationId,
        userId: input.userId,
        action: 'session.org_switch',
        targetType: 'Organization',
        targetId: input.organizationId,
      }),
    { userId: input.userId },
  );

export interface CreatedOrganization {
  organizationId: string;
  membershipId: string;
  customsProfileId: string;
}

/**
 * Onboarding: Organization + OWNER Membership + an empty CustomsProfile (BROKER_DEFERMENT, no PVA)
 * and their audit rows, in ONE transaction. RLS requires `app.current_org = <new id>` for the
 * inserts, so the id is generated first (packages/db README, "Creating an organisation").
 */
export const createOrganization = async (
  prisma: PrismaClient,
  input: { userId: string; name: string; organizationId?: string },
): Promise<CreatedOrganization> => {
  const organizationId = input.organizationId ?? randomUUID();
  return withOrgTransaction(
    prisma,
    organizationId,
    async (tx) => {
      await tx.organization.create({ data: { id: organizationId, name: input.name } });
      const membership = await tx.membership.create({
        data: { organizationId, userId: input.userId, role: 'OWNER' },
        select: { id: true },
      });
      const profile = await tx.customsProfile.create({
        data: { organizationId, paymentMethod: 'BROKER_DEFERMENT', usePva: false },
        select: { id: true },
      });
      // IDs and enum values only in audit metadata; the organisation name is user free text (§7.3).
      await recordAudit(tx, {
        organizationId,
        userId: input.userId,
        action: 'org.create',
        targetType: 'Organization',
        targetId: organizationId,
        metadata: { customsProfileId: profile.id },
      });
      await recordAudit(tx, {
        organizationId,
        userId: input.userId,
        action: 'membership.create',
        targetType: 'Membership',
        targetId: membership.id,
        metadata: { role: 'OWNER', memberUserId: input.userId },
      });
      return { organizationId, membershipId: membership.id, customsProfileId: profile.id };
    },
    { userId: input.userId },
  );
};
