import { describe, expect, it } from 'vitest';
import type { DocumentScanJobPayload, DocumentScanStore } from '@harbour/adapters';
import { loadEnv } from '../env.server';
import { createLogger } from '../logger.server';
import { contentSecurityPolicy } from '../security-headers.server';
import { BullMqJobEnqueuer, InlineJobEnqueuer } from './scan.server';
import { createDocumentServices, storageUploadOrigin } from './storage.server';

const capture = () => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { logger, lines };
};

const S3 = {
  STORAGE_BUCKET: 'harbour-docs',
  STORAGE_ACCESS_KEY_ID: 'AKIA',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

describe('createDocumentServices', () => {
  it('uses local disk outside production and says so', () => {
    const { logger, lines } = capture();
    const env = loadEnv({ NODE_ENV: 'development', STORAGE_LOCAL_DIR: '/tmp/harbour-test-x' });
    const s = createDocumentServices({ env, logger, prisma: null, redis: null });
    expect(s.backend).toBe('local');
    expect(s.unavailable).toBeNull();
    expect(s.scanner.engine).toBe('none');
    expect(s.enqueuer).toBeNull(); // no database → nothing to persist a scan to
    expect(s.uploadOrigin).toBeNull();
    expect(lines.map((l) => l.event)).toEqual([
      'documents.configured',
      'documents.local_storage',
      'documents.no_scanner',
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('fails closed in production without S3, and on a partial S3 configuration', () => {
    const { logger, lines } = capture();
    const prod = createDocumentServices({
      env: loadEnv({ NODE_ENV: 'production' }),
      logger,
      prisma: null,
      redis: null,
    });
    expect(prod.storage).toBeNull();
    expect(prod.unavailable).toBe('PRODUCTION_REQUIRES_S3');
    expect(lines[0]).toMatchObject({
      level: 'error',
      event: 'documents.storage_unavailable',
      reason: 'PRODUCTION_REQUIRES_S3',
    });

    const partial = createDocumentServices({
      env: loadEnv({ NODE_ENV: 'development', STORAGE_BUCKET: 'only-bucket' }),
      logger,
      prisma: null,
      redis: null,
    });
    expect(partial.storage).toBeNull();
    expect(partial.unavailable).toBe('S3_PARTIAL');
  });

  it('selects S3 (R2) when the full set is present and exposes the upload origin for the CSP', () => {
    const { logger } = capture();
    const env = loadEnv({
      NODE_ENV: 'production',
      ...S3,
      STORAGE_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
    });
    const s = createDocumentServices({ env, logger, prisma: null, redis: null });
    expect(s.backend).toBe('s3');
    expect(s.uploadOrigin).toBe('https://acc.r2.cloudflarestorage.com');
    expect(
      storageUploadOrigin(loadEnv({ NODE_ENV: 'production', ...S3, STORAGE_REGION: 'eu-west-2' })),
    ).toBe('https://harbour-docs.s3.eu-west-2.amazonaws.com');
    expect(storageUploadOrigin(loadEnv({ NODE_ENV: 'development' }))).toBeNull();
    const csp = contentSecurityPolicy('n', {
      connectSrc: ['https://acc.r2.cloudflarestorage.com'],
    });
    expect(csp).toContain("connect-src 'self' https://acc.r2.cloudflarestorage.com");
    expect(contentSecurityPolicy('n')).not.toContain('connect-src');
  });

  it('picks ClamAV from CLAMD_HOST', () => {
    const { logger, lines } = capture();
    const s = createDocumentServices({
      env: loadEnv({ NODE_ENV: 'development', CLAMD_HOST: 'clamav', CLAMD_PORT: '3310' }),
      logger,
      prisma: null,
      redis: null,
    });
    expect(s.scanner.engine).toBe('clamav');
    expect(lines.some((l) => l.event === 'documents.no_scanner')).toBe(false);
  });
});

describe('job enqueuers', () => {
  const payload: DocumentScanJobPayload = {
    documentId: '0f0f0f0f-0000-4000-8000-0000000000bb',
    organizationId: '0f0f0f0f-0000-4000-8000-0000000000aa',
  };

  it('BullMQ: adds one job per document with the document id as job id', async () => {
    const { logger, lines } = capture();
    const added: unknown[] = [];
    let closed = false;
    const enqueuer = new BullMqJobEnqueuer('redis://localhost:6379', logger, async () => ({
      add: async (name, data, opts) => {
        added.push({ name, data, opts });
      },
      close: async () => {
        closed = true;
      },
    }));
    await enqueuer.enqueueDocumentScan(payload);
    expect(added).toEqual([
      { name: 'document-scan', data: payload, opts: { jobId: payload.documentId } },
    ]);
    expect(lines.at(-1)).toMatchObject({
      event: 'document_scan.enqueued',
      documentId: payload.documentId,
    });
    await enqueuer.close();
    expect(closed).toBe(true);
  });

  it('inline: runs the scan in-process, logs that it did, and never throws into the request', async () => {
    const { logger, lines } = capture();
    const store: DocumentScanStore = {
      load: async () => null, // document gone → SKIPPED
      apply: async () => {},
    };
    const enqueuer = new InlineJobEnqueuer({
      storage: {
        backend: 'local',
        presignPut: () => Promise.reject(new Error('unused')),
        presignGet: () => Promise.reject(new Error('unused')),
        head: async () => null,
        getStream: () => Promise.reject(new Error('unused')),
        put: async () => {},
        delete: async () => {},
      },
      scanner: { engine: 'none', scan: async () => ({ verdict: 'not_scanned' }) },
      store,
      logger,
    });
    await enqueuer.enqueueDocumentScan(payload);
    await enqueuer.drain();
    expect(lines.map((l) => l.event)).toEqual(['document_scan.inline', 'document_scan.completed']);
    expect(lines[1]).toMatchObject({ outcome: 'SKIPPED', skipped: 'NOT_FOUND' });

    const failing = new InlineJobEnqueuer({
      ...{
        storage: undefined as never,
        scanner: { engine: 'none', scan: async () => ({ verdict: 'not_scanned' }) },
      },
      store: { load: () => Promise.reject(new Error('db down')), apply: async () => {} },
      logger,
    });
    await failing.enqueueDocumentScan(payload);
    await failing.drain();
    expect(lines.at(-1)).toMatchObject({ event: 'document_scan.failed', error: 'db down' });
  });
});
