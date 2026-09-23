/**
 * Local-disk storage routes: presigned PUT/GET round trip through /files/put/* and /files/get/*,
 * with expiry, tamper and content-type rejection. No database needed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalDiskObjectStorage } from '@harbour/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { createTestApp, type TestApp } from '../test-support/harness';
import { loader as getLoader } from './files.get.$';
import { action as putAction, loader as putLoader } from './files.put.$';

type RouteFn = (args: {
  request: Request;
  params: Record<string, string>;
  context: object;
}) => unknown;
const call = (fn: unknown, request: Request, key: string) =>
  (fn as RouteFn)({ request, params: { '*': key }, context: {} }) as Promise<Response>;

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
const KEY = '0f0f0f0f-0000-4000-8000-0000000000aa/org/0f0f0f0f-0000-4000-8000-0000000000bb';

describe('local storage routes', () => {
  let t: TestApp;
  let dir: string;
  let storage: LocalDiskObjectStorage;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harbour-files-'));
    t = await createTestApp({ env: { STORAGE_LOCAL_DIR: dir, SESSION_SECRET: 'x'.repeat(40) } });
    expect(t.app.documents.backend).toBe('local');
    storage = t.app.documents.storage as LocalDiskObjectStorage;
  });
  afterAll(async () => {
    setAppForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('PUT with a valid signature stores the bytes; GET with a valid signature returns them', async () => {
    const put = await storage.presignPut({
      key: KEY,
      contentType: 'application/pdf',
      maxBytes: PDF.length,
      expiresInSec: 300,
    });
    // APP_URL unset → relative URLs, so the dev server works on any port.
    expect(put.url.startsWith(`/files/put/${KEY}?`)).toBe(true);
    const abs = (u: string) => new URL(u, 'http://localhost:3000');
    const res = await call(
      putAction,
      new Request(abs(put.url), { method: 'PUT', headers: put.headers, body: new Uint8Array(PDF) }),
      KEY,
    );
    expect(res.status).toBe(200);
    expect(await storage.head(KEY)).toEqual({
      sizeBytes: PDF.length,
      contentType: 'application/pdf',
    });

    const url = await storage.presignGet({
      key: KEY,
      expiresInSec: 300,
      responseContentDisposition: 'attachment; filename="inv.pdf"',
    });
    const got = await call(getLoader, new Request(abs(url)), KEY);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/pdf');
    expect(got.headers.get('content-disposition')).toBe('attachment; filename="inv.pdf"');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PDF);
  });

  it('rejects the wrong content type, an oversize body, a tampered or expired signature', async () => {
    const abs = (u: string) => new URL(u, 'http://localhost:3000');
    const put = await storage.presignPut({
      key: KEY,
      contentType: 'application/pdf',
      maxBytes: 8,
      expiresInSec: 1,
    });
    const wrongType = await call(
      putAction,
      new Request(abs(put.url), {
        method: 'PUT',
        headers: { 'content-type': 'text/html' },
        body: new Uint8Array(PDF),
      }),
      KEY,
    );
    expect(wrongType.status).toBe(400);
    const tooBig = await call(
      putAction,
      new Request(abs(put.url), { method: 'PUT', headers: put.headers, body: new Uint8Array(PDF) }),
      KEY,
    );
    expect(tooBig.status).toBe(413);
    const tampered = abs(put.url);
    tampered.searchParams.set('max', '999999');
    const bad = await call(
      putAction,
      new Request(tampered, { method: 'PUT', headers: put.headers, body: new Uint8Array(PDF) }),
      KEY,
    );
    expect(bad.status).toBe(403);
    // Same signature presented for a different key.
    const other = await call(
      putAction,
      new Request(abs(put.url), {
        method: 'PUT',
        headers: put.headers,
        body: new Uint8Array(PDF.subarray(0, 4)),
      }),
      `${KEY}x`,
    );
    expect(other.status).toBe(403);
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await call(
      putAction,
      new Request(abs(put.url), {
        method: 'PUT',
        headers: put.headers,
        body: new Uint8Array(PDF.subarray(0, 4)),
      }),
      KEY,
    );
    expect(expired.status).toBe(403);

    const get = abs(await storage.presignGet({ key: KEY, expiresInSec: 300 }));
    get.searchParams.set('cd', 'inline');
    expect((await call(getLoader, new Request(get), KEY)).status).toBe(403);
    expect(
      (await call(getLoader, new Request(`http://localhost:3000/files/get/${KEY}`), KEY)).status,
    ).toBe(403);
    const missing = await storage.presignGet({ key: `${KEY}-missing`, expiresInSec: 300 });
    expect((await call(getLoader, new Request(abs(missing)), `${KEY}-missing`)).status).toBe(404);
  });

  it('GET on the PUT route is not allowed; keys with traversal are refused', async () => {
    expect(
      (await call(putLoader, new Request('http://localhost:3000/files/put/x'), 'x')).status,
    ).toBe(405);
    const res = await call(
      putAction,
      new Request('http://localhost:3000/files/put/../x?exp=1&ct=a&max=1&sig=b', {
        method: 'PUT',
        body: 'x',
      }),
      '../x',
    );
    expect(res.status).toBe(403);
    // No file name or query string reaches the logs.
    expect(t.lines.join('\n')).not.toContain('sig=');
  });
});
