import { createHash } from 'node:crypto';
import { nextStatus, type Milestone, type ShipmentStatus } from '@harbour/adapters/tracking/core';
import { recordAudit, trackingOrgStore, type TenantTransactionClient } from '@harbour/db';
import type { GeoPoint } from '@harbour/engine';
import type { Logger } from '../logger.server';
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
  type DemoShip,
} from './demo-fleet';

/**
 * Demo fleet persistence (see `demo-fleet.ts` for the model). Enabled by `DEMO_FLEET=on`:
 *
 *   - `seedDemoFleet`   — Home action `intent=demo-fleet-seed` (permission `shipment.track`):
 *                          three shipments/containers/vessels for the organisation, with the
 *                          departure events and the waypoints already passed, back-dated.
 *   - `advanceDemoFleet` — "tick on read": every map load (Home, tracking detail, map-state JSON)
 *                          moves each simulated vessel to where its voyage puts it now, at most
 *                          once per `DEMO_PING_INTERVAL_MS`, appends a `SIMULATED` event for each
 *                          lane waypoint passed since, and restarts the voyage on arrival. The
 *                          worker is not needed, which is the point: the demo runs on Vercel alone.
 *   - `clearDemoFleet`   — Home action `intent=demo-fleet-clear`: shipments → CANCELLED (events
 *                          are append-only, so nothing is deleted), vessels released.
 *
 * Everything goes through the organisation-scoped `tx` (RLS applies); `active_vessels` is the
 * shared pass-through table, keyed by the fictional IMO numbers, so two organisations seeding
 * the fleet share the same three hulls — exactly as two importers with boxes on one real ship.
 */

export interface DemoFleetActor {
  organizationId: string;
  userId: string;
  now: Date;
  log: Logger;
}

interface SimulatedShipmentRow {
  id: string;
  trackingRequestRef: string | null;
  etd: Date | null;
  containers: Array<{ id: string; containerNumber: string; vesselImo: string | null }>;
}

const activeSimulatedShipments = async (
  tx: TenantTransactionClient,
): Promise<SimulatedShipmentRow[]> => {
  const shipments = await tx.shipment.findMany({
    where: { trackingProvider: SIMULATED_PROVIDER, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, trackingRequestRef: true, etd: true },
  });
  if (shipments.length === 0) return [];
  const containers = await tx.container.findMany({
    where: { shipmentId: { in: shipments.map((s) => s.id) } },
    select: { id: true, shipmentId: true, containerNumber: true, vesselImo: true },
  });
  return shipments.map((s) => ({
    id: s.id,
    trackingRequestRef: s.trackingRequestRef,
    etd: s.etd,
    containers: containers
      .filter((c) => c.shipmentId === s.id)
      .map((c) => ({ id: c.id, containerNumber: c.containerNumber, vesselImo: c.vesselImo })),
  }));
};

