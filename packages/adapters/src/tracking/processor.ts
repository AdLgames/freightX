import { createHash } from 'node:crypto';
import { isAboard, nextStatus } from './state-machine.js';
import type { Milestone, NormalisedMilestone, ShipmentStatus } from './types.js';

/**
 * Milestone processor (brief §6.4, ADR-0017). Pure decision logic + a thin orchestration over
 * the `TrackingStore` port, so the same code runs in the worker (`tracking-events` queue), in
 * the web app's inline mode (no REDIS_URL) and for manual events.
 *
 * Tenancy: containers are tenant rows. `TrackingStore.findTrackedContainers` is the ONE
 * cross-organisation read (a narrow, deliberate RLS policy keyed by container number — see
 * packages/db `withTrackingLookup`); everything else runs per organisation inside
 * `withOrganization` (= `withOrgTransaction`: Prisma scope + RLS).
 *
 * Idempotency: `(organization_id, source, providerEventId)` is unique on `shipment_events` (per
 * tenant, because one provider event fans out to every tenant tracking that container); a
 * duplicate is a no-op. Illegal status transitions are stored as events but leave the status unchanged.
 */

// ---------- Ports ----------

export interface TrackedContainerRef {
  organizationId: string;
  shipmentId: string;
  containerId: string;
}

export interface ShipmentRow {
  id: string;
  status: ShipmentStatus;
  trackingProvider: string | null;
  trackingRequestRef: string | null;
  destinationLocode: string | null;
  eta: Date | null;
}

export interface ContainerRow {
  id: string;
  shipmentId: string;
  containerNumber: string;
  vesselImo: string | null;
  vesselName: string | null;
  voyageNumber: string | null;
  lastMilestone: string | null;
  lastMilestoneAt: Date | null;
}

export interface NewShipmentEvent {
  shipmentId: string;
  containerId: string | null;
  source: string;
  providerEventId: string;
  eventType: Milestone;
  statusAfter: ShipmentStatus | null;
  occurredAt: Date;
  locationLocode: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  vesselImo: string | null;
  payloadSha256: string;
  /** Provider payload, already free of PII. */
  payload: unknown;
}

export interface ShipmentPatch {
  status?: ShipmentStatus;
  eta?: Date | null;
  lastPolledAt?: Date;
}

export interface ContainerPatch {
  vesselImo?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  lastMilestone?: Milestone;
  lastMilestoneAt?: Date;
}

/** Shared `active_vessels` maintenance (non-tenant table). */
export interface VesselStore {
  /** Upsert: `activeContainerCount + 1`, state AT_SEA, `nextPollAt = now` (polls immediately). */
  addActiveContainer(
    imo: string,
    details: { name: string | null; destinationLocode: string | null; now: Date },
  ): Promise<void>;
  /** `activeContainerCount - 1` (floor 0); at zero the vessel is DOCKED (polling stops). */
  removeActiveContainer(imo: string, now: Date): Promise<void>;
}

/** Everything the processor needs inside one organisation's transaction. */
export interface TrackingOrgStore {
  getShipment(shipmentId: string): Promise<ShipmentRow | null>;
  getContainer(containerId: string): Promise<ContainerRow | null>;
  eventExists(source: string, providerEventId: string): Promise<boolean>;
  /** Returns null when `(organization, source, providerEventId)` already exists (race with a retry). */
  insertEvent(event: NewShipmentEvent): Promise<{ id: string } | null>;
  updateShipment(shipmentId: string, patch: ShipmentPatch): Promise<void>;
  updateContainer(containerId: string, patch: ContainerPatch): Promise<void>;
  vessels: VesselStore;
}

export interface TrackingStore {
  /** Cross-organisation: every container row with this number, whichever tenant tracks it. */
  findTrackedContainers(containerNumber: string): Promise<TrackedContainerRef[]>;
  withOrganization<T>(
    organizationId: string,
    fn: (org: TrackingOrgStore) => Promise<T>,
  ): Promise<T>;
}

export interface TrackingLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export const silentLog: TrackingLog = { info: () => undefined, warn: () => undefined };

// ---------- Pure decision ----------

