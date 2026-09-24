import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL49_SIGNATURE_HEADER } from '@harbour/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import type { TrackingEventsJob, TrackingQueue } from '../services/tracking/tracking.server';
import { ORIGIN, createTestApp, type TestApp } from '../test-support/harness';
import { MAX_WEBHOOK_BYTES, action, loader, readBodyCapped } from './webhooks.tracking.$providerId';

/** M9 — POST /webhooks/tracking/:providerId (brief §6.4). No database needed: the queue is faked. */
const SECRET = 'unit-test-webhook-secret';
const fixture = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'adapters',
    'fixtures',
    'tracking',
    'terminal49-webhook-vessel-loaded.json',
  ),
  'utf8',
);
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

const post = (providerId: string, body: string, headers: Record<string, string> = {}) => {
  const request = new Request(`${ORIGIN}/webhooks/tracking/${providerId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return action({ request, params: { providerId }, context: {} } as unknown as Parameters<
    typeof action
  >[0]);
};

describe('POST /webhooks/tracking/:providerId', () => {
  let t: TestApp;
  const jobs: TrackingEventsJob[] = [];
  const fakeQueue: TrackingQueue = {
    backend: 'inline',
    enqueue: async (job) => {
      jobs.push(job);
      return { queued: true };
    },
  };
  // The fixture's created_at is 2026-09-23T10:00:00Z; the replay window is 5 minutes.
  const now = () => new Date('2026-09-23T10:01:00Z');

  beforeAll(async () => {
    t = await createTestApp({ env: { TERMINAL49_WEBHOOK_SECRET: SECRET } });
    const { createTrackingServices } = await import('../services/tracking/tracking.server');
    const tracking = createTrackingServices({
      env: t.app.env,
      logger: t.app.logger,
      prisma: null,
      now,
      queue: fakeQueue,
    });
    setAppForTests({ ...t.app, tracking });
  });
  afterAll(() => setAppForTests(null));

  it('accepts a correctly signed fixture, enqueues the normalised events and answers 200', async () => {
    const before = t.logs.length;
    const res = await post('terminal49', fixture, { [TERMINAL49_SIGNATURE_HEADER]: sign(fixture) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, events: 1, queued: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: 'terminal49',
      events: [{ containerNumber: 'CSQU3054383', milestone: 'LOADED_ON_VESSEL' }],
    });
    // Logs: counts and provider id only; no payload, signature or secret.
    const text = JSON.stringify(t.logs.slice(before));
    expect(text).toContain('tracking.webhook_accepted');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(sign(fixture));
    expect(text).not.toContain('CSQU3054383');
  });

  it('401 on a bad signature, a wrong secret, or a stale timestamp; nothing is enqueued', async () => {
    const n = jobs.length;
    expect(
      (await post('terminal49', fixture, { [TERMINAL49_SIGNATURE_HEADER]: 'deadbeef' })).status,
    ).toBe(401);
    expect((await post('terminal49', fixture)).status).toBe(401);
    expect(
      (await post('terminal49', fixture, { [TERMINAL49_SIGNATURE_HEADER]: sign(fixture, 'other') }))
        .status,
    ).toBe(401);
    const tampered = fixture.replace('vessel_loaded', 'vessel_departed');
    expect(
      (await post('terminal49', tampered, { [TERMINAL49_SIGNATURE_HEADER]: sign(fixture) })).status,
    ).toBe(401);
    const stale = fixture.replace('2026-09-23T10:00:00Z', '2026-09-23T09:00:00Z');
    const res = await post('terminal49', stale, { [TERMINAL49_SIGNATURE_HEADER]: sign(stale) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'replay' });
    expect(jobs).toHaveLength(n);
  });

  it('413 over 256 KB (declared and undeclared), 400 malformed, 404 unknown provider, 405 GET', async () => {
    const big = 'x'.repeat(MAX_WEBHOOK_BYTES + 1);
    expect(
      (await post('terminal49', big, { [TERMINAL49_SIGNATURE_HEADER]: sign(big) })).status,
    ).toBe(413);
    const declared = new Request(`${ORIGIN}/webhooks/tracking/terminal49`, {
      method: 'POST',
      headers: {
        'content-length': String(MAX_WEBHOOK_BYTES + 1),
        [TERMINAL49_SIGNATURE_HEADER]: 'x',
      },
      body: 'small',
    });
    expect(
      (
        await action({
          request: declared,
          params: { providerId: 'terminal49' },
          context: {},
        } as unknown as Parameters<typeof action>[0])
      ).status,
    ).toBe(413);
    const junk = '{not json';
    expect(
      (await post('terminal49', junk, { [TERMINAL49_SIGNATURE_HEADER]: sign(junk) })).status,
    ).toBe(400);
    expect(
      (await post('project44', fixture, { [TERMINAL49_SIGNATURE_HEADER]: sign(fixture) })).status,
    ).toBe(404);
    expect((await post('../etc', fixture)).status).toBe(404);
    expect(loader().status).toBe(405);
  });

  it('503 when the provider secret is not configured', async () => {
    const bare = await createTestApp({});
    const { createTrackingServices } = await import('../services/tracking/tracking.server');
    setAppForTests({
      ...bare.app,
      tracking: createTrackingServices({
        env: bare.app.env,
        logger: bare.app.logger,
        prisma: null,
        now,
        queue: fakeQueue,
      }),
    });
    expect(
      (await post('terminal49', fixture, { [TERMINAL49_SIGNATURE_HEADER]: sign(fixture) })).status,
    ).toBe(503);
    setAppForTests({
      ...t.app,
      tracking: createTrackingServices({
        env: t.app.env,
        logger: t.app.logger,
        prisma: null,
        now,
        queue: fakeQueue,
      }),
    });
  });

  it('readBodyCapped stops reading a stream past the limit', async () => {
    const chunks = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const req = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await readBodyCapped(req, 2500)).toBeNull();
    const ok = new Request(`${ORIGIN}/x`, { method: 'POST', body: 'hello' });
    expect(await readBodyCapped(ok, 10)).toBe('hello');
  });
});
