import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withTimeout } from '../resilience.js';
import { checkContainerNumber, checkImo } from './check-digits.js';
import {
  LOCODE_RE,
  WEBHOOK_REPLAY_WINDOW_MS,
  type HttpFetch,
  normalisedMilestoneSchema,
  type Milestone,
  type MilestoneProvider,
  type NormalisedMilestone,
  type PollResult,
  type SubscribeRequest,
  type SubscribeResult,
  type WebhookParseResult,
} from './types.js';

/**
 * Terminal49 milestone provider (decision (ab), ADR-0017) — shaped on Terminal49's documented v2
 * JSON:API (https://developers.terminal49.com). EVERY path, header, field and event name below is
 * marked "TO CONFIRM": the build environment could not reach the live API or a sandbox, and the
 * fixtures under packages/adapters/fixtures/tracking are hand-authored in that documented shape.
 * Confirm against the live docs and sandbox before `TRACKING_MILESTONE_PROVIDER=terminal49` is
 * enabled (docs/decisions-needed.md (ae)).
 *
 * Security (§6.4): HMAC-SHA256 of the raw body with the per-provider webhook secret, compared in
 * constant time; replay window 5 minutes on the notification's `created_at`; the API key goes in
 * one request header and is never logged. Provider payloads carry no PII (container/vessel/port
 * identifiers only), and only the transport-event slice is stored as `raw`.
 */
export interface Terminal49Options {
  /** `TERMINAL49_API_KEY`. Missing → subscribe/poll report NOT_CONFIGURED. */
  apiKey?: string | undefined;
  /** TO CONFIRM. Default https://api.terminal49.com. */
  baseUrl?: string;
  fetch?: HttpFetch;
  now?: () => Date;
  timeoutMs?: number;
}

export const TERMINAL49_PROVIDER_ID = 'terminal49';
/** TO CONFIRM: the signature header name and encoding (hex HMAC-SHA256 of the raw body). */
export const TERMINAL49_SIGNATURE_HEADER = 'x-t49-webhook-signature';

/** TO CONFIRM: Terminal49 `container.transport.*` event names → normalised milestones. */
export const TERMINAL49_EVENT_MAP: Readonly<Record<string, Milestone>> = {
  'container.transport.rail_loaded': 'OTHER',
  'container.transport.full_in': 'GATE_IN_ORIGIN',
  'container.transport.vessel_loaded': 'LOADED_ON_VESSEL',
  'container.transport.vessel_departed': 'VESSEL_DEPARTED',
  'container.transport.transshipment_arrived': 'TRANSSHIPMENT_ARRIVED',
  'container.transport.transshipment_discharged': 'TRANSSHIPMENT_ARRIVED',
  'container.transport.transshipment_loaded': 'TRANSSHIPMENT_DEPARTED',
  'container.transport.transshipment_departed': 'TRANSSHIPMENT_DEPARTED',
  'container.transport.vessel_arrived': 'VESSEL_ARRIVED',
  'container.transport.vessel_berthed': 'VESSEL_ARRIVED',
  'container.transport.vessel_discharged': 'DISCHARGED_DESTINATION',
  'container.transport.full_out': 'GATE_OUT_DESTINATION',
  'container.transport.empty_in': 'EMPTY_RETURNED',
};

// ---------- JSON:API shapes (TO CONFIRM) ----------

const resourceRef = z.object({ id: z.string(), type: z.string() });
const relationship = z.object({ data: resourceRef.nullable().optional() }).optional();

const transportEventAttributes = z.object({
  event: z.string(),
  timestamp: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  voyage_number: z.string().nullable().optional(),
  location_locode: z.string().nullable().optional(),
  data_source: z.string().nullable().optional(),
});

const includedResource = z.object({
  id: z.string(),
  type: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  relationships: z.record(z.string(), relationship).optional(),
});
type IncludedResource = z.infer<typeof includedResource>;

const webhookNotificationSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.literal('webhook_notification'),
    attributes: z.object({
      event: z.string(),
      created_at: z.string().optional(),
    }),
    relationships: z.object({ reference_object: relationship }).passthrough().optional(),
  }),
  included: z.array(includedResource).default([]),
});

const trackingRequestResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.literal('tracking_request'),
    attributes: z.record(z.string(), z.unknown()).optional(),
    relationships: z.record(z.string(), relationship).optional(),
  }),
  included: z.array(includedResource).default([]),
});

const jsonApiListSchema = z.object({
  data: z.array(includedResource),
  included: z.array(includedResource).default([]),
});

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const findIncluded = (
  included: readonly IncludedResource[],
  ref: { id: string; type: string } | null | undefined,
): IncludedResource | undefined =>
  ref ? included.find((r) => r.id === ref.id && r.type === ref.type) : undefined;

/**
 * Normalises one `transport_event` resource using the `included` container / vessel / port
 * resources. Returns null (skipped) when the container number is missing or invalid, or the
 * event name is unknown — a webhook with an unexpected event is not an error, it is ignored.
 */
