import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '@harbour/adapters';

/** Fixture from packages/adapters/fixtures/fx (the adapters own the provider formats). */
export const fxFixture = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'adapters', 'fixtures', 'fx', name),
    'utf8',
  );

export type Route = { status: number; body: string } | Error;

/** Deterministic fetch: exact URL → response, unmatched URLs 404. Records every call. */
export const fakeFetch = (routes: Record<string, Route | (() => Route)>) => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const entry = routes[url];
    const route = typeof entry === 'function' ? entry() : entry;
    if (route instanceof Error) throw route;
    const { status, body } = route ?? { status: 404, body: 'not found' };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    };
  };
  return { fetch, calls };
};

export const noSleep = async (): Promise<void> => {};
