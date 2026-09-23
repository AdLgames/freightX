import type { Readable } from 'node:stream';

/**
 * Object storage port (brief §3 "S3-compatible bucket, private, presigned URLs only"; §7.4).
 *
 * Two implementations: `S3ObjectStorage` (AWS S3 / Cloudflare R2) and `LocalDiskObjectStorage`
 * (development and tests: a directory, with signed URLs served by the web app). Callers never see
 * a public URL; every URL that leaves this port is signed and short-lived.
 *
 * Keys are `orgId/<target>/docId` (§7.4) — built by the application, validated here because the
 * local backend maps them onto a file system path.
 */

export interface PresignPutInput {
  key: string;
  /** Enforced by the signature: the client must send exactly this Content-Type. */
  contentType: string;
  /**
   * Upper bound on the body. The local backend enforces it on receipt; S3 presigned PUTs cannot
   * express a size condition, so the application re-checks with `head()` on completion.
   */
  maxBytes: number;
  expiresInSec: number;
}

export interface PresignedPut {
  url: string;
  method: 'PUT';
  /** Headers the client must send verbatim (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignGetInput {
  key: string;
  expiresInSec: number;
  /** e.g. `attachment; filename="invoice.pdf"` — the storage sets it on the response. */
  responseContentDisposition?: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

export interface PutObjectInput {
  contentType: string;
  /** Known up front: streams of unknown length cannot be PUT to S3 in one request. */
  sizeBytes: number;
}

export type StorageBackend = 'local' | 's3';

export interface ObjectStorage {
  readonly backend: StorageBackend;
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  presignGet(input: PresignGetInput): Promise<string>;
  /** `null` when the object does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Rejects with `ObjectNotFoundError` when the object does not exist. */
  getStream(key: string): Promise<Readable>;
  /** Server-side upload (the no-JS fallback and tests). Overwrites. */
  put(key: string, body: Readable, input: PutObjectInput): Promise<void>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
  }
}

export class InvalidObjectKeyError extends Error {
  override readonly name = 'InvalidObjectKeyError';
  constructor(reason: string) {
    super(`invalid object key: ${reason}`);
  }
}

export class ObjectTooLargeError extends Error {
  override readonly name = 'ObjectTooLargeError';
  constructor(readonly maxBytes: number) {
    super(`object exceeds ${maxBytes} bytes`);
  }
}

/** `orgId/target/docId` style keys only: no leading slash, no `..`, no empty segments, ASCII. */
export const OBJECT_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_OBJECT_KEY_LENGTH = 512;

export function assertObjectKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidObjectKeyError('must be a non-empty string');
  }
  if (key.length > MAX_OBJECT_KEY_LENGTH) throw new InvalidObjectKeyError('too long');
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new InvalidObjectKeyError('dot segment');
    if (!OBJECT_KEY_SEGMENT.test(segment)) throw new InvalidObjectKeyError('bad segment');
  }
}

export const isValidObjectKey = (key: unknown): key is string => {
  try {
    assertObjectKey(key);
    return true;
  } catch {
    return false;
  }
};
