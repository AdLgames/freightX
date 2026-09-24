import { describe, expect, it } from 'vitest';
import {
  CSP_ADDITIONS_HEADER,
  applySecurityHeaders,
  contentSecurityPolicy,
  parseCspAdditions,
  serializeCspAdditions,
} from './security-headers.server';
import { mapCspAdditions, withAisOrigin } from './tracking/csp.server';

/** M9 — route-scoped CSP additions (ADR-0017). The global policy must stay byte-identical. */
describe('contentSecurityPolicy', () => {
  it('is unchanged without additions', () => {
    expect(contentSecurityPolicy('n1')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-n1' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; object-src 'none'",
    );
  });

  it('merges the map additions for one response and never touches script-src', () => {
    const add = mapCspAdditions('https://tiles.openfreemap.org/styles/liberty', [
      'https://cdn.example',
    ]);
    expect(add).toEqual({
      'connect-src': ['https://tiles.openfreemap.org', 'https://cdn.example'],
      'img-src': ['https://tiles.openfreemap.org', 'https://cdn.example', 'data:', 'blob:'],
      'worker-src': ['blob:'],
      'child-src': ['blob:'],
    });
    const csp = contentSecurityPolicy('n2', add);
    expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org https://cdn.example");
    expect(csp).toContain(
      "img-src 'self' https://tiles.openfreemap.org https://cdn.example data: blob:",
    );
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self' 'nonce-n2' https://challenges.cloudflare.com;");
    expect(csp.startsWith("default-src 'self'; ")).toBe(true);
    // An http style URL contributes no host.
    expect(mapCspAdditions('http://insecure.example/style.json')['connect-src']).toEqual([]);
  });

  it('parse/serialize round-trip; rejects unsafe sources and non-addable directives (fail closed)', () => {
    const raw = serializeCspAdditions({
      'connect-src': ['https://a.example'],
      'worker-src': ['blob:'],
    });
    expect(raw).toBe('connect-src https://a.example; worker-src blob:');
    expect(parseCspAdditions(raw)).toEqual({
      'connect-src': ['https://a.example'],
      'worker-src': ['blob:'],
    });
    expect(
      parseCspAdditions(
        "script-src https://evil.example; connect-src 'unsafe-inline' http://plain.example https://ok.example; base-uri https://x; style-src 'self'",
      ),
    ).toEqual({ 'connect-src': ['https://ok.example'], 'style-src': ["'self'"] });
    expect(parseCspAdditions(null)).toEqual({});
    expect(contentSecurityPolicy('n', { 'script-src': ['https://evil.example'] })).not.toContain(
      'evil',
    );
  });

  it('applySecurityHeaders consumes the marker header and never forwards it', () => {
    const headers = new Headers({ [CSP_ADDITIONS_HEADER]: 'connect-src https://tiles.example' });
    applySecurityHeaders(headers, 'n3', { hsts: false });
    expect(headers.get(CSP_ADDITIONS_HEADER)).toBeNull();
    expect(headers.get('Content-Security-Policy')).toContain(
      "connect-src 'self' https://tiles.example",
    );
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Strict-Transport-Security')).toBeNull();

    const plain = new Headers();
    applySecurityHeaders(plain, 'n4');
    expect(plain.get('Content-Security-Policy')).toBe(contentSecurityPolicy('n4'));
  });
});

describe('withAisOrigin', () => {
  it('adds the aisstream socket to connect-src only when a key is configured', () => {
    const base = mapCspAdditions('https://tiles.openfreemap.org/styles/liberty');
    expect(withAisOrigin(base, null)).toEqual(base);
    const withAis = withAisOrigin(base, 'wss://stream.aisstream.io');
    expect(withAis['connect-src']).toEqual([
      'https://tiles.openfreemap.org',
      'wss://stream.aisstream.io',
    ]);
    const csp = contentSecurityPolicy('n', parseCspAdditions(serializeCspAdditions(withAis)));
    expect(csp).toContain(
      "connect-src 'self' https://tiles.openfreemap.org wss://stream.aisstream.io",
    );
  });
});
