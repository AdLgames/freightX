import {
  InMemoryTariffCache,
  type NormalisedCommodity,
  type TariffLookup,
} from '@harbour/adapters';
import { describe, expect, it, vi } from 'vitest';
import { refreshingCacheView, runTariffRefresh } from '../src/jobs/tariff-refresh.js';
import { mapWithLimit } from '../src/limiter.js';
import { CollectingAlertSink, StaticHsCodeSource } from '../src/ports.js';

const commodity = (code: string): NormalisedCommodity => ({
  code,
  description: 'x',
  declarable: true,
  measures: [],
});

const codes = Array.from({ length: 20 }, (_, i) => `950300${String(i).padStart(4, '0')}`);

/** Fake client: outcome by code suffix; tracks max in-flight lookups. */
const fakeClient = (outcome: (code: string) => TariffLookup) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const seen: string[] = [];
  return {
    get maxInFlight() {
      return maxInFlight;
    },
    seen,
    lookupCommodity: async (code: string): Promise<TariffLookup> => {
      seen.push(code);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return outcome(code);
    },
  };
};

const ok = (code: string): TariffLookup => ({
  ok: true,
  commodity: commodity(code),
  fetchedAt: new Date(),
  fromCache: false,
});
const unavailable = (): TariffLookup => ({ ok: false, reason: 'UNAVAILABLE', message: 'timeout' });
const notFound = (): TariffLookup => ({ ok: false, reason: 'NOT_FOUND', message: 'nope' });

describe('runTariffRefresh', () => {
  it('warms every code with at most 5 in flight and summarises outcomes', async () => {
    const client = fakeClient((code) => (code.endsWith('9') ? notFound() : ok(code)));
    const alerts = new CollectingAlertSink();
    const summary = await runTariffRefresh({
      client,
      codes: new StaticHsCodeSource([...codes, codes[0]!]), // duplicate is de-duplicated
      now: () => new Date('2026-09-23T02:00:00Z'),
      alerts,
      gapMs: 0,
    });
    expect(client.seen).toHaveLength(20);
    expect(client.maxInFlight).toBeLessThanOrEqual(5);
    expect(client.maxInFlight).toBeGreaterThan(1);
    expect(summary).toMatchObject({
      codeCount: 20,
      ok: 18,
      notFound: 2,
      unavailable: 0,
      degraded: false,
    });
    expect(alerts.alerts).toEqual([]);
  });

  it('raises TARIFF_REFRESH_DEGRADED when more than 20% of codes are unavailable', async () => {
    const client = fakeClient((code) => (Number(code.slice(-1)) < 3 ? unavailable() : ok(code)));
    const alerts = new CollectingAlertSink();
    const summary = await runTariffRefresh({
      client,
      codes,
      now: () => new Date(),
      alerts,
      gapMs: 0,
    });
    expect(summary).toMatchObject({ codeCount: 20, unavailable: 6, degraded: true });
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({ level: 'warning', code: 'TARIFF_REFRESH_DEGRADED' });
  });

  it('exactly 20% unavailable is not degraded, and a thrown lookup counts as unavailable', async () => {
    const client = {
      lookupCommodity: async (code: string): Promise<TariffLookup> => {
        if (code.endsWith('0')) throw new Error('cache store down');
        if (code.endsWith('1')) return unavailable();
        return ok(code);
      },
    };
    const alerts = new CollectingAlertSink();
    const summary = await runTariffRefresh({
      client,
      codes,
      now: () => new Date(),
      alerts,
      gapMs: 0,
    });
    expect(summary).toMatchObject({ unavailable: 4, degraded: false });
    expect(alerts.alerts).toEqual([]);
  });

  it('handles an empty code list without dividing by zero', async () => {
    const alerts = new CollectingAlertSink();
    const summary = await runTariffRefresh({
      client: fakeClient(ok),
      codes: [],
      now: () => new Date(),
      alerts,
    });
    expect(summary).toMatchObject({ codeCount: 0, degraded: false });
  });
});

describe('mapWithLimit', () => {
  it('keeps consecutive starts at least gapMs apart (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const pending = mapWithLimit(
        Array.from({ length: 12 }, (_, i) => i),
        async (i) => {
          starts.push(Date.now());
          return i;
        },
        { concurrency: 5, gapMs: 100 },
      );
      await vi.runAllTimersAsync();
      await pending;
      expect(starts).toHaveLength(12);
      for (let i = 1; i < starts.length; i += 1)
        expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves result order', async () => {
    const out = await mapWithLimit(
      [3, 1, 2],
      async (n) => {
        await new Promise((r) => setTimeout(r, n));
        return n * 10;
      },
      { concurrency: 3, gapMs: 0 },
    );
    expect(out).toEqual([30, 10, 20]);
  });
});

describe('refreshingCacheView', () => {
  it('hides entries that are older than an hour so the refresh refetches them', async () => {
    const store = new InMemoryTariffCache();
    const now = new Date('2026-09-23T02:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const fresh = new Date(now.getTime() - 10 * 60 * 1000);
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await store.set('1', commodity('1'), fresh, new Date(fresh.getTime() + dayMs));
    await store.set('2', commodity('2'), old, new Date(old.getTime() + dayMs));
    const view = refreshingCacheView(store, { now: () => now });
    expect(await view.get('1')).not.toBeNull();
    expect(await view.get('2')).toBeNull();
    expect(await store.get('2')).not.toBeNull(); // the real store is untouched
    await view.set('3', commodity('3'), now, new Date(now.getTime() + dayMs));
    expect(await store.get('3')).not.toBeNull(); // writes go through
  });
});
