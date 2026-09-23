import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  createLogger,
  redact,
  redactString,
  requestIdFor,
  requestLogger,
} from './logger.server';

describe('redact', () => {
  it('masks sensitive keys wholesale, case-insensitively', () => {
    const out = redact({
      email: 'jane@example.com',
      EORI: 'GB123456789000',
      vat: 'GB123456782',
      vatNumber: 'x',
      eoriNumber: 'y',
      originalName: 'passport.pdf',
      nested: { Email: 'z@z.io', keep: 'fine' },
      list: [{ email: 'a@b.c' }],
    }) as Record<string, unknown>;
    expect(out.email).toBe(REDACTED);
    expect(out.EORI).toBe(REDACTED);
    expect(out.vat).toBe(REDACTED);
    expect(out.vatNumber).toBe(REDACTED);
    expect(out.eoriNumber).toBe(REDACTED);
    expect(out.originalName).toBe(REDACTED);
    expect(out.nested).toEqual({ Email: REDACTED, keep: 'fine' });
    expect(out.list).toEqual([{ email: REDACTED }]);
  });
  it('masks deferment account numbers and API keys by key name', () => {
    const out = redact({
      dan: '1234567',
      danNumber: '1234567',
      apiKey: 'k',
      TRADE_TARIFF_API_KEY: 'k',
      dutyPayment: 'OWN_DAN',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      dan: REDACTED,
      danNumber: REDACTED,
      apiKey: REDACTED,
      TRADE_TARIFF_API_KEY: REDACTED,
      dutyPayment: 'OWN_DAN',
    });
  });
  it('scrubs emails, EORI and VAT numbers inside free-text strings', () => {
    expect(redactString('contact jane.doe+x@example.co.uk now')).toBe('contact [EMAIL] now');
    expect(redactString('eori GB123456789000 vat GB123456782 branch GB123456782001')).toBe(
      // A 12-digit GB VAT (branch trader) has the same shape as an EORI; either mask is fine.
      'eori GB[EORI] vat GB[VAT] branch GB[EORI]',
    );
    expect(redactString('XI123456789000')).toBe('XI[EORI]');
    expect(redactString('order GB1234 is fine')).toBe('order GB1234 is fine');
  });
  it('handles Errors, Dates, Maps, cycles and depth', () => {
    const err = new Error('failed for jane@example.com');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redact({
      err,
      when: new Date('2026-09-23T00:00:00Z'),
      m: new Map([['email', 'x@y.z']]),
      cyclic,
    }) as Record<string, unknown>;
    expect((out.err as { message: string }).message).toBe('failed for [EMAIL]');
    expect(out.when).toBe('2026-09-23T00:00:00.000Z');
    expect(out.m).toEqual({ email: REDACTED });
    expect((out.cyclic as { self: unknown }).self).toBe('[CIRCULAR]');
    let deep: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 12; i += 1) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
  });
});

describe('createLogger', () => {
  const collect = () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: 'info',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
      now: () => new Date('2026-09-23T12:00:00Z'),
      base: { app: 'test' },
    });
    return { lines, logger };
  };
  it('emits one JSON object per line with ts/level/event and redacted fields', () => {
    const { lines, logger } = collect();
    logger.info('signup.completed', { email: 'a@b.co', created: true });
    expect(lines).toEqual([
      {
        ts: '2026-09-23T12:00:00.000Z',
        level: 'info',
        event: 'signup.completed',
        app: 'test',
        email: REDACTED,
        created: true,
      },
    ]);
  });
  it('filters below the configured level and carries child fields', () => {
    const { lines, logger } = collect();
    logger.debug('hidden');
    const child = logger.child({ requestId: 'req-1' });
    child.warn('thing', { n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'thing',
      requestId: 'req-1',
      n: 1,
      app: 'test',
    });
  });
  it('requestLogger includes request id, method and path but not the query string', () => {
    const { lines, logger } = collect();
    const req = new Request('https://h.test/calculator?email=x@y.z', {
      headers: { 'x-request-id': 'abc-123' },
    });
    requestLogger(logger, req).info('hit');
    expect(lines[0]).toMatchObject({ requestId: 'abc-123', method: 'GET', path: '/calculator' });
    expect(JSON.stringify(lines[0])).not.toContain('x@y.z');
  });
  it('requestIdFor mints a UUID when the header is missing or unsafe', () => {
    expect(requestIdFor(new Request('https://h.test/'))).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      requestIdFor(
        new Request('https://h.test/', { headers: { 'x-request-id': 'bad id <script>' } }),
      ),
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      requestIdFor(new Request('https://h.test/', { headers: { 'x-request-id': 'ok_id-1' } })),
    ).toBe('ok_id-1');
  });
});
