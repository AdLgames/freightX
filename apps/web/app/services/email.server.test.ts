import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailTransport,
  EmailSendError,
  RESEND_ENDPOINT,
  ResendEmailTransport,
  createEmailTransport,
  linkPathFrom,
  type EmailFetch,
} from './email.server';
import { loadEnv } from './env.server';
import { createLogger } from './logger.server';

const capture = () => {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) };
};

const MESSAGE = {
  to: 'jane.doe@example.test',
  subject: 'Your Harbour sign-in link',
  text: 'Sign in:\n\nhttps://app.example.test/login/verify?token=abc_DEF-123\n\nThanks',
};

describe('ConsoleEmailTransport', () => {
  it('refuses to exist in production', () => {
    expect(() => new ConsoleEmailTransport(capture().logger, 'production')).toThrow(
      /development and test only/,
    );
  });

  it('logs only the link path at info level, never the recipient or body', async () => {
    const { lines, logger } = capture();
    await new ConsoleEmailTransport(logger, 'development').send(MESSAGE);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      event: 'email.console',
      to: '[REDACTED]',
      linkPath: '/login/verify?token=abc_DEF-123',
    });
    expect(lines[0]).not.toContain('jane');
    expect(lines[0]).not.toContain('app.example.test');
    expect(lines[0]).not.toContain('Thanks');
  });

  it('linkPathFrom drops the origin', () => {
    expect(linkPathFrom('go to http://localhost:3000/a/b?c=d now')).toBe('/a/b?c=d');
    expect(linkPathFrom('no link here')).toBeNull();
  });
});

describe('ResendEmailTransport', () => {
  const recorder = (responses: Array<Response | Error>) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: EmailFetch = async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return next;
    };
    return { calls, fetchImpl };
  };
  const ok = () => new Response(JSON.stringify({ id: 'em_123' }), { status: 200 });

  it('POSTs JSON to Resend with a bearer key and an idempotency key', async () => {
    const { calls, fetchImpl } = recorder([ok()]);
    await new ResendEmailTransport({
      apiKey: 're_key',
      from: 'Harbour <a@b.test>',
      fetchImpl,
    }).send(MESSAGE);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_key');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Harbour <a@b.test>',
      to: ['jane.doe@example.test'],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a 4xx, and the error carries no response body', async () => {
    const { calls, fetchImpl } = recorder([
      new Response('{"message":"invalid to jane.doe@example.test"}', { status: 422 }),
      ok(),
    ]);
    const err = await new ResendEmailTransport({ apiKey: 'k', from: 'a@b.test', fetchImpl })
      .send(MESSAGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).status).toBe(422);
    expect((err as Error).message).not.toContain('jane');
    expect(calls).toHaveLength(1);
  });

  it('retries once on 5xx or a network error, with the same idempotency key', async () => {
    const { calls, fetchImpl } = recorder([new Response('', { status: 503 }), ok()]);
    await new ResendEmailTransport({ apiKey: 'k', from: 'a@b.test', fetchImpl }).send(MESSAGE);
    expect(calls).toHaveLength(2);
    const key = (i: number) =>
      (calls[i]!.init.headers as Record<string, string>)['idempotency-key'];
    expect(key(0)).toBe(key(1));

    const flaky = recorder([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    await expect(
      new ResendEmailTransport({ apiKey: 'k', from: 'a@b.test', fetchImpl: flaky.fetchImpl }).send(
        MESSAGE,
      ),
    ).rejects.toThrow(/unreachable/);
    expect(flaky.calls).toHaveLength(2);
  });

  it('times out after timeoutMs', async () => {
    const hanging: EmailFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError')));
      });
    const started = Date.now();
    await expect(
      new ResendEmailTransport({
        apiKey: 'k',
        from: 'a@b.test',
        fetchImpl: hanging,
        timeoutMs: 20,
        maxAttempts: 1,
      }).send(MESSAGE),
    ).rejects.toThrow(/TimeoutError/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('createEmailTransport', () => {
  const pick = (env: Record<string, string>) =>
    createEmailTransport(loadEnv(env), capture().logger);

  it('defaults to the console transport outside production', () => {
    expect(pick({ NODE_ENV: 'development' }).transport?.name).toBe('console');
    expect(pick({ NODE_ENV: 'test' }).transport?.name).toBe('console');
  });

  it('fails closed in production without a real transport', () => {
    expect(pick({ NODE_ENV: 'production' })).toMatchObject({ transport: null });
    expect(pick({ NODE_ENV: 'production', EMAIL_TRANSPORT: 'console' })).toMatchObject({
      transport: null,
      problem: expect.stringMatching(/refused in production/) as string,
    });
    expect(pick({ NODE_ENV: 'production', EMAIL_TRANSPORT: 'resend' })).toMatchObject({
      transport: null,
    });
  });

  it('builds Resend when the key and sender are set', () => {
    expect(
      pick({
        NODE_ENV: 'production',
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_x',
        EMAIL_FROM: 'Harbour <sign-in@example.test>',
      }).transport?.name,
    ).toBe('resend');
  });
});
