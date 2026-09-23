import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HMRC_ACCEPT_V1,
  HMRC_EORI_LOOKUP_PATH,
  HMRC_VAT_CHECK_PATH,
  HmrcEoriChecker,
  HmrcVatChecker,
  toVrn,
  type FetchLike,
  type PostFetchLike,
} from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'hmrc', name), 'utf8');

type Route = { status: number; body: string } | Error;

interface Call {
  url: string;
  method: string | undefined;
  body: string | undefined;
  headers: Record<string, string> | undefined;
}

const fakeFetch = (routes: Record<string, Route | (() => Route)>) => {
  const calls: Call[] = [];
  const fetch: PostFetchLike & FetchLike = async (url, init) => {
    const i = init as Parameters<PostFetchLike>[1];
    calls.push({ url, method: i?.method, body: i?.body, headers: i?.headers });
    const entry = routes[url];
    const route = typeof entry === 'function' ? entry() : entry;
    if (route instanceof Error) throw route;
    const { status, body } = route ?? { status: 404, body: '{"code":"NOT_FOUND"}' };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    };
  };
  return { fetch, calls };
};

const BASE = 'https://hmrc.test';
const EORI_URL = `${BASE}${HMRC_EORI_LOOKUP_PATH}`;
const NOW = new Date('2026-09-23T12:00:00Z');
const noSleep = async () => {};

