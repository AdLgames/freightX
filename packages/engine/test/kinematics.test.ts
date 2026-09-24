import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  APPROACHING_KM,
  CHOKE_POINTS,
  LANES,
  LANE_MATCH_KM,
  advanceAlongPath,
  deadReckon,
  deadReckonAlongLane,
  destinationPoint,
  haversineKm,
  initialBearingDeg,
  knotsToKmPerHour,
  lanePathToDestination,
  matchLane,
  maxExtrapolationMsFor,
  nearestKm,
  nearestLanePoint,
  nextPollDelayMs,
  pollStateFor,
  uncertaintyRadiusKm,
  type GeoPoint,
} from '../src/kinematics.js';

const HOUR = 3_600_000;
const FELIXSTOWE: GeoPoint = { lat: 51.95, lon: 1.35 };
const SUEZ: GeoPoint = { lat: 29.97, lon: 32.55 };
const SINGAPORE: GeoPoint = { lat: 1.26, lon: 103.85 };
const LONDON: GeoPoint = { lat: 51.5074, lon: -0.1278 };
const PARIS: GeoPoint = { lat: 48.8566, lon: 2.3522 };

const point = fc.record({
  lat: fc.double({ min: -85, max: 85, noNaN: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true }),
});

describe('haversineKm / destinationPoint', () => {
  it('London–Paris is about 344 km', () => {
    expect(haversineKm(LONDON, PARIS)).toBeCloseTo(343.5, 0);
    expect(haversineKm(LONDON, LONDON)).toBe(0);
  });

  it('destinationPoint then haversine round-trips within 0.5% (property)', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0.1, max: 5000, noNaN: true }),
        (origin, bearing, km) => {
          const dest = destinationPoint(origin, bearing, km);
          expect(dest.lon).toBeGreaterThanOrEqual(-180);
          expect(dest.lon).toBeLessThanOrEqual(180);
          const back = haversineKm(origin, dest);
          expect(Math.abs(back - km)).toBeLessThanOrEqual(km * 0.005 + 1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('initial bearing: due north and due east', () => {
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0, 6);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90, 6);
  });
});

describe('deadReckon', () => {
  const ping = {
    lat: 5.4,
    lon: 80.5,
    speedKnots: 18,
    headingDeg: 270,
    positionAt: new Date('2026-09-23T00:00:00Z'),
  };

  it('advances speed × elapsed along the heading', () => {
    const r = deadReckon(ping, new Date('2026-09-23T02:00:00Z'), {
      maxExtrapolationMs: 20 * HOUR,
    });
    expect(r.capped).toBe(false);
    expect(r.extrapolatedMs).toBe(2 * HOUR);
    expect(r.advancedKm).toBeCloseTo(knotsToKmPerHour(18) * 2, 6);
    expect(haversineKm(ping, r)).toBeCloseTo(r.advancedKm, 3);
    expect(r.lon).toBeLessThan(ping.lon); // heading west
  });

  it('never exceeds the cap (property) and reports capped', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.integer({ min: 0, max: 100 * HOUR }),
        fc.integer({ min: 0, max: 30 * HOUR }),
        (p, speedKnots, headingDeg, elapsedMs, capMs) => {
          const at = new Date('2026-01-01T00:00:00Z');
          const r = deadReckon(
            { ...p, speedKnots, headingDeg, positionAt: at },
            new Date(at.getTime() + elapsedMs),
            { maxExtrapolationMs: capMs },
          );
          expect(r.extrapolatedMs).toBeLessThanOrEqual(capMs);
          expect(r.capped).toBe(elapsedMs > capMs);
          const maxKm = knotsToKmPerHour(speedKnots) * (capMs / HOUR);
          expect(haversineKm(p, r)).toBeLessThanOrEqual(maxKm * 1.005 + 1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a ping from the future or a stopped ship stays put', () => {
    const r = deadReckon(ping, new Date('2026-09-22T00:00:00Z'), { maxExtrapolationMs: HOUR });
    expect(r).toMatchObject({ lat: ping.lat, lon: ping.lon, extrapolatedMs: 0, capped: false });
    const s = deadReckon({ ...ping, speedKnots: 0 }, new Date('2026-09-23T05:00:00Z'), {
      maxExtrapolationMs: 20 * HOUR,
    });
    expect(s).toMatchObject({ lat: ping.lat, lon: ping.lon, advancedKm: 0 });
    const nan = deadReckon({ ...ping, speedKnots: Number.NaN }, new Date('2026-09-23T05:00:00Z'), {
      maxExtrapolationMs: 20 * HOUR,
    });
    expect(nan.advancedKm).toBe(0);
  });
});

describe('uncertaintyRadiusKm', () => {
  it('is the 2 km floor at the ping and grows 5% of distance travelled', () => {
    expect(uncertaintyRadiusKm(0, 20)).toBe(2);
    expect(uncertaintyRadiusKm(10 * HOUR, 20)).toBeCloseTo(2 + 0.05 * knotsToKmPerHour(20) * 10, 9);
    expect(uncertaintyRadiusKm(-5, 20)).toBe(2);
    expect(uncertaintyRadiusKm(HOUR, -3)).toBe(2);
  });

  it('never shrinks as time passes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 48 * HOUR }),
        fc.integer({ min: 0, max: 48 * HOUR }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        (a, b, v) => {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          expect(uncertaintyRadiusKm(hi, v)).toBeGreaterThanOrEqual(uncertaintyRadiusKm(lo, v));
        },
      ),
    );
  });
});

