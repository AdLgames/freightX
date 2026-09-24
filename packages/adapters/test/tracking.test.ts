import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ABOARD_MILESTONES,
  MILESTONES,
  MarineTrafficPositionProvider,
  NotConfiguredMilestoneProvider,
  NotConfiguredPositionProvider,
  SHIPMENT_STATUSES,
  SpirePositionProvider,
  TERMINAL49_SIGNATURE_HEADER,
  TRANSITIONS,
  Terminal49MilestoneProvider,
  applyMilestone,
  checkContainerNumber,
  checkImo,
  createMilestoneProvider,
  createPositionProvider,
  decideMilestone,
  imoCheckDigit,
  iso6346CheckDigit,
  isAboard,
  milestoneProviderForWebhook,
  nextStatus,
  normalisedMilestoneSchema,
  payloadSha256,
  processProviderEvents,
  terminal49Signature,
  type ContainerRow,
  type HttpFetch,
  type NormalisedMilestone,
  type ShipmentRow,
  type ShipmentStatus,
  type TrackingOrgStore,
  type TrackingStore,
} from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'tracking', name), 'utf8');

// ---------- check digits ----------

describe('ISO 6346 container check digit', () => {
  it('matches the reference algorithm on known numbers', () => {
    // CSQU3054383 is the worked example in the ISO 6346 literature; the rest are computed in-test
    // from the letter-value table (A=10, skipping multiples of 11) and 2^position weights.
    // ISO 6346 letter table transcribed independently of src (10–38 skipping 11, 22, 33).
    const TABLE: Record<string, number> = {
      A: 10,
      B: 12,
      C: 13,
      D: 14,
      E: 15,
      F: 16,
      G: 17,
      H: 18,
      I: 19,
      J: 20,
      K: 21,
      L: 23,
      M: 24,
      N: 25,
      O: 26,
      P: 27,
      Q: 28,
      R: 29,
      S: 30,
      T: 31,
      U: 32,
      V: 34,
      W: 35,
      X: 36,
      Y: 37,
      Z: 38,
    };
    const compute = (first10: string) => {
      let sum = 0;
      for (let i = 0; i < 10; i += 1) {
        const ch = first10[i]!;
        const v = ch >= '0' && ch <= '9' ? Number(ch) : TABLE[ch]!;
        sum += v * 2 ** i;
      }
      return (sum % 11) % 10;
    };
    for (const first10 of ['CSQU305438', 'MSKU123456', 'TGHU987654', 'HLCU654321', 'OOLU200000']) {
      expect(iso6346CheckDigit(first10)).toBe(compute(first10));
    }
    expect(iso6346CheckDigit('CSQU305438')).toBe(3);
    expect(checkContainerNumber('csqu 305438-3')).toEqual({
      ok: true,
      containerNumber: 'CSQU3054383',
    });
    expect(checkContainerNumber('CSQU3054384')).toMatchObject({ ok: false, reason: 'CHECK_DIGIT' });
    expect(checkContainerNumber('CSQ3054383')).toMatchObject({ ok: false, reason: 'FORMAT' });
    expect(checkContainerNumber('')).toMatchObject({ ok: false, reason: 'FORMAT' });
    expect(() => iso6346CheckDigit('BAD')).toThrow();
  });

  it('exactly one of the ten candidate digits is valid for any prefix (deterministic sweep)', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const l = Array.from({ length: 4 }, () => String.fromCharCode(65 + rnd(26))).join('');
      const d = Array.from({ length: 6 }, () => String(rnd(10))).join('');
      const valid = [...'0123456789'].filter((c) => checkContainerNumber(`${l}${d}${c}`).ok);
      expect(valid, `${l}${d}`).toHaveLength(1);
    }
  });
});

describe('IMO check digit', () => {
  it('validates known IMO numbers', () => {
    // 9074729: 9·7 + 0·6 + 7·5 + 4·4 + 7·3 + 2·2 = 63+0+35+16+21+4 = 139 → 9
    expect(imoCheckDigit('907472')).toBe(9);
    expect(checkImo('IMO 9074729')).toEqual({ ok: true, imo: '9074729' });
    expect(checkImo('9074728')).toMatchObject({ ok: false, reason: 'CHECK_DIGIT' });
    expect(checkImo('12345')).toMatchObject({ ok: false, reason: 'FORMAT' });
    expect(() => imoCheckDigit('12')).toThrow();
  });
});

