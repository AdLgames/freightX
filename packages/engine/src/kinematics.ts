/**
 * Vessel kinematics for shipment tracking (ADR-0017): great-circle distance, dead reckoning
 * between AIS pings, lane-following extrapolation along a small table of major shipping lanes,
 * the uncertainty heuristic, and the per-vessel polling policy.
 *
 * Pure module: no I/O, no clock (callers pass `now`). Coordinates and distances are NOT money —
 * plain `number` is correct here (ADR-0003 applies to currency only). Nothing computed here is
 * ever stored: extrapolated positions are for display only; the real ping keeps its
 * `positionSource`.
 *
 * Conventions: latitude/longitude in decimal degrees (WGS84), distances in km, speed in knots,
 * heading/bearing in degrees clockwise from true north, durations in milliseconds.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;
/** One international nautical mile, km. */
export const KM_PER_NAUTICAL_MILE = 1.852;
const MS_PER_HOUR = 3_600_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;
const normaliseLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
const normaliseBearing = (deg: number): number => ((deg % 360) + 360) % 360;

export const knotsToKmPerHour = (knots: number): number => knots * KM_PER_NAUTICAL_MILE;

/** Great-circle distance between two points (haversine), km. */
export const haversineKm = (a: GeoPoint, b: GeoPoint): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Initial great-circle bearing from `a` to `b`, degrees [0, 360). */
export const initialBearingDeg = (a: GeoPoint, b: GeoPoint): number => {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return normaliseBearing(toDeg(Math.atan2(y, x)));
};

/** Point reached after travelling `distanceKm` from `origin` on the great circle at `bearingDeg`. */
export const destinationPoint = (
  origin: GeoPoint,
  bearingDeg: number,
  distanceKm: number,
): GeoPoint => {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const la1 = toRad(origin.lat);
  const lo1 = toRad(origin.lon);
  const sinLa2 =
    Math.sin(la1) * Math.cos(delta) + Math.cos(la1) * Math.sin(delta) * Math.cos(theta);
  const la2 = Math.asin(Math.max(-1, Math.min(1, sinLa2)));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(la1);
  const x = Math.cos(delta) - Math.sin(la1) * sinLa2;
  const lo2 = lo1 + Math.atan2(y, x);
  return { lat: toDeg(la2), lon: normaliseLon(toDeg(lo2)) };
};

// ---------- Dead reckoning ----------

export interface LastPing {
  lat: number;
  lon: number;
  /** Speed over ground, knots. Non-finite or negative values are treated as stopped. */
  speedKnots: number;
  /** Heading (or course over ground) in degrees. */
  headingDeg: number;
  /** When the ping was recorded. */
  positionAt: Date;
}

export interface DeadReckonOptions {
  /** Extrapolation stops here; beyond it the icon stays put and shows "last seen". */
  maxExtrapolationMs: number;
}

export interface DeadReckonResult {
  lat: number;
  lon: number;
  /** How much time was actually extrapolated (≤ maxExtrapolationMs). */
  extrapolatedMs: number;
  /** True when `now - positionAt` exceeded the cap. */
  capped: boolean;
  /** Along-track distance the position was advanced by, km. */
  advancedKm: number;
}

/** Elapsed time clamped to [0, cap]; `capped` is true only when the cap actually bit. */
const clampElapsed = (
  positionAt: Date,
  now: Date,
  maxExtrapolationMs: number,
): { extrapolatedMs: number; capped: boolean } => {
  const cap = Math.max(0, maxExtrapolationMs);
  const elapsed = Math.max(0, now.getTime() - positionAt.getTime());
  return { extrapolatedMs: Math.min(elapsed, cap), capped: elapsed > cap };
};

const safeSpeed = (speedKnots: number): number =>
  Number.isFinite(speedKnots) && speedKnots > 0 ? speedKnots : 0;

/**
 * Straight-line (constant heading, constant speed) dead reckoning from the last ping, capped at
 * `maxExtrapolationMs`. ADR-0017: the cap is the poll interval plus two hours; beyond it the icon
 * stops and the UI shows "last seen {time}".
 */
