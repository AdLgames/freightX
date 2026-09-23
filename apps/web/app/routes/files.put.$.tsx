import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { LocalDiskObjectStorage, ObjectTooLargeError } from '@harbour/adapters';
import type { Route } from './+types/files.put.$';
import { getApp } from '../services/app.server';
import { requestLogger } from '../services/logger.server';
import { applySecurityHeaders } from '../services/security-headers.server';

/**
 * Local-disk storage backend only (development/tests): the "presigned PUT" target.
 * `PUT /files/put/<key>?exp=&ct=&max=&sig=` — the HMAC covers method, key, expiry, content type
 * and size limit (`LocalDiskObjectStorage.verifyPut`). No session, no CSRF: the signature is the
 * authorisation, exactly like an S3 presigned URL. The body streams to disk and is cut off at
 * `max` bytes. With the S3 backend this route answers 404.
 */
const reply = (status: number, body: string, production: boolean) => {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  applySecurityHeaders(headers, randomUUID(), { hsts: production });
  return new Response(body, { status, headers });
};

export const loader = async () => {
  const app = await getApp();
  return reply(405, 'Method not allowed', app.env.NODE_ENV === 'production');
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const app = await getApp();
  const production = app.env.NODE_ENV === 'production';
  const storage = app.documents.storage;
  if (!(storage instanceof LocalDiskObjectStorage)) return reply(404, 'Not found', production);
  if (request.method !== 'PUT') return reply(405, 'Method not allowed', production);
  const log = requestLogger(app.logger, request);
  const key = params['*'] ?? '';
  const verified = storage.verifyPut(key, new URL(request.url).searchParams);
  if (!verified.ok) {
    log.warn('files.put_denied', { problem: verified.problem });
    return reply(
      verified.problem === 'EXPIRED' ? 403 : 403,
      'Signature invalid or expired',
      production,
    );
  }
  const declaredType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (declaredType !== verified.contentType) {
    log.warn('files.put_denied', { problem: 'CONTENT_TYPE' });
    return reply(400, 'Content-Type does not match the signed upload', production);
  }
  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > verified.maxBytes) {
    return reply(413, 'Body exceeds the signed size limit', production);
  }
  if (!request.body) return reply(400, 'Empty body', production);
  try {
    const written = await storage.receivePut(
      key,
      Readable.fromWeb(request.body as NodeReadableStream),
      { contentType: verified.contentType, maxBytes: verified.maxBytes },
    );
    log.info('files.put', { bytes: written });
    return reply(200, 'OK', production);
  } catch (err) {
    if (err instanceof ObjectTooLargeError)
      return reply(413, 'Body exceeds the signed size limit', production);
    throw err;
  }
};