// ---------- state machine ----------

describe('ShipmentStatus state machine', () => {
  it('the table covers every milestone, and every listed status exists', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...MILESTONES].sort());
    for (const t of Object.values(TRANSITIONS)) {
      if (t.to !== null) expect(SHIPMENT_STATUSES).toContain(t.to);
      for (const f of t.from) expect(SHIPMENT_STATUSES).toContain(f);
    }
  });

  it('legal transitions move the status; repeats are no-ops', () => {
    expect(nextStatus('BOOKED', 'GATE_IN_ORIGIN')).toEqual({
      statusAfter: 'DISPATCHED',
      changed: true,
      illegal: false,
    });
    expect(nextStatus('DISPATCHED', 'LOADED_ON_VESSEL').statusAfter).toBe('IN_TRANSIT');
    expect(nextStatus('IN_TRANSIT', 'TRANSSHIPMENT_ARRIVED')).toEqual({
      statusAfter: 'IN_TRANSIT',
      changed: false,
      illegal: false,
    });
    expect(nextStatus('IN_TRANSIT', 'VESSEL_ARRIVED').statusAfter).toBe('AT_DESTINATION');
    expect(nextStatus('CLEARED', 'GATE_OUT_DESTINATION').statusAfter).toBe('OUT_FOR_DELIVERY');
    expect(nextStatus('OUT_FOR_DELIVERY', 'EMPTY_RETURNED').statusAfter).toBe('DELIVERED');
    expect(nextStatus('PENDING_DOCS', 'LOADED_ON_VESSEL').statusAfter).toBe('IN_TRANSIT');
  });

  it('illegal transitions keep the status and flag it', () => {
    expect(nextStatus('DELIVERED', 'LOADED_ON_VESSEL')).toEqual({
      statusAfter: 'DELIVERED',
      changed: false,
      illegal: true,
    });
    expect(nextStatus('CANCELLED', 'GATE_IN_ORIGIN').illegal).toBe(true);
    expect(nextStatus('AT_DESTINATION', 'GATE_IN_ORIGIN').illegal).toBe(true);
    expect(nextStatus('BOOKED', 'GATE_OUT_DESTINATION').illegal).toBe(true);
    // Terminal states never move.
    for (const s of ['DELIVERED', 'CANCELLED', 'EXCEPTION'] as const) {
      for (const m of MILESTONES) expect(nextStatus(s, m).changed).toBe(false);
    }
  });

  it('OTHER never changes status, and the aboard set is what the vessel counter uses', () => {
    for (const s of SHIPMENT_STATUSES)
      expect(nextStatus(s, 'OTHER')).toMatchObject({ changed: false, illegal: false });
    expect(ABOARD_MILESTONES).toEqual([
      'LOADED_ON_VESSEL',
      'VESSEL_DEPARTED',
      'TRANSSHIPMENT_DEPARTED',
    ]);
    expect(isAboard('VESSEL_DEPARTED')).toBe(true);
    expect(isAboard('DISCHARGED_DESTINATION')).toBe(false);
    expect(isAboard(null)).toBe(false);
  });
});

// ---------- processor ----------

const event = (over: Partial<NormalisedMilestone> = {}): NormalisedMilestone =>
  normalisedMilestoneSchema.parse({
    providerEventId: 'e1',
    containerNumber: 'CSQU3054383',
    milestone: 'LOADED_ON_VESSEL',
    occurredAt: '2026-09-23T08:30:00Z',
    vesselImo: '9074729',
    vesselName: 'EXAMPLE MAERSK',
    raw: { id: 'e1' },
    ...over,
  });

const shipmentRow = (over: Partial<ShipmentRow> = {}): ShipmentRow => ({
  id: 'ship-1',
  status: 'BOOKED',
  trackingProvider: 'terminal49',
  trackingRequestRef: 'tr_1',
  destinationLocode: 'GBFXT',
  eta: null,
  ...over,
});
const containerRow = (over: Partial<ContainerRow> = {}): ContainerRow => ({
  id: 'cont-1',
  shipmentId: 'ship-1',
  containerNumber: 'CSQU3054383',
  vesselImo: null,
  vesselName: null,
  voyageNumber: null,
  lastMilestone: null,
  lastMilestoneAt: null,
  ...over,
});

