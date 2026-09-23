import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertObjectKey,
  ObjectNotFoundError,
  ObjectTooLargeError,
  type ObjectHead,
  type ObjectStorage,
  type PresignGetInput,
  type PresignPutInput,
  type PresignedPut,
  type PutObjectInput,
} from './types.js';

/**
 * Development/test object storage on a local directory (phase-1-build-plan "Local directory
 * store with signed URLs served by the app"). Layout under `rootDir`:
 *
 *   objects/<key>        the bytes
 *   meta/<key>.json      `{ contentType, sizeBytes }`
 *   tmp/                 in-flight uploads, renamed into place when complete
 *
 * "Presigned" URLs point at the web app (`<baseUrl>/files/put/<key>` and `/files/get/<key>`)
 * and carry an expiry plus an HMAC-SHA256 over method, key, expiry and the enforced attributes
 * (content type + size limit for PUT, disposition for GET). The app's `files.*` routes call
 * `verifyPut`/`verifyGet` and then `receivePut`/`getStream`. Never for production: the config
 * layer refuses to select this backend when NODE_ENV=production.
 */

export interface LocalDiskObjectStorageOptions {
  rootDir: string;
  /** Any secret ≥ 16 bytes; `deriveLocalSigningSecret` builds one from SESSION_SECRET. */
  secret: string | Uint8Array;
  /** Origin (+ optional path prefix) of the app, e.g. `http://localhost:3000`. No trailing slash. */
  baseUrl: string;
  now?: () => number;
}

export const LOCAL_PUT_PATH = '/files/put/';
export const LOCAL_GET_PATH = '/files/get/';

export type SignedUrlProblem = 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE';

export type VerifiedPut =
  { ok: true; contentType: string; maxBytes: number } | { ok: false; problem: SignedUrlProblem };

export type VerifiedGet =
  | { ok: true; responseContentDisposition: string | null }
  | { ok: false; problem: SignedUrlProblem };

/** Stable 32-byte signing key from an app secret (never the raw secret itself). */
export const deriveLocalSigningSecret = (appSecret: string): Buffer =>
  createHash('sha256').update('harbour.storage.local.v1:').update(appSecret).digest();

const INTEGER = /^\d{1,15}$/;

