import {
  deadReckon,
  deadReckonAlongLane,
  maxExtrapolationMsFor,
  uncertaintyRadiusKm,
  type GeoPoint,
  type VesselPollState,
} from '@harbour/engine';

/**
 * M9 (ADR-0017) — the map's data contract, computed on the server from real rows and re-animated
 * in the browser. Pure module (no I/O, no Prisma) so it is unit-tested and its types are shared
 * with the client component. Nothing computed here is ever stored: the real ping keeps its
 * `positionSource`; extrapolated points exist only in this response.
 */

export interface MapPing {
  lat: number;
  lon: number;
  speedKnots: number;
  headingDeg: number;
  /** ISO time of the real AIS fix. */
  positionAt: string;
  /** The provider that produced the fix, e.g. SPIRE. Never an extrapolation. */
  positionSource: string | null;
}

export interface MapReckoned {
  lat: number;
  lon: number;
  extrapolatedMs: number;
  capped: boolean;
  method: 'lane' | 'heading';
  laneId: string | null;
}

export interface MapContainerState {
  containerId: string;
  shipmentId: string;
  containerNumber: string;
  shipmentReference: string | null;
  status: string;
  vessel: { imo: string; name: string | null; pollState: VesselPollState } | null;
  /** The last real ping, or null when the vessel has never been positioned. */
  ping: MapPing | null;
  /** Server-side dead reckoning at `serverNow`; null without a ping, or when STALE (shown as "last seen"). */
  reckoned: MapReckoned | null;
  uncertaintyRadiusKm: number;
  /** Cap for client-side extrapolation, measured from `ping.positionAt`. */
  maxExtrapolationMs: number;
  /** Solid line: event coordinates in time order, then the real ping. */
  actualPath: GeoPoint[];
  /** Dashed line: from the reckoned position along the lane to the destination (empty for heading fallback). */
  expectedPath: GeoPoint[];
  destination: { locode: string; name: string; lat: number; lon: number } | null;
  /** Provider ETA (ISO), labelled "Carrier ETA" in the UI. */
  carrierEtaAt: string | null;
}

export interface MapState {
  /** ISO time the state was computed; the client measures its own elapsed time from here. */
  serverNow: string;
  containers: MapContainerState[];
}

// ---------- Inputs (already tenant-scoped rows, coordinates as numbers) ----------

export interface MapContainerInput {
  containerId: string;
  shipmentId: string;
  containerNumber: string;
  shipmentReference: string | null;
  status: string;
  vesselImo: string | null;
  shipmentEta: Date | null;
  destinationLocode: string | null;
  /** Events with coordinates, ascending by occurredAt. */
  eventPoints: GeoPoint[];
}

export interface MapVesselInput {
  imo: string;
  name: string | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  speedKnots: number | null;
  headingDeg: number | null;
  positionAt: Date | null;
  positionSource: string | null;
  providerEtaAt: Date | null;
  destinationLocode: string | null;
  pollState: VesselPollState;
}

export interface MapPortInput {
  locode: string;
  name: string;
  latitude: number;
  longitude: number;
}

export const computeMapState = (
  input: {
    containers: readonly MapContainerInput[];
    vessels: readonly MapVesselInput[];
    ports: readonly MapPortInput[];
  },
  now: Date,
): MapState => {
  const vessels = new Map(input.vessels.map((v) => [v.imo, v]));
  const ports = new Map(input.ports.map((p) => [p.locode, p]));

  const containers = input.containers.map((c): MapContainerState => {
    const vessel = c.vesselImo ? (vessels.get(c.vesselImo) ?? null) : null;
    const destLocode = c.destinationLocode ?? vessel?.destinationLocode ?? null;
    const port = destLocode ? (ports.get(destLocode) ?? null) : null;
    const destination = port
      ? { locode: port.locode, name: port.name, lat: port.latitude, lon: port.longitude }
      : null;

    const ping: MapPing | null =
      vessel &&
      vessel.lastLatitude !== null &&
      vessel.lastLongitude !== null &&
      vessel.positionAt !== null
        ? {
            lat: vessel.lastLatitude,
            lon: vessel.lastLongitude,
            speedKnots: vessel.speedKnots ?? 0,
            headingDeg: vessel.headingDeg ?? 0,
            positionAt: vessel.positionAt.toISOString(),
            positionSource: vessel.positionSource,
          }
        : null;

    const pollState: VesselPollState = vessel?.pollState ?? 'AT_SEA';
    const maxExtrapolationMs = maxExtrapolationMsFor(pollState);
    let reckoned: MapReckoned | null = null;
    let expectedPath: GeoPoint[] = [];
    let radiusKm = 0;

    // ADR-0017: a STALE vessel is shown as "last seen", never extrapolated.
    if (ping && vessel && pollState !== 'STALE' && pollState !== 'DOCKED') {
      const lastPing = {
        lat: ping.lat,
        lon: ping.lon,
        speedKnots: ping.speedKnots,
        headingDeg: ping.headingDeg,
        positionAt: new Date(ping.positionAt),
      };
      const r = destination
        ? deadReckonAlongLane({ lastPing, destination }, now, { maxExtrapolationMs })
        : {
            ...deadReckon(lastPing, now, { maxExtrapolationMs }),
            method: 'heading' as const,
            laneId: null,
            remainingPath: [],
          };
      reckoned = {
        lat: r.lat,
        lon: r.lon,
        extrapolatedMs: r.extrapolatedMs,
        capped: r.capped,
        method: r.method,
        laneId: r.laneId,
      };
      expectedPath = r.remainingPath;
      radiusKm = uncertaintyRadiusKm(r.extrapolatedMs, ping.speedKnots);
    } else if (ping) {
      radiusKm = uncertaintyRadiusKm(0, 0);
    }

    const actualPath: GeoPoint[] = [...c.eventPoints];
    if (ping) actualPath.push({ lat: ping.lat, lon: ping.lon });

    const eta = vessel?.providerEtaAt ?? c.shipmentEta;
    return {
      containerId: c.containerId,
      shipmentId: c.shipmentId,
      containerNumber: c.containerNumber,
      shipmentReference: c.shipmentReference,
      status: c.status,
      vessel: vessel ? { imo: vessel.imo, name: vessel.name, pollState } : null,
      ping,
      reckoned,
      uncertaintyRadiusKm: radiusKm,
      maxExtrapolationMs,
      actualPath,
      expectedPath,
      destination,
      carrierEtaAt: eta ? eta.toISOString() : null,
    };
  });

  return { serverNow: now.toISOString(), containers };
};