describe('decideMilestone', () => {
  it('LOADED_ON_VESSEL from ashore: status IN_TRANSIT, container gets the vessel, vessel count +1', () => {
    const d = decideMilestone({
      shipment: shipmentRow(),
      container: containerRow(),
      event: event(),
    });
    expect(d.statusAfter).toBe('IN_TRANSIT');
    expect(d.statusChanged).toBe(true);
    expect(d.containerPatch).toMatchObject({
      vesselImo: '9074729',
      vesselName: 'EXAMPLE MAERSK',
      lastMilestone: 'LOADED_ON_VESSEL',
    });
    expect(d.vesselEffects).toEqual([{ kind: 'ADD', imo: '9074729', name: 'EXAMPLE MAERSK' }]);
  });

  it('VESSEL_DEPARTED after LOADED does not add the vessel twice', () => {
    const d = decideMilestone({
      shipment: shipmentRow({ status: 'IN_TRANSIT' }),
      container: containerRow({
        vesselImo: '9074729',
        lastMilestone: 'LOADED_ON_VESSEL',
        lastMilestoneAt: new Date('2026-09-23T08:30:00Z'),
      }),
      event: event({
        providerEventId: 'e2',
        milestone: 'VESSEL_DEPARTED',
        occurredAt: '2026-09-23T12:00:00Z',
      }),
    });
    expect(d.vesselEffects).toEqual([]);
    expect(d.statusChanged).toBe(false);
  });

  it('transshipment to another vessel moves the count across', () => {
    const d = decideMilestone({
      shipment: shipmentRow({ status: 'IN_TRANSIT' }),
      container: containerRow({
        vesselImo: '9074729',
        lastMilestone: 'VESSEL_DEPARTED',
        lastMilestoneAt: new Date('2026-09-23T12:00:00Z'),
      }),
      event: event({
        providerEventId: 'e3',
        milestone: 'TRANSSHIPMENT_DEPARTED',
        vesselImo: '9362994',
        vesselName: 'FEEDER',
        occurredAt: '2026-10-01T00:00:00Z',
      }),
    });
    expect(d.vesselEffects).toEqual([
      { kind: 'REMOVE', imo: '9074729' },
      { kind: 'ADD', imo: '9362994', name: 'FEEDER' },
    ]);
  });

  it('arrival/discharge removes the container from the vessel; an old event never rewinds the container', () => {
    const d = decideMilestone({
      shipment: shipmentRow({ status: 'IN_TRANSIT' }),
      container: containerRow({
        vesselImo: '9074729',
        lastMilestone: 'VESSEL_DEPARTED',
        lastMilestoneAt: new Date('2026-09-23T12:00:00Z'),
      }),
      event: event({
        providerEventId: 'e4',
        milestone: 'VESSEL_ARRIVED',
        occurredAt: '2026-10-28T07:00:00Z',
        etaAt: '2026-10-28T06:00:00Z',
      }),
    });
    expect(d.statusAfter).toBe('AT_DESTINATION');
    expect(d.vesselEffects).toEqual([{ kind: 'REMOVE', imo: '9074729' }]);
    expect(d.shipmentPatch.eta).toEqual(new Date('2026-10-28T06:00:00Z'));

    const late = decideMilestone({
      shipment: shipmentRow({ status: 'AT_DESTINATION' }),
      container: containerRow({
        vesselImo: '9074729',
        lastMilestone: 'VESSEL_ARRIVED',
        lastMilestoneAt: new Date('2026-10-28T07:00:00Z'),
      }),
      event: event({
        providerEventId: 'e5',
        milestone: 'GATE_IN_ORIGIN',
        occurredAt: '2026-09-20T00:00:00Z',
      }),
    });
    expect(late.advancesContainer).toBe(false);
    expect(late.containerPatch).toEqual({});
    expect(late.vesselEffects).toEqual([]);
    expect(late.illegal).toBe(true);
  });
});

