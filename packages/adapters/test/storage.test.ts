import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  ClamdScanner,
  contentMatchesFormat,
  createMalwareScanner,
  deriveLocalSigningSecret,
  inspectBytes,
  inspectStream,
  InvalidObjectKeyError,
  isValidObjectKey,
  LocalDiskObjectStorage,
  MAX_DOCUMENT_BYTES,
  NoScanner,
  ObjectNotFoundError,
  ObjectTooLargeError,
  parseClamdResponse,
  resolveDeclaredFormat,
  resolveStorageConfig,
  runDocumentScan,
  S3ObjectStorage,
  sanitiseFilename,
  ScannerError,
  scanStoredObject,
  storageEnvSchema,
  type DocumentScanOutcome,
  type DocumentScanStore,
  type MalwareScanner,
  type ScanDocumentRecord,
} from '../src/index.js';

// ---------- fixtures (generated in-test; never real documents) ----------

export const fixtures = {
  pdf: Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  ),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ]),
  jpeg: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]),
  ]),
  xlsx: (() => {
    const name = Buffer.from('[Content_Types].xml', 'latin1');
    const data = Buffer.from('<Types/>', 'latin1');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    return Buffer.concat([header, name, data]);
  })(),
  csv: Buffer.from('sku,quantity,unit_value\nSKU-1,10,4.50\nSKU-2,5,"12,00"\n', 'utf8'),
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ---------- keys ----------

describe('object keys', () => {
  it('accepts orgId/target/docId keys and rejects traversal', () => {
    expect(isValidObjectKey('a0b1/quote/c2d3')).toBe(true);
    expect(isValidObjectKey('org/quote/../other')).toBe(false);
    expect(isValidObjectKey('/abs/path')).toBe(false);
    expect(isValidObjectKey('org//x')).toBe(false);
    expect(isValidObjectKey('org/x y')).toBe(false);
    expect(isValidObjectKey('')).toBe(false);
    expect(isValidObjectKey('.hidden/x')).toBe(false);
    expect(isValidObjectKey('a'.repeat(600))).toBe(false);
  });
});

// ---------- formats ----------