export const deadReckon = (
  ping: LastPing,
  now: Date,
  opts: DeadReckonOptions,
): DeadReckonResult => {
  const { extrapolatedMs, capped } = clampElapsed(ping.positionAt, now, opts.maxExtrapolationMs);
  const advancedKm = knotsToKmPerHour(safeSpeed(ping.speedKnots)) * (extrapolatedMs / MS_PER_HOUR);
  const heading = Number.isFinite(ping.headingDeg) ? ping.headingDeg : 0;
  const point =
    advancedKm > 0 ? destinationPoint(ping, heading, advancedKm) : { lat: ping.lat, lon: ping.lon };
  return { ...point, extrapolatedMs, capped, advancedKm };
};

/**
 * Display-only uncertainty radius, km. Heuristic (documented, not statistical): 5% of the distance
 * the ship would have travelled since the ping plus a 2 km floor (AIS position accuracy and the
 * ship's own length). It grows linearly with elapsed time and never shrinks below the floor.
 */
export const UNCERTAINTY_FLOOR_KM = 2;
export const UNCERTAINTY_FRACTION = 0.05;
export const uncertaintyRadiusKm = (extrapolatedMs: number, speedKnots: number): number => {
  const travelledKm =
    knotsToKmPerHour(safeSpeed(speedKnots)) * (Math.max(0, extrapolatedMs) / MS_PER_HOUR);
  return UNCERTAINTY_FLOOR_KM + UNCERTAINTY_FRACTION * travelledKm;
};

// ---------- Polling policy (ADR-0017 "smart pull") ----------

export type VesselPollState = 'AT_SEA' | 'COASTAL' | 'APPROACHING' | 'DOCKED' | 'STALE';

/** Within 50 nautical miles of the destination port → hourly polling. */
export const APPROACHING_KM = 50 * KM_PER_NAUTICAL_MILE; // 92.6 km
/** Within 200 km of a choke point or any listed port (coast proxy) → 5-hourly polling. */
export const COASTAL_KM = 200;

/**
 * Chooses the polling state from the ship's distance to its destination and to the nearest
 * choke point / coast proxy. `DOCKED` and `STALE` are set by the milestone processor and the
 * failure counter respectively, never by distance.
 */
export const pollStateFor = (
  distanceToDestinationKm: number,
  chokePointDistanceKm: number,
): Extract<VesselPollState, 'AT_SEA' | 'COASTAL' | 'APPROACHING'> => {
  if (distanceToDestinationKm <= APPROACHING_KM) return 'APPROACHING';
  if (chokePointDistanceKm <= COASTAL_KM) return 'COASTAL';
  return 'AT_SEA';
};

export const POLL_DELAY_MS: Readonly<Record<VesselPollState, number | null>> = {
  AT_SEA: 18 * MS_PER_HOUR, // ADR-0017: 12–24 h at sea
  COASTAL: 5 * MS_PER_HOUR, // 4–6 h near coasts and choke points
  APPROACHING: 1 * MS_PER_HOUR, // within 50 nmi
  DOCKED: null, // kill switch: no polling until a container is loaded again
  STALE: 24 * MS_PER_HOUR, // retry daily so a recovered provider un-stales the vessel
};

/** Delay until the next position poll for a state; `null` = do not poll. */
export const nextPollDelayMs = (state: VesselPollState): number | null => POLL_DELAY_MS[state];

/** Extrapolation cap for a state: the poll interval plus two hours (ADR-0017). */
export const maxExtrapolationMsFor = (state: VesselPollState): number => {
  const delay = POLL_DELAY_MS[state] ?? 0;
  return delay + 2 * MS_PER_HOUR;
};

/** Distance from `position` to the nearest of `points`, km (Infinity for an empty list). */
export const nearestKm = (position: GeoPoint, points: readonly GeoPoint[]): number => {
  let best = Number.POSITIVE_INFINITY;
  for (const p of points) best = Math.min(best, haversineKm(position, p));
  return best;
};

