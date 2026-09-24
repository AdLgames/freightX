import { describe, expect, it, vi } from 'vitest';
import { AIS_STALE_MS, type AisVessel } from '../../lib/ais-client';
import { createLogger } from '../logger.server';
import {
  AIS_REFUSED_MESSAGE,
  AIS_UNCONFIRMED_MESSAGE,
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
  binaryType?: string;
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
      expect(socket.binaryType).toBe('arraybuffer');
      expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({ APIKey: 'secret-key' });
      socket.emit(
        'message',
        '{"MessageType":"SubscriptionConfirmation","Message":{"CompressionEnabled":true}}',
      );
      // aisstream sends binary frames (UTF-8 JSON inside); text frames are accepted too.
      socket.emit('message', new TextEncoder().encode(report(1)).buffer);
      socket.emit('message', new TextEncoder().encode(report(2)));
      socket.emit('message', report(1, 51, -2)); // newer report for the same vessel wins
      socket.emit('message', '{"MessageType":"ShipStaticData"}');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await done;
      expect(socket.closed).toBe(true);
      expect(result.error).toBeNull();
      expect(result.confirmed).toBe(true);
      expect(result.compression).toBe(true);
      expect(result.vessels.map((v) => [v.mmsi, v.lat])).toEqual([
        ['1', 51],
        ['2', 50.5],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands over batches on the flush interval and the remainder at the end', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const flushes: string[][] = [];
      const done = collectAisReports('k', {
        durationMs: 2_500,
        flushMs: 1_000,
        connect: () => socket,
        onFlush: (b) => flushes.push(b.map((v) => v.mmsi)),
      });
      socket.emit('open');
      socket.emit('message', report(1));
      await vi.advanceTimersByTimeAsync(1_000);
      socket.emit('message', report(2));
      socket.emit('message', report(1));
      await vi.advanceTimersByTimeAsync(1_000);
      socket.emit('message', report(3));
      await vi.advanceTimersByTimeAsync(500);
      await done;
      expect(flushes).toEqual([['1'], ['2', '1'], ['3']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a subscription that was never confirmed', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const done = collectAisReports('k', { durationMs: 1000, connect: () => socket });
      socket.emit('open');
      await vi.advanceTimersByTimeAsync(1000);
      expect((await done).error).toBe(AIS_UNCONFIRMED_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the provider refusing the key and a stream that closes early', async () => {
    const refused = new FakeSocket();
    const p1 = collectAisReports('bad', { durationMs: 60_000, connect: () => refused });
    refused.emit('open');
    refused.emit('message', '{"error":"Api Key Is Not Valid"}');
    expect(await p1).toMatchObject({ vessels: [], error: 'Api Key Is Not Valid' });
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
  const ok = (...vs: AisVessel[]): CollectResult => ({
    vessels: vs,
    error: null,
    confirmed: true,
    compression: null,
  });
  const relayWith = (
    results: CollectResult[],
    clock: { t: number },
    cache = new MemoryAisCache(() => clock.t),
  ) => {
    const flushes: AisVessel[][] = [];
    const collect = vi.fn(async (_key: string, onFlush: (b: AisVessel[]) => void) => {
      const r = results.shift() ?? ok();
      // Flush the first vessel early, like the live collector does every few seconds.
      if (r.vessels[0]) {
        onFlush([r.vessels[0]]);
        flushes.push([r.vessels[0]]);
      }
      await Promise.resolve();
      return r;
    });
    const background = vi.fn();
    const relay = new AisRelay({
      apiKey: 'k',
      cache,
      log,
      now: () => clock.t,
      collect,
      freshMs: 12_000,
      background,
    });
    return { relay, collect, cache, background, flushes };
  };

  it('answers from the cache and collects in the background, merging as it goes', async () => {
    const clock = { t: 100_000 };
    const { relay, collect, background } = relayWith(
      [ok(vessel('1', 100_000), vessel('3', 100_000)), ok(vessel('2', 120_000))],
      clock,
    );
    // Nothing cached yet: warming, and a collection has been kicked off (handed to waitUntil).
    expect(await relay.snapshot()).toEqual({
      status: 'warming',
      error: null,
      collectedAt: 0,
      v: [],
    });
    expect(background).toHaveBeenCalledTimes(1);
    await relay.idle();
    expect(collect).toHaveBeenCalledTimes(1);
    const first = await relay.snapshot();
    expect(first.status).toBe('live');
    expect(first.v.map((t) => t[0]).sort()).toEqual(['1', '3']);
    // Fresh: served as is, no new collection.
    clock.t += 5_000;
    expect((await relay.snapshot()).collectedAt).toBe(100_000);
    expect(collect).toHaveBeenCalledTimes(1);
    // Stale: the old picture is returned immediately and a new collection starts behind it.
    clock.t = 120_000;
    const stale = await relay.snapshot();
    expect(stale.collectedAt).toBe(100_000);
    await relay.idle();
    expect(collect).toHaveBeenCalledTimes(2);
    const merged = await relay.snapshot();
    expect(merged.collectedAt).toBe(120_000);
    expect(merged.v.map((t) => t[0]).sort()).toEqual(['1', '2', '3']);
    // `since` trims to vessels heard after the client's last snapshot.
    expect((await relay.snapshot(100_000)).v.map((t) => t[0])).toEqual(['2']);
    // Silent vessels fall out after the stale window.
    clock.t = 100_000 + AIS_STALE_MS + 1;
    await relay.snapshot();
    await relay.idle();
    expect((await relay.snapshot()).v.map((t) => t[0])).toEqual(['2']);
  });

  it('writes each flush to the cache before the collection ends', async () => {
    const clock = { t: 1_000 };
    const cache = new MemoryAisCache(() => clock.t);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const collect = vi.fn(async (_key: string, onFlush: (b: AisVessel[]) => void) => {
      onFlush([vessel('7', 1_000)]);
      await gate;
      return ok(vessel('8', 1_000));
    });
    const relay = new AisRelay({ apiKey: 'k', cache, log, now: () => clock.t, collect });
    await relay.snapshot();
    await Promise.resolve();
    await Promise.resolve();
    const midway = await relay.snapshot();
    expect(midway.status).toBe('live');
    expect(midway.v.map((t) => t[0])).toEqual(['7']);
    release();
    await relay.idle();
    expect((await relay.snapshot()).v.map((t) => t[0]).sort()).toEqual(['7', '8']);
  });

  it('reports the provider refusal as an error status, and stays quiet behind another collector', async () => {
    const clock = { t: 1_000 };
    const { relay } = relayWith(
      [{ vessels: [], error: 'Api Key Is Not Valid', confirmed: false, compression: null }],
      clock,
    );
    await relay.snapshot();
    await relay.idle();
    expect(await relay.snapshot()).toMatchObject({
      status: 'error',
      error: 'Api Key Is Not Valid',
      v: [],
    });

    // Another instance holds the lock and nothing is cached yet: warming, no collection.
    const cache = new MemoryAisCache(() => clock.t);
    await cache.setNx('ais:lock', '1', 10_000);
    const other = relayWith([ok(vessel('9', 1_000))], clock, cache);
    expect(await other.relay.snapshot()).toEqual({
      status: 'warming',
      error: null,
      collectedAt: 0,
      v: [],
    });
    await other.relay.idle();
    expect(other.collect).not.toHaveBeenCalled();
  });

  it('runs one collection per process however many callers arrive', async () => {
    const clock = { t: 1_000 };
    const { relay, collect } = relayWith([ok(vessel('1', 1_000))], clock);
    await Promise.all([relay.snapshot(), relay.snapshot(), relay.snapshot()]);
    await relay.idle();
    expect(collect).toHaveBeenCalledTimes(1);
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