/** In-memory TrackingStore: containers keyed by number across several organisations. */
const memoryStore = () => {
  interface Org {
    shipments: Map<string, ShipmentRow>;
    containers: Map<string, ContainerRow>;
    events: Array<{
      source: string;
      providerEventId: string;
      eventType: string;
      statusAfter: ShipmentStatus | null;
    }>;
  }
  const orgs = new Map<string, Org>();
  const vessels = new Map<string, { count: number; state: string; name: string | null }>();
  const addOrg = (id: string, shipment: ShipmentRow, container: ContainerRow) => {
    orgs.set(id, {
      shipments: new Map([[shipment.id, shipment]]),
      containers: new Map([[container.id, container]]),
      events: [],
    });
  };
  const store: TrackingStore = {
    async findTrackedContainers(containerNumber) {
      const out = [];
      for (const [organizationId, org] of orgs) {
        for (const c of org.containers.values()) {
          if (c.containerNumber === containerNumber)
            out.push({ organizationId, shipmentId: c.shipmentId, containerId: c.id });
        }
      }
      return out;
    },
    async withOrganization(organizationId, fn) {
      const org = orgs.get(organizationId)!;
      const api: TrackingOrgStore = {
        getShipment: async (id) => org.shipments.get(id) ?? null,
        getContainer: async (id) => org.containers.get(id) ?? null,
        eventExists: async (source, providerEventId) =>
          org.events.some((e) => e.source === source && e.providerEventId === providerEventId),
        insertEvent: async (e) => {
          org.events.push({
            source: e.source,
            providerEventId: e.providerEventId,
            eventType: e.eventType,
            statusAfter: e.statusAfter,
          });
          return { id: `ev-${org.events.length}` };
        },
        updateShipment: async (id, patch) => {
          const s = org.shipments.get(id)!;
          if (patch.status) s.status = patch.status;
          if (patch.eta !== undefined) s.eta = patch.eta;
        },
        updateContainer: async (id, patch) => {
          Object.assign(org.containers.get(id)!, patch);
        },
        vessels: {
          addActiveContainer: async (imo, d) => {
            const v = vessels.get(imo) ?? { count: 0, state: 'AT_SEA', name: d.name };
            v.count += 1;
            v.state = 'AT_SEA';
            vessels.set(imo, v);
          },
          removeActiveContainer: async (imo) => {
            const v = vessels.get(imo);
            if (!v) return;
            v.count = Math.max(0, v.count - 1);
            if (v.count === 0) v.state = 'DOCKED';
          },
        },
      };
      return fn(api);
    },
  };
  return { store, orgs, vessels, addOrg };
};

