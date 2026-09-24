/**
 * M9 tracking store against a real Postgres (ADR-0017, brief §6.4, §8 cross-tenant negatives).
 * Skipped unless DATABASE_URL is set. Works as a superuser or as a non-superuser member of
 * harbour_app (production-like; the raw-SQL assertions switch to the app role under a superuser).
 */
import { randomUUID } from 'node:crypto';
import {
  normalisedMilestoneSchema,
  processProviderEvents,
  type NormalisedMilestone,
} from '@harbour/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disposePrismaClient } from '../src/client.js';
import { withOrgTransaction, type TenantTransactionClient } from '../src/tenancy.js';
import {
  PrismaTrackingStore,
  PrismaVesselPollStore,
  withTrackingLookup,
  withTrackingSweep,
} from '../src/tracking.js';
import type { PrismaClient } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NUMBER = 'TGHU9876542'; // valid ISO 6346 check digit (distinct from the web flow test's numbers)
const OTHER = 'HLCU6543214';
const IMO = '9454230'; // distinct from the web flow test's vessel

const milestone = (over: Partial<NormalisedMilestone>): NormalisedMilestone =>
  normalisedMilestoneSchema.parse({
    providerEventId: randomUUID(),
    containerNumber: NUMBER,
    milestone: 'LOADED_ON_VESSEL',
    occurredAt: '2026-09-23T08:30:00Z',
    vesselImo: IMO,
    vesselName: 'EXAMPLE MAERSK',
    locationLocode: 'CNSZX',
    latitude: 22.5,
    longitude: 113.9,
    raw: { fixture: true },
    ...over,
  });

