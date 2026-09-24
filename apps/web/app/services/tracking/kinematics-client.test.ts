import * as engine from '@harbour/engine';
import { describe, expect, it } from 'vitest';
import * as client from '../../lib/kinematics-client';

/**
 * M9 — the browser copy of the kinematics must not drift from the engine. Same inputs, same
 * outputs, to floating-point precision.
 */
const HOUR = 3_600_000;
const samples = [
  { a: { lat: 5, lon: 80 }, b: { lat: 12.6, lon: 43.3 } },
  { a: { lat: 51.95, lon: 1.35 }, b: { lat: 51.95, lon: 4.05 } },
  { a: { lat: -33.9, lon: 18.4 }, b: { lat: 1.26, lon: 103.85 } },
  { a: { lat: 0, lon: 179.5 }, b: { lat: 0, lon: -179.5 } },
];

describe('kinematics-client matches the engine', () => {
  it('haversine, bearing and destination point', () => {
    for (const { a, b } of samples) {
      expect(client.haversineKm(a, b)).toBeCloseTo(engine.haversineKm(a, b), 9);
      expect(client.initialBearingDeg(a, b)).toBeCloseTo(engine.initialBearingDeg(a, b), 9);
      for (const km of [1, 250, 4000]) {
        const bearing = engine.initialBearingDeg(a, b);
        const e = engine.destinationPoint(a, bearing, km);
        const c = client.destinationPoint(a, bearing, km);
        expect(c.lat).toBeCloseTo(e.lat, 9);
        expect(c.lon).toBeCloseTo(e.lon, 9);
      }
    }
    expect(client.KM_PER_NAUTICAL_MILE).toBe(engine.KM_PER_NAUTICAL_MILE);
    expect(client.EARTH_RADIUS_KM).toBe(engine.EARTH_RADIUS_KM);
  });

  it('advanceAlongPath and the uncertainty heuristic', () => {
    const lane = engine.LANES[0]!;
    const path = lane.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    for (const km of [0, 10, 1234.5, 100_000]) {
      const e = engine.advanceAlongPath(path, km);
      const c = client.advanceAlongPath(path, km);
      expect(c.point.lat).toBeCloseTo(e.point.lat, 9);
      expect(c.point.lon).toBeCloseTo(e.point.lon, 9);
      expect(c.remaining.length).toBe(e.remaining.length);
      expect(c.advancedKm).toBeCloseTo(e.advancedKm, 9);
    }
    for (const [ms, v] of [
      [0, 0],
      [3 * HOUR, 18],
      [40 * HOUR, 25],
    ] as const) {
      expect(client.uncertaintyRadiusKm(ms, v)).toBeCloseTo(engine.uncertaintyRadiusKm(ms, v), 12);
    }
  });

  it('advanceClient continues the server reckoning and never exceeds the shared cap', () => {
    const at = new Date('2026-09-23T00:00:00Z');
    const lastPing = { lat: 5, lon: 80, speedKnots: 18, headingDeg: 300, positionAt: at };
    const destination = { lat: 51.95, lon: 1.35 };
    const cap = 20 * HOUR;
    const server = engine.deadReckonAlongLane(
      { lastPing, destination },
      new Date(at.getTime() + 5 * HOUR),
      { maxExtrapolationMs: cap },
    );
    const input = {
      start: { lat: server.lat, lon: server.lon },
      serverExtrapolatedMs: server.extrapolatedMs,
      maxExtrapolationMs: cap,
      speedKnots: 18,
      headingDeg: 300,
      expectedPath: server.remainingPath,
    };
    // 3 more hours in the browser = what the server would compute at +8 h.
    const c = client.advanceClient(input, 3 * HOUR);
    const e = engine.deadReckonAlongLane(
      { lastPing, destination },
      new Date(at.getTime() + 8 * HOUR),
      { maxExtrapolationMs: cap },
    );
    expect(c.point.lat).toBeCloseTo(e.lat, 6);
    expect(c.point.lon).toBeCloseTo(e.lon, 6);
    expect(c.extrapolatedMs).toBe(8 * HOUR);
    expect(c.capped).toBe(false);

    // Way beyond the cap: stops at the +20 h point.
    const capped = client.advanceClient(input, 100 * HOUR);
    const eCap = engine.deadReckonAlongLane(
      { lastPing, destination },
      new Date(at.getTime() + 100 * HOUR),
      { maxExtrapolationMs: cap },
    );
    expect(capped.capped).toBe(true);
    expect(capped.extrapolatedMs).toBe(cap);
    expect(capped.point.lat).toBeCloseTo(eCap.lat, 6);
    expect(capped.point.lon).toBeCloseTo(eCap.lon, 6);

    // Heading fallback (no lane path).
    const straight = client.advanceClient(
      { ...input, expectedPath: [], start: { lat: 30, lon: -40 } },
      2 * HOUR,
    );
    const eStraight = engine.deadReckon(
      { lat: 30, lon: -40, speedKnots: 18, headingDeg: 300, positionAt: at },
      new Date(at.getTime() + 2 * HOUR),
      { maxExtrapolationMs: cap },
    );
    expect(straight.point.lat).toBeCloseTo(eStraight.lat, 9);
    expect(straight.point.lon).toBeCloseTo(eStraight.lon, 9);
    expect(straight.remaining).toEqual([]);
  });
});
