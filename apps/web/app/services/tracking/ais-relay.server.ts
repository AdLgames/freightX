import {
  AIS_STALE_MS,
  AIS_STREAM_URL,
  aisSubscribeMessage,
  decodeAisVessels,
  encodeAisVessels,
  parseAisError,
  parseAisMessage,
  pruneAisVessels,
  type AisSnapshotResponse,
  type AisVessel,
} from '../../lib/ais-client';
import type { Logger } from '../logger.server';

/**
 * Live AIS relay (Home map). aisstream.io does not permit browser connections, so the server
 * holds the socket: each collection opens the stream, subscribes to the UK box, gathers position
 * reports for a few seconds and closes. Snapshots are merged into a cache shared across
 * instances (Redis when configured, else this process) and served to the browser, which polls
 * `/app/api/ais`. One collection at a time (a lock) keeps us inside aisstream's three
 * connections per account however many members have the Home page open; a request that finds
 * the lock taken gets the last snapshot. The API key never leaves the server.
 */
export const AIS_COLLECT_MS = 5_000;
/** A snapshot younger than this is served as is; older ones trigger a fresh collection. */
export const AIS_FRESH_MS = 12_000;
const LOCK_MS = AIS_COLLECT_MS + 10_000;
const SNAPSHOT_KEY = 'ais:snapshot';
const LOCK_KEY = 'ais:lock';

/** The slice of a WebSocket the collector uses (the DOM/Node global satisfies it). */
export interface AisSocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  send(data: string): void;
  close(): void;
}

export interface CollectResult {
  vessels: AisVessel[];
  /** The provider's refusal (bad key, bad subscription) or a connection failure. */
  error: string | null;
}

export interface CollectOptions {
  durationMs?: number;
  now?: () => number;
  /** Test seam: replaces `new WebSocket(AIS_STREAM_URL)`. */
  connect?: () => AisSocketLike;
}

/**
 * aisstream answers an invalid key or a malformed subscription by dropping the connection: no
 * error frame, no close reason (probed 2026-09). So "closed without reports" is the refusal.
 */
export const AIS_REFUSED_MESSAGE =
  'aisstream closed the connection without sending reports (this is how it rejects an invalid API key)';

/** Opens the stream, subscribes, gathers reports for `durationMs`, closes. Never throws. */
export const collectAisReports = (
  apiKey: string,
  opts: CollectOptions = {},
): Promise<CollectResult> =>
  new Promise((resolve) => {
    const now = opts.now ?? (() => Date.now());
    const durationMs = opts.durationMs ?? AIS_COLLECT_MS;
    const vessels = new Map<string, AisVessel>();
    let error: string | null = null;
    let done = false;
    let socket: AisSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fallback: string | null) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve({ vessels: [...vessels.values()], error: error ?? fallback });
    };
    if (!opts.connect && typeof WebSocket === 'undefined') {
      resolve({
        vessels: [],
        error: 'this server runtime has no WebSocket client (Node 22+ needed)',
      });
      return;
    }
    try {
      socket = opts.connect ? opts.connect() : new WebSocket(AIS_STREAM_URL);
    } catch (err) {
      resolve({ vessels: [], error: `could not open the AIS stream: ${errorText(err)}` });
      return;
    }
    let subscribed = false;
    // Guard against a socket that never opens or never closes.
    timer = setTimeout(
      () => finish(vessels.size === 0 ? 'no reports received' : null),
      durationMs + 8_000,
    );
    socket.addEventListener('open', () => {
      socket?.send(aisSubscribeMessage(apiKey));
      subscribed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => finish(null), durationMs);
    });
    socket.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const refused = parseAisError(ev.data);
      if (refused) {
        error = refused;
        finish(refused);
        return;
      }
      const t = now();
      const v = parseAisMessage(ev.data, t);
      if (v) vessels.set(v.mmsi, v);
    });
    const dropped = () =>
      vessels.size > 0
        ? null
        : subscribed
          ? AIS_REFUSED_MESSAGE
          : 'could not reach the AIS stream (connection failed before the subscription)';
    socket.addEventListener('error', () => finish(dropped()));
    socket.addEventListener('close', () => finish(dropped()));
  });

