import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  LocalDiskObjectStorage,
  NoScanner,
  deriveLocalSigningSecret,
  type DocumentScanOutcome,
  type DocumentScanStore,
  type MalwareScanner,
  type ScanDocumentRecord,
} from '@harbour/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDocumentScanJob } from '../src/jobs/document-scan.js';
import { CollectingAlertSink } from '../src/ports.js';
import { buildDocumentScanWiring, buildWiring, readEnv } from '../src/wiring.server.js';

const ORG = '0f0f0f0f-0000-4000-8000-0000000000aa';
const DOC = '0f0f0f0f-0000-4000-8000-0000000000bb';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

class MemoryStore implements DocumentScanStore {
  readonly applied: DocumentScanOutcome[] = [];
  constructor(private readonly record: ScanDocumentRecord | null) {}
  async load() {
    return this.record;
  }
  async apply(_p: unknown, outcome: DocumentScanOutcome) {
    this.applied.push(outcome);
  }
}

describe('document-scan job', () => {
  let root: string;
  let storage: LocalDiskObjectStorage;
  const key = `${ORG}/org/${DOC}`;
  const record = (): ScanDocumentRecord => ({
    id: DOC,
    organizationId: ORG,
    storageKey: key,
    mimeType: 'application/pdf',
    sizeBytes: PDF.length,
    status: 'SCANNING',
    deleted: false,
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'harbour-worker-scan-'));
    storage = new LocalDiskObjectStorage({
      rootDir: root,
      secret: deriveLocalSigningSecret('worker-test-secret'),
      baseUrl: 'http://x',
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('validates the payload before touching anything', async () => {
    const alerts = new CollectingAlertSink();
    const store = new MemoryStore(record());
    await expect(
      runDocumentScanJob(
        { port: { storage, scanner: new NoScanner(), store }, alerts, now: () => new Date() },
        { documentId: 'nope', organizationId: ORG },
      ),
    ).rejects.toThrow(/documentId/);
    expect(store.applied).toEqual([]);
  });

  it('runs the pipeline through the wiring switch and alerts on malware', async () => {
    await storage.put(key, Readable.from([PDF]), {
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    const infected: MalwareScanner = {
      engine: 'clamav',
      async scan(stream) {
        stream.destroy();
        return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
      },
    };
    const store = new MemoryStore(record());
    const wiring = buildWiring(readEnv({}), {
      documentScan: { storage, scanner: infected, store },
      now: () => new Date('2026-09-23T10:00:00Z'),
    });
    const summary = await wiring.runJob('document-scan', { documentId: DOC, organizationId: ORG });
    expect(summary).toMatchObject({
      outcome: 'REJECTED',
      scanResult: 'FOUND Eicar-Test-Signature',
      objectDeleted: true,
    });
    expect(store.applied[0]).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'MALWARE_FOUND',
      scannedAt: new Date('2026-09-23T10:00:00Z'),
    });
    expect(await storage.head(key)).toBeNull();
    const alerts = wiring.ports.alerts as { alert: unknown };
    expect(alerts).toBeDefined();
  });

  it('raises DOCUMENT_MALWARE_FOUND with ids only (no file names)', async () => {
    await storage.put(key, Readable.from([PDF]), {
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    const alerts = new CollectingAlertSink();
    const infected: MalwareScanner = {
      engine: 'clamav',
      async scan(stream) {
        stream.destroy();
        return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
      },
    };
    await runDocumentScanJob(
      {
        port: { storage, scanner: infected, store: new MemoryStore(record()) },
        alerts,
        now: () => new Date(),
      },
      { documentId: DOC, organizationId: ORG },
    );
    expect(alerts.alerts).toEqual([
      {
        level: 'warning',
        code: 'DOCUMENT_MALWARE_FOUND',
        message: 'Malware scanner rejected an uploaded document',
        meta: { documentId: DOC, organizationId: ORG, scanResult: 'FOUND Eicar-Test-Signature' },
      },
    ]);
  });

  it('with no scanner the document stays UPLOADED / not_scanned and nothing is alerted', async () => {
    await storage.put(key, Readable.from([PDF]), {
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    const alerts = new CollectingAlertSink();
    const store = new MemoryStore(record());
    const summary = await runDocumentScanJob(
      { port: { storage, scanner: new NoScanner(), store }, alerts, now: () => new Date() },
      { documentId: DOC, organizationId: ORG },
    );
    expect(summary).toMatchObject({
      outcome: 'UPLOADED',
      scanEngine: 'none',
      scanResult: 'not_scanned',
    });
    expect(store.applied[0]?.status).toBe('UPLOADED');
    expect(alerts.alerts).toEqual([]);
  });

  it('wiring explains what is missing and fails the job loudly when unconfigured', async () => {
    expect(buildDocumentScanWiring(readEnv({}))).toEqual({ missing: ['DATABASE_URL'] });
    expect(buildDocumentScanWiring(readEnv({ NODE_ENV: 'production' }))).toEqual({
      missing: ['storage (PRODUCTION_REQUIRES_S3)', 'DATABASE_URL'],
    });
    const wiring = buildWiring(readEnv({}));
    await expect(
      wiring.runJob('document-scan', { documentId: DOC, organizationId: ORG }),
    ).rejects.toThrow(/document-scan is not configured: missing DATABASE_URL/);
  });
});
