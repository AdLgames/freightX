import {
  applyMilestone,
  normalisedMilestoneSchema,
  type ApplyOutcome,
  type MilestoneProvider,
} from '@harbour/adapters';
import {
  recordAudit,
  toActiveVesselRow,
  toPortRow,
  trackingOrgStore,
  type ActiveVesselRow,
  type PortRow,
  type TenantTransactionClient,
} from '@harbour/db';
import { randomUUID } from 'node:crypto';
import type { GeoPoint } from '@harbour/engine';
import type { ManualEventInput, TrackShipmentInput } from '../../validators/tracking';
import type { Logger } from '../logger.server';
import { computeMapState, type MapContainerInput, type MapState } from './map-state';

/**
 * M9 (ADR-0017) — every tracking read/write the routes need, each taking the org-scoped `tx`
 * from `withOrg` (Prisma tenant scope + RLS). `active_vessels` and `ports` are pass-through
 * (shared) models and are read through the same `tx`.
 */

const dec = (d: { toNumber(): number } | null): number | null => (d === null ? null : d.toNumber());

// ---------- Lists ----------

export interface ShipmentListRow {
  id: string;
  reference: string | null;
  status: string;
  originLocode: string | null;
  destinationLocode: string | null;
  masterBillNumber: string | null;
  trackingProvider: string | null;
  eta: string | null;
  createdAt: string;
  containers: Array<{
    id: string;
    containerNumber: string;
    lastMilestone: string | null;
    lastMilestoneAt: string | null;
    vesselName: string | null;
    vesselImo: string | null;
  }>;
}

export const listShipments = async (tx: TenantTransactionClient): Promise<ShipmentListRow[]> => {
  const rows = await tx.shipment.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 200,
    select: {
      id: true,
      reference: true,
      status: true,
      originLocode: true,
      destinationLocode: true,
      masterBillNumber: true,
      trackingProvider: true,
      eta: true,
      createdAt: true,
      containers: {
        orderBy: { containerNumber: 'asc' },
        select: {
          id: true,
          containerNumber: true,
          lastMilestone: true,
          lastMilestoneAt: true,
          vesselName: true,
          vesselImo: true,
        },
      },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    reference: s.reference,
    status: s.status,
    originLocode: s.originLocode,
    destinationLocode: s.destinationLocode,
    masterBillNumber: s.masterBillNumber,
    trackingProvider: s.trackingProvider,
    eta: s.eta?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    containers: s.containers.map((c) => ({
      id: c.id,
      containerNumber: c.containerNumber,
      lastMilestone: c.lastMilestone,
      lastMilestoneAt: c.lastMilestoneAt?.toISOString() ?? null,
      vesselName: c.vesselName,
      vesselImo: c.vesselImo,
    })),
  }));
};

export const listPorts = async (tx: TenantTransactionClient): Promise<PortRow[]> =>
  (await tx.port.findMany({ orderBy: { name: 'asc' } })).map(toPortRow);

/** Quotes a shipment may link to (ADR-0013 sidebar later): id + a short label, no money. */
export const listLinkableQuotes = async (
  tx: TenantTransactionClient,
): Promise<Array<{ id: string; label: string }>> => {
  const quotes = await tx.quote.findMany({
    where: { status: { in: ['READY', 'ACCEPTED', 'INDICATIVE'] }, shipment: null },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, originPort: true, destinationPort: true, status: true, createdAt: true },
  });
  return quotes.map((q) => ({
    id: q.id,
    label: `${q.originPort ?? '?'} → ${q.destinationPort ?? '?'} · ${q.status} · ${q.createdAt.toISOString().slice(0, 10)}`,
  }));
};

// ---------- Create ----------

export interface TrackShipmentContext {
  organizationId: string;
  userId: string;
  provider: MilestoneProvider;
  now: Date;
  log: Logger;
}

