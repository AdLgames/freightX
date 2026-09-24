import type {
  ContainerPatch,
  ContainerRow,
  NewShipmentEvent,
  ShipmentPatch,
  ShipmentRow,
  TrackedContainerRef,
  TrackingOrgStore,
  TrackingStore,
  VesselStore,
} from '@harbour/adapters';
import { Prisma, type PrismaClient } from '../generated/client/index.js';
import { withOrgTransaction, type TenantTransactionClient } from './tenancy.js';

/**
 * M9 (ADR-0017) — Prisma-backed implementations of the tracking ports in `@harbour/adapters`:
 *
 *   - `PrismaTrackingStore`  what the milestone processor needs (webhook, poll fallback, manual
 *                            events): the ONE cross-tenant lookup by container number, then
 *                            per-organisation work inside `withOrgTransaction`.
 *   - `PrismaVesselPollStore` what the hourly `vessel-poll` job needs on the shared
 *                            `active_vessels` / `ports` tables (no RLS; see migration 0010).
 *
 * Cross-tenant reads are deliberate and narrow (migration 0010, policies `containers_tracking_lookup`
 * and `*_tracking_sweep`): they are gated by transaction-local settings this module sets and
 * nothing else in the app sets. Raw SQL here is reviewed (§7.5) and parameterised.
 */

// ---------- Narrow cross-tenant reads ----------

const CONTAINER_NUMBER_RE = /^[A-Z]{4}[0-9]{7}$/;

/**
 * Every (organisation, shipment, container) tracking `containerNumber`. Runs under the
 * `app.tracking_container` policy: only rows with exactly that number are visible.
 */
export const withTrackingLookup = async (
  prisma: PrismaClient,
  containerNumber: string,
): Promise<TrackedContainerRef[]> => {
  if (!CONTAINER_NUMBER_RE.test(containerNumber)) return [];
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tracking_container', ${containerNumber}, true)`;
    const rows = await tx.$queryRaw<
      Array<{ organization_id: string; shipment_id: string; container_id: string }>
    >`
      SELECT organization_id, shipment_id, id AS container_id
      FROM containers
      WHERE container_number = ${containerNumber}
      ORDER BY organization_id, shipment_id, id`;
    return rows.map((r) => ({
      organizationId: r.organization_id,
      shipmentId: r.shipment_id,
      containerId: r.container_id,
    }));
  });
};

export interface ShipmentDueForPoll {
  organizationId: string;
  shipmentId: string;
  trackingProvider: string;
  trackingRequestRef: string;
}

/**
 * Brief §6.4 polling fallback: shipments with a provider subscription, not DELIVERED/CANCELLED,
 * with no event received since `noEventSince` and not polled since `notPolledSince`. Runs under
 * the `app.tracking_sweep` policies (worker only — see the ROLE NOTE in migration 0010).
 */
export const withTrackingSweep = async (
  prisma: PrismaClient,
  input: { noEventSince: Date; notPolledSince: Date },
): Promise<ShipmentDueForPoll[]> =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tracking_sweep', 'on', true)`;
    const rows = await tx.$queryRaw<
      Array<{
        organization_id: string;
        id: string;
        tracking_provider: string;
        tracking_request_ref: string;
      }>
    >`
      SELECT s.organization_id, s.id, s.tracking_provider, s.tracking_request_ref
      FROM shipments s
      WHERE s.tracking_request_ref IS NOT NULL
        AND s.tracking_provider IS NOT NULL
        AND s.status NOT IN ('DELIVERED', 'CANCELLED')
        AND (s.last_polled_at IS NULL OR s.last_polled_at < ${input.notPolledSince})
        AND NOT EXISTS (
          SELECT 1 FROM shipment_events e
          WHERE e.shipment_id = s.id AND e.received_at > ${input.noEventSince}
        )
      ORDER BY s.organization_id, s.id`;
    return rows.map((r) => ({
      organizationId: r.organization_id,
      shipmentId: r.id,
      trackingProvider: r.tracking_provider,
      trackingRequestRef: r.tracking_request_ref,
    }));
  });

// ---------- Shared vessel table (used inside tenant transactions and by the worker) ----------

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());

/** `VesselStore` over a Prisma client or transaction (`active_vessels` is a pass-through model). */
export class PrismaVesselStore implements VesselStore {
  constructor(
    private readonly db:
      Pick<TenantTransactionClient, 'activeVessel'> | Pick<PrismaClient, 'activeVessel'>,
  ) {}