export const hasSimulatedFleet = async (tx: TenantTransactionClient): Promise<boolean> =>
  (await tx.shipment.count({
    where: { trackingProvider: SIMULATED_PROVIDER, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
  })) > 0;

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface SimulatedEvent {
  shipmentId: string;
  containerId: string;
  providerEventId: string;
  eventType: Milestone;
  statusAfter: ShipmentStatus | null;
  occurredAt: Date;
  locationLocode: string | null;
  locationName: string | null;
  point: GeoPoint | null;
  vesselImo: string | null;
  payload: Record<string, unknown>;
}

/** Inserts once per `providerEventId` (checked first: a unique violation would abort the tx). */
const insertSimulatedEvent = async (
  tx: TenantTransactionClient,
  e: SimulatedEvent,
): Promise<boolean> => {
  const store = trackingOrgStore(tx);
  if (await store.eventExists(SIMULATED_SOURCE, e.providerEventId)) return false;
  const payload = { ...e.payload, simulated: true };
  const row = await store.insertEvent({
    shipmentId: e.shipmentId,
    containerId: e.containerId,
    source: SIMULATED_SOURCE,
    providerEventId: e.providerEventId,
    eventType: e.eventType,
    statusAfter: e.statusAfter,
    occurredAt: e.occurredAt,
    locationLocode: e.locationLocode,
    locationName: e.locationName,
    latitude: e.point?.lat ?? null,
    longitude: e.point?.lon ?? null,
    vesselImo: e.vesselImo,
    payloadSha256: sha256(payload),
    payload,
  });
  return row !== null;
};

const HOUR = 3_600_000;

/**
 * Moves one ship to its position at `now`; restarts the voyage when it has arrived. Returns the
 * voyage's departure time (new when restarted) and whether the vessel row was refreshed.
 */
const tickShip = async (
  tx: TenantTransactionClient,
  ship: DemoShip,
  row: { shipmentId: string; containerId: string; etd: Date },
  now: Date,
): Promise<{ etd: Date; refreshed: boolean; events: number }> => {
  let etd = row.etd;
  let pos = demoPositionAt(ship, etd, now);
  if (pos.arrived) {
    // Next voyage: same lane, departing now. The old voyage's events stay in the timeline.
    etd = now;
    await tx.shipment.update({
      where: { id: row.shipmentId },
      data: { etd, atd: etd, eta: demoEtaFor(ship, etd) },
    });
    pos = demoPositionAt(ship, etd, now);
  }

  const route = demoRoute(ship);
  let events = 0;
  for (const i of pos.passedWaypoints) {
    const inserted = await insertSimulatedEvent(tx, {
      shipmentId: row.shipmentId,
      containerId: row.containerId,
      providerEventId: demoWaypointEventId(ship, etd, i),
      eventType: 'OTHER',
      statusAfter: null,
      occurredAt: demoWaypointPassedAt(ship, etd, i),
      locationLocode: null,
      locationName: route.labels[i] ?? null,
      point: route.path[i] ?? null,
      vesselImo: ship.vesselImo,
      payload: { waypoint: route.labels[i] ?? null, laneId: route.laneId },
    });
    if (inserted) events += 1;
  }

  const vessel = await tx.activeVessel.findUnique({
    where: { imo: ship.vesselImo },
    select: { positionAt: true, positionSource: true },
  });
  const fresh =
    vessel?.positionSource === SIMULATED_SOURCE &&
    vessel.positionAt !== null &&
    now.getTime() - vessel.positionAt.getTime() < DEMO_PING_INTERVAL_MS;
  if (fresh) return { etd, refreshed: false, events };

  await tx.activeVessel.update({
    where: { imo: ship.vesselImo },
    data: {
      name: ship.vesselName,
      lastLatitude: pos.point.lat.toFixed(6),
      lastLongitude: pos.point.lon.toFixed(6),
      speedKnots: pos.speedKnots.toFixed(1),
      headingDeg: pos.headingDeg.toFixed(1),
      positionAt: now,
      positionSource: SIMULATED_SOURCE,
      providerEtaAt: demoEtaFor(ship, etd),
      destinationLocode: ship.destinationLocode,
      pollState: pos.pollState,
      // Never polled by the worker: a real position provider knows nothing about this hull.
      nextPollAt: null,
      lastError: null,
    },
  });
  return { etd, refreshed: true, events };
};

const DEPARTURE_SEQUENCE: ReadonlyArray<{
  milestone: 'GATE_IN_ORIGIN' | 'LOADED_ON_VESSEL' | 'VESSEL_DEPARTED';
  hoursBeforeEtd: number;
}> = [
  { milestone: 'GATE_IN_ORIGIN', hoursBeforeEtd: 36 },
  { milestone: 'LOADED_ON_VESSEL', hoursBeforeEtd: 10 },
  { milestone: 'VESSEL_DEPARTED', hoursBeforeEtd: 0 },
];

/** Creates the fleet for the organisation unless it already has one. */
export const seedDemoFleet = async (
  tx: TenantTransactionClient,
  actor: DemoFleetActor,
): Promise<{ created: number }> => {
  if (await hasSimulatedFleet(tx)) return { created: 0 };
  const { now } = actor;

  for (const ship of DEMO_SHIPS) {
    const etd = demoEtdAtSeed(ship, now);
    const eta = demoEtaFor(ship, etd);
    const route = demoRoute(ship);
    const origin = route.path[0]!;

    const shipment = await tx.shipment.create({
      data: {
        organizationId: actor.organizationId,
        reference: ship.reference,
        status: 'IN_TRANSIT',
        originLocode: ship.originLocode,
        destinationLocode: ship.destinationLocode,
        trackingProvider: SIMULATED_PROVIDER,
        trackingRequestRef: demoRequestRef(ship),
        trackingSubscribedAt: now,
        etd,
        atd: etd,
        eta,
        vesselOrFlight: ship.vesselName,
        containerNo: ship.containerNumber,
      },
      select: { id: true },
    });
    const container = await tx.container.create({
      data: {
        organizationId: actor.organizationId,
        shipmentId: shipment.id,
        containerNumber: ship.containerNumber,
        sizeType: ship.sizeType,
        vesselImo: ship.vesselImo,
        vesselName: ship.vesselName,
        voyageNumber: ship.voyageNumber,
        lastMilestone: 'VESSEL_DEPARTED',
        lastMilestoneAt: etd,
      },
      select: { id: true },
    });
    await tx.activeVessel.upsert({
      where: { imo: ship.vesselImo },
      create: {
        imo: ship.vesselImo,
        name: ship.vesselName,
        destinationLocode: ship.destinationLocode,
        pollState: 'AT_SEA',
        nextPollAt: null,
        activeContainerCount: 1,
        positionSource: SIMULATED_SOURCE,
      },
      update: {
        name: ship.vesselName,
        destinationLocode: ship.destinationLocode,
        activeContainerCount: { increment: 1 },
      },
    });

    // Departure events, back-dated, with the status each would have produced from PENDING_DOCS.
    let status: ShipmentStatus = 'PENDING_DOCS';
    for (const step of DEPARTURE_SEQUENCE) {
      status = nextStatus(status, step.milestone).statusAfter;
      await insertSimulatedEvent(tx, {
        shipmentId: shipment.id,
        containerId: container.id,
        providerEventId: demoDepartureEventId(ship, etd, step.milestone),
        eventType: step.milestone,
        statusAfter: status,
        occurredAt: new Date(etd.getTime() - step.hoursBeforeEtd * HOUR),
        locationLocode: ship.originLocode,
        locationName: route.labels[0] ?? null,
        point: origin,
        vesselImo: step.milestone === 'GATE_IN_ORIGIN' ? null : ship.vesselImo,
        payload: {
          vesselName: ship.vesselName,
          voyageNumber: ship.voyageNumber,
          laneId: route.laneId,
        },
      });
    }

    await tickShip(tx, ship, { shipmentId: shipment.id, containerId: container.id, etd }, now);

    await recordAudit(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'shipment.track',
      targetType: 'Shipment',
      targetId: shipment.id,
      metadata: { containerCount: 1, provider: SIMULATED_PROVIDER, simulated: true },
    });
  }

  actor.log.info('tracking.demo_fleet_seeded', { ships: DEMO_SHIPS.length });
  return { created: DEMO_SHIPS.length };
};

