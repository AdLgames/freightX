import { z } from 'zod';
import { deriveLocalSigningSecret, LocalDiskObjectStorage } from './local.js';
import { ClamdScanner, NoScanner, type MalwareScanner } from './scanner.js';
import { S3ObjectStorage } from './s3.js';
import type { ObjectStorage } from './types.js';

/**
 * Storage and scanner configuration from the environment, shared by the web app and the worker
 * so both resolve the same backend from the same variables.
 *
 *   STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID,
 *   STORAGE_SECRET_ACCESS_KEY        → S3ObjectStorage (all of bucket/key/secret required; endpoint
 *                                      for R2/MinIO; region defaults to `auto` with an endpoint,
 *                                      else it is required)
 *   STORAGE_LOCAL_DIR                → LocalDiskObjectStorage root (default `.data/storage`)
 *   STORAGE_LOCAL_SECRET             → signing secret for local URLs (else derived from SESSION_SECRET)
 *   CLAMD_HOST, CLAMD_PORT (3310)    → ClamdScanner; unset → NoScanner (not a virus scan)
 *
 * Production never runs on local disk: with NODE_ENV=production and no S3 configuration the
 * result is `unconfigured`, and the application fails closed for documents only.
 */

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.preprocess(blank, z.string().url().optional()),
  STORAGE_REGION: z.preprocess(blank, z.string().min(1).max(64).optional()),
  STORAGE_BUCKET: z.preprocess(blank, z.string().min(3).max(63).optional()),
  STORAGE_ACCESS_KEY_ID: z.preprocess(blank, z.string().min(1).max(256).optional()),
  STORAGE_SECRET_ACCESS_KEY: z.preprocess(blank, z.string().min(1).max(256).optional()),
  STORAGE_FORCE_PATH_STYLE: z.preprocess(blank, z.enum(['true', 'false']).optional()),
  STORAGE_LOCAL_DIR: z.preprocess(blank, z.string().min(1).max(1024).optional()),
  STORAGE_LOCAL_SECRET: z.preprocess(blank, z.string().min(16).max(1024).optional()),
  CLAMD_HOST: z.preprocess(blank, z.string().min(1).max(253).optional()),
  CLAMD_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(3310)),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export const DEFAULT_LOCAL_STORAGE_DIR = '.data/storage';

export type StorageConfig =
  | {
      kind: 's3';
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    }
  | { kind: 'local'; rootDir: string; secret?: string }
  | { kind: 'unconfigured'; reason: 'PRODUCTION_REQUIRES_S3' | 'S3_PARTIAL' | 'S3_REGION_MISSING' };

/** Decides the backend. Never throws on missing config; a partial S3 setup is `unconfigured` (fail closed). */
export const resolveStorageConfig = (
  env: StorageEnv,
  opts: { production: boolean },
): StorageConfig => {
  const s3Vars = [env.STORAGE_BUCKET, env.STORAGE_ACCESS_KEY_ID, env.STORAGE_SECRET_ACCESS_KEY];
  const anyS3 =
    s3Vars.some((v) => v !== undefined) ||
    env.STORAGE_ENDPOINT !== undefined ||
    env.STORAGE_REGION !== undefined;
  if (env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY) {
    const region = env.STORAGE_REGION ?? (env.STORAGE_ENDPOINT ? 'auto' : undefined);
    if (!region) return { kind: 'unconfigured', reason: 'S3_REGION_MISSING' };
    return {
      kind: 's3',
      bucket: env.STORAGE_BUCKET,
      region,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
      ...(env.STORAGE_FORCE_PATH_STYLE
        ? { forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === 'true' }
        : {}),
    };
  }
  if (anyS3) return { kind: 'unconfigured', reason: 'S3_PARTIAL' };
  if (opts.production) return { kind: 'unconfigured', reason: 'PRODUCTION_REQUIRES_S3' };
  return {
    kind: 'local',
    rootDir: env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_STORAGE_DIR,
    ...(env.STORAGE_LOCAL_SECRET ? { secret: env.STORAGE_LOCAL_SECRET } : {}),
  };
};

export interface CreateObjectStorageOptions {
  /** Local backend: origin of the app that serves `/files/*`. */
  localBaseUrl: string;
  /** Local backend: fallback secret (e.g. SESSION_SECRET) when STORAGE_LOCAL_SECRET is unset. */
  localFallbackSecret: string;
}

export const createObjectStorage = (
  config: Exclude<StorageConfig, { kind: 'unconfigured' }>,
  opts: CreateObjectStorageOptions,
): ObjectStorage => {
  if (config.kind === 's3') {
    const { kind: _kind, ...s3 } = config;
    return new S3ObjectStorage(s3);
  }
  return new LocalDiskObjectStorage({
    rootDir: config.rootDir,
    secret: deriveLocalSigningSecret(config.secret ?? opts.localFallbackSecret),
    baseUrl: opts.localBaseUrl,
  });
};

export const createMalwareScanner = (
  env: Pick<StorageEnv, 'CLAMD_HOST' | 'CLAMD_PORT'>,
): MalwareScanner =>
  env.CLAMD_HOST
    ? new ClamdScanner({ host: env.CLAMD_HOST, port: env.CLAMD_PORT })
    : new NoScanner();
