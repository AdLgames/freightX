import {
  parseDocumentScanJobPayload,
  runDocumentScan,
  type DocumentScanStore,
  type DocumentScanSummary,
  type MalwareScanner,
  type ObjectStorage,
} from '@harbour/adapters';
import type { AlertSink } from '../ports.js';

/**
 * `document-scan` job (brief §7.4; M5). Enqueued by the web app when an upload completes
 * (`apps/web/app/services/documents/scan.server.ts`), one job per document:
 *
 *   data: { documentId, organizationId }
 *
 * The pipeline itself lives in `@harbour/adapters` (`runDocumentScan`): sha256, magic-byte check
 * against the declared type, then the malware scanner. Outcomes: REJECTED (object deleted; reason
 * recorded), CLEAN (a real scanner ran) or UPLOADED with `scanResult = 'not_scanned'` when no
 * scanner is configured — never CLEAN without a scanner, so unscanned documents still block
 * Phase 2 booking (§6.1).
 *
 * Failure semantics: storage/database/scanner errors throw, so BullMQ retries with backoff and
 * the worker raises `JOB_FAILED` after the last attempt (main.ts). A malware detection is a
 * successful job that raises a `warning` alert. Nothing here logs file names (§7.3).
 */
export interface DocumentScanPort {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  store: DocumentScanStore;
}

export interface DocumentScanDeps {
  port: DocumentScanPort;
  alerts: AlertSink;
  now: () => Date;
}

export type { DocumentScanSummary };

export const runDocumentScanJob = async (
  deps: DocumentScanDeps,
  data: unknown,
): Promise<DocumentScanSummary> => {
  const payload = parseDocumentScanJobPayload(data);
  const summary = await runDocumentScan(
    {
      storage: deps.port.storage,
      scanner: deps.port.scanner,
      store: deps.port.store,
      now: deps.now,
    },
    payload,
  );
  if (summary.outcome === 'REJECTED' && summary.scanResult?.startsWith('FOUND ')) {
    await deps.alerts.alert(
      'warning',
      'DOCUMENT_MALWARE_FOUND',
      'Malware scanner rejected an uploaded document',
      {
        documentId: payload.documentId,
        organizationId: payload.organizationId,
        scanResult: summary.scanResult,
      },
    );
  }
  return summary;
};
