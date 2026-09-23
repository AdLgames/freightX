/**
 * Response hardening (§7.3 HSTS, §7.5 CSP with script nonce). Applied to every document
 * response in entry.server.tsx and to resource routes that build their own Response.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export const contentSecurityPolicy = (
  nonce: string,
  opts: { connectSrc?: readonly string[] } = {}, // M5: extra connect-src origins (direct-to-storage uploads)
): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // M5: the browser PUTs uploads straight to S3/R2 when STORAGE_* names another origin.
    ...(opts.connectSrc && opts.connectSrc.length > 0
      ? [`connect-src 'self' ${opts.connectSrc.join(' ')}`]
      : []),
  ].join('; ');

export const applySecurityHeaders = (
  headers: Headers,
  nonce: string,
  opts: { hsts?: boolean; connectSrc?: readonly string[] } = {}, // M5: connectSrc
): Headers => {
  headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(nonce, opts.connectSrc ? { connectSrc: opts.connectSrc } : {}),
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('X-Frame-Options', 'DENY');
  if (opts.hsts ?? true) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  return headers;
};
