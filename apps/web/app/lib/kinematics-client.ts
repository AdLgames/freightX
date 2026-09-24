/**
 * M9 (ADR-0017) — the tiny slice of `@harbour/engine` kinematics the map needs in the browser,
 * duplicated here so the map chunk does not pull the engine (and decimal.js) into the client
 * bundle. Same constants and formulas; `app/services/tracking/kinematics-client.test.ts` checks
 * this copy against the engine on sample inputs so the two cannot drift.
 *
 * Plain numbers: coordinates and distances are not money.
 */
export interface GeoPoint {
  lat: number;
  lon: number;
}

export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_NAUTICAL_MILE = 1.852;
const MS_PER_HOUR = 3_600_000;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const normLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export const haversineKm = (a: GeoPoint, b: GeoPoint): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const initialBearingDeg = (a: GeoPoint, b: GeoPoint): number => {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
};

export const destinationPoint = (o: GeoPoint, bearingDeg: number, km: number): GeoPoint => {
  const d = km / EARTH_RADIUS_KM;
  const t = toRad(bearingDeg);
  const la1 = toRad(o.lat);
  const sinLa2 = Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t);
  const la2 = Math.asin(Math.max(-1, Math.min(1, sinLa2)));
  const y = Math.sin(t) * Math.sin(d) * Math.cos(la1);
  const x = Math.cos(d) - Math.sin(la1) * sinLa2;
  return { lat: toDeg(la2), lon: normLon(toDeg(toRad(o.lon) + Math.atan2(y, x))) };
};

export const knotsToKmPerHour = (knots: number): number => knots * KM_PER_NAUTICAL_MILE;

/** Same as the engine's `advanceAlongPath`. */
export const advanceAlongPath = (
  path: readonly GeoPoint[],
  km: number,
): { point: GeoPoint; remaining: GeoPoint[]; advancedKm: number } => {
  if (path.length === 0) return { point: { lat: 0, lon: 0 }, remaining: [], advancedKm: 0 };
  let left = Math.max(0, km);
  let advanced = 0;
  let current = path[0]!;
  for (let i = 1; i < path.length; i += 1) {
    const next = path[i]!;
    const seg = haversineKm(current, next);
    if (left < seg) {
      const point = destinationPoint(current, initialBearingDeg(current, next), left);
      return { point, remaining: [point, ...path.slice(i)], advancedKm: advanced + left };
    }
    left -= seg;
    advanced += seg;
    current = next;
  }
  return { point: current, remaining: [current], advancedKm: advanced };
};

/** Same heuristic as the engine's `uncertaintyRadiusKm`: 2 km floor + 5% of distance travelled. */
export const uncertaintyRadiusKm = (extrapolatedMs: number, speedKnots: number): number => {
  const v = Number.isFinite(speedKnots) && speedKnots > 0 ? speedKnots : 0;
  return 2 + 0.05 * knotsToKmPerHour(v) * (Math.max(0, extrapolatedMs) / MS_PER_HOUR);
};

export interface ClientReckonInput {
  /** Where the server left the ship at `serverNow` (already dead-reckoned). */
  start: GeoPoint;
  /** Time already extrapolated by the server, ms. */
  serverExtrapolatedMs: number;
  maxExtrapolationMs: number;
  speedKnots: number;
  headingDeg: number;
  /** Lane path ahead of `start` (starts at it), or empty for constant-heading motion. */
  expectedPath: readonly GeoPoint[];
}

/**
 * Advances the server's reckoned position by the time elapsed in the browser, along the lane
 * when one is known, capped exactly as the server caps (poll interval + 2 h from the real ping).
 */
export const advanceClient = (
  input: ClientReckonInput,
  elapsedMs: number,
): { point: GeoPoint; remaining: GeoPoint[]; extrapolatedMs: number; capped: boolean } => {
  const budget = Math.max(0, input.maxExtrapolationMs - input.serverExtrapolatedMs);
  const use = Math.min(Math.max(0, elapsedMs), budget);
  const capped = elapsedMs > budget;
  const km = knotsToKmPerHour(Math.max(0, input.speedKnots)) * (use / MS_PER_HOUR);
  if (input.expectedPath.length >= 2) {
    const r = advanceAlongPath(input.expectedPath, km);
    return {
      point: r.point,
      remaining: r.remaining,
      extrapolatedMs: input.serverExtrapolatedMs + use,
      capped,
    };
  }
  const point = km > 0 ? destinationPoint(input.start, input.headingDeg, km) : input.start;
  return { point, remaining: [], extrapolatedMs: input.serverExtrapolatedMs + use, capped };
};
