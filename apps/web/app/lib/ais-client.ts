/**
 * Ambient AIS traffic for the Home map (aisstream.io). Pure helpers, shared by the client map
 * and its tests: the subscription message, position-report parsing and the vessel cache. The
 * WebSocket itself lives in tracking-map.client.tsx. Positions here are never stored server-side
 * and are not the organisation's shipments; they are the live picture around them.
 */
export const AIS_STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
export const AIS_STREAM_ORIGIN = 'wss://stream.aisstream.io';
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

/** One `PositionReport` message → a vessel, or null for anything else (or a malformed report). */
export const parseAisMessage = (raw: string, now: number): AisVessel | null => {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
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
  for (const [key, v] of cache) {
    if (now - v.seenAt > AIS_STALE_MS) cache.delete(key);
  }
  while (cache.size > AIS_MAX_VESSELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};
