import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_SEARCH_MAX_ITEMS,
  CompaniesHouseClient,
  FINANCE_ELIGIBLE_COMPANY_TYPES,
  basicAuthHeader,
  isEligibleForFinance,
  type FetchLike,
} from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'companies-house', name), 'utf8');

type Route = { status: number; body: string } | Error;

const fakeFetch = (routes: Record<string, Route | (() => Route)>) => {
  const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const entry = routes[url];
    const route = typeof entry === 'function' ? entry() : entry;
    if (route instanceof Error) throw route;
    const { status, body } = route ?? { status: 404, body: '{"error":"not found"}' };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    };
  };
  return { fetch, calls };
};

const BASE = 'https://ch.test';
const SEARCH = `${BASE}/search/companies?q=Hydro+Imports&items_per_page=5`;
const noSleep = async () => {};

describe('CompaniesHouseClient.searchCompanies', () => {
  it('maps company_number, title, company_status and company_type with Basic auth (key as username)', async () => {
    const { fetch, calls } = fakeFetch({
      [SEARCH]: { status: 200, body: fixture('search-hydro-imports.json') },
    });
    const client = new CompaniesHouseClient({ apiKey: 'test-key', baseUrl: BASE, fetch });
    const result = await client.searchCompanies('  Hydro Imports ');
    expect(result).toEqual({
      ok: true,
      matches: [
        { companyNumber: '12345678', name: 'HYDRO IMPORTS LTD', status: 'active', type: 'ltd' },
        {
          companyNumber: 'OC654321',
          name: 'HYDRO IMPORTS PARTNERS LLP',
          status: 'active',
          type: 'llp',
        },
        {
          companyNumber: '09876543',
          name: 'HYDRO IMPORTS (OLD) LIMITED',
          status: 'dissolved',
          type: 'ltd',
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers?.authorization).toBe(basicAuthHeader('test-key'));
    expect(basicAuthHeader('test-key')).toBe(
      `Basic ${Buffer.from('test-key:').toString('base64')}`,
    );
    expect(calls[0]!.url).toContain(`items_per_page=${COMPANY_SEARCH_MAX_ITEMS}`);
  });

  it('an empty query does not call the API', async () => {
    const { fetch, calls } = fakeFetch({});
    const client = new CompaniesHouseClient({ apiKey: 'k', baseUrl: BASE, fetch });
    expect(await client.searchCompanies('   ')).toEqual({ ok: true, matches: [] });
    expect(calls).toHaveLength(0);
  });

  it('401/403 → UNAUTHORISED without retrying; 5xx retries then UNAVAILABLE', async () => {
    const unauth = fakeFetch({ [SEARCH]: { status: 401, body: '{}' } });
    const c1 = new CompaniesHouseClient({
      apiKey: 'k',
      baseUrl: BASE,
      fetch: unauth.fetch,
      sleep: noSleep,
    });
    expect(await c1.searchCompanies('Hydro Imports')).toEqual({
      ok: false,
      reason: 'UNAUTHORISED',
    });
    expect(unauth.calls).toHaveLength(1);

    const down = fakeFetch({ [SEARCH]: { status: 503, body: 'down' } });
    const c2 = new CompaniesHouseClient({
      apiKey: 'k',
      baseUrl: BASE,
      fetch: down.fetch,
      sleep: noSleep,
      retries: 2,
    });
    expect(await c2.searchCompanies('Hydro Imports')).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(down.calls).toHaveLength(3);

    const network = fakeFetch({ [SEARCH]: new Error('ECONNRESET') });
    const c3 = new CompaniesHouseClient({
      apiKey: 'k',
      baseUrl: BASE,
      fetch: network.fetch,
      sleep: noSleep,
      retries: 1,
    });
    expect(await c3.searchCompanies('Hydro Imports')).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(network.calls).toHaveLength(2);
  });

  it('a changed response shape is MALFORMED, never a crash', async () => {
    const { fetch } = fakeFetch({
      [SEARCH]: { status: 200, body: JSON.stringify({ results: [{ number: '1' }] }) },
    });
    const client = new CompaniesHouseClient({ apiKey: 'k', baseUrl: BASE, fetch });
    expect(await client.searchCompanies('Hydro Imports')).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
    const bad = fakeFetch({
      [SEARCH]: {
        status: 200,
        body: JSON.stringify({ items: [{ company_number: 'x', title: 'y' }] }),
      },
    });
    expect(
      await new CompaniesHouseClient({
        apiKey: 'k',
        baseUrl: BASE,
        fetch: bad.fetch,
      }).searchCompanies('Hydro Imports'),
    ).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('times out slow responses', async () => {
    const fetch: FetchLike = () => new Promise(() => {});
    const client = new CompaniesHouseClient({
      apiKey: 'k',
      baseUrl: BASE,
      fetch,
      timeoutMs: 20,
      retries: 0,
    });
    expect(await client.searchCompanies('Hydro Imports')).toEqual({
      ok: false,
      reason: 'UNAVAILABLE',
    });
  });

  it('refuses to be built without a key', () => {
    expect(() => new CompaniesHouseClient({ apiKey: '' })).toThrow(/API key/);
  });
});

describe('CompaniesHouseClient.getCompany', () => {
  it('reads the profile (name, number, status, type) and normalises the number', async () => {
    const { fetch, calls } = fakeFetch({
      [`${BASE}/company/12345678`]: { status: 200, body: fixture('company-12345678.json') },
    });
    const client = new CompaniesHouseClient({ apiKey: 'k', baseUrl: BASE, fetch });
    expect(await client.getCompany(' 12345678 ')).toEqual({
      ok: true,
      company: {
        companyNumber: '12345678',
        name: 'HYDRO IMPORTS LTD',
        status: 'active',
        type: 'ltd',
      },
    });
    expect(calls[0]!.url).toBe(`${BASE}/company/12345678`);
  });

  it('404 → NOT_FOUND; a malformed number never calls the API', async () => {
    const { fetch, calls } = fakeFetch({});
    const client = new CompaniesHouseClient({ apiKey: 'k', baseUrl: BASE, fetch, sleep: noSleep });
    expect(await client.getCompany('00000000')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(calls).toHaveLength(1);
    expect(await client.getCompany('1234')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await client.getCompany('../secret')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });
});

describe('isEligibleForFinance (ADR-0015 gate)', () => {
  it('only active ltd / plc / llp are eligible', () => {
    expect([...FINANCE_ELIGIBLE_COMPANY_TYPES]).toEqual(['ltd', 'plc', 'llp']);
    expect(isEligibleForFinance({ status: 'active', type: 'ltd' })).toBe(true);
    expect(isEligibleForFinance({ status: 'Active', type: 'PLC' })).toBe(true);
    expect(isEligibleForFinance({ status: 'active', type: 'llp' })).toBe(true);
    expect(isEligibleForFinance({ status: 'dissolved', type: 'ltd' })).toBe(false);
    expect(isEligibleForFinance({ status: 'liquidation', type: 'ltd' })).toBe(false);
    expect(isEligibleForFinance({ status: 'active', type: 'private-unlimited' })).toBe(false);
    expect(
      isEligibleForFinance({ status: 'active', type: 'charitable-incorporated-organisation' }),
    ).toBe(false);
    // Sole traders and partnerships have no record at all; unknown codes fail closed.
    expect(isEligibleForFinance({ status: null, type: null })).toBe(false);
    expect(isEligibleForFinance({ status: 'active', type: null })).toBe(false);
    expect(isEligibleForFinance({ status: undefined, type: 'ltd' })).toBe(false);
  });
});
