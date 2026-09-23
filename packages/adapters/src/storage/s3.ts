import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertObjectKey,
  ObjectNotFoundError,
  type ObjectHead,
  type ObjectStorage,
  type PresignGetInput,
  type PresignPutInput,
  type PresignedPut,
  type PutObjectInput,
} from './types.js';

/**
 * S3-compatible object storage: AWS S3 or Cloudflare R2 (endpoint `https://<account>.r2.cloudflarestorage.com`,
 * region `auto`, path-style). The bucket must be private with public access blocked (§7.4;
 * infra/terraform). Presigned PUTs sign the Content-Type, so a client sending another type is
 * rejected by the storage; a size condition is not expressible on a presigned PUT, so the
 * application re-checks the size with `head()` on completion.
 */

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint (R2, MinIO). Omit for AWS. */
  endpoint?: string;
  /** Default: true when an endpoint is set (R2, MinIO), false for AWS. */
  forcePathStyle?: boolean;
  /** Test seam. */
  client?: S3Client;
}

const isNotFound = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

export class S3ObjectStorage implements ObjectStorage {
  readonly backend = 's3' as const;
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(opts: S3ObjectStorageOptions) {
    this.bucket = opts.bucket;
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        forcePathStyle: opts.forcePathStyle ?? opts.endpoint !== undefined,
        // Presigned PUTs must not carry a hoisted CRC32 of the (empty) signing-time body: the
        // browser's real bytes would then fail the checksum. Checksums only where the API needs them.
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });
  }

  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    assertObjectKey(input.key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    // `signableHeaders` puts content-type into X-Amz-SignedHeaders: the storage rejects a PUT whose
    // Content-Type differs from the one signed here (§7.4 "content-type enforced on the presign").
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSec,
      signableHeaders: new Set(['content-type']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSec * 1000),
    };
  }

  async presignGet(input: PresignGetInput): Promise<string> {
    assertObjectKey(input.key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ...(input.responseContentDisposition
        ? { ResponseContentDisposition: input.responseContentDisposition }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresInSec });
  }

  /** The origin presigned URLs use (for the web app's CSP `connect-src`). Offline: signing only. */
  async uploadOrigin(): Promise<string> {
    const probe = await this.presignPut({
      key: 'probe/csp-origin',
      contentType: 'application/octet-stream',
      maxBytes: 1,
      expiresInSec: 60,
    });
    return new URL(probe.url).origin;
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    assertObjectKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new ObjectNotFoundError(key);
      // In Node the SDK's Body is an IncomingMessage (a Readable).
      return out.Body as unknown as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async put(key: string, body: Readable, input: PutObjectInput): Promise<void> {
    assertObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }
}
