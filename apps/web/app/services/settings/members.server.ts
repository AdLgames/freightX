import { recordAudit, type Role, type TenantTransactionClient } from '@harbour/db';

/**
 * M2 — members (UX spec "Settings", brief §7.2 "manage members"). All functions run on the
 * transaction client from `withOrg` (tenant scope + RLS) and return a result object; the route
 * turns `ok: false` into a form message. Rules:
 *
 *   - OWNER may be granted or removed only by an OWNER.
 *   - Nobody changes their own role or removes themselves (an OWNER handing over does it in two
 *     steps: promote, then be demoted by the new owner).
 *   - The last OWNER can be neither demoted nor removed.
 *   - Removing a member bumps `users.sessionEpoch`, which signs that user out everywhere on their
 *     next request (auth.server.ts). A role change is picked up by M1's role check.
 *
 * Audit metadata: ids and roles only; the member's address is never recorded.
 */
export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  since: string;
  isSelf: boolean;
}

export const listMembers = async (
  tx: TenantTransactionClient,
  selfUserId: string,
): Promise<MemberView[]> => {
  const rows = await tx.membership.findMany({
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((m) => ({
    membershipId: m.id,
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    since: m.createdAt.toISOString(),
    isSelf: m.user.id === selfUserId,
  }));
};

export interface MemberActionContext {
  organizationId: string;
  userId: string;
  role: Role;
}

export type MemberActionResult = { ok: true } | { ok: false; message: string };

export const MEMBER_MESSAGES = {
  ownerOnly: 'Only an owner can grant or remove the owner role.',
  self: 'You cannot change your own role or remove yourself. Ask another owner or admin.',
  lastOwner: 'An organisation needs at least one owner. Make someone else an owner first.',
  notFound: 'That member is no longer part of this organisation.',
  noChange: 'That member already has this role.',
} as const;

/** OWNER may assign any role; ADMIN may assign any role except OWNER. */
export const canAssignRole = (actor: Role, target: Role): boolean =>
  actor === 'OWNER' || (actor === 'ADMIN' && target !== 'OWNER');

const ownerCount = (tx: TenantTransactionClient): Promise<number> =>
  tx.membership.count({ where: { role: 'OWNER' } });

export const changeMemberRole = async (
  tx: TenantTransactionClient,
  ctx: MemberActionContext,
  input: { membershipId: string; role: Role },
): Promise<MemberActionResult> => {
  const target = await tx.membership.findFirst({
    where: { id: input.membershipId },
    select: { id: true, userId: true, role: true },
  });
  if (!target) return { ok: false, message: MEMBER_MESSAGES.notFound };
  if (target.userId === ctx.userId) return { ok: false, message: MEMBER_MESSAGES.self };
  if (target.role === input.role) return { ok: false, message: MEMBER_MESSAGES.noChange };
  // Granting OWNER, or taking it away, is an owner-only act.
  if (!canAssignRole(ctx.role, input.role) || (target.role === 'OWNER' && ctx.role !== 'OWNER')) {
    return { ok: false, message: MEMBER_MESSAGES.ownerOnly };
  }
  if (target.role === 'OWNER' && (await ownerCount(tx)) <= 1) {
    return { ok: false, message: MEMBER_MESSAGES.lastOwner };
  }
  await tx.membership.update({ where: { id: target.id }, data: { role: input.role } });
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'membership.role_change',
    targetType: 'Membership',
    targetId: target.id,
    metadata: { memberUserId: target.userId, from: target.role, to: input.role },
  });
  return { ok: true };
};

export const removeMember = async (
  tx: TenantTransactionClient,
  ctx: MemberActionContext,
  input: { membershipId: string },
): Promise<MemberActionResult> => {
  const target = await tx.membership.findFirst({
    where: { id: input.membershipId },
    select: { id: true, userId: true, role: true },
  });
  if (!target) return { ok: false, message: MEMBER_MESSAGES.notFound };
  if (target.userId === ctx.userId) return { ok: false, message: MEMBER_MESSAGES.self };
  if (target.role === 'OWNER' && ctx.role !== 'OWNER') {
    return { ok: false, message: MEMBER_MESSAGES.ownerOnly };
  }
  if (target.role === 'OWNER' && (await ownerCount(tx)) <= 1) {
    return { ok: false, message: MEMBER_MESSAGES.lastOwner };
  }
  await tx.membership.delete({ where: { id: target.id } });
  // `users` is global (no RLS): bump the epoch so every session of that user is invalidated on
  // its next request. They can sign in again; they just no longer see this organisation.
  await tx.user.update({
    where: { id: target.userId },
    data: { sessionEpoch: { increment: 1 } },
  });
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'membership.delete',
    targetType: 'Membership',
    targetId: target.id,
    metadata: { memberUserId: target.userId, role: target.role },
  });
  return { ok: true };
};
