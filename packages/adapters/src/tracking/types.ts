import { z } from 'zod';

/**
 * Normalised shipment-tracking contracts (ADR-0017, brief §6.4). Two data streams:
 *   - `MilestoneProvider`: discrete container milestones pushed by webhook (Terminal49 …) with a
 *     6-hourly `pollShipment` fallback.
 *   - `PositionProvider`: AIS vessel positions pulled once per ship by the worker (Spire,
 *     MarineTraffic …).
 * Provider payloads are zod-validated at the boundary (§7.5); anything malformed is rejected,
 * never guessed. Coordinates and speeds are plain numbers (not money — ADR-0003 does not apply).
 */

export const MILESTONES = [
  'GATE_IN_ORIGIN',
  'LOADED_ON_VESSEL',
  'VESSEL_DEPARTED',
  'TRANSSHIPMENT_ARRIVED',
  'TRANSSHIPMENT_DEPARTED',
  'VESSEL_ARRIVED',
  'DISCHARGED_DESTINATION',
  'GATE_OUT_DESTINATION',
  'EMPTY_RETURNED',
  'OTHER',
] as const;
export type Milestone = (typeof MILESTONES)[number];
export const isMilestone = (v: unknown): v is Milestone =>
  typeof v === 'string' && (MILESTONES as readonly string[]).includes(v);

/** Mirrors the Prisma `ShipmentStatus` enum (brief §4); additive only. */
export const SHIPMENT_STATUSES = [
  'PENDING_DOCS',
  'PENDING_BOOKING',
  'BOOKED',
  'DISPATCHED',
  'IN_TRANSIT',
  'AT_DESTINATION',
  'CUSTOMS',
  'CLEARED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Fetch with method/body (the tariff adapters' `FetchLike` is GET-only). `globalThis.fetch` fits. */
export type HttpFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export const LOCODE_RE = /^[A-Z]{2}[A-Z0-9]{3}$/;
export const CONTAINER_NUMBER_RE = /^[A-Z]{4}[0-9]{7}$/;
export const IMO_RE = /^[0-9]{7}$/;

const isoDateTime = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date-time');

/** One normalised milestone. `raw` is the provider's event object, redacted of PII by the provider. */
export const normalisedMilestoneSchema = z.object({
  /** Provider-scoped stable id: with `source` it is the idempotency key (`(source, providerEventId)`). */
  providerEventId: z.string().min(1).max(200),
  containerNumber: z.string().regex(CONTAINER_NUMBER_RE),
  milestone: z.enum(MILESTONES),
  /** ISO date-time. */
  occurredAt: isoDateTime,
  locationLocode: z.string().regex(LOCODE_RE).optional(),
  locationName: z.string().max(200).optional(),
  vesselImo: z.string().regex(IMO_RE).optional(),
  vesselName: z.string().max(120).optional(),
  voyageNumber: z.string().max(40).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /** Provider's ETA at the destination port (ISO). Displayed as "Carrier ETA"; never computed by us. */
  etaAt: isoDateTime.optional(),
  /** Provider's own event name, e.g. `container.transport.vessel_loaded`. */
  providerEventType: z.string().max(120).optional(),
  raw: z.unknown(),
});
export type NormalisedMilestone = z.infer<typeof normalisedMilestoneSchema>;

export interface SubscribeRequest {
  /** ISO 6346 container number (check digit already validated by the caller). */
  containerNumber?: string;
  /** Master bill of lading number. One of the two is required. */
  masterBillNumber?: string;
  /** Carrier SCAC when known — some providers need it for bill-of-lading requests. */
  carrierScac?: string;
}

export type SubscribeResult =
  | { ok: true; providerRef: string }
  | {
      ok: false;
      reason: 'NOT_CONFIGURED' | 'INVALID' | 'UNAVAILABLE' | 'MALFORMED';
      message: string;
    };

export type WebhookParseResult =
  | { ok: true; events: NormalisedMilestone[] }
  | {
      ok: false;
      /**
       * BAD_SIGNATURE → 401; REPLAY (timestamp outside the 5-minute window) → 401;
       * MALFORMED → 400; NOT_CONFIGURED (no secret) → 503.
       */
      reason: 'BAD_SIGNATURE' | 'REPLAY' | 'MALFORMED' | 'NOT_CONFIGURED';
      message: string;
    };

export type PollResult =
  | { ok: true; events: NormalisedMilestone[] }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'MALFORMED'; message: string };

export interface MilestoneProvider {
  /** Stable id used in the webhook URL (`/webhooks/tracking/:providerId`) and as `ShipmentEvent.source`. */
  readonly id: string;
  readonly name: string;
  subscribe(req: SubscribeRequest): Promise<SubscribeResult>;
  unsubscribe(providerRef: string): Promise<{ ok: boolean; message?: string }>;
  /**
   * Verifies the webhook signature (constant-time) and the replay window where the provider
   * supplies a timestamp, then normalises the payload. `rawBody` is the exact bytes received.
   */
  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    secret: string | undefined,
  ): WebhookParseResult;
  /** 6-hourly fallback (§6.4) for a subscription with no webhook in 24 h. */
  pollShipment(providerRef: string): Promise<PollResult>;
}

/** Replay window for webhook timestamps (§6.4: reject timestamps older than 5 minutes). */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export const vesselPositionSchema = z.object({
  imo: z.string().regex(IMO_RE),
  name: z.string().max(120).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  speedKnots: z.number().min(0).max(80),
  headingDeg: z.number().min(0).max(360),
  /** ISO date-time of the AIS fix. */
  positionAt: isoDateTime,
  destinationLocode: z.string().regex(LOCODE_RE).optional(),
  /** Provider ETA (ISO). */
  etaAt: isoDateTime.optional(),
});
export type VesselPosition = z.infer<typeof vesselPositionSchema>;

export interface PositionProvider {
  /** e.g. 'SPIRE', 'MARINETRAFFIC', 'NOT_CONFIGURED'. Stored as `ActiveVessel.positionSource`. */
  readonly name: string;
  readonly configured: boolean;
  /** Provider limit per call; the caller chunks the IMO list accordingly. */
  readonly maxImosPerCall: number;
  /**
   * Latest position for each IMO the provider knows. Vessels it cannot find are simply absent.
   * Throws on transport/HTTP/parse failure (the worker counts consecutive failures per vessel).
   */
  positions(imos: readonly string[]): Promise<VesselPosition[]>;
}
