import { describe, expect, it, vi } from 'vitest';
import { AIS_STALE_MS, type AisVessel } from '../../lib/ais-client';
import { createLogger } from '../logger.server';
import {
  AIS_REFUSED_MESSAGE,
  AisRelay,
  MemoryAisCache,
  collectAisReports,
  redisAisCache,
  type AisSocketLike,
  type CollectResult,
} from './ais-relay.server';

const log = createLogger({ level: 'error' });

/** A scripted aisstream socket: records what was sent, replays messages on demand. */
class FakeSocket implements AisSocketLike {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {};
  addEventListener(type: string, listener: (ev: { data: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  emit(type: string, data: unknown = null) {
    for (const l of this.listeners[type] ?? []) l({ data });
  }
}

const report = (mmsi: number, lat = 50.5, lon = -1) =>
  JSON.stringify({
    MessageType: 'PositionReport',
    Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lon, Sog: 10, Cog: 90 } },
  });

describe('collectAisReports', () => {
  it('subscribes on open, gathers reports for the window, then closes', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const done = collectAisReports('secret-key', {
        durationMs: 1000,
        connect: () => socket,
        now: () => 5000,
      });
      socket.emit('open');
      expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ APIKey: 'secret-key' });
      socket.emit('message', report(1));
      socket.emit('message', report(2));
      socket.emit('message', report(1, 51, -2)); // newer report for the same vessel wins
      socket.emit('message', '{"MessageType":"ShipStaticData"}');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await done;
      expect(socket.closed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.vessels.map((v) => [v.mmsi, v.lat])).toEqual([
        ['1', 51],
        ['2', 50.5],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the provider refusing the key and a stream that closes early', async () => {
    const refused = new FakeSocket();
    const p1 = collectAisReports('bad', { durationMs: 60_000, connect: () => refused });
    refused.emit('open');
    refused.emit('message', '{"error":"Api Key Is Not Valid"}');
    expect(await p1).toEqual({ vessels: [], error: 'Api Key Is Not Valid' });
    expect(refused.closed).toBe(true);

    const dropped = new FakeSocket();
    const p2 = collectAisReports('k', { durationMs: 60_000, connect: () => dropped });
    dropped.emit('open');
    dropped.emit('close');
    expect((await p2).error).toBe(AIS_REFUSED_MESSAGE);

    const unreachable = new FakeSocket();
    const p4 = collectAisReports('k', { durationMs: 60_000, connect: () => unreachable });
    unreachable.emit('error');
    expect((await p4).error).toContain('before the subscription');

    const p3 = collectAisReports('k', {
      durationMs: 60_000,
      connect: () => {
        throw new Error('no WebSocket');
      },
    });
    expect((await p3).error).toBe('could not open the AIS stream: no WebSocket');
  });
});

const vessel = (mmsi: string, seenAt: number): AisVessel => ({
  mmsi,
  lat: 50,
  lon: -1,
  speedKnots: 1,
  courseDeg: 2,
  seenAt,
});

describe('AisRelay', () => {
  const relayWith = (
    results: CollectResult[],
    clock: { t: number },
    cache = new MemoryAisCache(() => clock.t),
  ) => {
    const collect = vi.fn(async () => results.shift() ?? { vessels: [], error: null });
    const relay = new AisRelay({
      apiKey: 'k',
      cache,
      log,
      now: () => clock.t,
      collect,
      freshMs: 12_000,
    });
    return { relay, collect, cache };
  };

  it('collects once, serves the snapshot while fresh, then merges a new collection', async () => {
    const clock = { t: 100_000 };
    const { relay, collect } = relayWith(
      [
        { vessels: [vessel('1', 100_000)], error: null },
        { vessels: [vessel('2', 120_000)], error: null },
      ],
      clock,
    );
    const first = await relay.snapshot();
    expect(first.status).toBe('live');
    expect(first.v.map((t) => t[0])).toEqual(['1']);
    clock.t += 5_000;
    const again = await relay.snapshot();
    expect(again.collectedAt).toBe(100_000);
    expect(collect).toHaveBeenCalledTimes(1);

    clock.t = 120_000;
    const merged = await relay.snapshot();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(merged.v.map((t) => t[0]).sort()).toEqual(['1', '2']);
    // `since` trims to vessels heard after the client's last snapshot.
    const delta = await relay.snapshot(100_000);
    expect(delta.v.map((t) => t[0])).toEqual(['2']);

    // Silent vessels fall out after the stale window.
    clock.t = 100_000 + AIS_STALE_MS + 1;
    const pruned = await relay.snapshot();
    expect(pruned.v.map((t) => t[0])).toEqual(['2']);
  });

  it('reports the provider refusal as an error status, and warms up behind another collector', async () => {
    const clock = { t: 1_000 };
    const { relay } = relayWith([{ vessels: [], error: 'Api Key Is Not Valid' }], clock);
    expect(await relay.snapshot()).toMatchObject({
      status: 'error',
      error: 'Api Key Is Not Valid',
      v: [],
    });

    // Another instance holds the lock and nothing is cached yet: warming, no collection.
    const cache = new MemoryAisCache(() => clock.t);
    await cache.setNx('ais:lock', '1', 10_000);
    const other = relayWith([{ vessels: [vessel('9', 1_000)], error: null }], clock, cache);
    expect(await other.relay.snapshot()).toEqual({
      status: 'warming',
      error: null,
      collectedAt: 0,
      v: [],
    });
    expect(other.collect).not.toHaveBeenCalled();
  });

  it('shares one collection between concurrent callers in a process', async () => {
    const clock = { t: 1_000 };
    const { relay, collect } = relayWith([{ vessels: [vessel('1', 1_000)], error: null }], clock);
    const [a, b] = await Promise.all([relay.snapshot(), relay.snapshot()]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe('redisAisCache', () => {
  it('maps onto ioredis SET PX / SET PX NX', async () => {
    const calls: unknown[][] = [];
    const redis = {
      get: async () => 'v',
      set: async (...args: unknown[]) => {
        calls.push(args);
        return args.includes('NX') ? null : 'OK';
      },
      del: async () => 1,
    };
    const cache = redisAisCache(redis);
    await cache.set('a', '1', 500);
    expect(await cache.setNx('b', '2', 600)).toBe(false);
    expect(calls).toEqual([
      ['a', '1', 'PX', 500],
      ['b', '2', 'PX', 600, 'NX'],
    ]);
    expect(await cache.get('a')).toBe('v');
  });
});