// ---------- Shipping lanes ----------

export interface LaneWaypoint extends GeoPoint {
  /** UN/LOCODE when the waypoint is a port; choke points carry a short label instead. */
  locode?: string;
  label: string;
  /** Choke points and headlands where polling tightens (COASTAL). */
  chokePoint?: boolean;
}

export interface Lane {
  id: string;
  name: string;
  /** Ordered from the Asian/Indian/Turkish end towards the UK. Direction of travel is inferred. */
  waypoints: readonly LaneWaypoint[];
}

/**
 * Choke points and headlands (approximate, ±0.05°, for distance calculations only).
 * The Port seed in migration 0010 carries the same coordinates for the LOCODE'd ones.
 */
const P = (lat: number, lon: number, label: string, extra: Partial<LaneWaypoint> = {}) =>
  ({ lat, lon, label, ...extra }) satisfies LaneWaypoint;

const SHANGHAI = P(31.23, 121.49, 'Shanghai', { locode: 'CNSHA' });
const NINGBO = P(29.87, 121.55, 'Ningbo', { locode: 'CNNGB' });
const SHENZHEN = P(22.5, 113.9, 'Shenzhen (Yantian)', { locode: 'CNSZX' });
const TAIWAN_STRAIT = P(24.5, 119.5, 'Taiwan Strait', { chokePoint: true });
const SOUTH_CHINA_SEA = P(14.0, 112.0, 'South China Sea');
const SINGAPORE = P(1.26, 103.85, 'Singapore', { locode: 'SGSIN', chokePoint: true });
const PORT_KLANG = P(3.0, 101.35, 'Port Klang', { locode: 'MYPKG', chokePoint: true });
const MALACCA_NW = P(5.6, 97.3, 'Malacca Strait (NW exit)', { chokePoint: true });
const COLOMBO = P(6.95, 79.85, 'Colombo', { locode: 'LKCMB' });
const SOUTH_OF_SRI_LANKA = P(5.4, 80.5, 'South of Sri Lanka');
const ARABIAN_SEA = P(12.5, 58.0, 'Arabian Sea');
const NHAVA_SHEVA = P(18.95, 72.95, 'Nhava Sheva', { locode: 'INNSA' });
const JEBEL_ALI = P(25.0, 55.06, 'Jebel Ali', { locode: 'AEJEA' });
const HORMUZ = P(26.5, 56.5, 'Strait of Hormuz', { chokePoint: true });
const GULF_OF_OMAN = P(23.5, 60.0, 'Gulf of Oman');
const SOCOTRA = P(12.0, 52.0, 'North of Socotra');
const GULF_OF_ADEN = P(12.6, 46.5, 'Gulf of Aden', { chokePoint: true });
const BAB_EL_MANDEB = P(12.6, 43.3, 'Bab-el-Mandeb', { chokePoint: true });
const RED_SEA_S = P(16.5, 40.9, 'Red Sea (south)');
const RED_SEA_N = P(24.0, 36.5, 'Red Sea (north)');
const SUEZ = P(29.97, 32.55, 'Suez', { locode: 'EGSUZ', chokePoint: true });
const PORT_SAID = P(31.26, 32.3, 'Port Said', { locode: 'EGPSD', chokePoint: true });
const CRETE_S = P(34.4, 24.0, 'South of Crete');
const SICILY_CHANNEL = P(37.2, 11.3, 'Strait of Sicily', { chokePoint: true });
const ALGIERS_N = P(37.3, 3.0, 'North of Algiers');
const GIBRALTAR = P(35.95, -5.6, 'Strait of Gibraltar', { chokePoint: true });
const CAPE_ST_VINCENT = P(36.9, -9.4, 'Cape St Vincent');
const FINISTERRE = P(43.1, -9.7, 'Cape Finisterre', { chokePoint: true });
const USHANT = P(48.6, -5.6, 'Ushant', { chokePoint: true });
const CHANNEL_MID = P(50.1, -1.9, 'English Channel (mid)');
const DOVER_STRAIT = P(51.0, 1.5, 'Strait of Dover', { chokePoint: true });
const SOUTHAMPTON = P(50.9, -1.4, 'Southampton', { locode: 'GBSOU' });
const LONDON_GATEWAY = P(51.5, 0.45, 'London Gateway', { locode: 'GBLGP' });
const FELIXSTOWE = P(51.95, 1.35, 'Felixstowe', { locode: 'GBFXT' });
const ISTANBUL = P(41.0, 28.95, 'Istanbul (Ambarli)', { locode: 'TRIST' });
const DARDANELLES = P(40.2, 26.4, 'Dardanelles', { chokePoint: true });
const AEGEAN_S = P(36.8, 25.0, 'South Aegean');
const ROTTERDAM = P(51.95, 4.05, 'Rotterdam', { locode: 'NLRTM' });
const ANTWERP = P(51.3, 4.3, 'Antwerp', { locode: 'BEANR' });
const HAMBURG = P(53.55, 9.95, 'Hamburg', { locode: 'DEHAM' });