export type VesselEffect =
  { kind: 'ADD'; imo: string; name: string | null } | { kind: 'REMOVE'; imo: string };

export interface MilestoneDecision {
  statusAfter: ShipmentStatus;
  statusChanged: boolean;
  illegal: boolean;
  /** False when the event is older than the container's last milestone (out of order). */
  advancesContainer: boolean;
  containerPatch: ContainerPatch;
  shipmentPatch: ShipmentPatch;
  vesselEffects: VesselEffect[];
}

/**
 * Decides what a milestone does to a shipment, its container and the shared vessel counts.
 * Vessel counting follows the container's aboard/ashore state so duplicates and repeats never
 * double-count: ashore→aboard adds one to the (new) vessel; aboard→ashore removes one from the
 * (previous) vessel; aboard→aboard on a different IMO (transshipment) moves the count across.
 */
export const decideMilestone = (input: {
  shipment: ShipmentRow;
  container: ContainerRow;
  event: NormalisedMilestone;
}): MilestoneDecision => {
  const { shipment, container, event } = input;
  const occurredAt = new Date(event.occurredAt);
  const status = nextStatus(shipment.status, event.milestone);
  const advancesContainer =
    container.lastMilestoneAt === null ||
    occurredAt.getTime() >= container.lastMilestoneAt.getTime();

  const shipmentPatch: ShipmentPatch = {};
  if (status.changed) shipmentPatch.status = status.statusAfter;
  if (event.etaAt !== undefined) shipmentPatch.eta = new Date(event.etaAt);

  if (!advancesContainer) {
    return {
      statusAfter: status.statusAfter,
      statusChanged: status.changed,
      illegal: status.illegal,
      advancesContainer,
      containerPatch: {},
      shipmentPatch,
      vesselEffects: [],
    };
  }

  const wasAboard = isAboard(container.lastMilestone);
  const nowAboard = event.milestone === 'OTHER' ? wasAboard : isAboard(event.milestone);
  const newImo = event.vesselImo ?? container.vesselImo;
  const containerPatch: ContainerPatch = {
    lastMilestone: event.milestone,
    lastMilestoneAt: occurredAt,
  };
  if (event.vesselImo !== undefined) containerPatch.vesselImo = event.vesselImo;
  if (event.vesselName !== undefined) containerPatch.vesselName = event.vesselName;
  if (event.voyageNumber !== undefined) containerPatch.voyageNumber = event.voyageNumber;

  const vesselEffects: VesselEffect[] = [];
  const name = event.vesselName ?? container.vesselName;
  if (!wasAboard && nowAboard && newImo) {
    vesselEffects.push({ kind: 'ADD', imo: newImo, name });
  } else if (wasAboard && !nowAboard && container.vesselImo) {
    vesselEffects.push({ kind: 'REMOVE', imo: container.vesselImo });
  } else if (
    wasAboard &&
    nowAboard &&
    newImo &&
    container.vesselImo &&
    newImo !== container.vesselImo
  ) {
    vesselEffects.push({ kind: 'REMOVE', imo: container.vesselImo });
    vesselEffects.push({ kind: 'ADD', imo: newImo, name });
  }

  return {
    statusAfter: status.statusAfter,
    statusChanged: status.changed,
    illegal: status.illegal,
    advancesContainer,
    containerPatch,
    shipmentPatch,
    vesselEffects,
  };
};

/** sha256 of the canonical JSON of the provider payload (stored for dedupe forensics, §6.4). */
export const payloadSha256 = (payload: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');

// ---------- Orchestration ----------

export interface ApplyMilestoneInput {
  shipmentId: string;
  containerId: string;
  event: NormalisedMilestone;
  /** `ShipmentEvent.source`: the provider id, `MANUAL`, `POLL`… */
  source: string;
  now: Date;
  log?: TrackingLog;
}

export type ApplyOutcome =
  | { outcome: 'INSERTED'; eventId: string; statusAfter: ShipmentStatus; illegal: boolean }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'NOT_FOUND' };

