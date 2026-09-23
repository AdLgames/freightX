import { InMemoryTariffCache, type FetchLike } from '@harbour/adapters';
import { describe, expect, it } from 'vitest';
import { loadEnv, pricingConfigFromEnv, tariffApiKeyFromEnv } from './env.server';
import { createTariffClient } from './tariff.server';

describe('loadEnv', () => {
  it('runs with nothing set: no API key, no fee defaults, no inland VAT adjustment', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(tariffApiKeyFromEnv(env)).toBeNull();
    expect(pricingConfigFromEnv(env)).toEqual({
      brokerDefermentDefaults: { feePct: null, minimumGbp: null },
      inlandVatAdjustmentGbp: {},
    });
  });

  it('requires the Trade Tariff API key and header name together', () => {
    expect(() => loadEnv({ TRADE_TARIFF_API_KEY: 'k' })).toThrow(/both .* or neither/);
    expect(() => loadEnv({ TRADE_TARIFF_API_KEY_HEADER: 'X-Api-Key' })).toThrow(
      /both .* or neither/,
    );
    expect(() =>
      loadEnv({ TRADE_TARIFF_API_KEY: 'k', TRADE_TARIFF_API_KEY_HEADER: 'bad header:' }),
    ).toThrow();
    const env = loadEnv({
      TRADE_TARIFF_API_KEY: 'k-123',
      TRADE_TARIFF_API_KEY_HEADER: 'X-Api-Key',
    });
    expect(tariffApiKeyFromEnv(env)).toEqual({ header: 'X-Api-Key', key: 'k-123' });
  });

  it('parses fee defaults and per-mode inland VAT adjustments as decimal strings', () => {
    const env = loadEnv({
      BROKER_DEFERMENT_FEE_PCT: '2.5',
      BROKER_DEFERMENT_MIN_GBP: '25',
      INLAND_VAT_ADJUSTMENT_LCL_GBP: '170',
      INLAND_VAT_ADJUSTMENT_AIR_GBP: '',
    });
    expect(pricingConfigFromEnv(env)).toEqual({
      brokerDefermentDefaults: { feePct: '2.5', minimumGbp: '25' },
      inlandVatAdjustmentGbp: { SEA_LCL: '170' },
    });
    for (const bad of [
      { BROKER_DEFERMENT_FEE_PCT: '-1' },
      { BROKER_DEFERMENT_FEE_PCT: '101' },
      { BROKER_DEFERMENT_MIN_GBP: 'twenty' },
      { INLAND_VAT_ADJUSTMENT_FCL_GBP: '550.001' },
    ]) {
      expect(() => loadEnv(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('createTariffClient', () => {
  const recordingFetch = (): { fetch: FetchLike; seen: Array<Record<string, string>> } => {
    const seen: Array<Record<string, string>> = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push({ ...(init?.headers ?? {}) });
      return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
    };
    return { fetch, seen };
  };

  it('sends the API key in the configured header, and never in an error message', async () => {
    const { fetch, seen } = recordingFetch();
    const client = createTariffClient({
      cache: new InMemoryTariffCache(),
      apiKey: { header: 'X-Api-Key', key: 'secret-key-value' },
      fetch,
    });
    const res = await client.lookupCommodity('9503004100');
    expect(res.ok).toBe(false);
    expect(seen[0]).toMatchObject({ 'X-Api-Key': 'secret-key-value', accept: 'application/json' });
    expect(JSON.stringify(res)).not.toContain('secret-key-value');
  });

  it('sends no extra header without a key', async () => {
    const { fetch, seen } = recordingFetch();
    await createTariffClient({ cache: new InMemoryTariffCache(), fetch }).lookupCommodity(
      '9503004100',
    );
    expect(seen[0]).toEqual({ accept: 'application/json' });
  });
});