describe('declared format', () => {
  it('needs an allowed extension and an agreeing MIME type', () => {
    expect(resolveDeclaredFormat({ filename: 'inv.pdf', mimeType: 'application/pdf' })).toEqual({
      ok: true,
      format: 'pdf',
      contentType: 'application/pdf',
    });
    expect(resolveDeclaredFormat({ filename: 'PHOTO.JPG', mimeType: 'image/jpeg' })).toMatchObject({
      format: 'jpeg',
    });
    expect(
      resolveDeclaredFormat({ filename: 'list.csv', mimeType: 'application/vnd.ms-excel' }),
    ).toMatchObject({
      format: 'csv',
      contentType: 'text/csv',
    });
    expect(
      resolveDeclaredFormat({ filename: 'list.csv', mimeType: 'text/csv; charset=utf-8' }),
    ).toMatchObject({ format: 'csv' });
    expect(resolveDeclaredFormat({ filename: 'book.xlsx', mimeType: '' })).toMatchObject({
      format: 'xlsx',
    });
    expect(resolveDeclaredFormat({ filename: 'x.exe', mimeType: 'application/pdf' })).toEqual({
      ok: false,
      problem: 'EXTENSION_NOT_ALLOWED',
    });
    expect(resolveDeclaredFormat({ filename: 'x.pdf', mimeType: 'application/zip' })).toEqual({
      ok: false,
      problem: 'MIME_NOT_ALLOWED',
    });
    expect(resolveDeclaredFormat({ filename: 'x.png', mimeType: 'application/pdf' })).toEqual({
      ok: false,
      problem: 'MIME_EXTENSION_MISMATCH',
    });
    expect(resolveDeclaredFormat({ filename: 'noext', mimeType: 'application/pdf' })).toEqual({
      ok: false,
      problem: 'EXTENSION_NOT_ALLOWED',
    });
  });

  it('sniffs magic bytes and text heuristics', () => {
    expect(contentMatchesFormat(inspectBytes(fixtures.pdf), 'pdf')).toBe(true);
    expect(contentMatchesFormat(inspectBytes(fixtures.png), 'png')).toBe(true);
    expect(contentMatchesFormat(inspectBytes(fixtures.jpeg), 'jpeg')).toBe(true);
    expect(contentMatchesFormat(inspectBytes(fixtures.xlsx), 'xlsx')).toBe(true);
    expect(contentMatchesFormat(inspectBytes(fixtures.csv), 'csv')).toBe(true);
    // A PDF renamed .png / .csv, a plain ZIP called .xlsx, binary or empty "CSV".
    expect(contentMatchesFormat(inspectBytes(fixtures.pdf), 'png')).toBe(false);
    expect(contentMatchesFormat(inspectBytes(fixtures.pdf), 'csv')).toBe(false);
    const plainZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('notes.txt', 'latin1'),
    ]);
    expect(contentMatchesFormat(inspectBytes(plainZip), 'xlsx')).toBe(false);
    expect(contentMatchesFormat(inspectBytes(Buffer.from('a,b\n\0c', 'latin1')), 'csv')).toBe(
      false,
    );
    expect(contentMatchesFormat(inspectBytes(Buffer.from([0x61, 0x2c, 0xff, 0xfe])), 'csv')).toBe(
      false,
    );
    expect(contentMatchesFormat(inspectBytes(Buffer.alloc(0)), 'csv')).toBe(false);
  });

  it('finds the OOXML marker across chunk boundaries', async () => {
    const chunks = [
      fixtures.xlsx.subarray(0, 36),
      fixtures.xlsx.subarray(36, 41),
      fixtures.xlsx.subarray(41),
    ];
    const { findings, sha256 } = await inspectStream(Readable.from(chunks));
    expect(findings.ooxml).toBe(true);
    expect(findings.head).toBe('zip');
    expect(sha256).toBe(sha(fixtures.xlsx));
  });

  it('stops reading past the size limit', async () => {
    await expect(
      inspectStream(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), { maxBytes: 15 }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it('sanitises file names for display and Content-Disposition', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('C:\\Users\\me\\Invoice "final".pdf')).toBe('Invoice final.pdf');
    expect(sanitiseFilename('  a\u0000b\r\n c.PDF ')).toBe('ab c.PDF');
    expect(sanitiseFilename('')).toBe('document');
    expect(sanitiseFilename('...')).toBe('document');
    expect(sanitiseFilename(`${'x'.repeat(200)}.xlsx`)).toHaveLength(120);
    expect(sanitiseFilename(`${'x'.repeat(200)}.xlsx`).endsWith('.xlsx')).toBe(true);
    expect(attachmentDisposition('Rechnung März.pdf')).toBe(
      `attachment; filename="Rechnung M_rz.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`,
    );
  });
});

// ---------- local disk backend ----------