describe('HmrcEoriChecker', () => {
  it('POSTs { eoris: [...] } and reads valid=true', async () => {
    const { fetch, calls } = fakeFetch({
      [EORI_URL]: { status: 200, body: fixture('eori-lookup-valid.json') },
    });
    const checker = new HmrcEoriChecker({ baseUrl: BASE, fetch, now: () => NOW });
    expect(await checker.check('gb 1234 5678 9000')).toEqual({
      ok: true,
      valid: true,
      checkedAt: NOW,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: EORI_URL,
      method: 'POST',
      body: JSON.stringify({ eoris: ['GB123456789000'] }),
    });
    expect(calls[0]!.headers?.['content-type']).toBe('application/json');
  });

  it('reads valid=false for an unknown EORI', async () => {
    const { fetch } = fakeFetch({
      [EORI_URL]: { status: 200, body: fixture('eori-lookup-invalid.json') },
    });
    const checker = new HmrcEoriChecker({ baseUrl: BASE, fetch, now: () => NOW });
    expect(await checker.check('GB000000000000')).toEqual({
      ok: true,
      valid: false,
      checkedAt: NOW,
    });
  });

  it('a badly formed EORI is BAD_REQUEST without calling HMRC', async () => {
    const { fetch, calls } = fakeFetch({});
    const checker = new HmrcEoriChecker({ baseUrl: BASE, fetch });
    expect(await checker.check('GB12345')).toEqual({ ok: false, reason: 'BAD_REQUEST' });
    expect(await checker.check('FR123456789000')).toEqual({ ok: false, reason: 'BAD_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('400 → BAD_REQUEST (no retry); 5xx/network → UNAVAILABLE after retries; shape change → MALFORMED', async () => {
    const bad = fakeFetch({ [EORI_URL]: { status: 400, body: '{"code":"INVALID_EORI"}' } });
    const c1 = new HmrcEoriChecker({ baseUrl: BASE, fetch: bad.fetch, sleep: noSleep });
    expect(await c1.check('GB123456789000')).toEqual({ ok: false, reason: 'BAD_REQUEST' });
    expect(bad.calls).toHaveLength(1);

    const down = fakeFetch({ [EORI_URL]: { status: 502, body: 'bad gateway' } });
    const c2 = new HmrcEoriChecker({
      baseUrl: BASE,
      fetch: down.fetch,
      sleep: noSleep,
      retries: 2,
    });
    expect(await c2.check('GB123456789000')).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(down.calls).toHaveLength(3);

    const net = fakeFetch({ [EORI_URL]: new Error('ECONNREFUSED') });
    const c3 = new HmrcEoriChecker({ baseUrl: BASE, fetch: net.fetch, sleep: noSleep, retries: 0 });
    expect(await c3.check('GB123456789000')).toEqual({ ok: false, reason: 'UNAVAILABLE' });

    const shape = fakeFetch({
      [EORI_URL]: { status: 200, body: JSON.stringify({ eori: 'GB123456789000', valid: true }) },
    });
    const c4 = new HmrcEoriChecker({ baseUrl: BASE, fetch: shape.fetch });
    expect(await c4.check('GB123456789000')).toEqual({ ok: false, reason: 'MALFORMED' });

    // A response about a different EORI is not trusted.
    const other = fakeFetch({
      [EORI_URL]: { status: 200, body: fixture('eori-lookup-valid.json') },
    });
    const c5 = new HmrcEoriChecker({ baseUrl: BASE, fetch: other.fetch });
    expect(await c5.check('GB999999999999')).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('times out', async () => {
    const fetch: PostFetchLike = () => new Promise(() => {});
    const checker = new HmrcEoriChecker({ baseUrl: BASE, fetch, timeoutMs: 20, retries: 0 });
    expect(await checker.check('GB123456789000')).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });
});

describe('HmrcVatChecker', () => {
  const vrnUrl = (vrn: string) => `${BASE}${HMRC_VAT_CHECK_PATH}/${vrn}`;

  it('toVrn strips GB and whitespace', () => {
    expect(toVrn('GB123456782')).toBe('123456782');
    expect(toVrn('gb 123 4567 82')).toBe('123456782');
    expect(toVrn('123456782')).toBe('123456782');
    expect(toVrn('GB123456782001')).toBe('123456782001');
    expect(toVrn('GB12345')).toBeNull();
    expect(toVrn('FR123456782')).toBeNull();
  });

  it('200 with a matching target is valid; sends the versioned Accept header', async () => {
    const { fetch, calls } = fakeFetch({
      [vrnUrl('123456782')]: { status: 200, body: fixture('vat-check-found.json') },
    });
    const checker = new HmrcVatChecker({ baseUrl: BASE, fetch, now: () => NOW });
    expect(await checker.check('GB123456782')).toEqual({ ok: true, valid: true, checkedAt: NOW });
    expect(calls[0]!.headers?.accept).toBe(HMRC_ACCEPT_V1);
    expect(calls[0]!.headers?.accept).toBe('application/vnd.hmrc.1.0+json');
  });

  it('404 NOT_FOUND is a definite "not registered" (valid: false), not an error', async () => {
    const { fetch, calls } = fakeFetch({
      [vrnUrl('123456782')]: { status: 404, body: fixture('vat-check-not-found.json') },
    });
    const checker = new HmrcVatChecker({ baseUrl: BASE, fetch, now: () => NOW, sleep: noSleep });
    expect(await checker.check('GB123456782')).toEqual({ ok: true, valid: false, checkedAt: NOW });
    expect(calls).toHaveLength(1);
  });

  it('5xx → UNAVAILABLE after retries; 400 → BAD_REQUEST; a target for another VRN → MALFORMED', async () => {
    const down = fakeFetch({ [vrnUrl('123456782')]: { status: 500, body: 'oops' } });
    const c1 = new HmrcVatChecker({ baseUrl: BASE, fetch: down.fetch, sleep: noSleep, retries: 1 });
    expect(await c1.check('GB123456782')).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(down.calls).toHaveLength(2);

    const bad = fakeFetch({
      [vrnUrl('123456782')]: { status: 400, body: '{"code":"INVALID_REQUEST"}' },
    });
    const c2 = new HmrcVatChecker({ baseUrl: BASE, fetch: bad.fetch, sleep: noSleep });
    expect(await c2.check('GB123456782')).toEqual({ ok: false, reason: 'BAD_REQUEST' });

    const other = fakeFetch({
      [vrnUrl('987654321')]: { status: 200, body: fixture('vat-check-found.json') },
    });
    const c3 = new HmrcVatChecker({ baseUrl: BASE, fetch: other.fetch });
    expect(await c3.check('GB987654321')).toEqual({ ok: false, reason: 'MALFORMED' });

    const { fetch, calls } = fakeFetch({});
    expect(await new HmrcVatChecker({ baseUrl: BASE, fetch }).check('nope')).toEqual({
      ok: false,
      reason: 'BAD_REQUEST',
    });
    expect(calls).toHaveLength(0);
  });
});