/** The Mediterranean → Channel → UK tail shared by every lane below. */
const MED_TO_UK: readonly LaneWaypoint[] = [
  SICILY_CHANNEL,
  ALGIERS_N,
  GIBRALTAR,
  CAPE_ST_VINCENT,
  FINISTERRE,
  USHANT,
  CHANNEL_MID,
  SOUTHAMPTON,
  DOVER_STRAIT,
  LONDON_GATEWAY,
  FELIXSTOWE,
];
const ADEN_TO_MED: readonly LaneWaypoint[] = [
  GULF_OF_ADEN,
  BAB_EL_MANDEB,
  RED_SEA_S,
  RED_SEA_N,
  SUEZ,
  PORT_SAID,
  CRETE_S,
];

/**
 * Major lanes into the UK, as ordered waypoint polylines. Approximate (±0.05°) and for
 * distance calculations and display only; they are not navigational routes. Southampton and
 * London Gateway sit on the Felixstowe lane so the projection of any of the three UK
 * destinations lands on it. Spurs to Rotterdam/Antwerp/Hamburg are listed so their Port rows
 * resolve to a lane end as well.
 */
export const LANES: readonly Lane[] = [
  {
    id: 'ASIA_EUROPE_SUEZ',
    name: 'China – Singapore Strait – Suez – Gibraltar – UK',
    waypoints: [
      SHANGHAI,
      NINGBO,
      TAIWAN_STRAIT,
      SHENZHEN,
      SOUTH_CHINA_SEA,
      SINGAPORE,
      PORT_KLANG,
      MALACCA_NW,
      SOUTH_OF_SRI_LANKA,
      COLOMBO,
      ARABIAN_SEA,
      SOCOTRA,
      ...ADEN_TO_MED,
      ...MED_TO_UK,
    ],
  },
  {
    id: 'INDIA_EUROPE_SUEZ',
    name: 'Nhava Sheva – Arabian Sea – Suez – UK',
    waypoints: [NHAVA_SHEVA, ARABIAN_SEA, SOCOTRA, ...ADEN_TO_MED, ...MED_TO_UK],
  },
  {
    id: 'GULF_EUROPE_SUEZ',
    name: 'Jebel Ali – Hormuz – Gulf of Aden – Suez – UK',
    waypoints: [JEBEL_ALI, HORMUZ, GULF_OF_OMAN, SOCOTRA, ...ADEN_TO_MED, ...MED_TO_UK],
  },
  {
    id: 'TURKEY_UK',
    name: 'Istanbul – Dardanelles – Sicily – Gibraltar – UK',
    waypoints: [ISTANBUL, DARDANELLES, AEGEAN_S, CRETE_S, ...MED_TO_UK],
  },
  {
    id: 'NORTH_SEA_HUBS',
    name: 'Felixstowe – Rotterdam – Antwerp – Hamburg',
    waypoints: [FELIXSTOWE, ROTTERDAM, ANTWERP, HAMBURG],
  },
];