describe('LocalDiskObjectStorage', () => {
  let root: string;
  let clock = 1_700_000_000_000;
  let storage: LocalDiskObjectStorage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'harbour-storage-'));
    storage = new LocalDiskObjectStorage({
      rootDir: root,
      secret: deriveLocalSigningSecret('test-secret-test-secret-test-secret'),
      baseUrl: 'http://localhost:3000/',
      now: () => clock,
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const key = '0f0f0f0f-0000-4000-8000-000000000001/org/1111';

  it('presigns a PUT that the verifier accepts, receives the bytes and serves a signed GET', async () => {
    const put = await storage.presignPut({
      key,
      contentType: 'application/pdf',
      maxBytes: 1024,
      expiresInSec: 300,
    });
    expect(put.method).toBe('PUT');
    expect(put.headers).toEqual({ 'Content-Type': 'application/pdf' });
    expect(put.expiresAt.toISOString()).toBe(new Date(clock + 300_000).toISOString());
    const url = new URL(put.url);
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe(`/files/put/${key}`);
    const verified = storage.verifyPut(key, url.searchParams);
    expect(verified).toEqual({ ok: true, contentType: 'application/pdf', maxBytes: 1024 });

    const written = await storage.receivePut(key, Readable.from([fixtures.pdf]), {
      contentType: 'application/pdf',
      maxBytes: 1024,
    });
    expect(written).toBe(fixtures.pdf.length);
    expect(await storage.head(key)).toEqual({
      sizeBytes: fixtures.pdf.length,
      contentType: 'application/pdf',
    });
    expect(await readFile(join(root, 'objects', key))).toEqual(fixtures.pdf);

    const get = new URL(
      await storage.presignGet({
        key,
        expiresInSec: 300,
        responseContentDisposition: 'attachment; filename="a.pdf"',
      }),
    );
    expect(get.pathname).toBe(`/files/get/${key}`);
    expect(storage.verifyGet(key, get.searchParams)).toEqual({
      ok: true,
      responseContentDisposition: 'attachment; filename="a.pdf"',
    });
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(fixtures.pdf);
  });

  it('rejects tampered, foreign and expired signatures', async () => {
    const put = new URL(
      (
        await storage.presignPut({
          key,
          contentType: 'application/pdf',
          maxBytes: 1024,
          expiresInSec: 60,
        })
      ).url,
    );
    const tamper = (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(put.searchParams);
      mutate(p);
      return storage.verifyPut(key, p);
    };
    expect(tamper((p) => p.set('ct', 'application/x-msdownload'))).toEqual({
      ok: false,
      problem: 'BAD_SIGNATURE',
    });
    expect(tamper((p) => p.set('max', '999999999'))).toEqual({
      ok: false,
      problem: 'BAD_SIGNATURE',
    });
    expect(tamper((p) => p.set('exp', String(Number(p.get('exp')) + 3600)))).toEqual({
      ok: false,
      problem: 'BAD_SIGNATURE',
    });
    expect(tamper((p) => p.set('sig', 'f'.repeat(64)))).toEqual({
      ok: false,
      problem: 'BAD_SIGNATURE',
    });
    expect(tamper((p) => p.delete('sig'))).toEqual({ ok: false, problem: 'BAD_SIGNATURE' });
    expect(tamper((p) => p.delete('exp'))).toEqual({ ok: false, problem: 'MALFORMED' });
    // Same query for another key.
    expect(storage.verifyPut('other/org/doc', put.searchParams)).toEqual({
      ok: false,
      problem: 'BAD_SIGNATURE',
    });
    expect(storage.verifyPut('../../etc', put.searchParams)).toEqual({
      ok: false,
      problem: 'MALFORMED',
    });
    // Another instance with another secret.
    const other = new LocalDiskObjectStorage({
      rootDir: root,
      secret: deriveLocalSigningSecret('another-secret-entirely'),
      baseUrl: 'http://x',
    });
    expect(other.verifyPut(key, put.searchParams)).toEqual({ ok: false, problem: 'BAD_SIGNATURE' });
    // Expiry.
    const get = new URL(await storage.presignGet({ key, expiresInSec: 10 }));
    clock += 11_000;
    expect(storage.verifyGet(key, get.searchParams)).toEqual({ ok: false, problem: 'EXPIRED' });
    expect(storage.verifyPut(key, put.searchParams)).toEqual({
      ok: true,
      contentType: 'application/pdf',
      maxBytes: 1024,
    });
    clock += 60_000;
    expect(storage.verifyPut(key, put.searchParams)).toEqual({ ok: false, problem: 'EXPIRED' });
  });

  it('enforces the size limit while streaming and leaves nothing behind', async () => {
    const big = 'org/x/big';
    await expect(
      storage.receivePut(big, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), {
        contentType: 'text/csv',
        maxBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await storage.head(big)).toBeNull();
    await expect(storage.getStream(big)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('put verifies the declared size; delete is idempotent', async () => {
    const k = 'org/x/put';
    await expect(
      storage.put(k, Readable.from([fixtures.csv]), {
        contentType: 'text/csv',
        sizeBytes: fixtures.csv.length + 1,
      }),
    ).rejects.toThrow(/expected/);
    expect(await storage.head(k)).toBeNull();
    await storage.put(k, Readable.from([fixtures.csv]), {
      contentType: 'text/csv',
      sizeBytes: fixtures.csv.length,
    });
    expect((await storage.head(k))?.sizeBytes).toBe(fixtures.csv.length);
    await storage.delete(k);
    await storage.delete(k);
    expect(await storage.head(k)).toBeNull();
  });

  it('never maps a bad key onto the file system', async () => {
    await expect(storage.head('../outside')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(storage.presignGet({ key: 'a/../../b', expiresInSec: 5 })).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
  });
});

// ---------- S3 backend (signing only, no network) ----------

describe('S3ObjectStorage presigning', () => {
  const r2 = new S3ObjectStorage({
    bucket: 'harbour-docs',
    region: 'auto',
    endpoint: 'https://abc123.r2.cloudflarestorage.com',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
  });

  it('signs the content type and expiry on a path-style R2 PUT', async () => {
    const put = await r2.presignPut({
      key: 'org/quote/doc',
      contentType: 'application/pdf',
      maxBytes: 1,
      expiresInSec: 300,
    });
    const url = new URL(put.url);
    expect(url.origin).toBe('https://abc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/harbour-docs/org/quote/doc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('auto/s3');
    expect(put.headers).toEqual({ 'Content-Type': 'application/pdf' });
    expect(await r2.uploadOrigin()).toBe('https://abc123.r2.cloudflarestorage.com');
  });

  it('puts the disposition on a GET and keeps the secret out of the URL', async () => {
    const url = new URL(
      await r2.presignGet({
        key: 'org/quote/doc',
        expiresInSec: 300,
        responseContentDisposition: 'attachment; filename="a.pdf"',
      }),
    );
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a.pdf"',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.toString()).not.toContain('secret');
  });

  it('uses virtual-hosted style on AWS', async () => {
    const aws = new S3ObjectStorage({
      bucket: 'harbour-docs',
      region: 'eu-west-2',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    });
    const url = new URL(await aws.presignGet({ key: 'org/org/doc', expiresInSec: 60 }));
    expect(url.host).toBe('harbour-docs.s3.eu-west-2.amazonaws.com');
    expect(url.pathname).toBe('/org/org/doc');
  });
});

// ---------- config ----------

describe('resolveStorageConfig', () => {
  const parse = (env: Record<string, string>) => storageEnvSchema.parse(env);
  it('selects local disk outside production and refuses it in production', () => {
    expect(resolveStorageConfig(parse({}), { production: false })).toEqual({
      kind: 'local',
      rootDir: '.data/storage',
    });
    expect(
      resolveStorageConfig(
        parse({ STORAGE_LOCAL_DIR: '/tmp/x', STORAGE_LOCAL_SECRET: 'sixteen-chars-min' }),
        { production: false },
      ),
    ).toEqual({
      kind: 'local',
      rootDir: '/tmp/x',
      secret: 'sixteen-chars-min',
    });
    expect(resolveStorageConfig(parse({}), { production: true })).toEqual({
      kind: 'unconfigured',
      reason: 'PRODUCTION_REQUIRES_S3',
    });
  });
  it('selects S3 only when the full set is present', () => {
    const full = {
      STORAGE_BUCKET: 'docs',
      STORAGE_ACCESS_KEY_ID: 'k',
      STORAGE_SECRET_ACCESS_KEY: 's',
      STORAGE_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
    };
    expect(resolveStorageConfig(parse(full), { production: true })).toEqual({
      kind: 's3',
      bucket: 'docs',
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'https://x.r2.cloudflarestorage.com',
    });
    expect(resolveStorageConfig(parse({ STORAGE_BUCKET: 'docs' }), { production: false })).toEqual({
      kind: 'unconfigured',
      reason: 'S3_PARTIAL',
    });
    expect(
      resolveStorageConfig(
        parse({
          STORAGE_BUCKET: 'docs',
          STORAGE_ACCESS_KEY_ID: 'k',
          STORAGE_SECRET_ACCESS_KEY: 's',
        }),
        { production: true },
      ),
    ).toEqual({
      kind: 'unconfigured',
      reason: 'S3_REGION_MISSING',
    });
  });
  it('picks the scanner from CLAMD_HOST', () => {
    expect(createMalwareScanner(parse({})).engine).toBe('none');
    expect(createMalwareScanner(parse({ CLAMD_HOST: 'clamav', CLAMD_PORT: '3310' })).engine).toBe(
      'clamav',
    );
  });
});

// ---------- clamd ----------

const fakeClamd = (reply: string | Error, opts: { silent?: boolean } = {}) => {
  const received: Buffer[] = [];
  const sockets: PassThrough[] = [];
  const connect = () => {
    const socket = new PassThrough();
    sockets.push(socket);
    const original = socket.write.bind(socket);
    socket.write = ((chunk: Buffer) => {
      received.push(Buffer.from(chunk));
      // Reply once the terminating zero-length chunk arrives.
      if (chunk.length === 4 && chunk.readUInt32BE(0) === 0 && !opts.silent) {
        queueMicrotask(() => {
          if (reply instanceof Error) socket.emit('error', reply);
          else original(Buffer.from(reply, 'latin1'));
        });
      }
      return true;
    }) as typeof socket.write;
    return socket;
  };
  return { connect, received, sockets };
};

describe('ClamdScanner', () => {
  it('parses clamd replies', () => {
    expect(parseClamdResponse('stream: OK\0')).toEqual({ verdict: 'clean' });
    expect(parseClamdResponse('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(() => parseClamdResponse('INSTREAM size limit exceeded. ERROR\0')).toThrow(ScannerError);
    expect(() => parseClamdResponse('')).toThrow(ScannerError);
  });

  it('speaks INSTREAM: command, length-prefixed chunks, zero terminator', async () => {
    const fake = fakeClamd('stream: OK\0');
    const scanner = new ClamdScanner({
      host: 'clamd',
      port: 3310,
      connect: fake.connect,
      chunkBytes: 8,
    });
    const body = Buffer.from('0123456789abcdef!', 'latin1');
    expect(await scanner.scan(Readable.from([body]))).toEqual({ verdict: 'clean' });
    const wire = Buffer.concat(fake.received);
    expect(wire.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    let offset = 10;
    const chunks: Buffer[] = [];
    for (;;) {
      const len = wire.readUInt32BE(offset);
      offset += 4;
      if (len === 0) break;
      chunks.push(wire.subarray(offset, offset + len));
      offset += len;
    }
    expect(chunks.map((c) => c.length)).toEqual([8, 8, 1]);
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(offset).toBe(wire.length);
  });

  it('reports FOUND with the signature, and errors as ScannerError', async () => {
    const found = new ClamdScanner({
      host: 'c',
      port: 1,
      connect: fakeClamd('stream: Eicar-Test-Signature FOUND\0').connect,
    });
    expect(await found.scan(Readable.from([fixtures.csv]))).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    const error = new ClamdScanner({
      host: 'c',
      port: 1,
      connect: fakeClamd('stream: INSTREAM size limit exceeded. ERROR\0').connect,
    });
    await expect(error.scan(Readable.from([fixtures.csv]))).rejects.toBeInstanceOf(ScannerError);
    const broken = new ClamdScanner({
      host: 'c',
      port: 1,
      connect: fakeClamd(new Error('ECONNREFUSED')).connect,
    });
    await expect(broken.scan(Readable.from([fixtures.csv]))).rejects.toThrow(/ECONNREFUSED/);
  });

  it('times out when clamd never answers', async () => {
    const fake = fakeClamd('never', { silent: true });
    const scanner = new ClamdScanner({ host: 'c', port: 1, connect: fake.connect, timeoutMs: 20 });
    await expect(scanner.scan(Readable.from([fixtures.csv]))).rejects.toThrow(/timed out/);
    expect(fake.sockets[0]!.destroyed).toBe(true);
  });
});

// ---------- scan pipeline ----------

class MemoryScanStore implements DocumentScanStore {
  readonly applied: DocumentScanOutcome[] = [];
  constructor(public record: ScanDocumentRecord | null) {}
  async load() {
    return this.record;
  }
  async apply(_payload: unknown, outcome: DocumentScanOutcome) {
    this.applied.push(outcome);
    if (this.record) this.record.status = outcome.status;
  }
}

const infected: MalwareScanner = {
  engine: 'clamav',
  async scan(stream) {
    stream.destroy();
    return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
  },
};
const clean: MalwareScanner = {
  engine: 'clamav',
  async scan(stream) {
    stream.destroy();
    return { verdict: 'clean' };
  },
};

describe('scan pipeline', () => {
  let root: string;
  let storage: LocalDiskObjectStorage;
  const org = '0f0f0f0f-0000-4000-8000-0000000000aa';
  let n = 0;
  const stored = async (bytes: Buffer, contentType: string) => {
    n += 1;
    const key = `${org}/org/doc-${n}`;
    await storage.put(key, Readable.from([bytes]), { contentType, sizeBytes: bytes.length });
    return key;
  };
  const record = (
    key: string,
    mimeType: string,
    sizeBytes: number,
    status: ScanDocumentRecord['status'] = 'SCANNING',
  ): ScanDocumentRecord => ({
    id: `doc-${n}`,
    organizationId: org,
    storageKey: key,
    mimeType,
    sizeBytes,
    status,
    deleted: false,
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'harbour-scan-'));
    storage = new LocalDiskObjectStorage({
      rootDir: root,
      secret: deriveLocalSigningSecret('scan-pipeline-secret'),
      baseUrl: 'http://x',
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('every accepted format passes the content check', async () => {
    for (const [format, bytes, mime] of [
      ['pdf', fixtures.pdf, 'application/pdf'],
      ['png', fixtures.png, 'image/png'],
      ['jpeg', fixtures.jpeg, 'image/jpeg'],
      ['xlsx', fixtures.xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['csv', fixtures.csv, 'text/csv'],
    ] as const) {
      const key = await stored(bytes, mime);
      const verdict = await scanStoredObject(
        { storage, scanner: new NoScanner() },
        { key, mimeType: mime, expectedSizeBytes: bytes.length },
      );
      expect(verdict, format).toEqual({
        outcome: 'not_scanned',
        engine: 'none',
        sha256: sha(bytes),
        sizeBytes: bytes.length,
      });
    }
  });

  it('a PDF uploaded as PNG is rejected as TYPE_MISMATCH and its object removed', async () => {
    const key = await stored(fixtures.pdf, 'image/png');
    const store = new MemoryScanStore(record(key, 'image/png', fixtures.pdf.length));
    const summary = await runDocumentScan(
      { storage, scanner: clean, store },
      { documentId: store.record!.id, organizationId: org },
    );
    expect(summary).toMatchObject({
      outcome: 'REJECTED',
      scanResult: 'TYPE_MISMATCH',
      objectDeleted: true,
    });
    expect(store.applied[0]).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'TYPE_MISMATCH',
      scanEngine: 'clamav',
      sha256: sha(fixtures.pdf),
    });
    expect(await storage.head(key)).toBeNull();
  });

  it('a scanner FOUND rejects with the signature; a clean scan is CLEAN; no scanner stays UPLOADED', async () => {
    const key1 = await stored(fixtures.pdf, 'application/pdf');
    const s1 = new MemoryScanStore(record(key1, 'application/pdf', fixtures.pdf.length));
    expect(
      await runDocumentScan(
        { storage, scanner: infected, store: s1 },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      outcome: 'REJECTED',
      scanResult: 'FOUND Eicar-Test-Signature',
      objectDeleted: true,
    });
    expect(s1.applied[0]).toMatchObject({ status: 'REJECTED', rejectedReason: 'MALWARE_FOUND' });
    expect(await storage.head(key1)).toBeNull();

    const key2 = await stored(fixtures.csv, 'text/csv');
    const s2 = new MemoryScanStore(record(key2, 'text/csv', fixtures.csv.length));
    expect(
      await runDocumentScan(
        { storage, scanner: clean, store: s2 },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      outcome: 'CLEAN',
      scanEngine: 'clamav',
      objectDeleted: false,
    });
    expect(s2.applied[0]).toMatchObject({
      status: 'CLEAN',
      scanEngine: 'clamav',
      scanResult: 'clean',
      sha256: sha(fixtures.csv),
    });
    expect(await storage.head(key2)).not.toBeNull();

    const key3 = await stored(fixtures.png, 'image/png');
    const s3 = new MemoryScanStore(record(key3, 'image/png', fixtures.png.length));
    expect(
      await runDocumentScan(
        { storage, scanner: new NoScanner(), store: s3 },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      outcome: 'UPLOADED',
      scanEngine: 'none',
      scanResult: 'not_scanned',
    });
    expect(s3.applied[0]).toMatchObject({
      status: 'UPLOADED',
      scanEngine: 'none',
      scanResult: 'not_scanned',
    });
  });

  it('rejects a missing object, a size disagreement, an empty file and a type it cannot name', async () => {
    const scanner = new NoScanner();
    expect(
      await scanStoredObject(
        { storage, scanner },
        { key: `${org}/org/missing`, mimeType: 'application/pdf', expectedSizeBytes: 1 },
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'OBJECT_MISSING',
    });
    const key = await stored(fixtures.pdf, 'application/pdf');
    expect(
      await scanStoredObject(
        { storage, scanner },
        { key, mimeType: 'application/pdf', expectedSizeBytes: fixtures.pdf.length + 5 },
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'SIZE_MISMATCH',
    });
    expect(
      await scanStoredObject(
        { storage, scanner },
        { key, mimeType: 'application/pdf', expectedSizeBytes: fixtures.pdf.length, maxBytes: 4 },
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'TOO_LARGE',
    });
    expect(
      await scanStoredObject(
        { storage, scanner },
        { key, mimeType: 'application/zip', expectedSizeBytes: fixtures.pdf.length },
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'UNSUPPORTED_TYPE',
    });
    const empty = await stored(Buffer.alloc(0), 'text/csv');
    expect(
      await scanStoredObject(
        { storage, scanner },
        { key: empty, mimeType: 'text/csv', expectedSizeBytes: 0 },
      ),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'EMPTY',
    });
    expect(MAX_DOCUMENT_BYTES).toBe(26_214_400);
  });

  it('skips documents that are gone or no longer scanning (idempotent retries)', async () => {
    const key = await stored(fixtures.pdf, 'application/pdf');
    const done = new MemoryScanStore(record(key, 'application/pdf', fixtures.pdf.length, 'CLEAN'));
    expect(
      await runDocumentScan(
        { storage, scanner: clean, store: done },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      outcome: 'SKIPPED',
      skipped: 'NOT_SCANNING',
    });
    const gone = new MemoryScanStore(null);
    expect(
      await runDocumentScan(
        { storage, scanner: clean, store: gone },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      outcome: 'SKIPPED',
      skipped: 'NOT_FOUND',
    });
    const deleted = new MemoryScanStore({
      ...record(key, 'application/pdf', fixtures.pdf.length),
      deleted: true,
    });
    expect(
      await runDocumentScan(
        { storage, scanner: clean, store: deleted },
        { documentId: 'd', organizationId: org },
      ),
    ).toMatchObject({
      skipped: 'DELETED',
    });
    expect(done.applied).toEqual([]);
    expect(await storage.head(key)).not.toBeNull();
  });

  it('a scanner failure propagates (the job retries, nothing is written)', async () => {
    const key = await stored(fixtures.pdf, 'application/pdf');
    const failing: MalwareScanner = {
      engine: 'clamav',
      async scan(stream) {
        stream.destroy();
        throw new ScannerError('clamd: connect failed');
      },
    };
    const store = new MemoryScanStore(record(key, 'application/pdf', fixtures.pdf.length));
    await expect(
      runDocumentScan(
        { storage, scanner: failing, store },
        { documentId: 'd', organizationId: org },
      ),
    ).rejects.toBeInstanceOf(ScannerError);
    expect(store.applied).toEqual([]);
    expect(store.record!.status).toBe('SCANNING');
    expect(await storage.head(key)).not.toBeNull();
  });
});