export interface TrackShipmentResult {
  shipmentId: string;
  containerIds: string[];
  subscription: { ok: true; providerRef: string } | { ok: false; reason: string; message: string };
}

/**
 * Creates the Shipment + Containers, then subscribes with the provider. The provider call happens
 * inside the transaction so a provider that says "invalid" rolls the rows back; a provider that
 * is merely not configured or unavailable still lets the shipment exist (manual events work).
 */
export const trackShipment = async (
  tx: TenantTransactionClient,
  ctx: TrackShipmentContext,
  input: TrackShipmentInput,
): Promise<TrackShipmentResult> => {
  const shipmentId = randomUUID();
  await tx.shipment.create({
    data: {
      id: shipmentId,
      organizationId: ctx.organizationId,
      reference: input.reference,
      masterBillNumber: input.masterBillNumber ?? null,
      originLocode: input.originLocode ?? null,
      destinationLocode: input.destinationLocode ?? null,
      quoteId: input.quoteId ?? null,
      status: 'PENDING_DOCS',
    },
  });
  const containerIds: string[] = [];
  for (const containerNumber of input.containerNumbers) {
    const c = await tx.container.create({
      data: {
        organizationId: ctx.organizationId,
        shipmentId,
        containerNumber,
        sizeType: input.sizeType ?? null,
      },
      select: { id: true },
    });
    containerIds.push(c.id);
  }

  const subscribeReq = input.masterBillNumber
    ? { masterBillNumber: input.masterBillNumber }
    : { containerNumber: input.containerNumbers[0] ?? '' };
  const result = await ctx.provider.subscribe(subscribeReq);
  let subscription: TrackShipmentResult['subscription'];
  if (result.ok) {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: {
        trackingProvider: ctx.provider.id,
        trackingRequestRef: result.providerRef,
        trackingSubscribedAt: ctx.now,
      },
    });
    subscription = { ok: true, providerRef: result.providerRef };
  } else {
    if (result.reason === 'INVALID') {
      // Roll the whole thing back: the provider could not track this number.
      throw new TrackShipmentError(result.message);
    }
    subscription = { ok: false, reason: result.reason, message: result.message };
  }

  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'shipment.track',
    targetType: 'Shipment',
    targetId: shipmentId,
    metadata: {
      containerCount: containerIds.length,
      provider: ctx.provider.id,
      subscribed: subscription.ok,
      quoteId: input.quoteId ?? null,
    },
  });
  ctx.log.info('tracking.shipment_tracked', {
    shipmentId,
    containers: containerIds.length,
    provider: ctx.provider.id,
    subscribed: subscription.ok,
  });
  return { shipmentId, containerIds, subscription };
};

export class TrackShipmentError extends Error {
  override readonly name = 'TrackShipmentError';
}

/** Stops provider tracking (audit `shipment.untrack`); the shipment and its events stay. */
export const untrackShipment = async (
  tx: TenantTransactionClient,
  ctx: TrackShipmentContext,
  shipmentId: string,
): Promise<{ ok: boolean; message?: string }> => {
  const shipment = await tx.shipment.findUnique({
    where: { id: shipmentId },
    select: { trackingRequestRef: true, trackingProvider: true },
  });
  if (!shipment?.trackingRequestRef) return { ok: true };
  const r = await ctx.provider.unsubscribe(shipment.trackingRequestRef);
  if (!r.ok) return r;
  await tx.shipment.update({
    where: { id: shipmentId },
    data: { trackingRequestRef: null, trackingSubscribedAt: null },
  });
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action: 'shipment.untrack',
    targetType: 'Shipment',
    targetId: shipmentId,
    metadata: { provider: shipment.trackingProvider },
  });
  return { ok: true };
};

// ---------- Manual milestone ----------

