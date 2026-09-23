import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  ContentInspector,
  contentMatchesFormat,
  formatForStoredMimeType,
  MAX_DOCUMENT_BYTES,
  type ContentFindings,
  type DocumentFormat,
} from './formats.js';
import type { MalwareScanner, ScanEngine } from './scanner.js';
import { ObjectNotFoundError, ObjectTooLargeError, type ObjectStorage } from './types.js';

/**
 * Upload-complete pipeline (§7.4): stream the stored object once for sha256 + content sniffing,
 * then (if the content matches the declared type) hand it to the malware scanner. Pure with
 * respect to persistence: `runDocumentScan` talks to the database through `DocumentScanStore`,
 * implemented by `@harbour/db` and used by both the worker job and the web app's inline fallback.
 *
 * Outcomes (DocumentStatus):
 *   REJECTED  object missing, size disagrees with the record, empty, content ≠ declared type,
 *             or the scanner found something. The object is deleted; `rejectedReason` says why.
 *   CLEAN     a real scanner (`clamav`) ran and found nothing.
 *   UPLOADED  no scanner configured: `scanEngine = 'none'`, `scanResult = 'not_scanned'`.
 *             Deliberately not CLEAN — brief §6.1 needs CLEAN/VERIFIED before booking.
 *
 * Nothing here logs or returns file names (§7.3): ids, sizes, formats and reasons only.
 */

export type RejectedReason =
  | 'OBJECT_MISSING'
  | 'SIZE_MISMATCH'
  | 'TOO_LARGE'
  | 'EMPTY'
  | 'UNSUPPORTED_TYPE'
  | 'TYPE_MISMATCH'
  | 'MALWARE_FOUND';

export interface InspectedObject {
  sha256: string;
  findings: ContentFindings;
}

/** sha256 + content findings in one pass. Stops (and rejects) as soon as `maxBytes` is exceeded. */
export const inspectStream = async (
  stream: Readable,
  opts: { maxBytes?: number } = {},
): Promise<InspectedObject> => {
  const maxBytes = opts.maxBytes ?? MAX_DOCUMENT_BYTES;
  const hash = createHash('sha256');
  const inspector = new ContentInspector();
  let seen = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      seen += buf.length;
      if (seen > maxBytes) throw new ObjectTooLargeError(maxBytes);
      hash.update(buf);
      inspector.update(buf);
    }
  } finally {
    stream.destroy();
  }
  return { sha256: hash.digest('hex'), findings: inspector.finish() };
};

export interface ScanTarget {
  key: string;
  /** The stored (canonical) MIME type; resolved to a format here. */
  mimeType: string;
  /** What the record says was uploaded; the object must be exactly this size. */
  expectedSizeBytes: number;
  maxBytes?: number;
}

export type ScanVerdict =
  | {
      outcome: 'rejected';
      reason: RejectedReason;
      sha256: string | null;
      sizeBytes: number | null;
      signature?: string;
    }
  | { outcome: 'clean'; engine: 'clamav'; sha256: string; sizeBytes: number }
  | { outcome: 'not_scanned'; engine: 'none'; sha256: string; sizeBytes: number };

export interface ScanDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
}

/** Inspects and scans one stored object. Never deletes; the caller decides (see `runDocumentScan`). */
export const scanStoredObject = async (
  deps: ScanDeps,
  target: ScanTarget,
): Promise<ScanVerdict> => {
  const maxBytes = target.maxBytes ?? MAX_DOCUMENT_BYTES;
  const format: DocumentFormat | null = formatForStoredMimeType(target.mimeType);
  const head = await deps.storage.head(target.key);
  if (head === null)
    return { outcome: 'rejected', reason: 'OBJECT_MISSING', sha256: null, sizeBytes: null };
  if (head.sizeBytes > maxBytes)
    return { outcome: 'rejected', reason: 'TOO_LARGE', sha256: null, sizeBytes: head.sizeBytes };
  if (head.sizeBytes !== target.expectedSizeBytes) {
    return {
      outcome: 'rejected',
      reason: 'SIZE_MISMATCH',
      sha256: null,
      sizeBytes: head.sizeBytes,
    };
  }
  if (format === null)
    return {
      outcome: 'rejected',
      reason: 'UNSUPPORTED_TYPE',
      sha256: null,
      sizeBytes: head.sizeBytes,
    };

  let inspected: InspectedObject;
  try {
    inspected = await inspectStream(await deps.storage.getStream(target.key), { maxBytes });
  } catch (err) {
    if (err instanceof ObjectNotFoundError)
      return { outcome: 'rejected', reason: 'OBJECT_MISSING', sha256: null, sizeBytes: null };
    if (err instanceof ObjectTooLargeError)
      return { outcome: 'rejected', reason: 'TOO_LARGE', sha256: null, sizeBytes: null };
    throw err;
  }
  const { sha256, findings } = inspected;
  if (findings.sizeBytes === 0)
    return { outcome: 'rejected', reason: 'EMPTY', sha256, sizeBytes: 0 };
  if (findings.sizeBytes !== target.expectedSizeBytes) {
    return { outcome: 'rejected', reason: 'SIZE_MISMATCH', sha256, sizeBytes: findings.sizeBytes };
  }
  if (!contentMatchesFormat(findings, format)) {
    return { outcome: 'rejected', reason: 'TYPE_MISMATCH', sha256, sizeBytes: findings.sizeBytes };
  }

  const result = await deps.scanner.scan(await deps.storage.getStream(target.key));
  switch (result.verdict) {
    case 'infected':
      return {
        outcome: 'rejected',
        reason: 'MALWARE_FOUND',
        sha256,
        sizeBytes: findings.sizeBytes,
        signature: result.signature,
      };
    case 'clean':
      return { outcome: 'clean', engine: 'clamav', sha256, sizeBytes: findings.sizeBytes };
    case 'not_scanned':
      return { outcome: 'not_scanned', engine: 'none', sha256, sizeBytes: findings.sizeBytes };
  }
};

