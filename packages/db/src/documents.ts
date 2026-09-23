import type { DocumentScanOutcome, DocumentScanStore, ScanDocumentRecord } from '@harbour/adapters';
import type { PrismaClient } from '../generated/client/index.js';
import { recordAudit } from './audit.js';
import { withOrgTransaction } from './tenancy.js';

/**
 * M5: Prisma implementation of the scan pipeline's persistence seam (`DocumentScanStore` in
 * `@harbour/adapters`), used by the worker's `document-scan` job and by the web app when it runs the
 * scan inline (no Redis). Every access runs under `withOrgTransaction` with the organisation from
 * the job payload, so RLS applies exactly as in a request; the worker connection must therefore be
 * a member of `harbour_app` like the web app's (README "Database roles").
 *
 * `apply` only writes when the row is still SCANNING (an idempotency guard against duplicate job
 * deliveries) and records a system audit row (`userId: null`) with ids and enum values only.
 */
export const DOCUMENT_SCAN_AUDIT_ACTION = 'doc.scan';

export class PrismaDocumentScanStore implements DocumentScanStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(payload: {
    documentId: string;
    organizationId: string;
  }): Promise<ScanDocumentRecord | null> {
    const row = await withOrgTransaction(this.prisma, payload.organizationId, (tx) =>
      tx.document.findUnique({
        where: { id: payload.documentId },
        select: {
          id: true,
          organizationId: true,
          storageKey: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          deletedAt: true,
        },
      }),
    );
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      storageKey: row.storageKey,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      deleted: row.deletedAt !== null,
    };
  }

  async apply(
    payload: { documentId: string; organizationId: string },
    outcome: DocumentScanOutcome,
  ): Promise<void> {
    await withOrgTransaction(this.prisma, payload.organizationId, async (tx) => {
      const updated = await tx.document.updateMany({
        where: { id: payload.documentId, status: 'SCANNING', deletedAt: null },
        data: {
          status: outcome.status,
          scanEngine: outcome.scanEngine,
          scanResult: outcome.scanResult,
          scannedAt: outcome.scannedAt,
          rejectedReason: outcome.rejectedReason,
          ...(outcome.sha256 !== null ? { sha256: outcome.sha256 } : {}),
        },
      });
      if (updated.count !== 1) return;
      await recordAudit(tx, {
        organizationId: payload.organizationId,
        userId: null,
        action: DOCUMENT_SCAN_AUDIT_ACTION,
        targetType: 'Document',
        targetId: payload.documentId,
        metadata: {
          status: outcome.status,
          scanEngine: outcome.scanEngine,
          scanResult: outcome.scanResult,
          rejectedReason: outcome.rejectedReason,
        },
      });
    });
  }
}