describe('processProviderEvents (cross-tenant fan-out, idempotency, kill switch)', () => {
  it('an event for a container tracked by orgs A and B updates both; C (other container) is untouched', async () => {
    const m = memoryStore();
    m.addOrg('A', shipmentRow({ id: 'sa' }), containerRow({ id: 'ca', shipmentId: 'sa' }));
    m.addOrg('B', shipmentRow({ id: 'sb' }), containerRow({ id: 'cb', shipmentId: 'sb' }));
    m.addOrg(
      'C',
      shipmentRow({ id: 'sc' }),
      containerRow({ id: 'cc', shipmentId: 'sc', containerNumber: 'MSKU1234565' }),
    );
    const warnings: string[] = [];
    const log = { info: () => undefined, warn: (e: string) => void warnings.push(e) };

    const s1 = await processProviderEvents(m.store, [event()], {
      source: 'terminal49',
      now: new Date(),
      log,
    });
    expect(s1).toEqual({
      received: 1,
      matched: 2,
      inserted: 2,
      duplicates: 0,
      illegal: 0,
      unmatched: 0,
    });
    expect(m.orgs.get('A')!.shipments.get('sa')!.status).toBe('IN_TRANSIT');
    expect(m.orgs.get('B')!.shipments.get('sb')!.status).toBe('IN_TRANSIT');
    expect(m.orgs.get('C')!.shipments.get('sc')!.status).toBe('BOOKED');
    expect(m.orgs.get('C')!.events).toEqual([]);
    // One vessel, two containers aboard (one per organisation).
    expect(m.vessels.get('9074729')).toMatchObject({ count: 2, state: 'AT_SEA' });

    // Duplicate delivery is a no-op everywhere.
    const s2 = await processProviderEvents(m.store, [event()], {
      source: 'terminal49',
      now: new Date(),
    });
    expect(s2).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(m.vessels.get('9074729')!.count).toBe(2);

    // Discharge: both organisations' containers come off; at zero the vessel is DOCKED.
    const discharged = event({
      providerEventId: 'e9',
      milestone: 'DISCHARGED_DESTINATION',
      occurredAt: '2026-10-28T07:40:00Z',
    });
    const s3 = await processProviderEvents(m.store, [discharged], {
      source: 'terminal49',
      now: new Date(),
    });
    expect(s3.inserted).toBe(2);
    expect(m.vessels.get('9074729')).toMatchObject({ count: 0, state: 'DOCKED' });
    expect(m.orgs.get('A')!.shipments.get('sa')!.status).toBe('AT_DESTINATION');

    // Illegal transition afterwards: stored, warned, status unchanged.
    const gateIn = event({
      providerEventId: 'e10',
      milestone: 'GATE_IN_ORIGIN',
      occurredAt: '2026-10-29T00:00:00Z',
    });
    const s4 = await processProviderEvents(m.store, [gateIn], {
      source: 'terminal49',
      now: new Date(),
      log,
    });
    expect(s4.illegal).toBe(2);
    expect(m.orgs.get('A')!.shipments.get('sa')!.status).toBe('AT_DESTINATION');
    expect(m.orgs.get('A')!.events.map((e) => e.eventType)).toEqual([
      'LOADED_ON_VESSEL',
      'DISCHARGED_DESTINATION',
      'GATE_IN_ORIGIN',
    ]);
    expect(warnings).toEqual(['tracking.illegal_transition', 'tracking.illegal_transition']);

    // An unknown container number matches nobody.
    const s5 = await processProviderEvents(
      m.store,
      [event({ providerEventId: 'e11', containerNumber: 'TGHU9876542' })],
      { source: 'terminal49', now: new Date() },
    );
    expect(s5).toMatchObject({ unmatched: 1, matched: 0 });
  });

  it('applyMilestone refuses a container that does not match the event or shipment', async () => {
    const m = memoryStore();
    m.addOrg(
      'A',
      shipmentRow({ id: 'sa' }),
      containerRow({ id: 'ca', shipmentId: 'sa', containerNumber: 'MSKU1234565' }),
    );
    const r = await m.store.withOrganization('A', (org) =>
      applyMilestone(org, {
        shipmentId: 'sa',
        containerId: 'ca',
        event: event(),
        source: 'MANUAL',
        now: new Date(),
      }),
    );
    expect(r).toEqual({ outcome: 'NOT_FOUND' });
    expect(payloadSha256({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadSha256(undefined)).toBe(payloadSha256(null));
  });
});

// ---------- Terminal49 ----------

const SECRET = 'test-webhook-secret';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

describe('Terminal49MilestoneProvider', () => {
  const now = () => new Date('2026-09-23T10:02:00Z');

  it('parses a signed vessel_loaded webhook into a normalised milestone', () => {
    const p = new Terminal49MilestoneProvider({ now });
    const body = fixture('terminal49-webhook-vessel-loaded.json');
    const r = p.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, SECRET);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      providerEventId: 'te_0001',
      containerNumber: 'CSQU3054383',
      milestone: 'LOADED_ON_VESSEL',
      occurredAt: '2026-09-23T08:30:00Z',
      locationLocode: 'CNSZX',
      locationName: 'Shenzhen (Yantian)',
      vesselImo: '9074729',
      vesselName: 'EXAMPLE MAERSK',
      voyageNumber: '042W',
      latitude: 22.5,
      longitude: 113.9,
      etaAt: '2026-10-28T06:00:00Z',
      providerEventType: 'container.transport.vessel_loaded',
    });
    // Only the event resource is kept as raw payload.
    expect(JSON.stringify(r.events[0]!.raw)).not.toContain('bill_of_lading_number');
    expect(terminal49Signature(SECRET, body)).toBe(sign(body));
  });

  it('accepts a `sha256=` prefixed signature and a mixed-case header name', () => {
    const p = new Terminal49MilestoneProvider({ now: () => new Date('2026-10-28T09:01:00Z') });
    const body = fixture('terminal49-webhook-vessel-discharged.json');
    const r = p.parseWebhook(body, { 'X-T49-Webhook-Signature': `sha256=${sign(body)}` }, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.events[0]).toMatchObject({
        milestone: 'DISCHARGED_DESTINATION',
        locationLocode: 'GBFXT',
      });
  });

  it('rejects a bad, missing or wrong-length signature, a tampered body and a stale timestamp', () => {
    const p = new Terminal49MilestoneProvider({ now });
    const body = fixture('terminal49-webhook-vessel-loaded.json');
    expect(
      p.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: 'deadbeef' }, SECRET),
    ).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(p.parseWebhook(body, {}, SECRET)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(p.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: 'zz' }, SECRET)).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    expect(
      p.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, 'other-secret'),
    ).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    const tampered = body.replace('CSQU3054383', 'MSKU1234565');
    expect(
      p.parseWebhook(tampered, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, SECRET),
    ).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(
      p.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, undefined),
    ).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });

    const late = new Terminal49MilestoneProvider({ now: () => new Date('2026-09-23T10:06:00Z') });
    expect(
      late.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, SECRET),
    ).toMatchObject({ ok: false, reason: 'REPLAY' });
    const early = new Terminal49MilestoneProvider({ now: () => new Date('2026-09-23T09:54:00Z') });
    expect(
      early.parseWebhook(body, { [TERMINAL49_SIGNATURE_HEADER]: sign(body) }, SECRET),
    ).toMatchObject({ ok: false, reason: 'REPLAY' });
  });

  it('rejects non-JSON and unexpected shapes; ignores unknown events and bad container numbers', () => {
    const p = new Terminal49MilestoneProvider({ now });
    expect(
      p.parseWebhook('nope', { [TERMINAL49_SIGNATURE_HEADER]: sign('nope') }, SECRET),
    ).toMatchObject({ ok: false, reason: 'MALFORMED' });
    const wrong = JSON.stringify({ data: { id: 'x', type: 'something_else', attributes: {} } });
    expect(
      p.parseWebhook(wrong, { [TERMINAL49_SIGNATURE_HEADER]: sign(wrong) }, SECRET),
    ).toMatchObject({ ok: false, reason: 'MALFORMED' });

    const doc = JSON.parse(fixture('terminal49-webhook-vessel-loaded.json')) as {
      included: Array<{ type: string; attributes: Record<string, unknown> }>;
    };
    doc.included[0]!.attributes.event = 'container.transport.something_new';
    const unknown = JSON.stringify(doc);
    const r1 = p.parseWebhook(unknown, { [TERMINAL49_SIGNATURE_HEADER]: sign(unknown) }, SECRET);
    expect(r1).toEqual({ ok: true, events: [] });

    doc.included[0]!.attributes.event = 'container.transport.vessel_loaded';
    doc.included[1]!.attributes.number = 'CSQU3054384'; // bad check digit
    const bad = JSON.stringify(doc);
    expect(p.parseWebhook(bad, { [TERMINAL49_SIGNATURE_HEADER]: sign(bad) }, SECRET)).toEqual({
      ok: true,
      events: [],
    });
  });

  it('subscribe posts a tracking request with the API key and returns the provider ref', async () => {
    const calls: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        text: async () => fixture('terminal49-tracking-request.json'),
        json: async () => JSON.parse(fixture('terminal49-tracking-request.json')) as unknown,
      };
    };
    const p = new Terminal49MilestoneProvider({ apiKey: 'k-123', fetch, now });
    const r = await p.subscribe({ containerNumber: 'CSQU3054383', carrierScac: 'MAEU' });
    expect(r).toEqual({ ok: true, providerRef: 'tr_01hx0000000000000000000009' });
    expect(calls[0]!.url).toBe('https://api.terminal49.com/v2/tracking_requests');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers?.authorization).toBe('Bearer k-123');
    expect(JSON.parse(calls[0]!.init?.body ?? '{}')).toEqual({
      data: {
        type: 'tracking_request',
        attributes: { request_type: 'container', request_number: 'CSQU3054383', scac: 'MAEU' },
      },
    });
    const bol = await p.subscribe({ masterBillNumber: 'MAEU987654321' });
    expect(bol.ok).toBe(true);
    expect(JSON.parse(calls[1]!.init?.body ?? '{}')).toMatchObject({
      data: { attributes: { request_type: 'bill_of_lading' } },
    });
    expect(await p.subscribe({})).toMatchObject({ ok: false, reason: 'INVALID' });
  });

  it('subscribe/poll report NOT_CONFIGURED without a key, UNAVAILABLE on 5xx and MALFORMED on garbage', async () => {
    const none = new Terminal49MilestoneProvider({ now });
    expect(await none.subscribe({ containerNumber: 'CSQU3054383' })).toMatchObject({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(await none.pollShipment('tr_1')).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(none.configured).toBe(false);

    const down: HttpFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'down',
      json: async () => ({}),
    });
    const d = new Terminal49MilestoneProvider({ apiKey: 'k', fetch: down, now });
    expect(await d.subscribe({ containerNumber: 'CSQU3054383' })).toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
    expect(await d.pollShipment('tr_1')).toMatchObject({ ok: false, reason: 'UNAVAILABLE' });
    expect(await d.unsubscribe('tr_1')).toMatchObject({ ok: false });

    const garbage: HttpFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"data":{"id":1}}',
      json: async () => ({}),
    });
    const g = new Terminal49MilestoneProvider({ apiKey: 'k', fetch: garbage, now });
    expect(await g.subscribe({ containerNumber: 'CSQU3054383' })).toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });

    const thrown: HttpFetch = async () => {
      throw new Error('ECONNRESET');
    };
    const t = new Terminal49MilestoneProvider({ apiKey: 'k', fetch: thrown, now });
    expect(await t.subscribe({ containerNumber: 'CSQU3054383' })).toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
      message: 'ECONNRESET',
    });
  });

  it('pollShipment walks tracking request → containers → transport events', async () => {
    const trackingRequest = JSON.parse(fixture('terminal49-tracking-request.json')) as {
      data: { relationships: Record<string, unknown> };
    };
    trackingRequest.data.relationships.tracked_object = {
      data: { id: 's_0001', type: 'shipment' },
    };
    const loaded = JSON.parse(fixture('terminal49-webhook-vessel-loaded.json')) as {
      included: Array<{ id: string; type: string }>;
    };
    const routes: Record<string, unknown> = {
      'https://api.terminal49.com/v2/tracking_requests/tr_1?include=tracked_object':
        trackingRequest,
      'https://api.terminal49.com/v2/shipments/s_0001/containers': {
        data: loaded.included.filter((r) => r.type === 'container'),
      },
      'https://api.terminal49.com/v2/containers/c_0001/transport_events?include=container,vessel,location':
        {
          data: loaded.included.filter((r) => r.type === 'transport_event'),
          included: loaded.included.filter((r) => r.type !== 'transport_event'),
        },
    };
    const fetch: HttpFetch = async (url) => {
      const body = routes[url];
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        text: async () => JSON.stringify(body ?? {}),
        json: async () => body,
      };
    };
    const p = new Terminal49MilestoneProvider({ apiKey: 'k', fetch, now });
    const r = await p.pollShipment('tr_1');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.events.map((e) => [e.providerEventId, e.milestone])).toEqual([
        ['te_0001', 'LOADED_ON_VESSEL'],
      ]);
    expect(await p.unsubscribe('tr_missing')).toEqual({ ok: true }); // 404 = already gone
  });
});

