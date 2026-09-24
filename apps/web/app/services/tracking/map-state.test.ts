import { haversineKm, knotsToKmPerHour } from '@harbour/engine';
import { describe, expect, it } from 'vitest';
import { computeMapState, type MapContainerInput, type MapVesselInput } from './map-state';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-30T10:00:00Z');
const PORTS = [
  { locode: 'GBFXT', name: 'Felixstowe', latitude: 51.95, longitude: 1.35 },
  { locode: 'CNSZX', name: 'Shenzhen', latitude: 22.5, longitude: 113.9 },
];

const container = (over: Partial<MapContainerInput> = {}): MapContainerInput => ({
  containerId: 'c1',
  shipmentId: 's1',
  containerNumber: 'CSQU3054383',
  shipmentReference: 'ref',
  status: 'IN_TRANSIT',
  vesselImo: '9074729',
  shipmentEta: null,
  destinationLocode: 'GBFXT',
  eventPoints: [{ lat: 22.5, lon: 113.9 }],
  ...over,
});

const vessel = (over: Partial<MapVesselInput> = {}): MapVesselInput => ({
  imo: '9074729',
  name: 'EXAMPLE MAERSK',
  lastLatitude: 5.0,
  lastLongitude: 80.0,
  speedKnots: 18,
  headingDeg: 300,
  positionAt: new Date(NOW.getTime() - 5 * HOUR),
  positionSource: 'SPIRE',
  providerEtaAt: new Date('2026-10-28T06:00:00Z'),
  destinationLocode: 'GBFXT',
  pollState: 'AT_SEA',
  ...over,
});

describe('computeMapState', () => {
  it('dead-reckons along the lane from the last real ping, keeps the source, and builds both paths', () => {
    const s = computeMapState(
      { containers: [container()], vessels: [vessel()], ports: PORTS },
      NOW,
    );
    expect(s.serverNow).toBe(NOW.toISOString());
    const c = s.containers[0]!;
    expect(c.ping).toEqual({
      lat: 5,
      lon: 80,
      speedKnots: 18,
      headingDeg: 300,
      positionAt: vessel().positionAt!.toISOString(),
      positionSource: 'SPIRE',
    });
    expect(c.reckoned).toMatchObject({
      method: 'lane',
      laneId: 'ASIA_EUROPE_SUEZ',
      capped: false,
      extrapolatedMs: 5 * HOUR,
    });
    const moved = haversineKm({ lat: 5, lon: 80 }, { lat: c.reckoned!.lat, lon: c.reckoned!.lon });
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(knotsToKmPerHour(18) * 5 * 1.01);
    expect(c.uncertaintyRadiusKm).toBeCloseTo(2 + 0.05 * knotsToKmPerHour(18) * 5, 6);
    expect(c.maxExtrapolationMs).toBe(20 * HOUR);
    // Solid path: events then the REAL ping (never the reckoned point).
    expect(c.actualPath).toEqual([
      { lat: 22.5, lon: 113.9 },
      { lat: 5, lon: 80 },
    ]);
    // Dashed path: from the reckoned point to the destination.
    expect(c.expectedPath[0]).toEqual({ lat: c.reckoned!.lat, lon: c.reckoned!.lon });
    expect(c.expectedPath[c.expectedPath.length - 1]).toEqual({ lat: 51.95, lon: 1.35 });
    expect(c.destination).toEqual({ locode: 'GBFXT', name: 'Felixstowe', lat: 51.95, lon: 1.35 });
    expect(c.carrierEtaAt).toBe('2026-10-28T06:00:00.000Z');
    expect(c.vessel).toEqual({ imo: '9074729', name: 'EXAMPLE MAERSK', pollState: 'AT_SEA' });
  });

  it('caps extrapolation at the poll interval + 2 h and flags it', () => {
    const s = computeMapState(
      {
        containers: [container()],
        vessels: [vessel({ positionAt: new Date(NOW.getTime() - 30 * HOUR) })],
        ports: PORTS,
      },
      NOW,
    );
    const c = s.containers[0]!;
    expect(c.reckoned).toMatchObject({ capped: true, extrapolatedMs: 20 * HOUR });
    expect(haversineKm({ lat: 5, lon: 80 }, c.reckoned!)).toBeLessThanOrEqual(
      knotsToKmPerHour(18) * 20 * 1.01,
    );
  });

  it('a STALE or DOCKED vessel is never extrapolated ("last seen"); no ping → nothing to draw', () => {
    const stale = computeMapState(
      { containers: [container()], vessels: [vessel({ pollState: 'STALE' })], ports: PORTS },
      NOW,
    ).containers[0]!;
    expect(stale.reckoned).toBeNull();
    expect(stale.expectedPath).toEqual([]);
    expect(stale.ping?.positionSource).toBe('SPIRE');
    expect(stale.uncertaintyRadiusKm).toBe(2);
    const docked = computeMapState(
      { containers: [container()], vessels: [vessel({ pollState: 'DOCKED' })], ports: PORTS },
      NOW,
    ).containers[0]!;
    expect(docked.reckoned).toBeNull();
    const none = computeMapState(
      {
        containers: [container()],
        vessels: [vessel({ lastLatitude: null, lastLongitude: null, positionAt: null })],
        ports: PORTS,
      },
      NOW,
    ).containers[0]!;
    expect(none.ping).toBeNull();
    expect(none.reckoned).toBeNull();
    expect(none.actualPath).toEqual([{ lat: 22.5, lon: 113.9 }]);
    const noVessel = computeMapState(
      { containers: [container({ vesselImo: null })], vessels: [], ports: PORTS },
      NOW,
    ).containers[0]!;
    expect(noVessel.vessel).toBeNull();
    expect(noVessel.carrierEtaAt).toBeNull();
  });

  it('falls back to heading-based reckoning without a destination or off every lane', () => {
    const noDest = computeMapState(
      {
        containers: [container({ destinationLocode: null })],
        vessels: [vessel({ destinationLocode: null })],
        ports: PORTS,
      },
      NOW,
    ).containers[0]!;
    expect(noDest.reckoned?.method).toBe('heading');
    expect(noDest.expectedPath).toEqual([]);
    expect(noDest.destination).toBeNull();
    const atlantic = computeMapState(
      {
        containers: [container()],
        vessels: [vessel({ lastLatitude: 30, lastLongitude: -40 })],
        ports: PORTS,
      },
      NOW,
    ).containers[0]!;
    expect(atlantic.reckoned?.method).toBe('heading');
    expect(atlantic.reckoned?.laneId).toBeNull();
  });
});