export class LocalDiskObjectStorage implements ObjectStorage {
  readonly backend = 'local' as const;
  readonly rootDir: string;
  private readonly key: Buffer;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: LocalDiskObjectStorageOptions) {
    this.rootDir = resolve(opts.rootDir);
    this.key =
      typeof opts.secret === 'string' ? Buffer.from(opts.secret, 'utf8') : Buffer.from(opts.secret);
    if (this.key.length < 16)
      throw new Error('LocalDiskObjectStorage: secret must be at least 16 bytes');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.now = opts.now ?? (() => Date.now());
  }

  // ---------- paths ----------

  private pathFor(area: 'objects' | 'meta', key: string): string {
    assertObjectKey(key);
    const base = join(this.rootDir, area);
    const full = resolve(base, area === 'meta' ? `${key}.json` : key);
    if (!full.startsWith(base + sep)) throw new ObjectNotFoundError(key); // cannot happen after assertObjectKey; belt and braces
    return full;
  }

  // ---------- signing ----------

  private sign(parts: readonly (string | number)[]): string {
    return createHmac('sha256', this.key).update(parts.join('\n')).digest('hex');
  }

  private signatureMatches(expected: string, presented: string | null): boolean {
    if (presented === null || presented.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(presented, 'utf8'));
  }

  private expirySeconds(expiresInSec: number): number {
    if (!Number.isInteger(expiresInSec) || expiresInSec <= 0)
      throw new Error('expiresInSec must be a positive integer');
    return Math.floor(this.now() / 1000) + expiresInSec;
  }

  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    assertObjectKey(input.key);
    if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0)
      throw new Error('maxBytes must be a positive integer');
    const exp = this.expirySeconds(input.expiresInSec);
    const sig = this.sign(['PUT', input.key, exp, input.contentType, input.maxBytes]);
    const query = new URLSearchParams({
      exp: String(exp),
      ct: input.contentType,
      max: String(input.maxBytes),
      sig,
    });
    return {
      url: `${this.baseUrl}${LOCAL_PUT_PATH}${input.key}?${query.toString()}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt: new Date(exp * 1000),
    };
  }

  async presignGet(input: PresignGetInput): Promise<string> {
    assertObjectKey(input.key);
    const exp = this.expirySeconds(input.expiresInSec);
    const cd = input.responseContentDisposition ?? '';
    const sig = this.sign(['GET', input.key, exp, cd]);
    const query = new URLSearchParams({ exp: String(exp), sig });
    if (cd !== '') query.set('cd', cd);
    return `${this.baseUrl}${LOCAL_GET_PATH}${input.key}?${query.toString()}`;
  }

  /** Checks a `/files/put/<key>?...` request's query string. */
  verifyPut(key: string, query: URLSearchParams): VerifiedPut {
    try {
      assertObjectKey(key);
    } catch {
      return { ok: false, problem: 'MALFORMED' };
    }
    const exp = query.get('exp');
    const ct = query.get('ct');
    const max = query.get('max');
    if (exp === null || ct === null || max === null || !INTEGER.test(exp) || !INTEGER.test(max)) {
      return { ok: false, problem: 'MALFORMED' };
    }
    const expected = this.sign(['PUT', key, Number(exp), ct, Number(max)]);
    if (!this.signatureMatches(expected, query.get('sig')))
      return { ok: false, problem: 'BAD_SIGNATURE' };
    if (Number(exp) * 1000 < this.now()) return { ok: false, problem: 'EXPIRED' };
    return { ok: true, contentType: ct, maxBytes: Number(max) };
  }

  /** Checks a `/files/get/<key>?...` request's query string. */
  verifyGet(key: string, query: URLSearchParams): VerifiedGet {
    try {
      assertObjectKey(key);
    } catch {
      return { ok: false, problem: 'MALFORMED' };
    }
    const exp = query.get('exp');
    if (exp === null || !INTEGER.test(exp)) return { ok: false, problem: 'MALFORMED' };
    const cd = query.get('cd') ?? '';
    const expected = this.sign(['GET', key, Number(exp), cd]);
    if (!this.signatureMatches(expected, query.get('sig')))
      return { ok: false, problem: 'BAD_SIGNATURE' };
    if (Number(exp) * 1000 < this.now()) return { ok: false, problem: 'EXPIRED' };
    return { ok: true, responseContentDisposition: cd === '' ? null : cd };
  }

  // ---------- objects ----------

  /**
   * Streams a PUT body to disk, enforcing `maxBytes` while reading (the stream is destroyed and
   * the partial file removed as soon as the limit is crossed). Returns the size written.
   */
  async receivePut(
    key: string,
    body: Readable,
    input: { contentType: string; maxBytes: number },
  ): Promise<number> {
    const dest = this.pathFor('objects', key);
    const tmpDir = join(this.rootDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(tmpDir, `${randomBytes(12).toString('hex')}.part`);
    let received = 0;
    const limit = async function* (source: Readable) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        received += buf.length;
        if (received > input.maxBytes) throw new ObjectTooLargeError(input.maxBytes);
        yield buf;
      }
    };
    try {
      await pipeline(body, limit, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, dest);
      await this.writeMeta(key, { contentType: input.contentType, sizeBytes: received });
      return received;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async put(key: string, body: Readable, input: PutObjectInput): Promise<void> {
    const written = await this.receivePut(key, body, {
      contentType: input.contentType,
      maxBytes: input.sizeBytes,
    });
    if (written !== input.sizeBytes) {
      await this.delete(key);
      throw new Error(`put: body was ${written} bytes, expected ${input.sizeBytes}`);
    }
  }

  private async writeMeta(key: string, head: ObjectHead): Promise<void> {
    const metaPath = this.pathFor('meta', key);
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(head), 'utf8');
  }

  async head(key: string): Promise<ObjectHead | null> {
    const objectPath = this.pathFor('objects', key);
    let size: number;
    try {
      size = (await stat(objectPath)).size;
    } catch {
      return null;
    }
    let contentType: string | null = null;
    try {
      const meta = JSON.parse(await readFile(this.pathFor('meta', key), 'utf8')) as {
        contentType?: unknown;
      };
      if (typeof meta.contentType === 'string') contentType = meta.contentType;
    } catch {
      contentType = null;
    }
    return { sizeBytes: size, contentType };
  }

  async getStream(key: string): Promise<Readable> {
    const objectPath = this.pathFor('objects', key);
    try {
      await stat(objectPath);
    } catch {
      throw new ObjectNotFoundError(key);
    }
    return createReadStream(objectPath);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor('objects', key), { force: true });
    await rm(this.pathFor('meta', key), { force: true });
  }
}