  async addActiveContainer(
    imo: string,
    details: { name: string | null; destinationLocode: string | null; now: Date },
  ): Promise<void> {
    await this.db.activeVessel.upsert({
      where: { imo },
      create: {
        imo,
        name: details.name,
        destinationLocode: details.destinationLocode,
        pollState: 'AT_SEA',
        nextPollAt: details.now,
        activeContainerCount: 1,
        lastError: null,
      },
      update: {
        activeContainerCount: { increment: 1 },
        pollState: 'AT_SEA',
        nextPollAt: details.now,
        lastError: null,
        ...(details.name !== null ? { name: details.name } : {}),
        ...(details.destinationLocode !== null
          ? { destinationLocode: details.destinationLocode }
          : {}),
      },
    });
  }

  async removeActiveContainer(imo: string, _now: Date): Promise<void> {
    const current = await this.db.activeVessel.findUnique({
      where: { imo },
      select: { activeContainerCount: true },
    });
    if (!current) return;
    const count = Math.max(0, current.activeContainerCount - 1);
    await this.db.activeVessel.update({
      where: { imo },
      data: {
        activeContainerCount: count,
        // Kill switch (ADR-0017): at zero the vessel is DOCKED and polling stops.
        ...(count === 0 ? { pollState: 'DOCKED', nextPollAt: null } : {}),
      },
    });
  }
}

// ---------- Milestone processor store ----------

const shipmentSelect = {
  id: true,
  status: true,
  trackingProvider: true,
  trackingRequestRef: true,
  destinationLocode: true,
  eta: true,
} as const;

const containerSelect = {
  id: true,
  shipmentId: true,
  containerNumber: true,
  vesselImo: true,
  vesselName: true,
  voyageNumber: true,
  lastMilestone: true,
  lastMilestoneAt: true,
} as const;

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** `TrackingOrgStore` over one organisation's scoped transaction. */
export const trackingOrgStore = (tx: TenantTransactionClient): TrackingOrgStore => ({
  async getShipment(shipmentId): Promise<ShipmentRow | null> {
    return tx.shipment.findUnique({ where: { id: shipmentId }, select: shipmentSelect });
  },
  async getContainer(containerId): Promise<ContainerRow | null> {
    return tx.container.findUnique({ where: { id: containerId }, select: containerSelect });
  },
  async eventExists(source, providerEventId) {
    const n = await tx.shipmentEvent.count({ where: { source, providerEventId } });
    return n > 0;
  },
  async insertEvent(event: NewShipmentEvent) {
    try {
      const organizationId = (
        await tx.shipment.findUniqueOrThrow({
          where: { id: event.shipmentId },
          select: { organizationId: true },
        })
      ).organizationId;
      const row = await tx.shipmentEvent.create({
        data: {
          organizationId,
          shipmentId: event.shipmentId,
          containerId: event.containerId,
          source: event.source,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          statusAfter: event.statusAfter,
          occurredAt: event.occurredAt,
          locationLocode: event.locationLocode,
          locationName: event.locationName,
          latitude: event.latitude === null ? null : new Prisma.Decimal(event.latitude.toFixed(6)),
          longitude:
            event.longitude === null ? null : new Prisma.Decimal(event.longitude.toFixed(6)),
          vesselImo: event.vesselImo,
          payloadSha256: event.payloadSha256,
          payload: (event.payload ?? {}) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  },
  async updateShipment(shipmentId, patch: ShipmentPatch) {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.eta !== undefined ? { eta: patch.eta } : {}),
        ...(patch.lastPolledAt !== undefined ? { lastPolledAt: patch.lastPolledAt } : {}),
      },
    });
  },
  async updateContainer(containerId, patch: ContainerPatch) {
    await tx.container.update({
      where: { id: containerId },
      data: {
        ...(patch.vesselImo !== undefined ? { vesselImo: patch.vesselImo } : {}),
        ...(patch.vesselName !== undefined ? { vesselName: patch.vesselName } : {}),
        ...(patch.voyageNumber !== undefined ? { voyageNumber: patch.voyageNumber } : {}),
        ...(patch.lastMilestone !== undefined ? { lastMilestone: patch.lastMilestone } : {}),
        ...(patch.lastMilestoneAt !== undefined ? { lastMilestoneAt: patch.lastMilestoneAt } : {}),
      },
    });
  },
  vessels: new PrismaVesselStore(tx),
});

/** `TrackingStore` over the process-wide Prisma client. */
export class PrismaTrackingStore implements TrackingStore {
  constructor(private readonly prisma: PrismaClient) {}

  findTrackedContainers(containerNumber: string): Promise<TrackedContainerRef[]> {
    return withTrackingLookup(this.prisma, containerNumber);
  }

  withOrganization<T>(
    organizationId: string,
    fn: (org: TrackingOrgStore) => Promise<T>,
  ): Promise<T> {
    return withOrgTransaction(this.prisma, organizationId, (tx) => fn(trackingOrgStore(tx)));
  }
}

// ---------- Vessel poll (worker) ----------

