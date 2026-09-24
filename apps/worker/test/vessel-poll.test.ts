import type { PositionProvider, VesselPosition } from '@harbour/adapters';
import type { ActiveVesselRow, PortRow, VesselPollPort, VesselPositionPatch } from '@harbour/db';
import { describe, expect, it } from 'vitest';
import { CollectingAlertSink } from '../src/ports.js';
import { decidePoll, parseFailureCount, runVesselPoll } from '../src/jobs/vessel-poll.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-30T05:00:00Z');

const PORTS: PortRow[] = [
  {
    locode: 'GBFXT',
    name: 'Felixstowe',
    countryCode: 'GB',
    latitude: 51.95,
    longitude: 1.35,
    chokePoint: false,
  },
  {
    locode: 'EGSUZ',
    name: 'Suez',
    countryCode: 'EG',
    latitude: 29.97,
    longitude: 32.55,
    chokePoint: true,
  },
  {
    locode: 'LKCMB',
    name: 'Colombo',
    countryCode: 'LK',
    latitude: 6.95,
    longitude: 79.85,
    chokePoint: true,
  },
];

const vessel = (over: Partial<ActiveVesselRow>): ActiveVesselRow => ({
  imo: '9074729',
  name: null,
  lastLatitude: null,
  lastLongitude: null,
  speedKnots: null,
  headingDeg: null,
  positionAt: null,
  positionSource: null,
  providerEtaAt: null,
  destinationLocode: 'GBFXT',
  pollState: 'AT_SEA',
  nextPollAt: new Date(NOW.getTime() - HOUR),
  lastError: null,
  activeContainerCount: 1,
  ...over,
});

/** In-memory VesselPollPort recording every write. */
const fakeStore = (rows: ActiveVesselRow[]) => {
  const positions: Array<{ imo: string; patch: VesselPositionPatch }> = [];
  const failures: Array<{
    imo: string;
    input: { lastError: string; pollState: string; nextPollAt: Date | null };
  }> = [];
  const store: VesselPollPort = {
    listDue: async (now) =>
      rows.filter((r) => r.pollState !== 'DOCKED' && r.nextPollAt !== null && r.nextPollAt <= now),
    listPorts: async () => PORTS,
    recordPosition: async (imo, patch) => {
      positions.push({ imo, patch });
      const r = rows.find((x) => x.imo === imo)!;
      Object.assign(r, {
        lastLatitude: patch.lastLatitude,
        lastLongitude: patch.lastLongitude,
        pollState: patch.pollState,
        nextPollAt: patch.nextPollAt,
        lastError: null,
      });
    },
    recordFailure: async (imo, input) => {
      failures.push({ imo, input });
      const r = rows.find((x) => x.imo === imo)!;
      Object.assign(r, {
        lastError: input.lastError,
        pollState: input.pollState,
        nextPollAt: input.nextPollAt,
      });
    },
  };
  return { store, positions, failures };
};

const fakeProvider = (
  impl: (imos: readonly string[]) => Promise<VesselPosition[]>,
  opts: { configured?: boolean; maxImosPerCall?: number } = {},
): PositionProvider & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    name: 'FAKE',
    configured: opts.configured ?? true,
    maxImosPerCall: opts.maxImosPerCall ?? 100,
    calls,
    positions: async (imos) => {
      calls.push([...imos]);
      return impl(imos);
    },
  };
};

const fix = (
  imo: string,
  lat: number,
  lon: number,
  over: Partial<VesselPosition> = {},
): VesselPosition => ({
  imo,
  lat,
  lon,
  speedKnots: 18,
  headingDeg: 300,
  positionAt: '2026-09-30T04:50:00Z',
  ...over,
});

