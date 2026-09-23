/**
 * A tariff client backed by the recorded fixtures in packages/adapters/fixtures/tariff (M3
 * tests). Commodities 9503004100 / 8712003000 / 6403999600 and heading 9503 resolve; 1701131000
 * simulates the service being down (the fetch throws); anything else is a 404.
 */
import { readFileSync } from 'node:fs';
import { InMemoryTariffCache, UkTradeTariffClient, type FetchLike } from '@harbour/adapters';
import { adaptersFile } from '../services/paths.server';

export const FIXTURE_NOW = new Date('2026-09-23T10:00:00Z');
export const DOWN_COMMODITY = '1701131000';

const notFound = () => ({ ok: false, status: 404, text: async () => '{}', json: async () => ({}) });

export const fixtureFetch: FetchLike = async (url) => {
  const m = /\/(commodities|headings)\/(\d+)$/.exec(url);
  if (!m) return notFound();
  if (m[2] === DOWN_COMMODITY) throw new Error('ECONNREFUSED 10.0.0.1:443');
  const file =
    m[1] === 'headings'
      ? adaptersFile('fixtures', 'tariff', `heading-${m[2]}.json`)
      : adaptersFile('fixtures', 'tariff', `commodity-${m[2]}.json`);
  if (!file) return notFound();
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return notFound();
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
};

export const fixtureTariff = (now: () => Date = () => FIXTURE_NOW) =>
  new UkTradeTariffClient({
    fetch: fixtureFetch,
    cache: new InMemoryTariffCache(),
    now,
    sleep: async () => {},
  });
