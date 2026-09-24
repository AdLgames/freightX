import { isValidContainerNumber, isValidImo } from '@harbour/adapters/tracking/core';
import { haversineKm, knotsToKmPerHour } from '@harbour/engine';
import { describe, expect, it } from 'vitest';
import {
  DEMO_PING_INTERVAL_MS,
  DEMO_SHIPS,
  SIMULATED_PROVIDER,
  SIMULATED_SOURCE,
  demoDepartureEventId,
  demoEtaFor,
  demoEtdAtSeed,
  demoPositionAt,
  demoRequestRef,
  demoRoute,
  demoShipFromRequestRef,
  demoWaypointEventId,
  demoWaypointPassedAt,
} from './demo-fleet';

const NOW = new Date('2026-09-24T12:00:00Z');
const HOUR = 3_600_000;

describe('demo fleet definitions', () => {
  it('has three ships whose numbers pass the real check-digit validators', () => {
    expect(DEMO_SHIPS).toHaveLength(3);
    for (const s of DEMO_SHIPS) {
      expect(isValidContainerNumber(s.containerNumber)).toBe(true);
      expect(isValidImo(s.vesselImo)).toBe(true);
      expect(s.reference.startsWith('Demo')).toBe(true);
      expect(s.vesselName.startsWith('SIM ')).toBe(true);
    }
    expect(new Set(DEMO_SHIPS.map((s) => s.key)).size).toBe(3);
    expect(new Set(DEMO_SHIPS.map((s) => s.vesselImo)).size).toBe(3);
    expect(new Set(DEMO_SHIPS.map((s) => s.containerNumber)).size).toBe(3);
  });

  it('labels simulated rows unmistakably', () => {
    expect(SIMULATED_SOURCE).toBe('SIMULATED');
    expect(SIMULATED_PROVIDER).toBe('simulated');
    expect(DEMO_PING_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('round-trips the tracking request ref', () => {
    for (const s of DEMO_SHIPS) expect(demoShipFromRequestRef(demoRequestRef(s))).toBe(s);
    expect(demoShipFromRequestRef('t49_abc')).toBeNull();
    expect(demoShipFromRequestRef(null)).toBeNull();
    expect(demoShipFromRequestRef('sim:nope')).toBeNull();
  });
});

describe('demoRoute', () => {
  it('runs every ship along a lane from its origin port to its destination port', () => {
    for (const s of DEMO_SHIPS) {
      const r = demoRoute(s);
      expect(r.path.length).toBeGreaterThan(10);
      expect(r.labels).toHaveLength(r.path.length);
      expect(r.labels.every((l) => l !== '')).toBe(true);
      expect(r.routeKm).toBeGreaterThan(5_000);
      expect(r.cumulativeKm[0]).toBe(0);
      expect(r.cumulativeKm[r.cumulativeKm.length - 1]).toBeCloseTo(r.routeKm, 6);
      // No zero-length steps: the origin and destination appear once each.
      for (let i = 1; i < r.path.length; i += 1) {
        expect(haversineKm(r.path[i - 1]!, r.path[i]!)).toBeGreaterThan(1);
      }
    }
    expect(demoRoute(DEMO_SHIPS[0]!).laneId).toBe('ASIA_EUROPE_SUEZ');
    expect(demoRoute(DEMO_SHIPS[1]!).laneId).toBe('INDIA_EUROPE_SUEZ');
  });

  it('throws for a pair no lane serves', () => {
    expect(() =>
      demoRoute({ ...DEMO_SHIPS[0]!, originLocode: 'DEHAM', destinationLocode: 'CNSHA' }),
    ).toThrow(/no lane/);
  });
});

describe('demoPositionAt', () => {
  it('starts at the origin, advances at the ship speed and arrives at the destination', () => {
    const s = DEMO_SHIPS[0]!;
    const r = demoRoute(s);
    const etd = new Date('2026-09-01T00:00:00Z');
    const start = demoPositionAt(s, etd, etd);
    expect(haversineKm(start.point, r.path[0]!)).toBeLessThan(0.001);
    expect(start.progressKm).toBe(0);
    expect(start.arrived).toBe(false);
    expect(start.passedWaypoints).toEqual([]);

    const tenHours = demoPositionAt(s, etd, new Date(etd.getTime() + 10 * HOUR));
    expect(tenHours.progressKm).toBeCloseTo(knotsToKmPerHour(s.speedKnots) * 10, 3);
    // Along the lane, so the crow-flies distance from the origin is at most the distance sailed.
    const fromOrigin = haversineKm(tenHours.point, r.path[0]!);
    expect(fromOrigin).toBeGreaterThan(100);
    expect(fromOrigin).toBeLessThanOrEqual(tenHours.progressKm + 0.5);
    expect(tenHours.headingDeg).toBeGreaterThanOrEqual(0);
    expect(tenHours.headingDeg).toBeLessThan(360);

    const end = demoPositionAt(s, etd, new Date(etd.getTime() + 60 * 24 * HOUR));
    expect(end.arrived).toBe(true);
    expect(haversineKm(end.point, r.path[r.path.length - 1]!)).toBeLessThan(0.001);
    expect(end.passedWaypoints).toEqual(r.path.slice(1, -1).map((_, i) => i + 1));
    expect(end.pollState).toBe('APPROACHING');
  });

  it('is monotonic in time and never reports a port as a passed waypoint', () => {
    const s = DEMO_SHIPS[1]!;
    const etd = new Date('2026-09-01T00:00:00Z');
    let last = -1;
    for (let h = 0; h <= 20 * 24; h += 12) {
      const p = demoPositionAt(s, etd, new Date(etd.getTime() + h * HOUR));
      expect(p.progressKm).toBeGreaterThanOrEqual(last);
      last = p.progressKm;
      expect(p.passedWaypoints.includes(0)).toBe(false);
      expect(p.passedWaypoints.includes(demoRoute(s).path.length - 1)).toBe(false);
    }
  });

  it('seeds each ship somewhere at sea, not yet arrived, on its own lane segment', () => {
    for (const s of DEMO_SHIPS) {
      const etd = demoEtdAtSeed(s, NOW);
      expect(NOW.getTime() - etd.getTime()).toBe(s.hoursAtSeaAtSeed * HOUR);
      const p = demoPositionAt(s, etd, NOW);
      expect(p.arrived).toBe(false);
      expect(p.progressKm).toBeGreaterThan(0);
      expect(p.progressKm / p.routeKm).toBeLessThan(0.98);
      expect(p.passedWaypoints.length).toBeGreaterThan(0);
      expect(demoEtaFor(s, etd).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('dates passed waypoints between departure and now', () => {
    const s = DEMO_SHIPS[0]!;
    const etd = demoEtdAtSeed(s, NOW);
    const p = demoPositionAt(s, etd, NOW);
    let prev = etd.getTime();
    for (const i of p.passedWaypoints) {
      const at = demoWaypointPassedAt(s, etd, i).getTime();
      expect(at).toBeGreaterThanOrEqual(prev);
      expect(at).toBeLessThanOrEqual(NOW.getTime());
      prev = at;
    }
  });

  it('keys events per voyage so a restarted voyage gets new ids', () => {
    const s = DEMO_SHIPS[2]!;
    const a = new Date('2026-09-01T00:00:00Z');
    const b = new Date('2026-09-28T00:00:00Z');
    expect(demoWaypointEventId(s, a, 3)).not.toBe(demoWaypointEventId(s, b, 3));
    expect(demoWaypointEventId(s, a, 3)).not.toBe(demoWaypointEventId(s, a, 4));
    expect(demoDepartureEventId(s, a, 'VESSEL_DEPARTED')).toContain('VESSEL_DEPARTED');
    expect(demoDepartureEventId(s, a, 'VESSEL_DEPARTED')).not.toBe(
      demoDepartureEventId(s, a, 'LOADED_ON_VESSEL'),
    );
  });
});