/** Every distinct choke point across the lane table (for the COASTAL state). */
export const CHOKE_POINTS: readonly LaneWaypoint[] = (() => {
  const seen = new Set<string>();
  const out: LaneWaypoint[] = [];
  for (const lane of LANES) {
    for (const w of lane.waypoints) {
      if (w.chokePoint && !seen.has(w.label)) {
        seen.add(w.label);
        out.push(w);
      }
    }
  }
  return out;
})();

/** A lane matches only when the ship is within this distance of its polyline. */
export const LANE_MATCH_KM = 150;

export interface LaneProjection {
  /** Nearest point on the lane polyline. */
  point: GeoPoint;
  /** Distance from the query position to that point, km. */
  distanceKm: number;
  /** Index of the segment [waypoints[i], waypoints[i+1]] containing the point. */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  fraction: number;
  /** Distance along the lane from waypoints[0] to the point, km. */
  alongKm: number;
}

/** Equirectangular local projection: good enough for the nearest-point search on short segments. */
const projectOntoSegment = (
  p: GeoPoint,
  a: GeoPoint,
  b: GeoPoint,
): { fraction: number; point: GeoPoint } => {
  const cosLat = Math.cos(toRad((a.lat + b.lat) / 2));
  const ax = a.lon * cosLat;
  const bx = b.lon * cosLat;
  const px = p.lon * cosLat;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / lenSq));
  return { fraction: t, point: { lat: a.lat + t * dy, lon: a.lon + t * (b.lon - a.lon) } };
};

/** Cumulative along-lane distance at each waypoint, km. */
const cumulativeKm = (lane: Lane): number[] => {
  const out = [0];
  for (let i = 1; i < lane.waypoints.length; i += 1) {
    out.push(out[i - 1]! + haversineKm(lane.waypoints[i - 1]!, lane.waypoints[i]!));
  }
  return out;
};

/** Nearest point on `lane` to `position`. */
export const nearestLanePoint = (position: GeoPoint, lane: Lane): LaneProjection => {
  const cum = cumulativeKm(lane);
  let best: LaneProjection | null = null;
  for (let i = 0; i + 1 < lane.waypoints.length; i += 1) {
    const a = lane.waypoints[i]!;
    const b = lane.waypoints[i + 1]!;
    const { fraction, point } = projectOntoSegment(position, a, b);
    const distanceKm = haversineKm(position, point);
    if (!best || distanceKm < best.distanceKm) {
      best = {
        point,
        distanceKm,
        segmentIndex: i,
        fraction,
        alongKm: cum[i]! + fraction * (cum[i + 1]! - cum[i]!),
      };
    }
  }
  if (!best) {
    const only = lane.waypoints[0] ?? { lat: 0, lon: 0 };
    return {
      point: only,
      distanceKm: haversineKm(position, only),
      segmentIndex: 0,
      fraction: 0,
      alongKm: 0,
    };
  }
  return best;
};

export interface LaneMatch {
  lane: Lane;
  ship: LaneProjection;
  destination: LaneProjection;
}

/**
 * Picks the lane that passes within `LANE_MATCH_KM` of both the ship and its destination, taking
 * the one nearest the ship on a tie. `null` → fall back to heading-based dead reckoning.
 */
export const matchLane = (
  position: GeoPoint,
  destination: GeoPoint,
  lanes: readonly Lane[] = LANES,
): LaneMatch | null => {
  let best: LaneMatch | null = null;
  for (const lane of lanes) {
    const ship = nearestLanePoint(position, lane);
    if (ship.distanceKm > LANE_MATCH_KM) continue;
    const dest = nearestLanePoint(destination, lane);
    if (dest.distanceKm > LANE_MATCH_KM) continue;
    if (!best || ship.distanceKm < best.ship.distanceKm) best = { lane, ship, destination: dest };
  }
  return best;
};

