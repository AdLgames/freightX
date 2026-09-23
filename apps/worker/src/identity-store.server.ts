import { recordAudit, withOrgTransaction, type PrismaClient } from '@harbour/db';
import type {
  IdentityField,
  IdentityOutcome,
  IdentityRecord,
  IdentityVerificationStore,
} from './jobs/identity-verify.js';

/**
 * M2 — Prisma implementation of `IdentityVerificationStore`.
 *
 * Every read and write runs inside `withOrgTransaction(organizationId)`, i.e. with
 * `app.current_org` set, so Postgres RLS applies exactly as it does for the web app. The worker's
 * database role must therefore be a non-superuser member of `harbour_app` (packages/db README,
 * "Database roles") — the same kind of login the web app uses, not a BYPASSRLS service role.
 *
 * The write is conditional on the ciphertext being unchanged (`expectedCiphertext`) and records a
 * system audit row (`userId: null`) with the outcome only.
 */
const COLUMNS = {
  eori: {
    value: 'eoriNumber',
    status: 'eoriVerificationStatus',
    verifiedAt: 'eoriVerifiedAt',
    audit: 'org.eori.verify',
  },
  vat: {
    value: 'vatNumber',
    status: 'vatVerificationStatus',
    verifiedAt: 'vatVerifiedAt',
    audit: 'org.vat.verify',
  },
} as const;

export class PrismaIdentityVerificationStore implements IdentityVerificationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(organizationId: string, field: IdentityField): Promise<IdentityRecord | null> {
    return withOrgTransaction(this.prisma, organizationId, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { eoriNumber: true, vatNumber: true, dataKeyCiphertext: true, deletedAt: true },
      });
      if (!org || org.deletedAt !== null) return null;
      return {
        ciphertext: org[COLUMNS[field].value],
        dataKeyCiphertext: org.dataKeyCiphertext,
      };
    });
  }

  async record(
    organizationId: string,
    field: IdentityField,
    result: { status: IdentityOutcome; checkedAt: Date; expectedCiphertext: string },
  ): Promise<boolean> {
    const c = COLUMNS[field];
    return withOrgTransaction(this.prisma, organizationId, async (tx) => {
      const { count } = await tx.organization.updateMany({
        where: { id: organizationId, [c.value]: result.expectedCiphertext },
        data: {
          [c.status]: result.status,
          ...(result.status === 'ERROR' ? {} : { [c.verifiedAt]: result.checkedAt }),
        },
      });
      if (count !== 1) return false;
      await recordAudit(tx, {
        organizationId,
        userId: null,
        action: c.audit,
        targetType: 'Organization',
        targetId: organizationId,
        metadata: { status: result.status },
      });
      return true;
    });
  }
}

/** For `--once` runs without a database: fails loudly instead of pretending. */
export class UnavailableIdentityVerificationStore implements IdentityVerificationStore {
  async load(): Promise<IdentityRecord | null> {
    throw new Error('DATABASE_URL is not set: identity verification jobs need the database');
  }
  async record(): Promise<boolean> {
    throw new Error('DATABASE_URL is not set: identity verification jobs need the database');
  }
}
