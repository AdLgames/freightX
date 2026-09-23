import { Prisma } from '../generated/client/index.js';

/**
 * Audit trail helper (§9 definition of done: "audit log entry for any state-changing action on
 * quotes, docs, org settings").
 *
 * PII RULE (§7.3): `metadata` must NEVER contain PII — no emails, names, EORI/VAT numbers, document
 * names or free text copied from users. Record IDs, enum values, amounts and before/after
 * *identifiers* only. Logs are retained for 6 years and are exported/read by support tooling.
 *
 * Pass the *transaction* client (`tx` from withOrgTransaction) so the audit row commits or rolls
 * back together with the change it describes. audit_logs is append-only (migration 0002).
 */

export interface AuditEntry {
  /** null only for tenant-less events (login, signup); those rows are invisible to the app role. */
  organizationId: string | null;
  /** null for system-initiated actions (cron, webhook worker). */
  userId: string | null;
  /** Dotted verb, e.g. "quote.accept", "org.eori.update", "doc.download". */
  action: string;
  /** e.g. "Quote", "Document", "Organization". */
  targetType: string;
  targetId: string;
  ip?: string | null;
  userAgent?: string | null;
  /** IDs and enum values only — never PII (see above). */
  metadata?: Prisma.InputJsonObject | null;
}

/** Structural type satisfied by PrismaClient, a tenant-scoped client and either's transaction client. */
export interface AuditWriter {
  auditLog: {
    createMany(args: { data: Prisma.AuditLogCreateManyInput[] }): Promise<unknown>;
  };
}

/**
 * Written with `createMany` (a plain INSERT) rather than `create` (INSERT ... RETURNING): rows
 * with a NULL organisation are deliberately unreadable through the app role (migration 0002), and
 * Postgres applies the SELECT policy to RETURNING, so `create` would fail with "new row violates
 * row-level security policy" for tenant-less events such as sign-in. Nothing reads the row back.
 */
export async function recordAudit(tx: AuditWriter, entry: AuditEntry): Promise<void> {
  const data: Prisma.AuditLogCreateManyInput = {
    organizationId: entry.organizationId,
    userId: entry.userId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? Prisma.JsonNull,
  };
  await tx.auditLog.createMany({ data: [data] });
}