export const addManualEvent = async (
  tx: TenantTransactionClient,
  ctx: { organizationId: string; userId: string; now: Date; log: Logger },
  shipmentId: string,
  input: ManualEventInput,
): Promise<ApplyOutcome> => {
  const container = await tx.container.findUnique({
    where: { id: input.containerId },
    select: { containerNumber: true, shipmentId: true },
  });
  if (!container || container.shipmentId !== shipmentId) return { outcome: 'NOT_FOUND' };
  const event = normalisedMilestoneSchema.parse({
    providerEventId: randomUUID(),
    containerNumber: container.containerNumber,
    milestone: input.milestone,
    occurredAt: input.occurredAt,
    ...(input.locationLocode ? { locationLocode: input.locationLocode } : {}),
    ...(input.locationName ? { locationName: input.locationName } : {}),
    ...(input.vesselImo ? { vesselImo: input.vesselImo } : {}),
    ...(input.vesselName ? { vesselName: input.vesselName } : {}),
    ...(input.voyageNumber ? { voyageNumber: input.voyageNumber } : {}),
    ...(input.latitude !== undefined && input.longitude !== undefined
      ? { latitude: input.latitude, longitude: input.longitude }
      : {}),
    // The note is user free text: kept in the event payload (tenant row), never logged.
    raw: { enteredByUserId: ctx.userId, note: input.note ?? null },
  });
  return applyMilestone(trackingOrgStore(tx), {
    shipmentId,
    containerId: input.containerId,
    event,
    source: 'MANUAL',
    now: ctx.now,
    log: { info: (e, f) => ctx.log.info(e, f), warn: (e, f) => ctx.log.warn(e, f) },
  });
};

// ---------- Detail ----------

export interface ShipmentDetail {
  shipment: {
    id: string;
    reference: string | null;
    status: string;
    originLocode: string | null;
    destinationLocode: string | null;
    masterBillNumber: string | null;
    quoteId: string | null;
    trackingProvider: string | null;
    trackingRequestRef: string | null;
    trackingSubscribedAt: string | null;
    eta: string | null;
    createdAt: string;
  };
  containers: Array<{
    id: string;
    containerNumber: string;
    sizeType: string | null;
    vesselImo: string | null;
    vesselName: string | null;
    voyageNumber: string | null;
    lastMilestone: string | null;
    lastMilestoneAt: string | null;
  }>;
  events: Array<{
    id: string;
    containerNumber: string | null;
    source: string;
    eventType: string;
    statusAfter: string | null;
    occurredAt: string;
    receivedAt: string;
    locationLocode: string | null;
    locationName: string | null;
    vesselImo: string | null;
    latitude: number | null;
    longitude: number | null;
  }>;
  vessels: Array<{
    imo: string;
    name: string | null;
    speedKnots: number | null;
    headingDeg: number | null;
    positionAt: string | null;
    positionSource: string | null;
    providerEtaAt: string | null;
    pollState: ActiveVesselRow['pollState'];
    lastLatitude: number | null;
    lastLongitude: number | null;
  }>;
  ports: Record<string, string>;
}

