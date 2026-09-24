import {
  normalisedMilestoneSchema,
  processProviderEvents,
  type MilestoneProvider,
  type ProcessSummary,
  type TrackingLog,
  type TrackingStore,
} from '@harbour/adapters';
import { z } from 'zod';

/**
 * M9 (ADR-0017, brief §6.4) — two jobs over the same milestone processor:
 *
 *   `tracking-events`  consumes jobs the web app's webhook route enqueued ({ source, events });
 *                      the processor upserts per (organisation, source, providerEventId), so a
 *                      BullMQ retry of a half-processed job is safe.
 *   `tracking-poll`    the 6-hourly fallback: shipments with a provider subscription and no event
 *                      in 24 h are polled through `MilestoneProvider.pollShipment` and the events
 *                      go through the same processor with source = the provider id.
 *
 * Store errors throw (BullMQ retries, JOB_FAILED after 5); provider errors are counted.
 */
export const trackingEventsJobSchema = z.object({
  source: z.string().min(1).max(40),
  events: z.array(normalisedMilestoneSchema).max(1000),
  receivedAt: z.string().optional(),
});
export type TrackingEventsJob = z.infer<typeof trackingEventsJobSchema>;

export interface TrackingEventsDeps {
  store: TrackingStore | null;
  now: () => Date;
  log: TrackingLog;
}

export interface TrackingEventsSummary extends ProcessSummary {
  source: string;
  skipped: 'NO_DATABASE' | 'INVALID_JOB' | null;
  asOf: string;
}

export const runTrackingEvents = async (
  deps: TrackingEventsDeps,
  data: unknown,
): Promise<TrackingEventsSummary> => {
  const now = deps.now();
  const empty: ProcessSummary = {
    received: 0,
    matched: 0,
    inserted: 0,
    duplicates: 0,
    illegal: 0,
    unmatched: 0,
  };
  const parsed = trackingEventsJobSchema.safeParse(data);
  if (!parsed.success) {
    deps.log.warn('tracking_events.invalid_job', { issues: parsed.error.issues.length });
    return { ...empty, source: 'unknown', skipped: 'INVALID_JOB', asOf: now.toISOString() };
  }
  if (!deps.store) {
    deps.log.warn('tracking_events.no_database', {
      source: parsed.data.source,
      events: parsed.data.events.length,
    });
    return {
      ...empty,
      source: parsed.data.source,
      skipped: 'NO_DATABASE',
      asOf: now.toISOString(),
    };
  }
  const summary = await processProviderEvents(deps.store, parsed.data.events, {
    source: parsed.data.source,
    now,
    log: deps.log,
  });
  return { ...summary, source: parsed.data.source, skipped: null, asOf: now.toISOString() };
};

// ---------- 6-hourly fallback ----------

export interface ShipmentDue {
  organizationId: string;
  shipmentId: string;
  trackingProvider: string;
  trackingRequestRef: string;
}

export interface TrackingPollDeps {
  store: TrackingStore | null;
  /** Shipments subscribed with a provider and silent for 24 h (packages/db `withTrackingSweep`). */
  listDue: (input: { noEventSince: Date; notPolledSince: Date }) => Promise<ShipmentDue[]>;
  markPolled: (organizationId: string, shipmentId: string, at: Date) => Promise<void>;
  provider: MilestoneProvider;
  now: () => Date;
  log: TrackingLog;
}

export interface TrackingPollSummary {
  provider: string;
  due: number;
  polled: number;
  providerErrors: number;
  events: ProcessSummary;
  skipped: 'NOT_CONFIGURED' | 'NO_DATABASE' | null;
  asOf: string;
}

export const NO_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const runTrackingPoll = async (deps: TrackingPollDeps): Promise<TrackingPollSummary> => {
  const now = deps.now();
  const events: ProcessSummary = {
    received: 0,
    matched: 0,
    inserted: 0,
    duplicates: 0,
    illegal: 0,
    unmatched: 0,
  };
  const base = {
    provider: deps.provider.name,
    due: 0,
    polled: 0,
    providerErrors: 0,
    events,
    asOf: now.toISOString(),
  };
  if (deps.provider.id === 'none') {
    deps.log.info('tracking_poll.not_configured', {});
    return { ...base, skipped: 'NOT_CONFIGURED' };
  }
  if (!deps.store) {
    deps.log.warn('tracking_poll.no_database', {});
    return { ...base, skipped: 'NO_DATABASE' };
  }
  const due = await deps.listDue({
    noEventSince: new Date(now.getTime() - NO_EVENT_WINDOW_MS),
    notPolledSince: new Date(now.getTime() - POLL_INTERVAL_MS),
  });
  base.due = due.length;
  for (const s of due) {
    if (s.trackingProvider !== deps.provider.id) continue; // another provider's subscription
    const r = await deps.provider.pollShipment(s.trackingRequestRef);
    await deps.markPolled(s.organizationId, s.shipmentId, now);
    if (!r.ok) {
      base.providerErrors += 1;
      deps.log.warn('tracking_poll.provider_error', { shipmentId: s.shipmentId, reason: r.reason });
      continue;
    }
    base.polled += 1;
    const summary = await processProviderEvents(deps.store, r.events, {
      source: deps.provider.id,
      now,
      log: deps.log,
    });
    for (const k of Object.keys(events) as Array<keyof ProcessSummary>) events[k] += summary[k];
  }
  return { ...base, skipped: null };
};