/**
 * The lane path from the ship's projection to the destination's projection (in whichever
 * direction the lane runs), then a final straight leg to the destination itself.
 */
export const lanePathToDestination = (match: LaneMatch, destination: GeoPoint): GeoPoint[] => {
  const { lane, ship, destination: dest } = match;
  const forward = dest.alongKm >= ship.alongKm;
  const plain = (w: GeoPoint): GeoPoint => ({ lat: w.lat, lon: w.lon });
  const path: GeoPoint[] = [plain(ship.point)];
  if (forward) {
    for (let i = ship.segmentIndex + 1; i <= dest.segmentIndex; i += 1) {
      path.push(plain(lane.waypoints[i]!));
    }
  } else {
    for (let i = ship.segmentIndex; i > dest.segmentIndex; i -= 1) {
      path.push(plain(lane.waypoints[i]!));
    }
  }
  path.push(plain(dest.point));
  path.push(plain(destination));
  // Drop zero-length steps (projection exactly on a waypoint).
  return path.filter((p, i) => i === 0 || haversineKm(p, path[i - 1]!) > 1e-6);
};

/** Advances `km` along a polyline; returns the new point and the path still ahead of it. */
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
      const bearing = initialBearingDeg(current, next);
      const point = destinationPoint(current, bearing, left);
      return { point, remaining: [point, ...path.slice(i)], advancedKm: advanced + left };
    }
    left -= seg;
    advanced += seg;
    current = next;
  }
  // Ran out of path: stop at the destination.
  return { point: current, remaining: [current], advancedKm: advanced };
};

export interface LaneDeadReckonInput {
  lastPing: LastPing;
  /** Destination port coordinates (from the Port table). */
  destination: GeoPoint;
}

export interface LaneDeadReckonResult extends DeadReckonResult {
  /** 'lane' when a lane matched, 'heading' for the straight-line fallback. */
  method: 'lane' | 'heading';
  laneId: string | null;
  /**
   * Expected route still ahead of the extrapolated position (starts at it, ends at the
   * destination). Empty for the heading fallback. Display only.
   */
  remainingPath: GeoPoint[];
}

/**
 * Lane-following dead reckoning: projects the last ping onto the best matching lane and advances
 * along the lane polyline towards the destination at the reported speed, turning at waypoints,
 * with the same cap and the same uncertainty radius as `deadReckon`. When no lane passes within
 * `LANE_MATCH_KM` of both ship and destination, falls back to `deadReckon` (constant heading).
 */
export const deadReckonAlongLane = (
  input: LaneDeadReckonInput,
  now: Date,
  opts: DeadReckonOptions,
  lanes: readonly Lane[] = LANES,
): LaneDeadReckonResult => {
  const { lastPing, destination } = input;
  const match = matchLane(lastPing, destination, lanes);
  if (!match) {
    const straight = deadReckon(lastPing, now, opts);
    return { ...straight, method: 'heading', laneId: null, remainingPath: [] };
  }
  const { extrapolatedMs, capped } = clampElapsed(
    lastPing.positionAt,
    now,
    opts.maxExtrapolationMs,
  );
  const travelKm =
    knotsToKmPerHour(safeSpeed(lastPing.speedKnots)) * (extrapolatedMs / MS_PER_HOUR);
  // The ship's actual ping is the start; the lane path starts at its projection so the first
  // step is the short hop onto the lane (bounded by LANE_MATCH_KM), then along it.
  const path = [
    { lat: lastPing.lat, lon: lastPing.lon },
    ...lanePathToDestination(match, destination),
  ];
  const { point, remaining, advancedKm } = advanceAlongPath(path, travelKm);
  return {
    lat: point.lat,
    lon: point.lon,
    extrapolatedMs,
    capped,
    advancedKm,
    method: 'lane',
    laneId: match.lane.id,
    remainingPath: remaining,
  };
};
