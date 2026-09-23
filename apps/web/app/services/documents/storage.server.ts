import {
  createMalwareScanner,
  createObjectStorage,
  resolveStorageConfig,
  S3ObjectStorage,
  type MalwareScanner,
  type ObjectStorage,
  type StorageConfig,
} from '@harbour/adapters';
import { PrismaDocumentScanStore, type PrismaClient } from '@harbour/db';
import type { Env } from '../env.server';
import type { Logger } from '../logger.server';
import { BullMqJobEnqueuer, InlineJobEnqueuer, type JobEnqueuer } from './scan.server';

/**
 * Document vault services (M5), decided once at startup like the auth services:
 *
 *   S3 env complete                  → S3ObjectStorage (AWS S3 / Cloudflare R2)
 *   no S3 env, not production        → LocalDiskObjectStorage under STORAGE_LOCAL_DIR
 *                                      (default `.data/storage`), URLs served by /files/*
 *   no S3 env, production            → `storage: null`: the Documents section says
 *                                      "Document storage not configured"; nothing else is affected
 *   partial S3 env                   → also `null` (fail closed, error logged once)
 *   CLAMD_HOST set                   → ClamdScanner; unset → NoScanner ("not scanned", never CLEAN)
 *   REDIS_URL set                    → scans enqueued for apps/worker; unset → run inline
 */
export type DocumentsUnavailable = 'PRODUCTION_REQUIRES_S3' | 'S3_PARTIAL' | 'S3_REGION_MISSING';

export interface DocumentServices {
  /** null → "Document storage not configured". */
  storage: ObjectStorage | null;
  unavailable: DocumentsUnavailable | null;
  backend: 'local' | 's3' | null;
  scanner: MalwareScanner;
  enqueuer: JobEnqueuer | null;
  /** Origin the browser PUTs to for S3 (CSP `connect-src`); null when same-origin (local) or unset. */
  uploadOrigin: string | null;
}

export interface DocumentServicesDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient | null;
  redis: unknown;
  /** Test seams. */
  storage?: ObjectStorage;
  scanner?: MalwareScanner;
  enqueuer?: JobEnqueuer;
  now?: () => Date;
}

const LOCAL_FALLBACK_SECRET = 'harbour-development-storage-secret-not-for-production';

/**
 * Pure: which origin presigned S3 uploads will use, from env alone (for the CSP header, which is
 * built before any storage client exists). Path-style with an endpoint → the endpoint's origin;
 * AWS virtual-hosted → `https://<bucket>.s3.<region>.amazonaws.com`.
 */
export const storageUploadOrigin = (env: Env): string | null => {
  const config = resolveStorageConfig(env, { production: env.NODE_ENV === 'production' });
  if (config.kind !== 's3') return null;
  if (config.endpoint) return new URL(config.endpoint).origin;
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
};

export const createDocumentServices = (deps: DocumentServicesDeps): DocumentServices => {
  const { env, logger } = deps;
  const production = env.NODE_ENV === 'production';
  const scanner = deps.scanner ?? createMalwareScanner(env);

  let storage: ObjectStorage | null = deps.storage ?? null;
  let unavailable: DocumentsUnavailable | null = null;
  let config: StorageConfig | null = null;
  if (!storage) {
    config = resolveStorageConfig(env, { production });
    if (config.kind === 'unconfigured') {
      unavailable = config.reason;
      logger[production ? 'error' : 'warn']('documents.storage_unavailable', {
        reason: config.reason,
        message:
          config.reason === 'PRODUCTION_REQUIRES_S3'
            ? 'No S3-compatible storage configured in production: the document vault is disabled.'
            : 'Incomplete STORAGE_* configuration: the document vault is disabled (fail closed).',
      });
    } else {
      storage = createObjectStorage(config, {
        // Relative `/files/*` URLs when APP_URL is unset (dev server on any port); absolute otherwise.
        localBaseUrl: env.APP_URL ?? '',
        localFallbackSecret: env.SESSION_SECRET ?? LOCAL_FALLBACK_SECRET,
      });
    }
  }

  let enqueuer: JobEnqueuer | null = deps.enqueuer ?? null;
  if (!enqueuer && storage && deps.prisma) {
    enqueuer = env.REDIS_URL
      ? new BullMqJobEnqueuer(env.REDIS_URL, logger)
      : new InlineJobEnqueuer({
          storage,
          scanner,
          store: new PrismaDocumentScanStore(deps.prisma),
          logger,
          ...(deps.now ? { now: deps.now } : {}),
        });
  }

  const uploadOrigin = storage instanceof S3ObjectStorage ? storageUploadOrigin(env) : null;

  logger.info('documents.configured', {
    storage: storage?.backend ?? null,
    unavailable,
    scanner: scanner.engine,
    scanJobs: enqueuer?.backend ?? null,
    localDir: config?.kind === 'local' ? config.rootDir : null,
  });
  if (storage?.backend === 'local' && !production) {
    logger.warn('documents.local_storage', {
      message:
        'Documents are stored on local disk with app-signed URLs. Development only; production requires STORAGE_* (S3/R2).',
    });
  }
  if (scanner.engine === 'none') {
    logger.warn('documents.no_scanner', {
      message:
        'CLAMD_HOST unset: uploads get a type and size check only, not a virus scan. Documents stay "Uploaded" and never become "Clean".',
    });
  }

  return {
    storage,
    unavailable,
    backend: storage?.backend ?? null,
    scanner,
    enqueuer,
    uploadOrigin,
  };
};
