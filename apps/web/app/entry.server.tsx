import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createReadableStreamFromReadable } from '@react-router/node';
import { isbot } from 'isbot';
import type { RenderToPipeableStreamOptions } from 'react-dom/server';
import { renderToPipeableStream } from 'react-dom/server';
import {
  ServerRouter,
  isRouteErrorResponse,
  type EntryContext,
  type HandleErrorFunction,
} from 'react-router';
import { loadEnv } from './services/env.server';
import { createLogger, requestIdFor, type Logger } from './services/logger.server';
import { applySecurityHeaders } from './services/security-headers.server';
import { storageUploadOrigin } from './services/documents/storage.server'; // M5

export const streamTimeout = 5_000;

const bootLogger = (): Logger => {
  try {
    const env = loadEnv();
    return createLogger({ level: env.logLevel, base: { app: 'web' } });
  } catch {
    return createLogger({ base: { app: 'web' } });
  }
};
const logger = bootLogger();
const isProduction = process.env.NODE_ENV === 'production';
// M5: when uploads go straight to S3/R2 the CSP needs that origin in connect-src (env-driven,
// computed once; local-disk storage is same-origin and adds nothing).
const storageConnectSrc: string[] = (() => {
  try {
    const origin = storageUploadOrigin(loadEnv());
    return origin ? [origin] : [];
  } catch {
    return [];
  }
})();

/**
 * Streaming SSR (React Router 7 framework mode). Per request we mint a CSP nonce, hand it to
 * <ServerRouter nonce> — which makes it the default for <Scripts>, <ScrollRestoration> and
 * <Links> — and to React's own streaming inline scripts via renderToPipeableStream's `nonce`.
 * The same nonce goes into the Content-Security-Policy header (§7.5).
 */
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const nonce = randomUUID();
  applySecurityHeaders(responseHeaders, nonce, {
    hsts: isProduction,
    connectSrc: storageConnectSrc,
  }); // M5
  responseHeaders.set('X-Request-Id', requestIdFor(request));

  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get('user-agent');
    // Bots (and SPA-mode renders) wait for all content so crawlers see the full document.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? 'onAllReady' : 'onShellReady';

    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
          pipe(body);
          resolve(new Response(stream, { headers: responseHeaders, status: responseStatusCode }));
        },
        onShellError(error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Shell errors reject above and are logged by handleError; only log post-shell ones.
          if (shellRendered) logger.error('render.stream_error', { error });
        },
      },
    );
  });
}

/** Server-side error sink: structured, redacted, and silent for client-aborted requests. */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  const url = new URL(request.url);
  // 4xx route errors (404s, thrown 400s) are expected traffic, not incidents.
  if (isRouteErrorResponse(error) && error.status < 500) {
    logger.info('request.client_error', {
      method: request.method,
      path: url.pathname,
      status: error.status,
    });
    return;
  }
  // React Router's own CSRF layer: a POST whose Origin differs from the request URL gets a 400
  // before any action runs. Expected hostile/misrouted traffic, not a server fault.
  if (error instanceof Error && error.message.includes('does not match `origin` header')) {
    logger.warn('request.cross_origin_rejected', { method: request.method, path: url.pathname });
    return;
  }
  logger.error('request.error', {
    requestId: requestIdFor(request),
    method: request.method,
    path: url.pathname,
    error,
  });
};
