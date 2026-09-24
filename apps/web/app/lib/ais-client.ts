/**
 * Ambient AIS traffic for the Home map (aisstream.io). Pure helpers shared by the server relay
 * (`services/tracking/ais-relay.server.ts`), the client map and their tests: the subscription
 * message, position-report parsing, the bounded vessel cache and the compact wire format between
 * the relay and the browser. aisstream does not accept browser connections, so the server holds
 * the socket and the browser polls `/app/api/ais`. Positions are the live picture around the
 * organisation's shipments, never its shipments, and are only ever cached for minutes.
 */
export const AIS_STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
/** [[south, west], [north, east]] — the English Channel, the Dover Strait and the UK south and east coasts. */
export const AIS_UK_BOUNDS: readonly [readonly [number, number], readonly [number, number]] = [
  [49.0, -6.0],
  [53.0, 3.0],
];
export const AIS_MAX_VESSELS = 1500;
/** A vessel silent for this long drops off the map. */
export const AIS_STALE_MS = 15 * 60_000;

export interface AisVessel {
  mmsi: string;
  lat: number;
  lon: number;
  speedKnots: number;
  courseDeg: number;
  seenAt: number;
}

/** What `/app/api/ais` returns. `v` is the compact vessel list (see `encodeAisVessels`). */
export interface AisSnapshotResponse {
  /** live: reports flowing; warming: first collection in progress; error: the provider refused us. */
  status: 'live' | 'warming' | 'error';
  /** Provider or relay message when status is `error` (never the key). */
  error: string | null;
  /** When the relay last collected reports (ms since epoch), 0 when it never has. */
  collectedAt: number;
  v: AisVesselTuple[];
}

export type AisVesselTuple = [
  mmsi: string,
  lat: number,
  lon: number,
  speedKnots: number,
  courseDeg: number,
  seenAt: number,
];

export const aisSubscribeMessage = (
  apiKey: string,
  bounds: typeof AIS_UK_BOUNDS = AIS_UK_BOUNDS,
): string =>
  JSON.stringify({
    APIKey: apiKey,
    BoundingBoxes: [[[...bounds[0]], [...bounds[1]]]],
    FilterMessageTypes: ['PositionReport'],
  });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** aisstream answers a bad key or subscription with `{"error": "..."}`; anything else → null. */
export const parseAisError = (raw: string): string | null => {
  const msg = parseJson(raw);
  if (typeof msg !== 'object' || msg === null) return null;
  const err = (msg as { error?: unknown }).error;
  return typeof err === 'string' && err.trim() !== '' ? err.trim().slice(0, 200) : null;
};

/** One `PositionReport` message → a vessel, or null for anything else (or a malformed report). */
export const parseAisMessage = (raw: string, now: number): AisVessel | null => {
  const msg = parseJson(raw);
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as {
    MessageType?: unknown;
    Message?: { PositionReport?: Record<string, unknown> };
  };
  if (m.MessageType !== 'PositionReport') return null;
  const r = m.Message?.PositionReport;
  if (!r) return null;
  const lat = num(r.Latitude);
  const lon = num(r.Longitude);
  const mmsi = num(r.UserID);
  if (lat === null || lon === null || mmsi === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const speed = num(r.Sog) ?? 0;
  const course = num(r.Cog) ?? 0;
  return {
    mmsi: String(mmsi),
    lat,
    lon,
    speedKnots: speed >= 0 && speed < 102.3 ? speed : 0, // 102.3 = "not available" in AIS
    courseDeg: course >= 0 && course < 360 ? course : 0,
    seenAt: now,
  };
};

/** Adds a report to the cache (mutates), evicting stale vessels and the oldest past the cap. */
export const upsertAisVessel = (
  cache: Map<string, AisVessel>,
  vessel: AisVessel,
  now: number,
): void => {
  cache.delete(vessel.mmsi);
  cache.set(vessel.mmsi, vessel);
  pruneAisVessels(cache, now);
};

/** Drops vessels silent for longer than `AIS_STALE_MS` and the oldest beyond the cap (mutates). */
export const pruneAisVessels = (cache: Map<string, AisVessel>, now: number): void => {
  for (const [key, v] of cache) {
    if (now - v.seenAt > AIS_STALE_MS) cache.delete(key);
  }
  while (cache.size > AIS_MAX_VESSELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Compact tuples for the wire and the cache: ~40 bytes a vessel instead of ~110 as objects. */
export const encodeAisVessels = (vessels: Iterable<AisVessel>): AisVesselTuple[] =>
  [...vessels].map((v) => [
    v.mmsi,
    round(v.lat, 5),
    round(v.lon, 5),
    round(v.speedKnots, 1),
    Math.round(v.courseDeg),
    v.seenAt,
  ]);

/** Inverse of `encodeAisVessels`; malformed tuples are skipped rather than thrown. */
export const decodeAisVessels = (raw: unknown): AisVessel[] => {
  if (!Array.isArray(raw)) return [];
  const out: AisVessel[] = [];
  for (const t of raw) {
    if (!Array.isArray(t) || t.length < 6) continue;
    const row = t as unknown[];
    const mmsi = row[0];
    const lat = num(row[1]);
    const lon = num(row[2]);
    const speedKnots = num(row[3]);
    const courseDeg = num(row[4]);
    const seenAt = num(row[5]);
    if (typeof mmsi !== 'string' || lat === null || lon === null) continue;
    if (speedKnots === null || courseDeg === null || seenAt === null) continue;
    out.push({ mmsi, lat, lon, speedKnots, courseDeg, seenAt });
  }
  return out;
};