export const normaliseTerminal49TransportEvent = (
  event: IncludedResource,
  included: readonly IncludedResource[],
): NormalisedMilestone | null => {
  const attrs = transportEventAttributes.safeParse(event.attributes ?? {});
  if (!attrs.success) return null;
  const milestone = TERMINAL49_EVENT_MAP[attrs.data.event];
  if (!milestone) return null;
  const container = findIncluded(included, event.relationships?.container?.data);
  const vessel = findIncluded(included, event.relationships?.vessel?.data);
  const location = findIncluded(included, event.relationships?.location?.data);
  const shipment = findIncluded(included, event.relationships?.shipment?.data);

  const number = str(container?.attributes?.number);
  if (!number) return null;
  const check = checkContainerNumber(number);
  if (!check.ok) return null;

  const occurredAt = str(attrs.data.timestamp) ?? str(attrs.data.created_at);
  if (!occurredAt) return null;

  const imoRaw = str(vessel?.attributes?.imo);
  const imo = imoRaw ? checkImo(imoRaw) : null;
  const locode = str(attrs.data.location_locode) ?? str(location?.attributes?.code);
  const lat = location?.attributes?.latitude;
  const lon = location?.attributes?.longitude;
  const eta = str(shipment?.attributes?.pod_eta_at);

  const candidate = {
    providerEventId: event.id,
    containerNumber: check.containerNumber,
    milestone,
    occurredAt,
    ...(locode && LOCODE_RE.test(locode) ? { locationLocode: locode } : {}),
    ...(str(location?.attributes?.name) ? { locationName: str(location?.attributes?.name) } : {}),
    ...(imo?.ok ? { vesselImo: imo.imo } : {}),
    ...(str(vessel?.attributes?.name) ? { vesselName: str(vessel?.attributes?.name) } : {}),
    ...(str(attrs.data.voyage_number) ? { voyageNumber: str(attrs.data.voyage_number) } : {}),
    ...(typeof lat === 'number' && typeof lon === 'number'
      ? { latitude: lat, longitude: lon }
      : {}),
    ...(eta ? { etaAt: eta } : {}),
    providerEventType: attrs.data.event,
    // Only the event resource itself is kept; the included graph is not stored.
    raw: { id: event.id, type: event.type, attributes: event.attributes ?? {} },
  };
  const parsed = normalisedMilestoneSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/** Hex HMAC-SHA256 of `body` with `secret` (the signing scheme assumed for Terminal49 — TO CONFIRM). */
export const terminal49Signature = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex');

const signaturesMatch = (expectedHex: string, presented: string): boolean => {
  const a = Buffer.from(expectedHex, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(presented.trim().replace(/^sha256=/i, ''), 'hex');
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const headerLookup = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};

export class Terminal49MilestoneProvider implements MilestoneProvider {
  readonly id = TERMINAL49_PROVIDER_ID;
  readonly name = 'Terminal49';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(opts: Terminal49Options = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.terminal49.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  get configured(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await withTimeout(
      (signal) =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          signal,
          headers: {
            // TO CONFIRM: Terminal49 documents `Authorization: Token YOUR_API_KEY`; Bearer is
            // used here per the brief and must be checked against the live API.
            authorization: `Bearer ${this.apiKey ?? ''}`,
            accept: 'application/vnd.api+json, application/json',
            ...(body !== undefined ? { 'content-type': 'application/vnd.api+json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      this.timeoutMs,
    );
    return { status: res.status, text: await res.text() };
  }

  /** TO CONFIRM: `POST /v2/tracking_requests` with `request_type` bill_of_lading | container. */
  async subscribe(req: SubscribeRequest): Promise<SubscribeResult> {
    if (!this.configured) {
      return { ok: false, reason: 'NOT_CONFIGURED', message: 'TERMINAL49_API_KEY is not set.' };
    }
    const requestNumber = req.masterBillNumber ?? req.containerNumber;
    if (!requestNumber) {
      return {
        ok: false,
        reason: 'INVALID',
        message: 'A container or master bill number is required.',
      };
    }
    const attributes: Record<string, string> = {
      request_type: req.masterBillNumber ? 'bill_of_lading' : 'container',
      request_number: requestNumber,
    };
    if (req.carrierScac) attributes.scac = req.carrierScac;
    try {
      const { status, text } = await this.request('POST', '/v2/tracking_requests', {
        data: { type: 'tracking_request', attributes },
      });
      if (status === 401 || status === 403) {
        return { ok: false, reason: 'UNAVAILABLE', message: 'Terminal49 rejected the API key.' };
      }
      if (status === 422) {
        return { ok: false, reason: 'INVALID', message: 'Terminal49 could not track that number.' };
      }
      if (status < 200 || status >= 300) {
        return { ok: false, reason: 'UNAVAILABLE', message: `Terminal49 responded ${status}.` };
      }
      const parsed = trackingRequestResponseSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return { ok: false, reason: 'MALFORMED', message: 'Unexpected tracking_request response.' };
      }
      return { ok: true, providerRef: parsed.data.data.id };
    } catch (err) {
      return {
        ok: false,
        reason: 'UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Terminal49 request failed.',
      };
    }
  }

  /** TO CONFIRM: whether tracking requests can be deleted; a 404 counts as already gone. */
  async unsubscribe(providerRef: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.configured) return { ok: false, message: 'TERMINAL49_API_KEY is not set.' };
    try {
      const { status } = await this.request(
        'DELETE',
        `/v2/tracking_requests/${encodeURIComponent(providerRef)}`,
      );
      if (status === 404 || (status >= 200 && status < 300)) return { ok: true };
      return { ok: false, message: `Terminal49 responded ${status}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'request failed' };
    }
  }

  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
    secret: string | undefined,
  ): WebhookParseResult {
    if (!secret) {
      return {
        ok: false,
        reason: 'NOT_CONFIGURED',
        message: 'TERMINAL49_WEBHOOK_SECRET is not set.',
      };
    }
    const presented = headerLookup(headers, TERMINAL49_SIGNATURE_HEADER);
    if (!presented || !signaturesMatch(terminal49Signature(secret, rawBody), presented)) {
      return { ok: false, reason: 'BAD_SIGNATURE', message: 'Webhook signature mismatch.' };
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: 'MALFORMED', message: 'Body is not JSON.' };
    }
    const parsed = webhookNotificationSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, reason: 'MALFORMED', message: 'Unexpected webhook_notification shape.' };
    }
    const createdAt = parsed.data.data.attributes.created_at;
    if (createdAt !== undefined) {
      const ts = Date.parse(createdAt);
      if (Number.isNaN(ts) || Math.abs(this.now().getTime() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
        return {
          ok: false,
          reason: 'REPLAY',
          message: 'Webhook timestamp outside the 5-minute window.',
        };
      }
    }
    const events: NormalisedMilestone[] = [];
    for (const resource of parsed.data.included) {
      if (resource.type !== 'transport_event') continue;
      const normalised = normaliseTerminal49TransportEvent(resource, parsed.data.included);
      if (normalised) events.push(normalised);
    }
    return { ok: true, events };
  }

  /**
   * TO CONFIRM: `GET /v2/tracking_requests/:id?include=tracked_object` → shipment id, then
   * `GET /v2/shipments/:id/containers` and per container `GET /v2/containers/:id/transport_events`
   * with `include=container,vessel,location`. Kept to the smallest documented calls.
   */
  async pollShipment(providerRef: string): Promise<PollResult> {
    if (!this.configured) {
      return { ok: false, reason: 'NOT_CONFIGURED', message: 'TERMINAL49_API_KEY is not set.' };
    }
    try {
      const tr = await this.request(
        'GET',
        `/v2/tracking_requests/${encodeURIComponent(providerRef)}?include=tracked_object`,
      );
      if (tr.status < 200 || tr.status >= 300) {
        return { ok: false, reason: 'UNAVAILABLE', message: `Terminal49 responded ${tr.status}.` };
      }
      const trParsed = trackingRequestResponseSchema.safeParse(JSON.parse(tr.text));
      if (!trParsed.success) {
        return { ok: false, reason: 'MALFORMED', message: 'Unexpected tracking_request response.' };
      }
      const tracked = trParsed.data.data.relationships?.tracked_object?.data;
      if (!tracked) return { ok: true, events: [] }; // still pending at the carrier
      const containers = await this.request(
        'GET',
        `/v2/shipments/${encodeURIComponent(tracked.id)}/containers`,
      );
      if (containers.status < 200 || containers.status >= 300) {
        return {
          ok: false,
          reason: 'UNAVAILABLE',
          message: `Terminal49 responded ${containers.status}.`,
        };
      }
      const list = jsonApiListSchema.safeParse(JSON.parse(containers.text));
      if (!list.success) {
        return { ok: false, reason: 'MALFORMED', message: 'Unexpected containers response.' };
      }
      const events: NormalisedMilestone[] = [];
      for (const container of list.data.data) {
        const te = await this.request(
          'GET',
          `/v2/containers/${encodeURIComponent(container.id)}/transport_events?include=container,vessel,location`,
        );
        if (te.status < 200 || te.status >= 300) continue;
        const teParsed = jsonApiListSchema.safeParse(JSON.parse(te.text));
        if (!teParsed.success) continue;
        const included = [...teParsed.data.included, container];
        for (const resource of teParsed.data.data) {
          if (resource.type !== 'transport_event') continue;
          const n = normaliseTerminal49TransportEvent(resource, included);
          if (n) events.push(n);
        }
      }
      return { ok: true, events };
    } catch (err) {
      return {
        ok: false,
        reason: 'UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Terminal49 request failed.',
      };
    }
  }
}