/** Applies one milestone to one container inside an organisation transaction. */
export const applyMilestone = async (
  org: TrackingOrgStore,
  input: ApplyMilestoneInput,
): Promise<ApplyOutcome> => {
  const log = input.log ?? silentLog;
  if (await org.eventExists(input.source, input.event.providerEventId)) {
    return { outcome: 'DUPLICATE' };
  }
  const [shipment, container] = await Promise.all([
    org.getShipment(input.shipmentId),
    org.getContainer(input.containerId),
  ]);
  if (!shipment || !container || container.shipmentId !== shipment.id)
    return { outcome: 'NOT_FOUND' };
  if (container.containerNumber !== input.event.containerNumber) return { outcome: 'NOT_FOUND' };

  const decision = decideMilestone({ shipment, container, event: input.event });
  const { event } = input;
  const inserted = await org.insertEvent({
    shipmentId: shipment.id,
    containerId: container.id,
    source: input.source,
    providerEventId: event.providerEventId,
    eventType: event.milestone,
    statusAfter: decision.statusAfter,
    occurredAt: new Date(event.occurredAt),
    locationLocode: event.locationLocode ?? null,
    locationName: event.locationName ?? null,
    latitude: event.latitude ?? null,
    longitude: event.longitude ?? null,
    vesselImo: event.vesselImo ?? container.vesselImo,
    payloadSha256: payloadSha256(event.raw),
    payload: event.raw ?? {},
  });
  if (!inserted) return { outcome: 'DUPLICATE' };

  if (decision.illegal) {
    log.warn('tracking.illegal_transition', {
      shipmentId: shipment.id,
      containerId: container.id,
      status: shipment.status,
      milestone: event.milestone,
      source: input.source,
    });
  }
  if (Object.keys(decision.shipmentPatch).length > 0) {
    await org.updateShipment(shipment.id, decision.shipmentPatch);
  }
  if (Object.keys(decision.containerPatch).length > 0) {
    await org.updateContainer(container.id, decision.containerPatch);
  }
  for (const effect of decision.vesselEffects) {
    if (effect.kind === 'ADD') {
      await org.vessels.addActiveContainer(effect.imo, {
        name: effect.name,
        destinationLocode: shipment.destinationLocode,
        now: input.now,
      });
    } else {
      await org.vessels.removeActiveContainer(effect.imo, input.now);
    }
  }
  return {
    outcome: 'INSERTED',
    eventId: inserted.id,
    statusAfter: decision.statusAfter,
    illegal: decision.illegal,
  };
};

export interface ProcessSummary {
  received: number;
  /** (event, organisation) pairs the events matched. */
  matched: number;
  inserted: number;
  duplicates: number;
  illegal: number;
  /** Events whose container number no organisation tracks. */
  unmatched: number;
}

/**
 * Feeds provider events to every organisation tracking the container. An organisation only ever
 * receives events for containers it tracks itself: org A's shipment never sees org B's event when
 * only B tracks that number (tested in packages/db).
 */
export const processProviderEvents = async (
  store: TrackingStore,
  events: readonly NormalisedMilestone[],
  opts: { source: string; now: Date; log?: TrackingLog },
): Promise<ProcessSummary> => {
  const log = opts.log ?? silentLog;
  const summary: ProcessSummary = {
    received: events.length,
    matched: 0,
    inserted: 0,
    duplicates: 0,
    illegal: 0,
    unmatched: 0,
  };
  for (const event of events) {
    const refs = await store.findTrackedContainers(event.containerNumber);
    if (refs.length === 0) {
      summary.unmatched += 1;
      log.info('tracking.event_unmatched', {
        source: opts.source,
        providerEventId: event.providerEventId,
      });
      continue;
    }
    for (const ref of refs) {
      summary.matched += 1;
      const result = await store.withOrganization(ref.organizationId, (org) =>
        applyMilestone(org, {
          shipmentId: ref.shipmentId,
          containerId: ref.containerId,
          event,
          source: opts.source,
          now: opts.now,
          log,
        }),
      );
      if (result.outcome === 'INSERTED') {
        summary.inserted += 1;
        if (result.illegal) summary.illegal += 1;
      } else if (result.outcome === 'DUPLICATE') {
        summary.duplicates += 1;
      }
    }
  }
  return summary;
};