describe('decidePoll (interval selection by distance)', () => {
  it('at sea far from everything → 18 h; near a choke point → 5 h; within 50 nmi of destination → 1 h', () => {
    const sea = decidePoll({ lat: 12.5, lon: 58 }, { lat: 51.95, lon: 1.35 }, PORTS, NOW);
    expect(sea.pollState).toBe('AT_SEA');
    expect(sea.nextPollAt.getTime() - NOW.getTime()).toBe(18 * HOUR);

    const coastal = decidePoll({ lat: 29.5, lon: 32.7 }, { lat: 51.95, lon: 1.35 }, PORTS, NOW);
    expect(coastal.pollState).toBe('COASTAL');
    expect(coastal.nextPollAt.getTime() - NOW.getTime()).toBe(5 * HOUR);

    const approaching = decidePoll({ lat: 51.9, lon: 2.0 }, { lat: 51.95, lon: 1.35 }, PORTS, NOW);
    expect(approaching.pollState).toBe('APPROACHING');
    expect(approaching.nextPollAt.getTime() - NOW.getTime()).toBe(HOUR);
    expect(approaching.distanceToDestinationKm).toBeLessThan(92.6);

    // Unknown destination: never "approaching", but a listed port still counts as coast.
    const unknown = decidePoll({ lat: 51.9, lon: 2.0 }, null, PORTS, NOW);
    expect(unknown.pollState).toBe('COASTAL');
    expect(unknown.distanceToDestinationKm).toBeNull();
  });
});

