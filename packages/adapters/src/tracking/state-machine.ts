import { type Milestone, type ShipmentStatus } from './types.js';

/**
 * The `ShipmentStatus` state machine (brief §6.4): "transitions defined in one table; illegal
 * transitions log a warning and are stored as events but do not change status". This is that
 * table. Row = milestone; `to` = the status the milestone moves the shipment to (null = the
 * milestone never changes status); `from` = the statuses it may legally move from. A milestone
 * whose `to` equals the current status is a legal no-op (e.g. a second transshipment while
 * IN_TRANSIT).
 */
export interface Transition {
  to: ShipmentStatus | null;
  from: readonly ShipmentStatus[];
}

const PRE_TRANSIT: readonly ShipmentStatus[] = ['PENDING_DOCS', 'PENDING_BOOKING', 'BOOKED'];
const PRE_SEA: readonly ShipmentStatus[] = [...PRE_TRANSIT, 'DISPATCHED'];
const AT_SEA: readonly ShipmentStatus[] = [...PRE_SEA, 'IN_TRANSIT'];
const LANDED: readonly ShipmentStatus[] = ['AT_DESTINATION', 'CUSTOMS', 'CLEARED'];

export const TRANSITIONS: Readonly<Record<Milestone, Transition>> = {
  GATE_IN_ORIGIN: { to: 'DISPATCHED', from: PRE_SEA },
  LOADED_ON_VESSEL: { to: 'IN_TRANSIT', from: AT_SEA },
  VESSEL_DEPARTED: { to: 'IN_TRANSIT', from: AT_SEA },
  TRANSSHIPMENT_ARRIVED: { to: 'IN_TRANSIT', from: AT_SEA },
  TRANSSHIPMENT_DEPARTED: { to: 'IN_TRANSIT', from: AT_SEA },
  VESSEL_ARRIVED: { to: 'AT_DESTINATION', from: [...AT_SEA, 'AT_DESTINATION'] },
  DISCHARGED_DESTINATION: { to: 'AT_DESTINATION', from: [...AT_SEA, 'AT_DESTINATION'] },
  GATE_OUT_DESTINATION: { to: 'OUT_FOR_DELIVERY', from: [...LANDED, 'OUT_FOR_DELIVERY'] },
  EMPTY_RETURNED: { to: 'DELIVERED', from: [...LANDED, 'OUT_FOR_DELIVERY', 'DELIVERED'] },
  OTHER: { to: null, from: [] },
};

export interface StatusDecision {
  /** Status to record on the event (`statusAfter`): the new status, or the unchanged current one. */
  statusAfter: ShipmentStatus;
  /** True when the shipment's status should be updated. */
  changed: boolean;
  /** True when the table forbids the move: the event is stored, the status is not changed. */
  illegal: boolean;
}

/** Applies the table. Terminal states (DELIVERED, CANCELLED, EXCEPTION) never move on a milestone. */
export const nextStatus = (current: ShipmentStatus, milestone: Milestone): StatusDecision => {
  const t = TRANSITIONS[milestone];
  if (t.to === null) return { statusAfter: current, changed: false, illegal: false };
  if (t.to === current) return { statusAfter: current, changed: false, illegal: false };
  if (!t.from.includes(current)) return { statusAfter: current, changed: false, illegal: true };
  return { statusAfter: t.to, changed: true, illegal: false };
};

/** Milestones after which the container is physically aboard a vessel (drives ActiveVessel counts). */
export const ABOARD_MILESTONES: readonly Milestone[] = [
  'LOADED_ON_VESSEL',
  'VESSEL_DEPARTED',
  'TRANSSHIPMENT_DEPARTED',
];
/** Milestones after which the container is ashore. `OTHER` leaves the aboard state as it was. */
export const ASHORE_MILESTONES: readonly Milestone[] = [
  'GATE_IN_ORIGIN',
  'TRANSSHIPMENT_ARRIVED',
  'VESSEL_ARRIVED',
  'DISCHARGED_DESTINATION',
  'GATE_OUT_DESTINATION',
  'EMPTY_RETURNED',
];

export const isAboard = (milestone: string | null | undefined): boolean =>
  milestone !== null &&
  milestone !== undefined &&
  (ABOARD_MILESTONES as readonly string[]).includes(milestone);

/** Human labels for the timeline (UI); provider names never leak through here. */
export const MILESTONE_LABELS: Readonly<Record<Milestone, string>> = {
  GATE_IN_ORIGIN: 'Gate in at origin',
  LOADED_ON_VESSEL: 'Loaded on vessel',
  VESSEL_DEPARTED: 'Vessel departed',
  TRANSSHIPMENT_ARRIVED: 'Arrived at transshipment port',
  TRANSSHIPMENT_DEPARTED: 'Departed transshipment port',
  VESSEL_ARRIVED: 'Vessel arrived',
  DISCHARGED_DESTINATION: 'Discharged at destination',
  GATE_OUT_DESTINATION: 'Gate out at destination',
  EMPTY_RETURNED: 'Empty container returned',
  OTHER: 'Update',
};