describe('polling policy', () => {
  it('pollStateFor thresholds: approaching < 50 nmi, coastal < 200 km of a choke point', () => {
    expect(APPROACHING_KM).toBeCloseTo(92.6, 6);
    expect(pollStateFor(50, 1000)).toBe('APPROACHING');
    expect(pollStateFor(92.6, 1000)).toBe('APPROACHING');
    expect(pollStateFor(93, 150)).toBe('COASTAL');
    expect(pollStateFor(93, 200)).toBe('COASTAL');
    expect(pollStateFor(2000, 201)).toBe('AT_SEA');
    expect(pollStateFor(2000, Number.POSITIVE_INFINITY)).toBe('AT_SEA');
  });

  it('nextPollDelayMs: 18 h at sea, 5 h coastal, 1 h approaching, none when docked', () => {
    expect(nextPollDelayMs('AT_SEA')).toBe(18 * HOUR);
    expect(nextPollDelayMs('COASTAL')).toBe(5 * HOUR);
    expect(nextPollDelayMs('APPROACHING')).toBe(HOUR);
    expect(nextPollDelayMs('DOCKED')).toBeNull();
    expect(nextPollDelayMs('STALE')).toBe(24 * HOUR);
    expect(maxExtrapolationMsFor('AT_SEA')).toBe(20 * HOUR);
    expect(maxExtrapolationMsFor('DOCKED')).toBe(2 * HOUR);
  });

  it('nearestKm over the choke-point table', () => {
    expect(CHOKE_POINTS.length).toBeGreaterThan(8);
    expect(nearestKm(SUEZ, CHOKE_POINTS)).toBeLessThan(1);
    expect(nearestKm({ lat: 12.5, lon: 58 }, CHOKE_POINTS)).toBeGreaterThan(200);
    expect(nearestKm(SUEZ, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('lanes', () => {
  it('every lane has ≥ 3 waypoints, and the choke points named in ADR-0017 are present', () => {
    const labels = CHOKE_POINTS.map((c) => c.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Suez', 'Singapore', 'Strait of Gibraltar', 'Strait of Dover']),
    );
    for (const lane of LANES) expect(lane.waypoints.length).toBeGreaterThanOrEqual(3);
    const locodes = LANES.flatMap((l) => l.waypoints.map((w) => w.locode)).filter(Boolean);
    expect(locodes).toEqual(
      expect.arrayContaining([
        'CNSHA',
        'CNSZX',
        'SGSIN',
        'EGSUZ',
        'EGPSD',
        'INNSA',
        'TRIST',
        'GBFXT',
      ]),
    );
  });

  it('nearestLanePoint projects onto the closest segment with along-track distance', () => {
    const lane = LANES.find((l) => l.id === 'ASIA_EUROPE_SUEZ')!;
    const start = nearestLanePoint(lane.waypoints[0]!, lane);
    expect(start.alongKm).toBe(0);
    expect(start.distanceKm).toBeLessThan(1e-6);
    const nearSriLanka = nearestLanePoint({ lat: 5.0, lon: 80.0 }, lane);
    expect(nearSriLanka.distanceKm).toBeLessThan(80);
    expect(nearSriLanka.alongKm).toBeGreaterThan(nearestLanePoint(SINGAPORE, lane).alongKm);
    expect(nearSriLanka.alongKm).toBeLessThan(nearestLanePoint(SUEZ, lane).alongKm);
  });

  it('matchLane finds the Asia–Europe lane south of Sri Lanka bound for Felixstowe, and nothing mid-Atlantic', () => {
    const m = matchLane({ lat: 5.0, lon: 80.0 }, FELIXSTOWE);
    expect(m?.lane.id).toBe('ASIA_EUROPE_SUEZ');
    expect(matchLane({ lat: 30, lon: -40 }, FELIXSTOWE)).toBeNull();
    // A destination the lane never reaches (Cape Town) is not matched either.
    expect(matchLane({ lat: 5.0, lon: 80.0 }, { lat: -33.9, lon: 18.4 })).toBeNull();
  });

  it('lanePathToDestination runs towards the destination in either direction', () => {
    const toUk = matchLane({ lat: 5.0, lon: 80.0 }, FELIXSTOWE)!;
    const path = lanePathToDestination(toUk, FELIXSTOWE);
    expect(path[path.length - 1]).toEqual(FELIXSTOWE);
    // Suez comes before Gibraltar on the way to the UK.
    const idx = (p: GeoPoint) => path.findIndex((q) => haversineKm(q, p) < 1);
    expect(idx(SUEZ)).toBeGreaterThan(0);
    expect(idx({ lat: 35.95, lon: -5.6 })).toBeGreaterThan(idx(SUEZ));

    const toSingapore = matchLane({ lat: 5.0, lon: 80.0 }, SINGAPORE)!;
    const back = lanePathToDestination(toSingapore, SINGAPORE);
    expect(back[back.length - 1]).toEqual(SINGAPORE);
    expect(back.some((q) => haversineKm(q, SUEZ) < 1)).toBe(false);
  });

  it('advanceAlongPath turns at waypoints and stops at the end', () => {
    const path: GeoPoint[] = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
    ];
    const seg = haversineKm(path[0]!, path[1]!);
    const a = advanceAlongPath(path, seg / 2);
    expect(a.point.lat).toBeCloseTo(0, 6);
    expect(a.point.lon).toBeCloseTo(0.5, 3);
    expect(a.remaining).toHaveLength(3);
    const b = advanceAlongPath(path, seg + 10);
    expect(b.point.lon).toBeCloseTo(1, 3);
    expect(b.point.lat).toBeGreaterThan(0);
    expect(b.remaining).toHaveLength(2);
    const end = advanceAlongPath(path, 10_000);
    expect(end.point).toEqual(path[2]);
    expect(end.remaining).toEqual([path[2]]);
    expect(advanceAlongPath([], 5).remaining).toEqual([]);
  });
});

describe('deadReckonAlongLane', () => {
  const at = new Date('2026-09-23T00:00:00Z');
  const ping = { lat: 5.0, lon: 80.0, speedKnots: 18, headingDeg: 300, positionAt: at };

  it('a ping near Sri Lanka bound for Felixstowe advances towards Suez, not into Africa', () => {
    const now = new Date(at.getTime() + 120 * HOUR); // 5 days at 18 kn ≈ 4000 km
    const r = deadReckonAlongLane({ lastPing: ping, destination: FELIXSTOWE }, now, {
      maxExtrapolationMs: 200 * HOUR,
    });
    expect(r.method).toBe('lane');
    expect(r.laneId).toBe('ASIA_EUROPE_SUEZ');
    expect(r.capped).toBe(false);
    // Closer to Suez than when it started, and still at sea north of the Horn of Africa.
    expect(haversineKm(r, SUEZ)).toBeLessThan(haversineKm(ping, SUEZ));
    expect(r.lat).toBeGreaterThan(11);
    expect(r.lon).toBeGreaterThan(38);
    expect(r.lon).toBeLessThan(50);
    // The straight-line version would have gone WNW across the ocean, far from the lane.
    const straight = deadReckon(ping, now, { maxExtrapolationMs: 200 * HOUR });
    expect(haversineKm(straight, r)).toBeGreaterThan(500);
    // Remaining path starts at the extrapolated point and ends at the destination.
    expect(r.remainingPath[0]).toEqual({ lat: r.lat, lon: r.lon });
    expect(r.remainingPath[r.remainingPath.length - 1]).toEqual(FELIXSTOWE);
  });

  it('respects the cap and stops at the destination', () => {
    const capped = deadReckonAlongLane(
      { lastPing: ping, destination: FELIXSTOWE },
      new Date(at.getTime() + 100 * HOUR),
      { maxExtrapolationMs: 20 * HOUR },
    );
    expect(capped.capped).toBe(true);
    expect(capped.extrapolatedMs).toBe(20 * HOUR);
    expect(capped.advancedKm).toBeCloseTo(knotsToKmPerHour(18) * 20, 6);

    const arrived = deadReckonAlongLane(
      { lastPing: ping, destination: FELIXSTOWE },
      new Date(at.getTime() + 2000 * HOUR),
      { maxExtrapolationMs: 3000 * HOUR },
    );
    expect(arrived.lat).toBeCloseTo(FELIXSTOWE.lat, 6);
    expect(arrived.lon).toBeCloseTo(FELIXSTOWE.lon, 6);
    expect(arrived.remainingPath).toEqual([FELIXSTOWE]);
  });

  it('falls back to heading-based reckoning when no lane is within 150 km', () => {
    const atlantic = { lat: 30, lon: -40, speedKnots: 15, headingDeg: 45, positionAt: at };
    const later = new Date(at.getTime() + 3 * HOUR);
    const r = deadReckonAlongLane({ lastPing: atlantic, destination: FELIXSTOWE }, later, {
      maxExtrapolationMs: 20 * HOUR,
    });
    expect(r.method).toBe('heading');
    expect(r.laneId).toBeNull();
    expect(r.remainingPath).toEqual([]);
    expect(r).toMatchObject(deadReckon(atlantic, later, { maxExtrapolationMs: 20 * HOUR }));
    expect(LANE_MATCH_KM).toBe(150);
  });

  it('never exceeds speed × elapsed by more than 1% (property, along-track and straight-line)', () => {
    const laneStarts = LANES.flatMap((l) => l.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })));
    fc.assert(
      fc.property(
        fc.constantFrom(...laneStarts),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 25, noNaN: true }),
        fc.integer({ min: 0, max: 400 * HOUR }),
        fc.integer({ min: 0, max: 400 * HOUR }),
        fc.constantFrom(FELIXSTOWE, SINGAPORE, SUEZ, { lat: 18.95, lon: 72.95 }),
        (start, dLat, dLon, speedKnots, elapsedMs, capMs, destination) => {
          const lastPing = {
            lat: start.lat + dLat,
            lon: start.lon + dLon,
            speedKnots,
            headingDeg: 0,
            positionAt: at,
          };
          const r = deadReckonAlongLane(
            { lastPing, destination },
            new Date(at.getTime() + elapsedMs),
            { maxExtrapolationMs: capMs },
          );
          const budgetKm = knotsToKmPerHour(speedKnots) * (r.extrapolatedMs / HOUR);
          expect(r.extrapolatedMs).toBeLessThanOrEqual(capMs);
          expect(r.advancedKm).toBeLessThanOrEqual(budgetKm * 1.01 + 1e-6);
          expect(haversineKm(lastPing, r)).toBeLessThanOrEqual(budgetKm * 1.01 + 1e-6);
          if (r.method === 'lane') {
            expect(r.remainingPath[r.remainingPath.length - 1]).toEqual(destination);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