// ---------- position providers ----------

describe('SpirePositionProvider', () => {
  it('queries by IMO with the bearer token and normalises positions', async () => {
    const calls: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
    const fetch: HttpFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => fixture('spire-vessels.json'),
        json: async () => JSON.parse(fixture('spire-vessels.json')) as unknown,
      };
    };
    const p = new SpirePositionProvider({ token: 't-1', fetch });
    const out = await p.positions(['9074729', '9362994', '9454230']);
    expect(calls[0]!.init?.headers?.authorization).toBe('Bearer t-1');
    expect(JSON.parse(calls[0]!.init?.body ?? '{}')).toMatchObject({
      variables: { imo: ['9074729', '9362994', '9454230'] },
    });
    expect(out).toEqual([
      {
        imo: '9074729',
        name: 'EXAMPLE MAERSK',
        lat: 5.42,
        lon: 80.61,
        speedKnots: 17.9,
        headingDeg: 292,
        positionAt: '2026-09-30T04:12:00Z',
        destinationLocode: 'GBFXT',
        etaAt: '2026-10-28T06:00:00Z',
      },
      {
        imo: '9362994',
        name: 'EXAMPLE DOCKED',
        lat: 51.95,
        lon: 1.31,
        speedKnots: 0,
        headingDeg: 151,
        positionAt: '2026-09-30T04:00:00Z',
      },
    ]);
    expect(await p.positions([])).toEqual([]);
    expect(p.configured).toBe(true);
  });

  it('throws on HTTP errors, GraphQL errors and malformed bodies; NOT configured without a token', async () => {
    const http: HttpFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => '',
      json: async () => ({}),
    });
    await expect(
      new SpirePositionProvider({ token: 't', fetch: http }).positions(['9074729']),
    ).rejects.toThrow(/500/);
    const gql: HttpFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ errors: [{ message: 'quota' }] }),
    });
    await expect(
      new SpirePositionProvider({ token: 't', fetch: gql }).positions(['9074729']),
    ).rejects.toThrow(/quota/);
    const bad: HttpFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ data: { vessels: 'x' } }),
    });
    await expect(
      new SpirePositionProvider({ token: 't', fetch: bad }).positions(['9074729']),
    ).rejects.toThrow(/shape/);
    await expect(new SpirePositionProvider({}).positions(['9074729'])).rejects.toThrow(
      /SPIRE_API_TOKEN/,
    );
  });
});

