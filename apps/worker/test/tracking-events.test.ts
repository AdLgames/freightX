import type {
  MilestoneProvider,
  NormalisedMilestone,
  TrackingOrgStore,
  TrackingStore,
} from '@harbour/adapters';
import { describe, expect, it } from 'vitest';
import {
  runTrackingEvents,
  runTrackingPoll,
  type ShipmentDue,
} from '../src/jobs/tracking-events.js';

const NOW = new Date('2026-09-30T05:00:00Z');
const silent = { info: () => undefined, warn: () => undefined };

const event = (
  id: string,
  milestone: NormalisedMilestone['milestone'] = 'LOADED_ON_VESSEL',
): NormalisedMilestone => ({
  providerEventId: id,
  containerNumber: 'CSQU3054383',
  milestone,
  occurredAt: '2026-09-23T08:30:00Z',
  vesselImo: '9074729',
  raw: {},
});

/** Minimal store: one org tracks CSQU3054383; records inserted events. */
const fakeStore = () => {
  const inserted: string[] = [];
  const vessels: string[] = [];
  const org: TrackingOrgStore = {
    getShipment: async () => ({
      id: 's1',
      status: 'BOOKED',
      trackingProvider: 'terminal49',
      trackingRequestRef: 'tr1',
      destinationLocode: 'GBFXT',
      eta: null,
    }),
    getContainer: async () => ({
      id: 'c1',
      shipmentId: 's1',
      containerNumber: 'CSQU3054383',
      vesselImo: null,
      vesselName: null,
      voyageNumber: null,
      lastMilestone: null,
      lastMilestoneAt: null,
    }),
    eventExists: async (_s, id) => inserted.includes(id),
    insertEvent: async (e) => {
      inserted.push(e.providerEventId);
      return { id: `ev-${inserted.length}` };
    },
    updateShipment: async () => undefined,
    updateContainer: async () => undefined,
    vessels: {
      addActiveContainer: async (imo) => void vessels.push(imo),
      removeActiveContainer: async () => undefined,
    },
  };
  const store: TrackingStore = {
    findTrackedContainers: async (n) =>
      n === 'CSQU3054383' ? [{ organizationId: 'A', shipmentId: 's1', containerId: 'c1' }] : [],
    withOrganization: async (_id, fn) => fn(org),
  };
  return { store, inserted, vessels };
};

describe('runTrackingEvents', () => {
  it('validates the job payload and feeds the processor; duplicates are no-ops', async () => {
    const { store, inserted } = fakeStore();
    const job = { source: 'terminal49', events: [event('e1'), event('e2', 'VESSEL_DEPARTED')] };
    const s = await runTrackingEvents({ store, now: () => NOW, log: silent }, job);
    expect(s).toMatchObject({
      source: 'terminal49',
      received: 2,
      matched: 2,
      inserted: 2,
      duplicates: 0,
      skipped: null,
    });
    expect(inserted).toEqual(['e1', 'e2']);
    const again = await runTrackingEvents({ store, now: () => NOW, log: silent }, job);
    expect(again).toMatchObject({ inserted: 0, duplicates: 2 });
  });

  it('rejects malformed jobs and reports NO_DATABASE without a store (never throws)', async () => {
    const bad = await runTrackingEvents(
      { store: fakeStore().store, now: () => NOW, log: silent },
      { source: 'x', events: [{ nope: true }] },
    );
    expect(bad.skipped).toBe('INVALID_JOB');
    const noDb = await runTrackingEvents(
      { store: null, now: () => NOW, log: silent },
      { source: 'terminal49', events: [event('e1')] },
    );
    expect(noDb.skipped).toBe('NO_DATABASE');
  });
});

describe('runTrackingPoll (6-hourly fallback)', () => {
  const provider = (
    impl: MilestoneProvider['pollShipment'],
    id = 'terminal49',
  ): MilestoneProvider & { polled: string[] } => {
    const polled: string[] = [];
    return {
      id,
      name: id,
      polled,
      subscribe: async () => ({ ok: false, reason: 'NOT_CONFIGURED', message: '' }),
      unsubscribe: async () => ({ ok: true }),
      parseWebhook: () => ({ ok: false, reason: 'NOT_CONFIGURED', message: '' }),
      pollShipment: async (ref) => {
        polled.push(ref);
        return impl(ref);
      },
    };
  };
  const due: ShipmentDue[] = [
    {
      organizationId: 'A',
      shipmentId: 's1',
      trackingProvider: 'terminal49',
      trackingRequestRef: 'tr1',
    },
    {
      organizationId: 'B',
      shipmentId: 's2',
      trackingProvider: 'project44',
      trackingRequestRef: 'p44-9',
    },
  ];

  it("polls only this provider's subscriptions, marks them polled and processes the events", async () => {
    const { store, inserted } = fakeStore();
    const p = provider(async () => ({ ok: true, events: [event('poll-1')] }));
    const marked: string[] = [];
    let seen: { noEventSince: Date; notPolledSince: Date } | null = null;
    const s = await runTrackingPoll({
      store,
      provider: p,
      now: () => NOW,
      log: silent,
      listDue: async (input) => {
        seen = input;
        return due;
      },
      markPolled: async (org, id) => void marked.push(`${org}/${id}`),
    });
    expect(seen).toEqual({
      noEventSince: new Date('2026-09-29T05:00:00Z'),
      notPolledSince: new Date('2026-09-29T23:00:00Z'),
    });
    expect(p.polled).toEqual(['tr1']);
    expect(marked).toEqual(['A/s1']);
    expect(s).toMatchObject({
      due: 2,
      polled: 1,
      providerErrors: 0,
      skipped: null,
      events: { inserted: 1 },
    });
    expect(inserted).toEqual(['poll-1']);
  });

  it('counts provider errors, and skips entirely when not configured or without a database', async () => {
    const { store } = fakeStore();
    const failing = provider(async () => ({ ok: false, reason: 'UNAVAILABLE', message: 'down' }));
    const s = await runTrackingPoll({
      store,
      provider: failing,
      now: () => NOW,
      log: silent,
      listDue: async () => due,
      markPolled: async () => undefined,
    });
    expect(s).toMatchObject({ polled: 0, providerErrors: 1 });

    const none = provider(async () => ({ ok: true, events: [] }), 'none');
    expect(
      (
        await runTrackingPoll({
          store,
          provider: none,
          now: () => NOW,
          log: silent,
          listDue: async () => due,
          markPolled: async () => undefined,
        })
      ).skipped,
    ).toBe('NOT_CONFIGURED');
    const noDb = await runTrackingPoll({
      store: null,
      provider: failing,
      now: () => NOW,
      log: silent,
      listDue: async () => due,
      markPolled: async () => undefined,
    });
    expect(noDb.skipped).toBe('NO_DATABASE');
    expect(failing.polled).toEqual(['tr1']); // only the first run polled
  });
});
