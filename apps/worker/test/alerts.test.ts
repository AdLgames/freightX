import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConsoleAlertSink, WebhookAlertSink } from '../src/alerts.js';
import { CompositeAlertSink, type AlertSink } from '../src/ports.js';

describe('ConsoleAlertSink', () => {
  it('writes one structured JSON line', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => void (text += chunk.toString()));
    new ConsoleAlertSink(out).alert('warning', 'FX_ECB_FETCH_FAILED', 'ecb down', { url: 'x' });
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: 'alert',
      level: 'warning',
      code: 'FX_ECB_FETCH_FAILED',
      message: 'ecb down',
      meta: { url: 'x' },
    });
    expect(typeof parsed['ts']).toBe('string');
  });
});

describe('WebhookAlertSink', () => {
  it('POSTs JSON with a timeout signal', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        init,
      });
      return new Response('ok', { status: 202 });
    }) as typeof fetch;
    const sink = new WebhookAlertSink('https://hooks.example.test/alerts', { fetch: fetchImpl });
    await sink.alert('critical', 'FX_HMRC_MISSING', 'missing', { month: '2026-10' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://hooks.example.test/alerts');
    expect(seen[0]!.init?.method).toBe('POST');
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    const raw = seen[0]!.init?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: 'harbour-worker',
      level: 'critical',
      code: 'FX_HMRC_MISSING',
      meta: { month: '2026-10' },
    });
  });

  it('never throws: network errors and non-2xx are reported to onError', async () => {
    const errors: unknown[] = [];
    const failing = new WebhookAlertSink('https://hooks.example.test/alerts', {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      onError: (e) => errors.push(e),
    });
    await expect(failing.alert('info', 'JOB_FAILED', 'x')).resolves.toBeUndefined();
    const rejecting = new WebhookAlertSink('https://hooks.example.test/alerts', {
      fetch: async () => new Response('no', { status: 500 }),
      onError: (e) => errors.push(e),
    });
    await expect(rejecting.alert('info', 'JOB_FAILED', 'x')).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});

describe('CompositeAlertSink', () => {
  it('delivers to every sink even when one throws', async () => {
    const got: string[] = [];
    const badSink: AlertSink = {
      alert: () => {
        throw new Error('broken channel');
      },
    };
    const good: AlertSink = { alert: (_l, code) => void got.push(code) };
    await new CompositeAlertSink([badSink, good]).alert('info', 'JOB_FAILED', 'x');
    expect(got).toEqual(['JOB_FAILED']);
  });
});