/** Shared snapshot cache: Redis across instances, or the in-process map below. */
export interface AisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** SET NX: true when this caller took the key. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export class MemoryAisCache implements AisCache {
  private readonly rows = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  private live(key: string) {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.rows.delete(key);
      return null;
    }
    return row;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlMs: number) {
    this.rows.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  async setNx(key: string, value: string, ttlMs: number) {
    if (this.live(key)) return false;
    this.rows.set(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }
  async del(key: string) {
    this.rows.delete(key);
  }
}

/** ioredis, narrowed to what the cache needs (so the relay can be tested with the memory cache). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const redisAisCache = (redis: RedisLike): AisCache => ({
  get: (key) => redis.get(key),
  set: async (key, value, ttlMs) => {
    await redis.set(key, value, 'PX', ttlMs);
  },
  setNx: async (key, value, ttlMs) => (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
  del: async (key) => {
    await redis.del(key);
  },
});

interface StoredSnapshot {
  collectedAt: number;
  error: string | null;
  v: ReturnType<typeof encodeAisVessels>;
}

export interface AisRelayDeps {
  apiKey: string;
  cache: AisCache;
  log: Logger;
  now?: () => number;
  /** Test seam: replaces the live collector. */
  collect?: (apiKey: string) => Promise<CollectResult>;
  freshMs?: number;
}

export class AisRelay {
  private inFlight: Promise<AisSnapshotResponse> | null = null;
  private readonly now: () => number;
  private readonly collect: (apiKey: string) => Promise<CollectResult>;
  private readonly freshMs: number;

  constructor(private readonly deps: AisRelayDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.collect = deps.collect ?? ((key) => collectAisReports(key, { now: this.now }));
    this.freshMs = deps.freshMs ?? AIS_FRESH_MS;
  }

  /**
   * The current picture: the cached snapshot when it is fresh, otherwise a new collection merged
   * into it. `since` (ms) trims the response to vessels heard after that instant.
   */
  async snapshot(since = 0): Promise<AisSnapshotResponse> {
    const cached = await this.read();
    const t = this.now();
    if (cached && t - cached.collectedAt < this.freshMs) return this.respond(cached, since);
    // One collection per process at a time: later callers join the promise, lock wait included.
    this.inFlight ??= this.lockAndRefresh(cached).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight.then((r) => trim(r, since));
  }

  private async lockAndRefresh(cached: StoredSnapshot | null): Promise<AisSnapshotResponse> {
    if (!(await this.tryLock())) {
      return cached
        ? this.respond(cached, 0)
        : { status: 'warming', error: null, collectedAt: 0, v: [] };
    }
    return this.refresh(cached);
  }

  private async refresh(previous: StoredSnapshot | null): Promise<AisSnapshotResponse> {
    const { apiKey, cache, log } = this.deps;
    try {
      const result = await this.collect(apiKey);
      const t = this.now();
      const merged = new Map<string, AisVessel>();
      for (const v of decodeAisVessels(previous?.v ?? [])) merged.set(v.mmsi, v);
      for (const v of result.vessels) merged.set(v.mmsi, v);
      pruneAisVessels(merged, t);
      const stored: StoredSnapshot = {
        collectedAt: t,
        error: result.error,
        v: encodeAisVessels(merged.values()),
      };
      if (result.error) log.warn('ais.collect_failed', { error: result.error });
      else log.info('ais.collected', { reports: result.vessels.length, vessels: stored.v.length });
      await this.write(stored);
      return this.respond(stored, 0);
    } finally {
      await cache.del(LOCK_KEY).catch(() => undefined);
    }
  }

  private respond(s: StoredSnapshot, since: number): AisSnapshotResponse {
    const status = s.error && s.v.length === 0 ? 'error' : 'live';
    return trim({ status, error: s.error, collectedAt: s.collectedAt, v: s.v }, since);
  }

  private async read(): Promise<StoredSnapshot | null> {
    try {
      const raw = await this.deps.cache.get(SNAPSHOT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredSnapshot>;
      if (typeof parsed.collectedAt !== 'number' || !Array.isArray(parsed.v)) return null;
      return {
        collectedAt: parsed.collectedAt,
        error: typeof parsed.error === 'string' ? parsed.error : null,
        v: encodeAisVessels(decodeAisVessels(parsed.v)),
      };
    } catch (err) {
      this.deps.log.warn('ais.cache_read_failed', { error: String(err) });
      return null;
    }
  }

  private async write(s: StoredSnapshot): Promise<void> {
    try {
      await this.deps.cache.set(SNAPSHOT_KEY, JSON.stringify(s), AIS_STALE_MS);
    } catch (err) {
      this.deps.log.warn('ais.cache_write_failed', { error: String(err) });
    }
  }

  private async tryLock(): Promise<boolean> {
    try {
      return await this.deps.cache.setNx(LOCK_KEY, String(this.now()), LOCK_MS);
    } catch (err) {
      this.deps.log.warn('ais.lock_failed', { error: String(err) });
      return true; // no shared lock available: better a collection than a blank map
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const trim = (r: AisSnapshotResponse, since: number): AisSnapshotResponse =>
  since > 0 ? { ...r, v: r.v.filter((t) => t[5] > since) } : r;