describe('MarineTrafficPositionProvider', () => {
  it('calls once per IMO and normalises tenths-of-knots, UTC timestamps and destinations', async () => {
    const urls: string[] = [];
    const fetch: HttpFetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => fixture('marinetraffic-exportvessel.json'),
        json: async () => JSON.parse(fixture('marinetraffic-exportvessel.json')) as unknown,
      };
    };
    const p = new MarineTrafficPositionProvider({ apiKey: 'mt-key', fetch });
    const out = await p.positions(['9074729']);
    expect(urls).toEqual([
      'https://services.marinetraffic.com/api/exportvessel/v:5/mt-key/imo:9074729/protocol:jsono',
    ]);
    expect(out).toEqual([
      {
        imo: '9074729',
        name: 'EXAMPLE MAERSK',
        lat: 5.42,
        lon: 80.61,
        speedKnots: 17.9,
        headingDeg: 292,
        positionAt: '2026-09-30T04:12:00Z',
        destinationLocode: 'GBFXT',
        etaAt: '2026-10-28T06:00:00Z',
      },
    ]);
    expect(p.maxImosPerCall).toBe(1);
    const down: HttpFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => '',
      json: async () => ({}),
    });
    await expect(
      new MarineTrafficPositionProvider({ apiKey: 'k', fetch: down }).positions(['9074729']),
    ).rejects.toThrow(/429/);
    await expect(new MarineTrafficPositionProvider({}).positions(['9074729'])).rejects.toThrow(
      /MARINETRAFFIC_API_KEY/,
    );
  });
});