describe('runVesselPoll', () => {
  it('logs once and exits when the provider is not configured', async () => {
    const events: string[] = [];
    const store = fakeStore([vessel({})]);
    const provider = fakeProvider(async () => [], { configured: false });
    const s = await runVesselPoll({
      provider,
      store: store.store,
      alerts: new CollectingAlertSink(),
      now: () => NOW,
      log: (e) => void events.push(e),
    });
    expect(s.skipped).toBe('NOT_CONFIGURED');
    expect(provider.calls).toEqual([]);
    expect(events).toEqual(['vessel_poll.not_configured']);
  });

  it('polls due vessels once per batch, skips DOCKED and not-yet-due ones, and stores the real fix', async () => {
    const rows = [
      vessel({ imo: '9074729' }),
      vessel({ imo: '9362994', pollState: 'DOCKED', nextPollAt: null }),
      vessel({ imo: '9454230', nextPollAt: new Date(NOW.getTime() + HOUR) }),
      vessel({ imo: '9618965', pollState: 'COASTAL', destinationLocode: null }),
    ];
    const store = fakeStore(rows);
    const provider = fakeProvider(async (imos) =>
      imos.map((imo) =>
        imo === '9618965'
          ? fix(imo, 51.9, 2.0, {
              destinationLocode: 'GBFXT',
              name: 'LATE SHIP',
              etaAt: '2026-10-01T00:00:00Z',
            })
          : fix(imo, 5.4, 80.5),
      ),
    );
    const alerts = new CollectingAlertSink();
    const s = await runVesselPoll({ provider, store: store.store, alerts, now: () => NOW });
    expect(provider.calls).toEqual([['9074729', '9618965']]);
    expect(s).toMatchObject({
      due: 2,
      polled: 2,
      updated: 2,
      missing: 0,
      failed: 0,
      stale: 0,
      skipped: null,
    });

    const first = store.positions.find((p) => p.imo === '9074729')!.patch;
    expect(first).toMatchObject({
      lastLatitude: 5.4,
      lastLongitude: 80.5,
      speedKnots: 18,
      headingDeg: 300,
      positionSource: 'FAKE',
      pollState: 'COASTAL',
    });
    expect(first.positionAt.toISOString()).toBe('2026-09-30T04:50:00.000Z');
    expect(first.nextPollAt?.getTime()).toBe(NOW.getTime() + 5 * HOUR); // near Colombo (listed port)
    expect(first.providerEtaAt).toBeNull();

    // The provider's AIS destination fills in a missing destinationLocode and the ETA is kept.
    const second = store.positions.find((p) => p.imo === '9618965')!.patch;
    expect(second).toMatchObject({
      destinationLocode: 'GBFXT',
      pollState: 'APPROACHING',
      name: 'LATE SHIP',
    });
    expect(second.providerEtaAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(alerts.alerts).toEqual([]);
  });

  it('chunks to the provider limit', async () => {
    const rows = ['9074729', '9362994', '9454230'].map((imo) => vessel({ imo }));
    const store = fakeStore(rows);
    const provider = fakeProvider(async (imos) => imos.map((imo) => fix(imo, 12.5, 58)), {
      maxImosPerCall: 2,
    });
    await runVesselPoll({
      provider,
      store: store.store,
      alerts: new CollectingAlertSink(),
      now: () => NOW,
    });
    expect(provider.calls).toEqual([['9074729', '9362994'], ['9454230']]);
    expect(
      store.positions.every(
        (p) =>
          p.patch.pollState === 'AT_SEA' &&
          p.patch.nextPollAt?.getTime() === NOW.getTime() + 18 * HOUR,
      ),
    ).toBe(true);
  });

  it('counts consecutive failures, marks STALE on the third and alerts once; a good fix recovers', async () => {
    const rows = [vessel({ imo: '9074729' })];
    const store = fakeStore(rows);
    const alerts = new CollectingAlertSink();
    let fail = true;
    const provider = fakeProvider(async (imos) => {
      if (fail) throw new Error('boom');
      return imos.map((imo) => fix(imo, 12.5, 58));
    });
    const run = (at: Date) =>
      runVesselPoll({ provider, store: store.store, alerts, now: () => at });

    let s = await run(NOW);
    expect(s).toMatchObject({ failed: 1, stale: 0 });
    expect(rows[0]).toMatchObject({ lastError: '1:Error', pollState: 'AT_SEA' });
    expect(rows[0]!.nextPollAt?.getTime()).toBe(NOW.getTime() + HOUR);

    s = await run(new Date(NOW.getTime() + HOUR));
    expect(rows[0]).toMatchObject({ lastError: '2:Error', pollState: 'AT_SEA' });
    expect(alerts.alerts).toEqual([]);

    s = await run(new Date(NOW.getTime() + 2 * HOUR));
    expect(s).toMatchObject({ failed: 1, stale: 1 });
    expect(rows[0]).toMatchObject({ lastError: '3:Error', pollState: 'STALE' });
    expect(rows[0]!.nextPollAt?.getTime()).toBe(NOW.getTime() + 2 * HOUR + 24 * HOUR); // daily retry
    expect(alerts.alerts).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'TRACKING_POSITION_STALE',
        meta: { imo: '9074729', provider: 'FAKE', failures: 3 },
      }),
    ]);

    // Still failing: no second alert, still STALE.
    s = await run(new Date(NOW.getTime() + 27 * HOUR));
    expect(rows[0]).toMatchObject({ lastError: '4:Error', pollState: 'STALE' });
    expect(alerts.alerts).toHaveLength(1);

    // Provider back: position stored, state recomputed, error cleared.
    fail = false;
    s = await run(new Date(NOW.getTime() + 52 * HOUR));
    expect(s).toMatchObject({ updated: 1, failed: 0 });
    expect(rows[0]).toMatchObject({ lastError: null, pollState: 'AT_SEA', lastLatitude: 12.5 });
    expect(parseFailureCount('12:HttpError')).toBe(12);
    expect(parseFailureCount(null)).toBe(0);
  });

  it('a vessel the provider does not return counts as a failure ("missing") without failing the batch', async () => {
    const rows = [vessel({ imo: '9074729' }), vessel({ imo: '9362994' })];
    const store = fakeStore(rows);
    const provider = fakeProvider(async () => [fix('9074729', 12.5, 58)]);
    const s = await runVesselPoll({
      provider,
      store: store.store,
      alerts: new CollectingAlertSink(),
      now: () => NOW,
    });
    expect(s).toMatchObject({ polled: 2, updated: 1, missing: 1, failed: 1 });
    expect(rows[1]).toMatchObject({ lastError: '1:Error' });
    expect(rows[0]).toMatchObject({ lastError: null });
  });
});
