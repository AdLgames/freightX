import {
  CHOKE_POINTS,
  LANES,
  advanceAlongPath,
  haversineKm,
  initialBearingDeg,
  knotsToKmPerHour,
  lanePathToDestination,
  matchLane,
  nearestKm,
  pollStateFor,
  type GeoPoint,
  type LaneWaypoint,
  type VesselPollState,
} from '@harbour/engine';

/**
 * Demo fleet (docs/design-system.md, Home: "when demo mode is on the pill reads Simulated data").
 *
 * Three fictional ships sailing the engine's shipping lanes towards UK ports. Pure module: given a
 * ship definition, its departure time and "now", it says where the ship is, which way it points
 * and which lane waypoints it has passed. The server module (`demo-fleet.server.ts`) turns that
 * into rows; nothing here touches I/O.
 *
 * Every simulated row is labelled so it can never be mistaken for a provider's data:
 * `shipments.tracking_provider = 'simulated'`, `active_vessels.position_source = 'SIMULATED'`,
 * `shipment_events.source = 'SIMULATED'`. Container and IMO numbers carry valid check digits
 * (so every validator accepts them) but belong to no real box or hull.
 */

/** `active_vessels.position_source` and `shipment_events.source` for simulated rows. */
export const SIMULATED_SOURCE = 'SIMULATED';
/** `shipments.tracking_provider` for simulated shipments. */
export const SIMULATED_PROVIDER = 'simulated';
/** A simulated vessel gets a fresh "ping" at most this often (tick-on-read, see server module). */
export const DEMO_PING_INTERVAL_MS = 10 * 60_000;

export interface DemoShip {
  /** Stable key; `shipments.tracking_request_ref` is `sim:<key>`. */
  key: string;
  reference: string;
  /** ISO 6346 with a valid check digit; prefix HRBU is not an allocated owner code. */
  containerNumber: string;
  sizeType: 'C20GP' | 'C40GP' | 'C40HC' | 'C45HC';
  /** 7 digits with a valid IMO check digit; the 99xxxxx block is not in use. */
  vesselImo: string;
  vesselName: string;
  voyageNumber: string;
  originLocode: string;
  destinationLocode: string;
  speedKnots: number;
  /** Hours already at sea when the fleet is seeded: spreads the ships along their lanes. */
  hoursAtSeaAtSeed: number;
}

export const DEMO_SHIPS: readonly DemoShip[] = [
  {
    key: 'orient-star',
    reference: 'Demo — Autumn stock (Shanghai)',
    containerNumber: 'HRBU2000010',
    sizeType: 'C40HC',
    vesselImo: '9900019',
    vesselName: 'SIM ORIENT STAR',
    voyageNumber: '041W',
    originLocode: 'CNSHA',
    destinationLocode: 'GBFXT',
    speedKnots: 16.5,
    hoursAtSeaAtSeed: 9 * 24, // Indian Ocean, west of Sri Lanka
  },
  {
    key: 'arabian-dawn',
    reference: 'Demo — Textiles (Nhava Sheva)',
    containerNumber: 'HRBU2000026',
    sizeType: 'C40GP',
    vesselImo: '9900021',
    vesselName: 'SIM ARABIAN DAWN',
    voyageNumber: '117W',
    originLocode: 'INNSA',
    destinationLocode: 'GBSOU',
    speedKnots: 15,
    hoursAtSeaAtSeed: 8 * 24, // Red Sea, approaching Suez
  },
  {
    key: 'channel-runner',
    reference: 'Demo — Machinery parts (Ningbo)',
    containerNumber: 'HRBU2000031',
    sizeType: 'C20GP',
    vesselImo: '9900033',
    vesselName: 'SIM CHANNEL RUNNER',
    voyageNumber: '208W',
    originLocode: 'CNNGB',
    destinationLocode: 'GBLGP',
    speedKnots: 17,
    hoursAtSeaAtSeed: 24 * 24, // Western Approaches, a day or so out
  },
];

export const demoShipByKey = (key: string): DemoShip | null =>
  DEMO_SHIPS.find((s) => s.key === key) ?? null;

/** `shipments.tracking_request_ref` ↔ ship key. */
export const demoRequestRef = (ship: DemoShip): string => `sim:${ship.key}`;
export const demoShipFromRequestRef = (ref: string | null): DemoShip | null =>
  ref && ref.startsWith('sim:') ? demoShipByKey(ref.slice(4)) : null;

const waypointByLocode = (locode: string): LaneWaypoint => {
  for (const lane of LANES) {
    const w = lane.waypoints.find((p) => p.locode === locode);
    if (w) return w;
  }
  throw new Error(`demo fleet: no lane waypoint for ${locode}`);
};

const plain = (p: GeoPoint): GeoPoint => ({ lat: p.lat, lon: p.lon });

export interface DemoRoute {
  laneId: string;
  /** Origin port → lane waypoints → destination port. */
  path: GeoPoint[];
  /** Labels for the intermediate points (same indexes as `path`; ports at the ends). */
  labels: string[];
  /** Cumulative km at each point of `path`. */
  cumulativeKm: number[];
  routeKm: number;
}