describe('provider selection', () => {
  it('falls back to the not-configured providers', async () => {
    expect(createMilestoneProvider({})).toBeInstanceOf(NotConfiguredMilestoneProvider);
    expect(createMilestoneProvider({ TRACKING_MILESTONE_PROVIDER: 'bogus' })).toBeInstanceOf(
      NotConfiguredMilestoneProvider,
    );
    expect(createMilestoneProvider({ TRACKING_MILESTONE_PROVIDER: 'terminal49' })).toBeInstanceOf(
      Terminal49MilestoneProvider,
    );
    expect(createPositionProvider({})).toBeInstanceOf(NotConfiguredPositionProvider);
    expect(createPositionProvider({ TRACKING_POSITION_PROVIDER: 'spire' })).toBeInstanceOf(
      SpirePositionProvider,
    );
    expect(createPositionProvider({ TRACKING_POSITION_PROVIDER: 'marinetraffic' })).toBeInstanceOf(
      MarineTrafficPositionProvider,
    );
    expect(milestoneProviderForWebhook('terminal49', {})).toBeInstanceOf(
      Terminal49MilestoneProvider,
    );
    expect(milestoneProviderForWebhook('project44', {})).toBeNull();

    const none = new NotConfiguredMilestoneProvider();
    expect(await none.subscribe({ containerNumber: 'CSQU3054383' })).toMatchObject({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(none.parseWebhook()).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(await none.pollShipment('x')).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(await none.unsubscribe('x')).toEqual({ ok: true });
    await expect(new NotConfiguredPositionProvider().positions(['9074729'])).rejects.toThrow(
      /TRACKING_POSITION_PROVIDER=none/,
    );
  });
});
