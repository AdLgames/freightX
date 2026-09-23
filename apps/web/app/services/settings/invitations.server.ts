import {
  recordAudit,
  withOrgTransaction,
  type PrismaClient,
  type Role,
  type TenantTransactionClient,
} from '@harbour/db';
import { hashEmail } from '../magic-link.server';
import { randomToken, sha256Hex } from '../session.server';
import { canAssignRole, MEMBER_MESSAGES } from './members.server';

/**
 * M2 — invitations (brief §7.2 "manage members"; UX spec "Settings").
 *
 * - The link is `${origin}/invite/accept?token=<organisation id>.<secret>`. The organisation id
 *   selects the RLS context for the lookup; the secret (32 random bytes) is the credential and
 *   only its sha256 is stored (`tokenHash`), like magic links.
 * - `email` is stored lower-cased for the accept-time comparison; `emailHash` (sha256) is what
 *   "already invited?" queries filter on, so the address is never a query parameter.
 * - 7-day expiry. Accepting requires being signed in AS THAT ADDRESS (case-insensitive); anyone
 *   else gets "sent to a different address" and nothing changes.
 * - Audit rows carry ids and roles only.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const inviteUrl = (origin: string, organizationId: string, secret: string): string =>
  `${origin}/invite/accept?token=${encodeURIComponent(`${organizationId}.${secret}`)}`;

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

/** Open invitations (not accepted, not revoked), newest first. */
export const listPendingInvitations = async (
  tx: TenantTransactionClient,
  now: Date,
): Promise<InvitationView[]> => {
  const rows = await tx.invitation.findMany({
    where: { acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= now.getTime(),
  }));
};

export interface InviteContext {
  organizationId: string;
  userId: string;
  role: Role;
  now: Date;
}

export type CreateInvitationResult =
  | { ok: true; invitationId: string; secret: string; expiresAt: Date }
  | { ok: false; message: string };

export const INVITE_MESSAGES = {
  alreadyMember: 'That person is already a member of this organisation.',
  alreadyInvited: 'That person already has a pending invitation. Revoke it to send a new one.',
  notPending: 'That invitation is no longer pending.',
} as const;

export const createInvitation = async (
  tx: TenantTransactionClient,
  ctx: InviteContext,
  input: { email: string; role: Role },
): Promise<CreateInvitationResult> => {
  if (!canAssignRole(ctx.role, input.role))
    return { ok: false, message: MEMBER_MESSAGES.ownerOnly };
  const email = input.email.trim().toLowerCase();
  const emailHash = hashEmail(email);

  // `users` is global: an existing account with this address that is already a member.
  const existingUser = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    const member = await tx.membership.findFirst({
      where: { userId: existingUser.id },
      select: { id: true },
    });
    if (member) return { ok: false, message: INVITE_MESSAGES.alreadyMember };
  }
  const pending = await tx.invitation.findFirst({
    where: { emailHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: ctx.now } },
    select: { id: true },
  });
  if (pending) return { ok: false, message: INVITE_MESSAGES.alreadyInvited };

  const secret = randomToken();
  const expiresAt = new Date(ctx.now.getTime() + INVITATION_TTL_MS);
  const row = await tx.invitation.create({
    data: {
      organizationId: ctx.organizationId,
      email,
      emailHash,
      role: input.role,
      invitedById: ctx.userId,
      tokenHash: sha256Hex(secret),
      expiresAt,
      createdAt: ctx.now,
    },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'invitation.create',
    targetType: 'Invitation',
    targetId: row.id,
    metadata: { role: input.role },
  });
  return { ok: true, invitationId: row.id, secret, expiresAt };
};

export const revokeInvitation = async (
  tx: TenantTransactionClient,
  ctx: InviteContext,
  input: { invitationId: string },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const { count } = await tx.invitation.updateMany({
    where: { id: input.invitationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: ctx.now },
  });
  if (count !== 1) return { ok: false, message: INVITE_MESSAGES.notPending };
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'invitation.revoke',
    targetType: 'Invitation',
    targetId: input.invitationId,
  });
  return { ok: true };
};

