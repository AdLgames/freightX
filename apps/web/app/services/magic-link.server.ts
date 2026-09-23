import { recordAudit, type PrismaClient } from '@harbour/db';
import { DEFAULT_NEXT } from '../validators/auth';
import { randomToken, sha256Hex } from './session.server';

/**
 * Magic-link tokens (§7.1: "15-min single-use token, hashed in DB").
 *
 * - The token is 32 random bytes (base64url). Only sha256(token) is stored
 *   (`MagicLinkToken.tokenHash`); the raw token exists only in the email.
 * - Single use is enforced by ONE conditional UPDATE (`usedAt IS NULL AND expiresAt > now`) whose
 *   row count must be exactly 1, so two concurrent confirmations cannot both succeed.
 * - No `User` row is created when a link is requested — only when a link is confirmed — so a
 *   request for an unknown address leaves no account behind and behaves identically to a known
 *   one (no enumeration).
 *
 * `magic_link_tokens` and `users` are global tables (no RLS, PASSTHROUGH_MODELS), so this module
 * takes the plain client. Rows are never logged.
 */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export const hashToken = (token: string): string => sha256Hex(token);
/** Rate-limit subject and stored `ip` value: never the address itself. */
export const hashEmail = (email: string): string => sha256Hex(email.trim().toLowerCase());
export const hashIp = (ip: string): string => sha256Hex(ip);

export const magicLinkUrl = (origin: string, token: string, next: string): string => {
  const params = new URLSearchParams({ token });
  if (next !== DEFAULT_NEXT) params.set('next', next);
  return `${origin}/login/verify?${params.toString()}`;
};

export interface IssuedMagicLink {
  token: string;
  expiresAt: Date;
}

export const issueMagicLink = async (
  prisma: PrismaClient,
  input: { email: string; ipHash: string | null; now: Date },
): Promise<IssuedMagicLink> => {
  const token = randomToken();
  const expiresAt = new Date(input.now.getTime() + MAGIC_LINK_TTL_MS);
  await prisma.magicLinkToken.createMany({
    data: [
      {
        tokenHash: hashToken(token),
        email: input.email.trim().toLowerCase(),
        expiresAt,
        ip: input.ipHash,
        createdAt: input.now,
      },
    ],
  });
  return { token, expiresAt };
};

export interface ConsumedMagicLink {
  userId: string;
  newUser: boolean;
}

/**
 * Marks the token used and returns the (possibly new) user, in one transaction. Unknown, expired
 * and already-used tokens all return null — callers show one message for all three.
 */
export const consumeMagicLink = async (
  prisma: PrismaClient,
  token: string,
  now: Date,
): Promise<ConsumedMagicLink | null> => {
  const tokenHash = hashToken(token);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.magicLinkToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    const row = await tx.magicLinkToken.findUnique({
      where: { tokenHash },
      select: { email: true },
    });
    if (!row) return null;

    // First verified sign-in creates the user. ON CONFLICT DO NOTHING makes two concurrent first
    // sign-ins (two links, same address) converge on one row instead of failing.
    const created = await tx.user.createMany({
      data: [{ email: row.email }],
      skipDuplicates: true,
    });
    const user = await tx.user.findUniqueOrThrow({
      where: { email: row.email },
      select: { id: true },
    });
    const newUser = created.count === 1;
    // Tenant-less audit row (no organisation context): readable only by support tooling.
    await recordAudit(tx, {
      organizationId: null,
      userId: user.id,
      action: 'auth.sign_in',
      targetType: 'User',
      targetId: user.id,
      metadata: { newUser },
    });
    return { userId: user.id, newUser };
  });
};
