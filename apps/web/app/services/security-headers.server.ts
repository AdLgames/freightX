/**
 * Response hardening (§7.3 HSTS, §7.5 CSP with script nonce). Applied to every document
 * response in entry.server.tsx and to resource routes that build their own Response.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
// M6: Checkout and Billing Portal are reached by a 302 after a form POST; Chromium applies
// form-action to that redirect, so Stripe's two documented origins are allowed as form targets.
// Nothing else changes (no scripts, no frames from Stripe).
export const STRIPE_FORM_ACTION_ORIGINS = 'https://checkout.stripe.com https://billing.stripe.com';
// end M6

// M9 — route-scoped CSP additions (ADR-0017: the map route needs tile/glyph hosts and blob
// workers; the global policy is unchanged everywhere else). A route's `headers()` export sets
// `CSP_ADDITIONS_HEADER` to a mini-policy, e.g. "connect-src https://tiles.example; worker-src blob:";
// `applySecurityHeaders` merges those sources into the policy for THAT response and removes the
// marker. Only https origins, 'self', blob: and data: are accepted as sources; directives that
// could weaken script execution (script-src, base-uri, form-action, frame-ancestors, object-src)
// cannot be added to. Anything else is ignored (fail closed).
export const CSP_ADDITIONS_HEADER = 'x-harbour-csp-additions';
const CSP_ADDABLE_DIRECTIVES = new Set([
  'connect-src',
  'img-src',
  'worker-src',
  'child-src',
  'style-src',
  'font-src',
]);
const CSP_SOURCE = /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?|'self'|blob:|data:)$/;
export type CspAdditions = Readonly<Record<string, readonly string[]>>;

export const parseCspAdditions = (raw: string | null | undefined): CspAdditions => {
  const out: Record<string, string[]> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const [directive, ...sources] = part.trim().split(/\s+/);
    if (!directive || !CSP_ADDABLE_DIRECTIVES.has(directive)) continue;
    const ok = sources.filter((s) => CSP_SOURCE.test(s));
    if (ok.length > 0) out[directive] = [...(out[directive] ?? []), ...ok];
  }
  return out;
};

export const serializeCspAdditions = (additions: CspAdditions): string =>
  Object.entries(additions)
    .map(([d, s]) => `${d} ${s.join(' ')}`)
    .join('; ');

export const contentSecurityPolicy = (nonce: string, rawAdditions: CspAdditions = {}): string => {
  // M5 callers pass `{ connectSrc }`; M9 route additions use directive names. Accept both.
  const { connectSrc, ...rest } = rawAdditions as CspAdditions & { connectSrc?: readonly string[] };
  const additions: CspAdditions =
    connectSrc && connectSrc.length > 0
      ? { ...rest, 'connect-src': [...(rest['connect-src'] ?? []), ...connectSrc] }
      : rest;
  const base: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, TURNSTILE_ORIGIN]],
    ['frame-src', [TURNSTILE_ORIGIN]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'", ...STRIPE_FORM_ACTION_ORIGINS.split(' ')]], // M6
    ['object-src', ["'none'"]],
  ];
  // M9: merge route additions. A directive absent from the base starts from 'self' (what it
  // inherits from default-src) so the addition widens, never narrows, the effective policy.
  for (const [directive, sources] of Object.entries(additions)) {
    if (!CSP_ADDABLE_DIRECTIVES.has(directive)) continue;
    const clean = sources.filter((s) => CSP_SOURCE.test(s));
    if (clean.length === 0) continue;
    const existing = base.find(([d]) => d === directive);
    if (existing) existing[1].push(...clean);
    else base.push([directive, ["'self'", ...clean]]);
  }
  return base.map(([d, s]) => `${d} ${[...new Set(s)].join(' ')}`).join('; ');
};

export const applySecurityHeaders = (
  headers: Headers,
  nonce: string,
  opts: { hsts?: boolean; connectSrc?: readonly string[] } = {}, // M5: connectSrc
): Headers => {
  const routeAdditions = parseCspAdditions(headers.get(CSP_ADDITIONS_HEADER)); // M9
  headers.delete(CSP_ADDITIONS_HEADER); // M9: never sent to the client
  // M5: direct-to-storage uploads need the storage origin in connect-src (merged like a route addition).
  const additions: CspAdditions =
    opts.connectSrc && opts.connectSrc.length > 0
      ? {
          ...routeAdditions,
          'connect-src': [...(routeAdditions['connect-src'] ?? []), ...opts.connectSrc],
        }
      : routeAdditions;
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce, additions));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('X-Frame-Options', 'DENY');
  if (opts.hsts ?? true) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  return headers;
};