describe.skipIf(!DATABASE_URL)('tracking store (database)', () => {
  const orgA = randomUUID();
  const orgB = randomUUID();
  const orgC = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let mustSwitchRole = false;
  const ships: Record<string, { shipmentId: string; containerId: string }> = {};

  const asAppRole = async (
    tx: TenantTransactionClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  ) => {
    if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
  };

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL!, log: ['error'] });
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    mustSwitchRole = who?.bypass === true;
    // active_vessels is shared across test runs and roles (no DELETE for the app role): reset it.
    await prisma.activeVessel.updateMany({
      where: { imo: IMO },
      data: {
        activeContainerCount: 0,
        pollState: 'DOCKED',
        nextPollAt: null,
        lastError: null,
        positionAt: null,
        lastLatitude: null,
        lastLongitude: null,
      },
    });

    for (const [org, label, number] of [
      [orgA, 'A', NUMBER],
      [orgB, 'B', NUMBER],
      [orgC, 'C', OTHER],
    ] as const) {
      ships[label] = await withOrgTransaction(prisma, org, async (tx) => {
        await tx.organization.create({ data: { name: `tracking test ${label} ${suffix}` } });
        const shipment = await tx.shipment.create({
          data: {
            organizationId: org,
            reference: `ref-${label}`,
            originLocode: 'CNSZX',
            destinationLocode: 'GBFXT',
            trackingProvider: label === 'C' ? 'terminal49' : null,
            trackingRequestRef: label === 'C' ? `tr-${suffix}` : null,
          },
          select: { id: true },
        });
        const container = await tx.container.create({
          data: { organizationId: org, shipmentId: shipment.id, containerNumber: number },
          select: { id: true },
        });
        return { shipmentId: shipment.id, containerId: container.id };
      });
    }
  });

  afterAll(async () => {
    // shipment_events is append-only; only a superuser can clear test rows (like the GDPR job).
    if (mustSwitchRole) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE shipment_events DISABLE TRIGGER shipment_events_append_only',
      );
      try {
        for (const org of [orgA, orgB, orgC]) {
          await withOrgTransaction(prisma, org, async (tx) => {
            await tx.shipmentEvent.deleteMany();
            await tx.container.deleteMany();
            await tx.shipment.deleteMany();
            await tx.organization.deleteMany();
          });
        }
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE shipment_events ENABLE TRIGGER shipment_events_append_only',
        );
      }
      await prisma.activeVessel.deleteMany({ where: { imo: IMO } });
    }
    await disposePrismaClient();
  });

  it('containers are tenant rows: org A cannot see org B, raw SQL under RLS returns only own rows', async () => {
    const seenByA = await withOrgTransaction(prisma, orgA, (tx) =>
      tx.container.findMany({ select: { id: true } }),
    );
    expect(seenByA.map((c) => c.id)).toEqual([ships.A!.containerId]);
    const rows = await withOrgTransaction(prisma, orgA, async (tx) => {
      await asAppRole(tx);
      return tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM containers WHERE container_number = ${NUMBER}`;
    });
    expect(rows.map((r) => r.id)).toEqual([ships.A!.containerId]);
    await expect(
      withOrgTransaction(prisma, orgA, (tx) =>
        tx.container.update({ where: { id: ships.B!.containerId }, data: { vesselName: 'x' } }),
      ),
    ).rejects.toThrow();
    // Bad check-digit format is rejected by the DB CHECK as well as the validator.
    await expect(
      withOrgTransaction(prisma, orgA, (tx) =>
        tx.container.create({
          data: { organizationId: orgA, shipmentId: ships.A!.shipmentId, containerNumber: 'bad' },
        }),
      ),
    ).rejects.toThrow(/containers_container_number_format/);
  });

  it('the lookup policy exposes exactly the rows for one container number, and nothing without the setting', async () => {
    const refs = await withTrackingLookup(prisma, NUMBER);
    expect(refs.map((r) => r.organizationId).sort()).toEqual([orgA, orgB].sort());
    expect(await withTrackingLookup(prisma, OTHER)).toEqual([
      { organizationId: orgC, shipmentId: ships.C!.shipmentId, containerId: ships.C!.containerId },
    ]);
    expect(await withTrackingLookup(prisma, 'not a number')).toEqual([]);

    // Under the app role, with the setting for NUMBER, OTHER is invisible; with no setting, nothing.
    const [withSetting, withoutSetting] = await prisma.$transaction(async (tx) => {
      await asAppRole(tx);
      const none = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM containers`;
      await tx.$queryRaw`SELECT set_config('app.tracking_container', ${NUMBER}, true)`;
      const some = await tx.$queryRaw<
        { container_number: string }[]
      >`SELECT container_number FROM containers`;
      return [some, none] as const;
    });
    expect(Number(withoutSetting[0]?.n)).toBe(0);
    expect(withSetting.every((r) => r.container_number === NUMBER)).toBe(true);
    expect(withSetting).toHaveLength(2);
  });

  it('an event for a number tracked by A and B updates both, never C; duplicates no-op; vessel counted once per container; kill switch', async () => {
    const store = new PrismaTrackingStore(prisma);
    const loaded = milestone({ providerEventId: `loaded-${suffix}` });
    const s1 = await processProviderEvents(store, [loaded], {
      source: 'terminal49',
      now: new Date(),
    });
    expect(s1).toEqual({
      received: 1,
      matched: 2,
      inserted: 2,
      duplicates: 0,
      illegal: 0,
      unmatched: 0,
    });

    for (const [org, label] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ] as const) {
      const state = await withOrgTransaction(prisma, org, async (tx) => ({
        shipment: await tx.shipment.findUniqueOrThrow({ where: { id: ships[label]!.shipmentId } }),
        container: await tx.container.findUniqueOrThrow({
          where: { id: ships[label]!.containerId },
        }),
        events: await tx.shipmentEvent.findMany({ orderBy: { occurredAt: 'asc' } }),
      }));
      expect(state.shipment.status).toBe('IN_TRANSIT');
      expect(state.container).toMatchObject({
        vesselImo: IMO,
        vesselName: 'EXAMPLE MAERSK',
        lastMilestone: 'LOADED_ON_VESSEL',
      });
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        source: 'terminal49',
        providerEventId: `loaded-${suffix}`,
        eventType: 'LOADED_ON_VESSEL',
        statusAfter: 'IN_TRANSIT',
        containerId: ships[label]!.containerId,
        locationLocode: 'CNSZX',
        vesselImo: IMO,
      });
      expect(state.events[0]!.latitude?.toNumber()).toBe(22.5);
      expect(state.events[0]!.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const c = await withOrgTransaction(prisma, orgC, async (tx) => ({
      shipment: await tx.shipment.findUniqueOrThrow({ where: { id: ships.C!.shipmentId } }),
      events: await tx.shipmentEvent.count(),
    }));
    expect(c.shipment.status).toBe('PENDING_DOCS');
    expect(c.events).toBe(0);

    const vessel = await prisma.activeVessel.findUniqueOrThrow({ where: { imo: IMO } });
    expect(vessel).toMatchObject({
      activeContainerCount: 2,
      pollState: 'AT_SEA',
      destinationLocode: 'GBFXT',
      name: 'EXAMPLE MAERSK',
    });
    expect(vessel.nextPollAt).not.toBeNull();

    // Same providerEventId again: no new rows anywhere, count unchanged.
    const s2 = await processProviderEvents(store, [loaded], {
      source: 'terminal49',
      now: new Date(),
    });
    expect(s2).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(
      (await prisma.activeVessel.findUniqueOrThrow({ where: { imo: IMO } })).activeContainerCount,
    ).toBe(2);

    // Departed: still aboard, no double count.
    await processProviderEvents(
      store,
      [
        milestone({
          providerEventId: `dep-${suffix}`,
          milestone: 'VESSEL_DEPARTED',
          occurredAt: '2026-09-23T12:00:00Z',
        }),
      ],
      { source: 'terminal49', now: new Date() },
    );
    expect(
      (await prisma.activeVessel.findUniqueOrThrow({ where: { imo: IMO } })).activeContainerCount,
    ).toBe(2);

    // Discharge in both organisations → 0 → DOCKED, nextPollAt cleared (kill switch).
    const s3 = await processProviderEvents(
      store,
      [
        milestone({
          providerEventId: `dis-${suffix}`,
          milestone: 'DISCHARGED_DESTINATION',
          occurredAt: '2026-10-28T07:40:00Z',
          locationLocode: 'GBFXT',
          latitude: 51.95,
          longitude: 1.35,
          etaAt: '2026-10-28T06:00:00Z',
        }),
      ],
      { source: 'terminal49', now: new Date() },
    );
    expect(s3.inserted).toBe(2);
    const docked = await prisma.activeVessel.findUniqueOrThrow({ where: { imo: IMO } });
    expect(docked).toMatchObject({
      activeContainerCount: 0,
      pollState: 'DOCKED',
      nextPollAt: null,
    });
    const a = await withOrgTransaction(prisma, orgA, (tx) =>
      tx.shipment.findUniqueOrThrow({ where: { id: ships.A!.shipmentId } }),
    );
    expect(a.status).toBe('AT_DESTINATION');
    expect(a.eta?.toISOString()).toBe('2026-10-28T06:00:00.000Z');

    // Illegal transition afterwards is stored, status unchanged.
    const warnings: string[] = [];
    const s4 = await processProviderEvents(
      store,
      [
        milestone({
          providerEventId: `late-${suffix}`,
          milestone: 'GATE_IN_ORIGIN',
          occurredAt: '2026-10-29T00:00:00Z',
        }),
      ],
      {
        source: 'terminal49',
        now: new Date(),
        log: { info: () => undefined, warn: (e) => void warnings.push(e) },
      },
    );
    expect(s4).toMatchObject({ inserted: 2, illegal: 2 });
    expect(warnings).toEqual(['tracking.illegal_transition', 'tracking.illegal_transition']);
    const a2 = await withOrgTransaction(prisma, orgA, (tx) =>
      tx.shipment.findUniqueOrThrow({
        where: { id: ships.A!.shipmentId },
        select: { status: true },
      }),
    );
    expect(a2.status).toBe('AT_DESTINATION');
  });

  it('events are append-only even with the new columns', async () => {
    await expect(
      withOrgTransaction(prisma, orgA, (tx) =>
        tx.shipmentEvent.updateMany({ data: { locationName: 'tampered' } }),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('the poll sweep lists subscribed shipments with no recent event and skips those with one', async () => {
    const now = new Date();
    const due = await withTrackingSweep(prisma, {
      noEventSince: new Date(now.getTime() - 24 * 3600_000),
      notPolledSince: new Date(now.getTime() - 6 * 3600_000),
    });
    const mine = due.filter((d) => d.organizationId === orgC);
    expect(mine).toEqual([
      {
        organizationId: orgC,
        shipmentId: ships.C!.shipmentId,
        trackingProvider: 'terminal49',
        trackingRequestRef: `tr-${suffix}`,
      },
    ]);
    // A and B have no provider subscription → never in the sweep.
    expect(due.some((d) => d.organizationId === orgA || d.organizationId === orgB)).toBe(false);

    // After a manual event in C the shipment leaves the sweep.
    const store = new PrismaTrackingStore(prisma);
    await processProviderEvents(
      store,
      [
        milestone({
          providerEventId: `c-${suffix}`,
          containerNumber: OTHER,
          milestone: 'GATE_IN_ORIGIN',
        }),
      ],
      { source: 'MANUAL', now },
    );
    const after = await withTrackingSweep(prisma, {
      noEventSince: new Date(now.getTime() - 24 * 3600_000),
      notPolledSince: new Date(now.getTime() - 6 * 3600_000),
    });
    expect(after.some((d) => d.organizationId === orgC)).toBe(false);
  });

  it('PrismaVesselPollStore: lists due vessels (not DOCKED), reads ports, records positions and failures', async () => {
    const poll = new PrismaVesselPollStore(prisma);
    const ports = await poll.listPorts();
    expect(ports.find((p) => p.locode === 'GBFXT')).toMatchObject({
      name: 'Felixstowe',
      countryCode: 'GB',
      latitude: 51.95,
      longitude: 1.35,
    });
    expect(ports.find((p) => p.locode === 'EGSUZ')?.chokePoint).toBe(true);

    // The vessel from the previous test is DOCKED → not due.
    expect((await poll.listDue(new Date('2100-01-01T00:00:00Z'))).some((v) => v.imo === IMO)).toBe(
      false,
    );
    await prisma.activeVessel.update({
      where: { imo: IMO },
      data: { pollState: 'AT_SEA', nextPollAt: new Date('2026-01-01T00:00:00Z') },
    });
    const due = await poll.listDue(new Date('2026-01-02T00:00:00Z'));
    expect(due.find((v) => v.imo === IMO)).toMatchObject({
      pollState: 'AT_SEA',
      activeContainerCount: 0,
    });

    await poll.recordPosition(IMO, {
      lastLatitude: 5.42,
      lastLongitude: 80.61,
      speedKnots: 17.9,
      headingDeg: 292,
      positionAt: new Date('2026-09-30T04:12:00Z'),
      positionSource: 'FAKE',
      providerEtaAt: new Date('2026-10-28T06:00:00Z'),
      pollState: 'COASTAL',
      nextPollAt: new Date('2026-09-30T09:12:00Z'),
    });
    const v = (await poll.listDue(new Date('2026-10-01T00:00:00Z'))).find((x) => x.imo === IMO)!;
    expect(v).toMatchObject({
      lastLatitude: 5.42,
      lastLongitude: 80.61,
      speedKnots: 17.9,
      headingDeg: 292,
      positionSource: 'FAKE',
      pollState: 'COASTAL',
      lastError: null,
    });
    await poll.recordFailure(IMO, {
      lastError: '3:HttpError',
      pollState: 'STALE',
      nextPollAt: new Date('2026-10-02T00:00:00Z'),
    });
    const stale = await prisma.activeVessel.findUniqueOrThrow({ where: { imo: IMO } });
    expect(stale).toMatchObject({ lastError: '3:HttpError', pollState: 'STALE' });
    // Position fields survive a failure ("last seen").
    expect(stale.lastLatitude?.toNumber()).toBe(5.42);
  });
});