/** Tick on read: brings every simulated vessel of the organisation up to `now`. */
export const advanceDemoFleet = async (
  tx: TenantTransactionClient,
  opts: { now: Date; log: Logger },
): Promise<{ shipments: number; refreshed: number; events: number }> => {
  const rows = await activeSimulatedShipments(tx);
  let refreshed = 0;
  let events = 0;
  for (const row of rows) {
    const ship = demoShipFromRequestRef(row.trackingRequestRef);
    const container = row.containers[0];
    if (!ship || !row.etd || !container) continue;
    const r = await tickShip(
      tx,
      ship,
      { shipmentId: row.id, containerId: container.id, etd: row.etd },
      opts.now,
    );
    if (r.refreshed) refreshed += 1;
    events += r.events;
  }
  if (refreshed > 0 || events > 0) {
    opts.log.debug('tracking.demo_fleet_advanced', { shipments: rows.length, refreshed, events });
  }
  return { shipments: rows.length, refreshed, events };
};

/** Cancels the organisation's simulated shipments and releases their vessels. */
export const clearDemoFleet = async (
  tx: TenantTransactionClient,
  actor: DemoFleetActor,
): Promise<{ cleared: number }> => {
  const rows = await activeSimulatedShipments(tx);
  for (const row of rows) {
    await tx.shipment.update({
      where: { id: row.id },
      data: { status: 'CANCELLED', trackingRequestRef: null, trackingSubscribedAt: null },
    });
    for (const c of row.containers) {
      if (!c.vesselImo) continue;
      await tx.activeVessel.updateMany({
        where: { imo: c.vesselImo, activeContainerCount: { gt: 0 } },
        data: { activeContainerCount: { decrement: 1 } },
      });
    }
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'shipment.untrack',
      targetType: 'Shipment',
      targetId: row.id,
      metadata: { provider: SIMULATED_PROVIDER, simulated: true },
    });
  }
  actor.log.info('tracking.demo_fleet_cleared', { shipments: rows.length });
  return { cleared: rows.length };
};