export interface ActiveVesselRow {
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
  pollState: 'AT_SEA' | 'COASTAL' | 'APPROACHING' | 'DOCKED' | 'STALE';
  nextPollAt: Date | null;
  lastError: string | null;
  activeContainerCount: number;
}

export interface VesselPositionPatch {
  name?: string | null;
  lastLatitude: number;
  lastLongitude: number;
  speedKnots: number;
  headingDeg: number;
  positionAt: Date;
  positionSource: string;
  providerEtaAt?: Date | null;
  destinationLocode?: string | null;
  pollState: ActiveVesselRow['pollState'];
  nextPollAt: Date | null;
}

export interface PortRow {
  locode: string;
  name: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  chokePoint: boolean;
}

export const toActiveVesselRow = (v: {
  imo: string;
  name: string | null;
  lastLatitude: Prisma.Decimal | null;
  lastLongitude: Prisma.Decimal | null;
  speedKnots: Prisma.Decimal | null;
  headingDeg: Prisma.Decimal | null;
  positionAt: Date | null;
  positionSource: string | null;
  providerEtaAt: Date | null;
  destinationLocode: string | null;
  pollState: ActiveVesselRow['pollState'];
  nextPollAt: Date | null;
  lastError: string | null;
  activeContainerCount: number;
}): ActiveVesselRow => ({
  imo: v.imo,
  name: v.name,
  lastLatitude: num(v.lastLatitude),
  lastLongitude: num(v.lastLongitude),
  speedKnots: num(v.speedKnots),
  headingDeg: num(v.headingDeg),
  positionAt: v.positionAt,
  positionSource: v.positionSource,
  providerEtaAt: v.providerEtaAt,
  destinationLocode: v.destinationLocode,
  pollState: v.pollState,
  nextPollAt: v.nextPollAt,
  lastError: v.lastError,
  activeContainerCount: v.activeContainerCount,
});

export const toPortRow = (p: {
  locode: string;
  name: string;
  countryCode: string;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  chokePoint: boolean;
}): PortRow => ({
  locode: p.locode,
  name: p.name,
  countryCode: p.countryCode,
  latitude: p.latitude.toNumber(),
  longitude: p.longitude.toNumber(),
  chokePoint: p.chokePoint,
});

/** Port of the shared `active_vessels` / `ports` tables for the worker's `vessel-poll` job. */
export interface VesselPollPort {
  listDue(now: Date): Promise<ActiveVesselRow[]>;
  listPorts(): Promise<PortRow[]>;
  recordPosition(imo: string, patch: VesselPositionPatch): Promise<void>;
  /** Consecutive-failure bookkeeping; the job decides when STALE applies. */
  recordFailure(
    imo: string,
    input: { lastError: string; pollState: ActiveVesselRow['pollState']; nextPollAt: Date | null },
  ): Promise<void>;
}

export class PrismaVesselPollStore implements VesselPollPort {
  constructor(private readonly prisma: PrismaClient) {}

  async listDue(now: Date): Promise<ActiveVesselRow[]> {
    const rows = await this.prisma.activeVessel.findMany({
      where: { nextPollAt: { lte: now }, pollState: { not: 'DOCKED' } },
      orderBy: [{ nextPollAt: 'asc' }, { imo: 'asc' }],
    });
    return rows.map(toActiveVesselRow);
  }

  async listPorts(): Promise<PortRow[]> {
    const rows = await this.prisma.port.findMany({ orderBy: { locode: 'asc' } });
    return rows.map(toPortRow);
  }

  async recordPosition(imo: string, patch: VesselPositionPatch): Promise<void> {
    await this.prisma.activeVessel.update({
      where: { imo },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        lastLatitude: new Prisma.Decimal(patch.lastLatitude.toFixed(6)),
        lastLongitude: new Prisma.Decimal(patch.lastLongitude.toFixed(6)),
        speedKnots: new Prisma.Decimal(patch.speedKnots.toFixed(1)),
        headingDeg: new Prisma.Decimal(patch.headingDeg.toFixed(1)),
        positionAt: patch.positionAt,
        positionSource: patch.positionSource,
        ...(patch.providerEtaAt !== undefined ? { providerEtaAt: patch.providerEtaAt } : {}),
        ...(patch.destinationLocode !== undefined
          ? { destinationLocode: patch.destinationLocode }
          : {}),
        pollState: patch.pollState,
        nextPollAt: patch.nextPollAt,
        lastError: null,
      },
    });
  }

  async recordFailure(
    imo: string,
    input: { lastError: string; pollState: ActiveVesselRow['pollState']; nextPollAt: Date | null },
  ): Promise<void> {
    await this.prisma.activeVessel.update({
      where: { imo },
      data: {
        lastError: input.lastError,
        pollState: input.pollState,
        nextPollAt: input.nextPollAt,
      },
    });
  }
}
