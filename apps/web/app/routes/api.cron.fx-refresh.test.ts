import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, makeRequest, run } from '../test-support/harness';
import { loader } from './api.cron.fx-refresh';

const SECRET = 'cron-secret-0123456789abcdef';
const historyXml = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'adapters',
    'fixtures',
    'fx',
    'ecb-history-sample.xml',
  ),
  'utf8',
);

const request = (auth?: string) =>
  makeRequest('/api/cron/fx-refresh', {
    headers: auth ? { authorization: auth } : {},
  });

describe('GET /api/cron/fx-refresh', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers 503 when CRON_SECRET is unset', async () => {
    await createTestApp();
    const res = await run(loader, request(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
  });

  it('answers 401 without the right bearer and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await createTestApp({ env: { CRON_SECRET: SECRET } });
    expect((await run(loader, request())).status).toBe(401);
    expect((await run(loader, request('Bearer nope'))).status).toBe(401);
    expect((await run(loader, request(`Basic ${SECRET}`))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads the ECB history into the refresh store and reports what it wrote', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(historyXml, { status: 200 })),
    );
    const t = await createTestApp({ env: { CRON_SECRET: SECRET } });
    const res = await run(loader, request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const usd = await t.app.stores.fxRefreshStore.history(
      'ECB',
      'USD',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
    );
    expect(usd.map((r) => r.validFrom)).toEqual(['2026-09-15', '2026-09-19', '2026-09-22']);
    expect(t.logs.some((l) => l.event === 'fx.ecb_refreshed')).toBe(true);

    // Second run: only the two newest days are rewritten.
    await run(loader, request(`Bearer ${SECRET}`));
    const again = t.logs.filter((l) => l.event === 'fx.ecb_refreshed');
    expect(again[1]).toMatchObject({ recordsWritten: 6, daysInFile: 3 });
  });

  it('answers 502 when the ECB is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    await createTestApp({ env: { CRON_SECRET: SECRET } });
    const res = await run(loader, request(`Bearer ${SECRET}`));
    expect(res.status).toBe(502);
  });
});
