import { describe, expect, it } from 'vitest';
import { canonicalRedirect } from './canonical-host.server';

const APP = 'https://freightx-chi.vercel.app';
const req = (url: string, method = 'GET') => new Request(url, { method });

describe('canonicalRedirect', () => {
  it('sends a document GET on another host to the same path on APP_URL', () => {
    const r = canonicalRedirect(
      req('https://freightx-j5fxlbyd-team.vercel.app/app?x=1'),
      APP,
      true,
    );
    expect(r?.status).toBe(308);
    expect(r?.headers.get('location')).toBe(`${APP}/app?x=1`);
  });

  it('turns a data request into its document URL', () => {
    const r = canonicalRedirect(
      req('https://freightx-git-main-team.vercel.app/app.data?_routes=routes%2Fapp&tab=2'),
      APP,
      true,
    );
    expect(r?.headers.get('location')).toBe(`${APP}/app?tab=2`);
    const root = canonicalRedirect(req('https://other.vercel.app/_root.data'), APP, true);
    expect(root?.headers.get('location')).toBe(`${APP}/`);
  });

  it('is a no-op on the canonical host, case-insensitively', () => {
    expect(canonicalRedirect(req(`${APP}/app`), APP, true)).toBeNull();
    expect(canonicalRedirect(req('https://FreightX-CHI.vercel.app/login'), APP, true)).toBeNull();
  });

  it('never redirects outside production, without APP_URL, or for POSTs', () => {
    const other = 'https://freightx-abc-team.vercel.app/app';
    expect(canonicalRedirect(req(other), APP, false)).toBeNull();
    expect(canonicalRedirect(req(other), null, true)).toBeNull();
    expect(canonicalRedirect(req(other, 'POST'), APP, true)).toBeNull();
    expect(canonicalRedirect(req(other), 'not a url', true)).toBeNull();
  });

  it('leaves the machine endpoints alone', () => {
    for (const path of ['/healthz', '/api/cron/fx-refresh', '/webhooks/stripe']) {
      expect(
        canonicalRedirect(req(`https://freightx-abc-team.vercel.app${path}`), APP, true),
      ).toBeNull();
    }
  });
});