/** The ship's whole voyage along its lane. Throws for a definition no lane serves (a test catches it). */
export const demoRoute = (ship: DemoShip): DemoRoute => {
  const origin = waypointByLocode(ship.originLocode);
  const destination = waypointByLocode(ship.destinationLocode);
  const match = matchLane(origin, destination);
  if (!match)
    throw new Error(`demo fleet: no lane from ${ship.originLocode} to ${ship.destinationLocode}`);
  const lanePath = lanePathToDestination(match, destination);
  // lanePathToDestination starts at the origin's projection (the origin itself, it is a waypoint)
  // and ends with the destination twice (projection then port); dedupe by distance.
  const path: GeoPoint[] = [plain(origin)];
  const labels: string[] = [origin.label];
  for (const p of lanePath) {
    if (haversineKm(p, path[path.length - 1]!) <= 1e-6) continue;
    path.push(plain(p));
    const w = match.lane.waypoints.find((x) => haversineKm(x, p) <= 1e-6);
    labels.push(w?.label ?? (haversineKm(p, destination) <= 1e-6 ? destination.label : ''));
  }
  const cumulativeKm = [0];
  for (let i = 1; i < path.length; i += 1) {
    cumulativeKm.push(cumulativeKm[i - 1]! + haversineKm(path[i - 1]!, path[i]!));
  }
  return {
    laneId: match.lane.id,
    path,
    labels,
    cumulativeKm,
    routeKm: cumulativeKm[cumulativeKm.length - 1] ?? 0,
  };
};

export interface DemoPosition {
  point: GeoPoint;
  headingDeg: number;
  speedKnots: number;
  progressKm: number;
  routeKm: number;
  /** True once the whole route has been covered; the server starts the next voyage. */
  arrived: boolean;
  pollState: VesselPollState;
  /** Indexes into `route.path` of intermediate waypoints already passed (never the ports). */
  passedWaypoints: number[];
  /** Lane points still ahead (starts at `point`). */
  remaining: GeoPoint[];
}

const MS_PER_HOUR = 3_600_000;

/** Where the ship is at `now`, having left its origin at `etd` and sailed at its speed since. */
export const demoPositionAt = (ship: DemoShip, etd: Date, now: Date): DemoPosition => {
  const route = demoRoute(ship);
  const elapsedH = Math.max(0, now.getTime() - etd.getTime()) / MS_PER_HOUR;
  const progressKm = knotsToKmPerHour(ship.speedKnots) * elapsedH;
  const { point, remaining, advancedKm } = advanceAlongPath(route.path, progressKm);
  const arrived = progressKm >= route.routeKm;
  const next = remaining[1] ?? null;
  const headingDeg = next
    ? initialBearingDeg(point, next)
    : initialBearingDeg(
        route.path[route.path.length - 2] ?? point,
        route.path[route.path.length - 1]!,
      );
  const destination = route.path[route.path.length - 1]!;
  const pollState = pollStateFor(haversineKm(point, destination), nearestKm(point, CHOKE_POINTS));
  const passedWaypoints: number[] = [];
  for (let i = 1; i < route.path.length - 1; i += 1) {
    if (route.cumulativeKm[i]! <= advancedKm) passedWaypoints.push(i);
  }
  return {
    point,
    headingDeg: Math.round(headingDeg * 10) / 10,
    speedKnots: ship.speedKnots,
    progressKm: advancedKm,
    routeKm: route.routeKm,
    arrived,
    pollState,
    passedWaypoints,
    remaining,
  };
};

/** Departure time that puts the ship `hoursAtSeaAtSeed` hours into its voyage at `now`. */
export const demoEtdAtSeed = (ship: DemoShip, now: Date): Date =>
  new Date(now.getTime() - ship.hoursAtSeaAtSeed * MS_PER_HOUR);

/** Planned arrival for a departure at `etd`: route length at the ship's speed. */
export const demoEtaFor = (ship: DemoShip, etd: Date): Date => {
  const route = demoRoute(ship);
  const hours = route.routeKm / knotsToKmPerHour(ship.speedKnots);
  return new Date(etd.getTime() + hours * MS_PER_HOUR);
};

/** When a waypoint was passed for a departure at `etd` (for back-dated events). */
export const demoWaypointPassedAt = (ship: DemoShip, etd: Date, waypointIndex: number): Date => {
  const route = demoRoute(ship);
  const km = route.cumulativeKm[waypointIndex] ?? 0;
  return new Date(etd.getTime() + (km / knotsToKmPerHour(ship.speedKnots)) * MS_PER_HOUR);
};

/** Idempotency key for the "passed waypoint" event of one voyage (`etd` changes per voyage). */
export const demoWaypointEventId = (ship: DemoShip, etd: Date, waypointIndex: number): string =>
  `sim:${ship.key}:${etd.toISOString()}:wp${waypointIndex}`;

/** Idempotency keys for the three departure events of one voyage. */
export const demoDepartureEventId = (
  ship: DemoShip,
  etd: Date,
  milestone: 'GATE_IN_ORIGIN' | 'LOADED_ON_VESSEL' | 'VESSEL_DEPARTED',
): string => `sim:${ship.key}:${etd.toISOString()}:${milestone}`;
