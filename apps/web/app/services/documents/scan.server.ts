import {
  DOCUMENT_SCAN_QUEUE,
  runDocumentScan,
  type DocumentScanJobPayload,
  type DocumentScanStore,
  type DocumentScanSummary,
  type MalwareScanner,
  type ObjectStorage,
} from '@harbour/adapters';
import type { Logger } from '../logger.server';

/**
 * How an upload-complete hands the scan (§7.4) to the worker.
 *
 *   REDIS_URL set   → `BullMqJobEnqueuer`: one `document-scan` job per document on the shared
 *                     queue; `apps/worker` runs it (same attempts/backoff as every other queue).
 *   REDIS_URL unset → `InlineJobEnqueuer`: the scan runs in this process, after the response
 *                     has been sent, with one log line saying so. Development and tests only.
 *
 * Neither path logs file names. The payload is ids only.
 */
export interface JobEnqueuer {
  readonly backend: 'bullmq' | 'inline';
  enqueueDocumentScan(payload: DocumentScanJobPayload): Promise<void>;
  /** Tests: waits for inline scans started so far. No-op for BullMQ. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface InlineScanDeps {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  store: DocumentScanStore;
  logger: Logger;
  now?: () => Date;
}

export class InlineJobEnqueuer implements JobEnqueuer {
  readonly backend = 'inline' as const;
  private pending: Promise<unknown>[] = [];

  constructor(private readonly deps: InlineScanDeps) {}

  async enqueueDocumentScan(payload: DocumentScanJobPayload): Promise<void> {
    const { logger } = this.deps;
    logger.info('document_scan.inline', {
      message: 'REDIS_URL unset: running the document scan in-process instead of the worker.',
      documentId: payload.documentId,
      orgId: payload.organizationId,
      scanEngine: this.deps.scanner.engine,
    });
    const run = runDocumentScan(
      {
        storage: this.deps.storage,
        scanner: this.deps.scanner,
        store: this.deps.store,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      },
      payload,
    )
      .then((summary: DocumentScanSummary) => {
        logger.info('document_scan.completed', {
          documentId: summary.documentId,
          orgId: summary.organizationId,
          outcome: summary.outcome,
          scanEngine: summary.scanEngine,
          scanResult: summary.scanResult,
          skipped: summary.skipped ?? null,
        });
      })
      .catch((err: unknown) => {
        // §7.8: a failed scan is an alert-worthy event; in-process there is no retry.
        logger.error('document_scan.failed', {
          documentId: payload.documentId,
          orgId: payload.organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.pending = this.pending.filter((p) => p !== run);
      });
    this.pending.push(run);
  }

  async drain(): Promise<void> {
    while (this.pending.length > 0) await Promise.all(this.pending);
  }

  async close(): Promise<void> {
    await this.drain();
  }
}

/** The slice of `bullmq.Queue` we use, so tests can pass a fake. */
export interface ScanQueue {
  add(name: string, data: DocumentScanJobPayload, opts?: { jobId?: string }): Promise<unknown>;
  close(): Promise<void>;
}

export class BullMqJobEnqueuer implements JobEnqueuer {
  readonly backend = 'bullmq' as const;
  private queue: Promise<ScanQueue> | undefined;

  constructor(
    private readonly redisUrl: string,
    private readonly logger: Logger,
    private readonly open: (url: string) => Promise<ScanQueue> = openBullMqQueue,
  ) {}

  private getQueue(): Promise<ScanQueue> {
    this.queue ??= this.open(this.redisUrl);
    return this.queue;
  }

  async enqueueDocumentScan(payload: DocumentScanJobPayload): Promise<void> {
    const queue = await this.getQueue();
    // jobId = documentId: a second complete for the same document is a no-op, not a second scan.
    await queue.add(DOCUMENT_SCAN_QUEUE, payload, { jobId: payload.documentId });
    this.logger.info('document_scan.enqueued', {
      documentId: payload.documentId,
      orgId: payload.organizationId,
    });
  }

  async drain(): Promise<void> {}

  async close(): Promise<void> {
    if (this.queue) await (await this.queue).close();
  }
}

/** Real BullMQ queue on its own connection (BullMQ wants `maxRetriesPerRequest: null`). */
const openBullMqQueue = async (url: string): Promise<ScanQueue> => {
  const [{ Queue }, { default: IORedis }] = await Promise.all([
    import('bullmq'),
    import('ioredis'),
  ]);
  const connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue(DOCUMENT_SCAN_QUEUE, {
    connection,
    // Mirrors apps/worker/src/queues.ts DEFAULT_JOB_OPTIONS (§7.8: 5 attempts, backoff from 30 s).
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return {
    add: (name, data, opts) => queue.add(name, data, opts),
    close: async () => {
      await queue.close();
      await connection.quit();
    },
  };
};
