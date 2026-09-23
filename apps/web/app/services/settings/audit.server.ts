import type { TenantTransactionClient } from '@harbour/db';
import { AUDIT_PAGE_SIZE } from '../../validators/settings';

/**
 * M2 — audit log view (`/app/settings/audit`, OWNER/ADMIN). Reads `AuditLog` rows of the current
 * organisation under RLS, newest first, and resolves actor ids to the user's name/email for the
 * SCREEN only (the join is done here, never written back, never logged). System rows
 * (`userId: null`, e.g. the worker's verification results) show as "System".
 */
export interface AuditRowView {
  id: string;
  at: string;
  action: string;
  actor: { userId: string | null; label: string };
  targetType: string;
  targetId: string;
  /** Pretty-printed metadata (ids/enums only by contract), or null. */
  metadata: string | null;
}

export interface AuditPage {
  rows: AuditRowView[];
  page: number;
  pageSize: number;
  entryCount: number;
  pages: number;
}

export const readAuditPage = async (
  tx: TenantTransactionClient,
  page: number,
): Promise<AuditPage> => {
  const entryCount = await tx.auditLog.count();
  const pages = Math.max(1, Math.ceil(entryCount / AUDIT_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = await tx.auditLog.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (current - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE,
    select: {
      id: true,
      createdAt: true,
      action: true,
      userId: true,
      targetType: true,
      targetId: true,
      metadata: true,
    },
  });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null))];
  const users =
    userIds.length === 0
      ? []
      : await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        });
  const labels = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      action: r.action,
      actor: {
        userId: r.userId,
        label: r.userId === null ? 'System' : (labels.get(r.userId) ?? 'Former member'),
      },
      targetType: r.targetType,
      targetId: r.targetId,
      metadata:
        r.metadata === null || typeof r.metadata !== 'object' ? null : JSON.stringify(r.metadata),
    })),
    page: current,
    pageSize: AUDIT_PAGE_SIZE,
    entryCount,
    pages,
  };
};