// ---------- accepting ----------

export interface InvitationPreview {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  role: Role;
  /** Whether the signed-in user's address matches (case-insensitive). */
  forThisUser: boolean;
}

export type LookupInvitationResult =
  | { ok: true; invitation: InvitationPreview }
  | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'REVOKED' | 'ACCEPTED' };

/**
 * Finds the invitation behind a link, in the organisation's RLS context (the id comes from the
 * link; the secret must match the stored hash, so a guessed id finds nothing).
 */
export const lookupInvitation = async (
  prisma: PrismaClient,
  token: { organizationId: string; secret: string },
  user: { id: string; email: string },
  now: Date,
): Promise<LookupInvitationResult> =>
  withOrgTransaction(
    prisma,
    token.organizationId,
    async (tx) => {
      const row = await tx.invitation.findFirst({
        where: { tokenHash: sha256Hex(token.secret) },
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          organization: { select: { id: true, name: true, deletedAt: true } },
        },
      });
      if (!row || row.organization.deletedAt !== null) return { ok: false, reason: 'INVALID' };
      if (row.revokedAt !== null) return { ok: false, reason: 'REVOKED' };
      if (row.acceptedAt !== null) return { ok: false, reason: 'ACCEPTED' };
      if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
      return {
        ok: true,
        invitation: {
          invitationId: row.id,
          organizationId: row.organization.id,
          organizationName: row.organization.name,
          role: row.role,
          forThisUser: row.email === user.email.trim().toLowerCase(),
        },
      };
    },
    { userId: user.id },
  );

export type AcceptInvitationResult =
  | { ok: true; organizationId: string; membershipId: string; role: Role }
  | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'REVOKED' | 'ACCEPTED' | 'WRONG_EMAIL' };

/**
 * Accepts in ONE transaction: the conditional `updateMany` (still pending, not expired, address
 * matches) is the single-use guard; then the membership is created (or, if the user somehow is a
 * member already, left as is) and audited.
 */
export const acceptInvitation = async (
  prisma: PrismaClient,
  token: { organizationId: string; secret: string },
  user: { id: string; email: string },
  now: Date,
): Promise<AcceptInvitationResult> => {
  const email = user.email.trim().toLowerCase();
  return withOrgTransaction(
    prisma,
    token.organizationId,
    async (tx) => {
      const tokenHash = sha256Hex(token.secret);
      const row = await tx.invitation.findFirst({
        where: { tokenHash },
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
      });
      if (!row) return { ok: false, reason: 'INVALID' };
      if (row.revokedAt !== null) return { ok: false, reason: 'REVOKED' };
      if (row.acceptedAt !== null) return { ok: false, reason: 'ACCEPTED' };
      if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
      if (row.email !== email) return { ok: false, reason: 'WRONG_EMAIL' };

      const { count } = await tx.invitation.updateMany({
        where: { id: row.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (count !== 1) return { ok: false, reason: 'ACCEPTED' };

      const existing = await tx.membership.findFirst({
        where: { userId: user.id },
        select: { id: true, role: true },
      });
      const membership =
        existing ??
        (await tx.membership.create({
          data: { organizationId: token.organizationId, userId: user.id, role: row.role },
          select: { id: true, role: true },
        }));
      await recordAudit(tx, {
        organizationId: token.organizationId,
        userId: user.id,
        action: 'invitation.accept',
        targetType: 'Invitation',
        targetId: row.id,
        metadata: { role: row.role },
      });
      if (!existing) {
        await recordAudit(tx, {
          organizationId: token.organizationId,
          userId: user.id,
          action: 'membership.create',
          targetType: 'Membership',
          targetId: membership.id,
          metadata: { role: membership.role, memberUserId: user.id, invitationId: row.id },
        });
      }
      return {
        ok: true,
        organizationId: token.organizationId,
        membershipId: membership.id,
        role: membership.role,
      };
    },
    { userId: user.id },
  );
};