export const getShipmentDetail = async (
  tx: TenantTransactionClient,
  shipmentId: string,
): Promise<ShipmentDetail | null> => {
  const s = await tx.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      containers: { orderBy: { containerNumber: 'asc' } },
      events: {
        orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
        take: 500,
        include: { container: { select: { containerNumber: true } } },
      },
    },
  });
  if (!s) return null;
  const imos = [...new Set(s.containers.map((c) => c.vesselImo).filter((i): i is string => !!i))];
  const vessels = imos.length
    ? await tx.activeVessel.findMany({ where: { imo: { in: imos } } })
    : [];
  const locodes = new Set<string>();
  for (const l of [s.originLocode, s.destinationLocode]) if (l) locodes.add(l);
  for (const e of s.events) if (e.locationLocode) locodes.add(e.locationLocode);
  const ports = locodes.size
    ? await tx.port.findMany({
        where: { locode: { in: [...locodes] } },
        select: { locode: true, name: true },
      })
    : [];
  return {
    shipment: {
      id: s.id,
      reference: s.reference,
      status: s.status,
      originLocode: s.originLocode,
      destinationLocode: s.destinationLocode,
      masterBillNumber: s.masterBillNumber,
      quoteId: s.quoteId,
      trackingProvider: s.trackingProvider,
      trackingRequestRef: s.trackingRequestRef,
      trackingSubscribedAt: s.trackingSubscribedAt?.toISOString() ?? null,
      eta: s.eta?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    },
    containers: s.containers.map((c) => ({
      id: c.id,
      containerNumber: c.containerNumber,
      sizeType: c.sizeType,
      vesselImo: c.vesselImo,
      vesselName: c.vesselName,
      voyageNumber: c.voyageNumber,
      lastMilestone: c.lastMilestone,
      lastMilestoneAt: c.lastMilestoneAt?.toISOString() ?? null,
    })),
    events: s.events.map((e) => ({
      id: e.id,
      containerNumber: e.container?.containerNumber ?? null,
      source: e.source,
      eventType: e.eventType,
      statusAfter: e.statusAfter,
      occurredAt: e.occurredAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      locationLocode: e.locationLocode,
      locationName: e.locationName,
      vesselImo: e.vesselImo,
      latitude: dec(e.latitude),
      longitude: dec(e.longitude),
    })),
    vessels: vessels.map(toActiveVesselRow).map((v) => ({
      imo: v.imo,
      name: v.name,
      speedKnots: v.speedKnots,
      headingDeg: v.headingDeg,
      positionAt: v.positionAt?.toISOString() ?? null,
      positionSource: v.positionSource,
      providerEtaAt: v.providerEtaAt?.toISOString() ?? null,
      pollState: v.pollState,
      lastLatitude: v.lastLatitude,
      lastLongitude: v.lastLongitude,
    })),
    ports: Object.fromEntries(ports.map((p) => [p.locode, p.name])),
  };
};

// ---------- Map state ----------

/** Active = not delivered/cancelled. Optionally limited to one shipment. */
export const loadMapState = async (
  tx: TenantTransactionClient,
  opts: { shipmentId?: string | undefined; now: Date },
): Promise<MapState> => {
  const containers = await tx.container.findMany({
    where: {
      ...(opts.shipmentId ? { shipmentId: opts.shipmentId } : {}),
      shipment: { status: { notIn: ['DELIVERED', 'CANCELLED'] } },
    },
    orderBy: { containerNumber: 'asc' },
    take: 200,
    select: {
      id: true,
      shipmentId: true,
      containerNumber: true,
      vesselImo: true,
      shipment: { select: { reference: true, status: true, eta: true, destinationLocode: true } },
      events: {
        where: { latitude: { not: null }, longitude: { not: null } },
        orderBy: { occurredAt: 'asc' },
        select: { latitude: true, longitude: true },
      },
    },
  });
  const imos = [...new Set(containers.map((c) => c.vesselImo).filter((i): i is string => !!i))];
  const vessels = imos.length
    ? await tx.activeVessel.findMany({ where: { imo: { in: imos } } })
    : [];
  const ports = (await tx.port.findMany()).map(toPortRow);
  const input: MapContainerInput[] = containers.map((c) => ({
    containerId: c.id,
    shipmentId: c.shipmentId,
    containerNumber: c.containerNumber,
    shipmentReference: c.shipment.reference,
    status: c.shipment.status,
    vesselImo: c.vesselImo,
    shipmentEta: c.shipment.eta,
    destinationLocode: c.shipment.destinationLocode,
    eventPoints: c.events
      .map((e): GeoPoint | null =>
        e.latitude !== null && e.longitude !== null
          ? { lat: e.latitude.toNumber(), lon: e.longitude.toNumber() }
          : null,
      )
      .filter((p): p is GeoPoint => p !== null),
  }));
  return computeMapState(
    {
      containers: input,
      vessels: vessels.map(toActiveVesselRow),
      ports,
    },
    opts.now,
  );
};
