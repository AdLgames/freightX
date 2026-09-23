import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { LocalDiskObjectStorage, ObjectNotFoundError } from '@harbour/adapters';
import { createReadableStreamFromReadable } from '@react-router/node';
import type { Route } from './+types/files.get.$';
import { getApp } from '../services/app.server';
import { requestLogger } from '../services/logger.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/**
 * Local-disk storage backend only (development/tests): the "presigned GET" target.
 * `GET /files/get/<key>?exp=&cd=&sig=` — HMAC over method, key, expiry and the disposition
 * (`LocalDiskObjectStorage.verifyGet`). The signature is the authorisation, like an S3 presigned
 * URL; the app's own authorisation and audit happened in /app/documents/:id/download. Served with
 * `Content-Disposition: attachment` and `nosniff`, never inline. 404 with the S3 backend.
 */
const reply = (status: number, body: string, production: boolean) => {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  applySecurityHeaders(headers, randomUUID(), { hsts: production });
  return new Response(body, { status, headers });
};

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const app = await getApp();
  const production = app.env.NODE_ENV === 'production';
  const storage = app.documents.storage;
  if (!(storage instanceof LocalDiskObjectStorage)) return reply(404, 'Not found', production);
  const log = requestLogger(app.logger, request);
  const key = params['*'] ?? '';
  const verified = storage.verifyGet(key, new URL(request.url).searchParams);
  if (!verified.ok) {
    log.warn('files.get_denied', { problem: verified.problem });
    return reply(403, 'Signature invalid or expired', production);
  }
  const head = await storage.head(key);
  if (!head) return reply(404, 'Not found', production);
  let stream: Readable;
  try {
    stream = await storage.getStream(key);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return reply(404, 'Not found', production);
    throw err;
  }
  const headers = new Headers({
    'content-type': head.contentType ?? 'application/octet-stream',
    'content-length': String(head.sizeBytes),
    'content-disposition': verified.responseContentDisposition ?? 'attachment',
    'cache-control': 'private, no-store',
  });
  applySecurityHeaders(headers, randomUUID(), { hsts: production });
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  log.info('files.get', { bytes: head.sizeBytes });
  if (request.method === 'HEAD') {
    stream.destroy();
    return new Response(null, { status: 200, headers });
  }
  return new Response(createReadableStreamFromReadable(stream), { status: 200, headers });
};
