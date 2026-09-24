import type { PositionProvider, VesselPosition } from '@harbour/adapters';
import type { ActiveVesselRow, PortRow, VesselPollPort } from '@harbour/db';
import {
  CHOKE_POINTS,
  haversineKm,
  nearestKm,
  nextPollDelayMs,
  pollStateFor,
  type GeoPoint,
  type VesselPollState,
} from '@harbour/engine';
import type { AlertSink } from '../ports.js';

/**
 * M9 (ADR-0017 "smart pull") — hourly vessel position poll.
 *
 *   1. select `active_vessels` with `nextPollAt <= now` and `pollState <> DOCKED`
 *   2. one provider call per batch (chunked to the provider's limit) — per SHIP, never per container
 *   3. per vessel: store the real fix (positionSource = provider name), compute the distance to
 *      the destination port and to the nearest choke point / listed port, set `pollState` and
 *      `nextPollAt` from the kinematics policy (18 h at sea, 5 h coastal, 1 h approaching)
 *   4. failures: `lastError` counts consecutive failures ("<n>:<class>"); the 3rd marks the vessel
 *      STALE and raises `TRACKING_POSITION_STALE`. A STALE vessel is retried daily and recovers on
 *      the next good fix. A provider that is not configured logs once and the job exits.
 *
 * Provider errors never throw (the next run retries); store errors do (BullMQ retries).
 */
export interface VesselPollDeps {
  provider: PositionProvider;
  store: VesselPollPort;
  alerts: AlertSink;
  now: () => Date;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface VesselPollSummary {
  provider: string;
  due: number;
  polled: number;
  updated: number;
  /** Vessels the provider returned nothing for (counted as a failure). */
  missing: number;
  failed: number;
  stale: number;
  skipped: 'NOT_CONFIGURED' | null;
  asOf: string;
}

export const STALE_AFTER_FAILURES = 3;
/** Retry a failed poll after this long, unless the vessel just went STALE (daily). */
export const FAILURE_RETRY_MS = 60 * 60 * 1000;

export const parseFailureCount = (lastError: string | null): number => {
  const m = /^(\d+):/.exec(lastError ?? '');
  return m ? Number(m[1]) : 0;
};

const errorClass = (err: unknown): string =>
  (err instanceof Error ? err.name || 'Error' : 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);

export interface PollDecision {
  pollState: Extract<VesselPollState, 'AT_SEA' | 'COASTAL' | 'APPROACHING'>;
  nextPollAt: Date;
  distanceToDestinationKm: number | null;
  chokePointDistanceKm: number;
}

/** Pure: the polling decision for one fix. Exported for tests. */
export const decidePoll = (
  fix: GeoPoint,
  destination: GeoPoint | null,
  ports: readonly PortRow[],
  now: Date,
): PollDecision => {
  const distanceToDestinationKm = destination ? haversineKm(fix, destination) : null;
  const coastProxies: GeoPoint[] = [
    ...CHOKE_POINTS,
    ...ports.map((p) => ({ lat: p.latitude, lon: p.longitude })),
  ];
  const chokePointDistanceKm = nearestKm(fix, coastProxies);
  const pollState = pollStateFor(
    distanceToDestinationKm ?? Number.POSITIVE_INFINITY,
    chokePointDistanceKm,
  );
  const delay = nextPollDelayMs(pollState) ?? 0;
  return {
    pollState,
    nextPollAt: new Date(now.getTime() + delay),
    distanceToDestinationKm,
    chokePointDistanceKm,
  };
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

export const runVesselPoll = async (deps: VesselPollDeps): Promise<VesselPollSummary> => {
  const now = deps.now();
  const log = deps.log ?? (() => undefined);
  const summary: VesselPollSummary = {
    provider: deps.provider.name,
    due: 0,
    polled: 0,
    updated: 0,
    missing: 0,
    failed: 0,
    stale: 0,
    skipped: null,
    asOf: now.toISOString(),
  };
  if (!deps.provider.configured) {
    log('vessel_poll.not_configured', { provider: deps.provider.name });
    summary.skipped = 'NOT_CONFIGURED';
    return summary;
  }

  const due = await deps.store.listDue(now);
  summary.due = due.length;
  if (due.length === 0) return summary;
  const ports = await deps.store.listPorts();
  const portByLocode = new Map(ports.map((p) => [p.locode, p]));

  const fail = async (vessel: ActiveVesselRow, err: unknown): Promise<void> => {
    const count = parseFailureCount(vessel.lastError) + 1;
    const wasStale = vessel.pollState === 'STALE';
    const becameStale = count >= STALE_AFTER_FAILURES;
    const pollState: VesselPollState = becameStale || wasStale ? 'STALE' : vessel.pollState;
    const retry = becameStale ? (nextPollDelayMs('STALE') ?? FAILURE_RETRY_MS) : FAILURE_RETRY_MS;
    await deps.store.recordFailure(vessel.imo, {
      lastError: `${count}:${errorClass(err)}`,
      pollState,
      nextPollAt: new Date(now.getTime() + retry),
    });
    summary.failed += 1;
    if (becameStale && !wasStale) {
      summary.stale += 1;
      await deps.alerts.alert(
        'warning',
        'TRACKING_POSITION_STALE',
        `Vessel ${vessel.imo} has no position after ${count} consecutive failed polls; shown as "last seen".`,
        { imo: vessel.imo, provider: deps.provider.name, failures: count },
      );
    }
  };

  for (const batch of chunk(due, deps.provider.maxImosPerCall)) {
    let positions: VesselPosition[];
    try {
      positions = await deps.provider.positions(batch.map((v) => v.imo));
      summary.polled += batch.length;
    } catch (err) {
      log('vessel_poll.provider_error', {
        provider: deps.provider.name,
        batch: batch.length,
        errorClass: errorClass(err),
      });
      for (const v of batch) await fail(v, err);
      continue;
    }
    const byImo = new Map(positions.map((p) => [p.imo, p]));
    for (const vessel of batch) {
      const fix = byImo.get(vessel.imo);
      if (!fix) {
        summary.missing += 1;
        await fail(vessel, new Error('VesselNotReturned'));
        continue;
      }
      const destLocode = vessel.destinationLocode ?? fix.destinationLocode ?? null;
      const port = destLocode ? (portByLocode.get(destLocode) ?? null) : null;
      const decision = decidePoll(
        { lat: fix.lat, lon: fix.lon },
        port ? { lat: port.latitude, lon: port.longitude } : null,
        ports,
        now,
      );
      await deps.store.recordPosition(vessel.imo, {
        ...(fix.name !== undefined ? { name: fix.name } : {}),
        lastLatitude: fix.lat,
        lastLongitude: fix.lon,
        speedKnots: fix.speedKnots,
        headingDeg: fix.headingDeg,
        positionAt: new Date(fix.positionAt),
        positionSource: deps.provider.name,
        providerEtaAt: fix.etaAt ? new Date(fix.etaAt) : null,
        ...(vessel.destinationLocode === null && fix.destinationLocode
          ? { destinationLocode: fix.destinationLocode }
          : {}),
        pollState: decision.pollState,
        nextPollAt: decision.nextPollAt,
      });
      summary.updated += 1;
      log('vessel_poll.updated', {
        imo: vessel.imo,
        pollState: decision.pollState,
        distanceToDestinationKm:
          decision.distanceToDestinationKm === null
            ? null
            : Math.round(decision.distanceToDestinationKm),
        nextPollAt: decision.nextPollAt.toISOString(),
      });
    }
  }
  return summary;
};