// ---------- document-level orchestration ----------

/** BullMQ queue name shared by the web app (producer) and the worker (consumer). */
export const DOCUMENT_SCAN_QUEUE = 'document-scan';

export interface DocumentScanJobPayload {
  documentId: string;
  organizationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates untrusted job data (queues are a boundary too). */
export const parseDocumentScanJobPayload = (data: unknown): DocumentScanJobPayload => {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const { documentId, organizationId } = d;
  if (typeof documentId !== 'string' || !UUID.test(documentId))
    throw new Error('document-scan: documentId must be a UUID');
  if (typeof organizationId !== 'string' || !UUID.test(organizationId))
    throw new Error('document-scan: organizationId must be a UUID');
  return { documentId, organizationId };
};

export type ScanDocumentStatus = 'UPLOADED' | 'SCANNING' | 'CLEAN' | 'REJECTED' | 'VERIFIED';

export interface ScanDocumentRecord {
  id: string;
  organizationId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  status: ScanDocumentStatus;
  deleted: boolean;
}

export interface DocumentScanOutcome {
  status: 'CLEAN' | 'REJECTED' | 'UPLOADED';
  scanEngine: ScanEngine;
  /** `clean` | `not_scanned` | the rejected reason (and `FOUND <signature>` for malware). */
  scanResult: string;
  rejectedReason: RejectedReason | null;
  sha256: string | null;
  scannedAt: Date;
}

/** Persistence seam. `@harbour/db` implements it with `withOrgTransaction` + an audit row. */
export interface DocumentScanStore {
  load(payload: DocumentScanJobPayload): Promise<ScanDocumentRecord | null>;
  apply(payload: DocumentScanJobPayload, outcome: DocumentScanOutcome): Promise<void>;
}

export const outcomeFromVerdict = (
  verdict: ScanVerdict,
  engine: ScanEngine,
  now: Date,
): DocumentScanOutcome => {
  switch (verdict.outcome) {
    case 'rejected':
      return {
        status: 'REJECTED',
        scanEngine: engine,
        scanResult: verdict.signature ? `FOUND ${verdict.signature}` : verdict.reason,
        rejectedReason: verdict.reason,
        sha256: verdict.sha256,
        scannedAt: now,
      };
    case 'clean':
      return {
        status: 'CLEAN',
        scanEngine: 'clamav',
        scanResult: 'clean',
        rejectedReason: null,
        sha256: verdict.sha256,
        scannedAt: now,
      };
    case 'not_scanned':
      return {
        status: 'UPLOADED',
        scanEngine: 'none',
        scanResult: 'not_scanned',
        rejectedReason: null,
        sha256: verdict.sha256,
        scannedAt: now,
      };
  }
};

export interface DocumentScanSummary {
  documentId: string;
  organizationId: string;
  outcome: DocumentScanOutcome['status'] | 'SKIPPED';
  scanEngine: ScanEngine;
  scanResult: string | null;
  /** Why the job did nothing: the document is gone or no longer waiting for a scan. */
  skipped?: 'NOT_FOUND' | 'NOT_SCANNING' | 'DELETED';
  objectDeleted: boolean;
}

export interface DocumentScanDeps extends ScanDeps {
  store: DocumentScanStore;
  now?: () => Date;
  maxBytes?: number;
}

/**
 * One document, end to end: load → inspect+scan → persist → delete the object when rejected.
 * Idempotent: a document that is not `SCANNING` any more (already processed, deleted, verified)
 * is skipped, so BullMQ retries and duplicate deliveries are harmless.
 */
export const runDocumentScan = async (
  deps: DocumentScanDeps,
  payload: DocumentScanJobPayload,
): Promise<DocumentScanSummary> => {
  const now = deps.now ?? (() => new Date());
  const base = {
    documentId: payload.documentId,
    organizationId: payload.organizationId,
    scanEngine: deps.scanner.engine,
  };
  const record = await deps.store.load(payload);
  if (record === null)
    return {
      ...base,
      outcome: 'SKIPPED',
      scanResult: null,
      skipped: 'NOT_FOUND',
      objectDeleted: false,
    };
  if (record.deleted)
    return {
      ...base,
      outcome: 'SKIPPED',
      scanResult: null,
      skipped: 'DELETED',
      objectDeleted: false,
    };
  if (record.status !== 'SCANNING')
    return {
      ...base,
      outcome: 'SKIPPED',
      scanResult: null,
      skipped: 'NOT_SCANNING',
      objectDeleted: false,
    };

  const verdict = await scanStoredObject(deps, {
    key: record.storageKey,
    mimeType: record.mimeType,
    expectedSizeBytes: record.sizeBytes,
    ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
  });
  const outcome = outcomeFromVerdict(verdict, deps.scanner.engine, now());
  let objectDeleted = false;
  if (outcome.status === 'REJECTED') {
    // Remove the bytes first: a rejected object must never be downloadable, even if the DB write
    // below fails and the job retries (the retry then finds OBJECT_MISSING and rejects again).
    await deps.storage.delete(record.storageKey);
    objectDeleted = true;
  }
  await deps.store.apply(payload, outcome);
  return { ...base, outcome: outcome.status, scanResult: outcome.scanResult, objectDeleted };
};
