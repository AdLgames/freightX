/**
 * M9 — tracking routes against a real Postgres (ADR-0017, brief §6.4, §9). Sign in → onboarding →
 * track a container → manual milestone → detail → map-state → webhook → cross-tenant negatives →
 * VIEWER cannot track → no PII in logs. Runs only with DATABASE_URL (migrations applied), as a
 * superuser or as a non-superuser member of harbour_app.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL49_SIGNATURE_HEADER } from '@harbour/adapters';
import { disposePrismaClient, withOrgTransaction, type PrismaClient } from '@harbour/db';
import { haversineKm, knotsToKmPerHour } from '@harbour/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests, type AppServices } from '../services/app.server';
import { listUserOrganizations } from '../services/organizations.server';
import { pageErrorSchema } from '../services/page-error';
import type { MapState } from '../services/tracking/map-state';
import { createTrackingServices } from '../services/tracking/tracking.server';
import {
  ORIGIN,
  createTestApp,
  lastLinkPath,
  makeRequest,
  run,
  sessionCookieFrom,
  sessionIdFrom,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { loader as mapStateLoader } from './app.api.map-state';
import { action as trackAction, loader as trackingLoader } from './app.tracking';
import { action as detailAction, loader as detailLoader } from './app.tracking_.$id';
import { action as loginAction } from './login';
import { action as verifyAction } from './login_.verify';
import { action as onboardingAction, loader as onboardingLoader } from './onboarding.organization';
import { action as webhookAction } from './webhooks.tracking.$providerId';

const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = 'db-test-webhook-secret-0123456789';
const fixture = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'adapters',
    'fixtures',
    'tracking',
    'terminal49-webhook-vessel-loaded.json',
  ),
  'utf8',
);
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

type RouteFn = (args: {
  request: Request;
  params: Record<string, string>;
  context: object;
}) => unknown;
const runWith = (fn: unknown, request: Request, params: Record<string, string>) =>
  run((args: { request: Request }) => (fn as RouteFn)({ ...args, params, context: {} }), request);

describe.skipIf(!DATABASE_URL)('tracking routes (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  let app: AppServices;
  const emails: string[] = [];
  const orgIds: string[] = [];
  let mustSwitchRole = false;

  const signIn = async (label: string, ip: string) => {
    const email = uniqueEmail(label);
    emails.push(email);
    const sent = await run(
      loginAction,
      makeRequest('/login', { form: { email }, headers: { 'x-forwarded-for': ip } }),
    );
    expect(sent.data).toMatchObject({ status: 'sent' });
    const token = new URL(lastLinkPath(t.logs)!, 'http://x').searchParams.get('token')!;
    const res = await run(verifyAction, makeRequest('/login/verify', { form: { token } }));
    return { email, cookie: sessionCookieFrom(res.setCookie)! };
  };

  const onboard = async (cookie: string, name: string) => {
    const page = await run(onboardingLoader, makeRequest('/onboarding/organization', { cookie }));
    const { csrfToken } = page.data as { csrfToken: string };
    const created = await run(
      onboardingAction,
      makeRequest('/onboarding/organization', { cookie, form: { name, _csrf: csrfToken } }),
    );
    expect(created.location).toBe('/app');
    return sessionCookieFrom(created.setCookie)!;
  };

  const csrfFor = async (cookie: string) =>
    (await app.auth.sessions!.read(sessionIdFrom(cookie)))!.data.csrfToken;

  beforeAll(async () => {
    t = await createTestApp({
      databaseUrl: DATABASE_URL,
      env: { TERMINAL49_WEBHOOK_SECRET: SECRET },
    });
    prisma = t.prisma!;
    // Inline queue (no REDIS_URL) with the fixture's timestamp inside the replay window.
    app = {
      ...t.app,
      tracking: createTrackingServices({
        env: t.app.env,
        logger: t.app.logger,
        prisma,
        now: () => new Date('2026-09-23T10:01:00Z'),
      }),
    };
    setAppForTests(app);
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    mustSwitchRole = who?.bypass === true;
    // active_vessels is shared across test runs and roles (no DELETE for the app role): reset it.
    await prisma.activeVessel.updateMany({
      where: { imo: '9074729' },
      data: {
        lastLatitude: null,
        lastLongitude: null,
        speedKnots: null,
        headingDeg: null,
        positionAt: null,
        positionSource: null,
        providerEtaAt: null,
        activeContainerCount: 0,
        pollState: 'DOCKED',
        nextPollAt: null,
        lastError: null,
      },
    });
  });

  afterAll(async () => {
    // shipment_events is append-only: only a superuser (like the GDPR hard-delete job) can clear
    // the test shipments and organisations. As the app role, memberships/profiles go and the
    // organisations stay behind with their events.
    if (mustSwitchRole) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE shipment_events DISABLE TRIGGER shipment_events_append_only',
      );
      try {
        for (const orgId of orgIds) {
          await withOrgTransaction(prisma, orgId, async (tx) => {
            await tx.shipmentEvent.deleteMany();
            await tx.container.deleteMany();
            await tx.shipment.deleteMany();
          });
        }
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE shipment_events ENABLE TRIGGER shipment_events_append_only',
        );
      }
      await prisma.activeVessel.deleteMany({ where: { imo: '9074729' } });
    }
    for (const orgId of orgIds) {
      await withOrgTransaction(prisma, orgId, async (tx) => {
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        if (mustSwitchRole) await tx.organization.deleteMany();
      });
    }
    await prisma.magicLinkToken.deleteMany({ where: { email: { in: emails } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    setAppForTests(null);
    await disposePrismaClient();
  });

  it('track → manual event → detail → map-state → webhook, with cross-tenant and role negatives', async () => {
    const firstLog = t.logs.length;
    const a = await signIn('owner-a', '198.51.100.31');
    const cookieA = await onboard(a.cookie, 'Tracking Org A');
    const userA = await prisma.user.findUniqueOrThrow({ where: { email: a.email } });
    const orgA = (await listUserOrganizations(prisma, userA.id))[0]!.organization.id;
    orgIds.push(orgA);
    const csrfA = await csrfFor(cookieA);

    // Empty list, provider not configured.
    const list0 = await run(trackingLoader, makeRequest('/app/tracking', { cookie: cookieA }));
    expect(list0.status).toBe(200);
    expect(list0.data).toMatchObject({
      shipments: [],
      canTrack: true,
      provider: { configured: false },
    });
    expect((list0.data as { ports: unknown[] }).ports.length).toBeGreaterThan(10);

    // Invalid check digit → 400 with the field error; nothing created.
    const bad = await run(
      trackAction,
      makeRequest('/app/tracking', {
        cookie: cookieA,
        form: {
          _csrf: csrfA,
          reference: 'Bad',
          containerNumbers: 'CSQU3054384',
          destinationLocode: 'GBFXT',
        },
      }),
    );
    expect(bad.status).toBe(400);
    expect((bad.data as { errors: Record<string, string> }).errors.containerNumbers).toMatch(
      /check digit/,
    );
    expect(await withOrgTransaction(prisma, orgA, (tx) => tx.shipment.count())).toBe(0);

    // No CSRF → 403 page.
    const noCsrf = await run(
      trackAction,
      makeRequest('/app/tracking', {
        cookie: cookieA,
        form: { reference: 'x', containerNumbers: 'CSQU3054383' },
      }),
    );
    expect(noCsrf.status).toBe(403);

    // Valid → redirect to the detail page (provider none → "not_configured" notice).
    const created = await run(
      trackAction,
      makeRequest('/app/tracking', {
        cookie: cookieA,
        form: {
          _csrf: csrfA,
          reference: 'Autumn stock',
          containerNumbers: 'csqu 305438-3\nMSKU1234565',
          originLocode: 'CNSZX',
          destinationLocode: 'GBFXT',
          sizeType: 'C40HC',
        },
      }),
    );
    expect(created.status).toBe(302);
    const shipmentId = created.location!.match(
      /^\/app\/tracking\/([0-9a-f-]{36})\?tracked=not_configured$/,
    )![1]!;
    const rows = await withOrgTransaction(prisma, orgA, async (tx) => ({
      shipment: await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } }),
      containers: await tx.container.findMany({ orderBy: { containerNumber: 'asc' } }),
      audits: await tx.auditLog.findMany({ where: { action: 'shipment.track' } }),
    }));
    expect(rows.shipment).toMatchObject({
      reference: 'Autumn stock',
      quoteId: null,
      status: 'PENDING_DOCS',
      originLocode: 'CNSZX',
      destinationLocode: 'GBFXT',
      trackingProvider: null,
    });
    expect(rows.containers.map((c) => c.containerNumber)).toEqual(['CSQU3054383', 'MSKU1234565']);
    expect(rows.containers[0]!.sizeType).toBe('C40HC');
    expect(rows.audits).toHaveLength(1);
    expect(rows.audits[0]!.metadata).toMatchObject({
      containerCount: 2,
      provider: 'none',
      subscribed: false,
    });
    const containerId = rows.containers[0]!.id;

    // Manual LOADED_ON_VESSEL with IMO + coordinates → status IN_TRANSIT, vessel row created.
    const manual = await runWith(
      detailAction,
      makeRequest(`/app/tracking/${shipmentId}`, {
        cookie: cookieA,
        form: {
          _csrf: csrfA,
          containerId,
          milestone: 'LOADED_ON_VESSEL',
          occurredAt: '2026-09-23T08:30',
          locationLocode: 'cnszx',
          locationName: 'Yantian',
          vesselImo: 'IMO 9074729',
          vesselName: 'EXAMPLE MAERSK',
          voyageNumber: '042W',
          latitude: '22.5',
          longitude: '113.9',
          note: 'From the carrier portal',
        },
      }),
      { id: shipmentId },
    );
    expect(manual.status).toBe(200);
    expect(manual.data).toMatchObject({ added: true });
    const badImo = await runWith(
      detailAction,
      makeRequest(`/app/tracking/${shipmentId}`, {
        cookie: cookieA,
        form: {
          _csrf: csrfA,
          containerId,
          milestone: 'VESSEL_DEPARTED',
          occurredAt: '2026-09-23T12:00',
          vesselImo: '9074728',
        },
      }),
      { id: shipmentId },
    );
    expect(badImo.status).toBe(400);
    expect((badImo.data as { errors: Record<string, string> }).errors.vesselImo).toMatch(
      /check digit/,
    );

    // Detail: timeline + containers + vessel card, CSP additions header for the map.
    const detail = await runWith(
      detailLoader,
      makeRequest(`/app/tracking/${shipmentId}`, { cookie: cookieA }),
      { id: shipmentId },
    );
    expect(detail.status).toBe(200);
    const d = detail.data as {
      detail: {
        shipment: { status: string };
        events: Array<Record<string, unknown>>;
        containers: Array<Record<string, unknown>>;
        vessels: Array<Record<string, unknown>>;
      };
      mapState: MapState;
      mapStyleUrl: string;
    };
    expect(d.detail.shipment.status).toBe('IN_TRANSIT');
    expect(d.detail.events).toHaveLength(1);
    expect(d.detail.events[0]).toMatchObject({
      source: 'MANUAL',
      eventType: 'LOADED_ON_VESSEL',
      statusAfter: 'IN_TRANSIT',
      containerNumber: 'CSQU3054383',
      locationLocode: 'CNSZX',
      locationName: 'Yantian',
      vesselImo: '9074729',
      latitude: 22.5,
      longitude: 113.9,
    });
    expect(d.detail.containers[0]).toMatchObject({
      vesselImo: '9074729',
      vesselName: 'EXAMPLE MAERSK',
      voyageNumber: '042W',
      lastMilestone: 'LOADED_ON_VESSEL',
    });
    expect(d.detail.vessels).toEqual([
      expect.objectContaining({
        imo: '9074729',
        name: 'EXAMPLE MAERSK',
        pollState: 'AT_SEA',
        positionAt: null,
      }),
    ]);
    expect(d.mapStyleUrl).toBe('https://tiles.openfreemap.org/styles/liberty');
    // The loader hands the CSP additions to the route's headers(); a non-map route has none.
    const detailInit = (await detailLoader({
      request: makeRequest(`/app/tracking/${shipmentId}`, { cookie: cookieA }),
      params: { id: shipmentId },
      context: {},
    } as unknown as Parameters<typeof detailLoader>[0])) as unknown as {
      init: { headers: Headers };
    };
    expect(new Headers(detailInit.init.headers).get('x-harbour-csp-additions')).toContain(
      'connect-src https://tiles.openfreemap.org',
    );
    const vessel = await prisma.activeVessel.findUniqueOrThrow({ where: { imo: '9074729' } });
    expect(vessel).toMatchObject({
      activeContainerCount: 1,
      pollState: 'AT_SEA',
      destinationLocode: 'GBFXT',
    });

    // Map state before any AIS ping: the container is listed, no reckoning yet.
    const map0 = await run(
      mapStateLoader,
      makeRequest(`/app/api/map-state?shipmentId=${shipmentId}`, { cookie: cookieA }),
    );
    expect(map0.status).toBe(200);
    // Give the vessel a real fix (what the worker's vessel-poll writes) and read the map again.
    await prisma.activeVessel.update({
      where: { imo: '9074729' },
      data: {
        lastLatitude: '5.000000',
        lastLongitude: '80.000000',
        speedKnots: '18.0',
        headingDeg: '300.0',
        positionAt: new Date(Date.now() - 3 * 3600_000),
        positionSource: 'TEST',
        providerEtaAt: new Date('2026-10-28T06:00:00Z'),
      },
    });
    const mapRes = await mapStateLoader({
      request: makeRequest(`/app/api/map-state?shipmentId=${shipmentId}`, { cookie: cookieA }),
      params: {},
      context: {},
    } as unknown as Parameters<typeof mapStateLoader>[0]);
    expect(mapRes.status).toBe(200);
    expect(mapRes.headers.get('content-type')).toContain('application/json');
    expect(mapRes.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    const map = (await mapRes.json()) as MapState;
    expect(map.containers).toHaveLength(2);
    const c = map.containers.find((x) => x.containerNumber === 'CSQU3054383')!;
    expect(c.ping).toMatchObject({ lat: 5, lon: 80, speedKnots: 18, positionSource: 'TEST' });
    expect(c.reckoned).toMatchObject({ method: 'lane', laneId: 'ASIA_EUROPE_SUEZ', capped: false });
    expect(c.reckoned!.extrapolatedMs).toBeGreaterThan(2.9 * 3600_000);
    expect(c.reckoned!.extrapolatedMs).toBeLessThanOrEqual(20 * 3600_000);
    // Joined the lane and heading north-west along it (towards Colombo / the Arabian Sea).
    expect(c.reckoned!.lat).toBeGreaterThan(5);
    // Displacement is below the along-track budget (the path turns at the lane), never above it.
    const displacementKm = haversineKm({ lat: 5, lon: 80 }, c.reckoned!);
    expect(displacementKm).toBeGreaterThan(40);
    expect(displacementKm).toBeLessThanOrEqual(
      knotsToKmPerHour(18) * (c.reckoned!.extrapolatedMs / 3600_000) * 1.01,
    );
    expect(c.uncertaintyRadiusKm).toBeGreaterThan(2);
    expect(c.actualPath).toEqual([
      { lat: 22.5, lon: 113.9 },
      { lat: 5, lon: 80 },
    ]);
    expect(c.expectedPath[c.expectedPath.length - 1]).toEqual({ lat: 51.95, lon: 1.35 });
    expect(c.carrierEtaAt).toBe('2026-10-28T06:00:00.000Z');
    // Capped: a 30-hour-old ping stops at the 20 h cap.
    await prisma.activeVessel.update({
      where: { imo: '9074729' },
      data: { positionAt: new Date(Date.now() - 30 * 3600_000) },
    });
    const capped = (await (
      await mapStateLoader({
        request: makeRequest(`/app/api/map-state?shipmentId=${shipmentId}`, { cookie: cookieA }),
        params: {},
        context: {},
      } as unknown as Parameters<typeof mapStateLoader>[0])
    ).json()) as MapState;
    expect(
      capped.containers.find((x) => x.containerNumber === 'CSQU3054383')!.reckoned,
    ).toMatchObject({ capped: true, extrapolatedMs: 20 * 3600_000 });
    expect(
      (
        await run(
          mapStateLoader,
          makeRequest('/app/api/map-state?shipmentId=nope', { cookie: cookieA }),
        )
      ).status,
    ).toBe(400);

    // Webhook (signed fixture, container tracked by org A) → event + status via the inline queue.
    const hook = await webhookAction({
      request: new Request(`${ORIGIN}/webhooks/tracking/terminal49`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TERMINAL49_SIGNATURE_HEADER]: sign(fixture),
        },
        body: fixture,
      }),
      params: { providerId: 'terminal49' },
      context: {},
    } as unknown as Parameters<typeof webhookAction>[0]);
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ ok: true, events: 1, queued: true });
    const afterHook = await withOrgTransaction(prisma, orgA, (tx) =>
      tx.shipmentEvent.findMany({ where: { source: 'terminal49' } }),
    );
    expect(afterHook).toHaveLength(1);
    expect(afterHook[0]).toMatchObject({
      providerEventId: 'te_0001',
      eventType: 'LOADED_ON_VESSEL',
      containerId,
      locationLocode: 'CNSZX',
    });
    // Same webhook again: duplicate, no second row.
    const again = await webhookAction({
      request: new Request(`${ORIGIN}/webhooks/tracking/terminal49`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TERMINAL49_SIGNATURE_HEADER]: sign(fixture),
        },
        body: fixture,
      }),
      params: { providerId: 'terminal49' },
      context: {},
    } as unknown as Parameters<typeof webhookAction>[0]);
    expect(again.status).toBe(200);
    expect(
      await withOrgTransaction(prisma, orgA, (tx) =>
        tx.shipmentEvent.count({ where: { source: 'terminal49' } }),
      ),
    ).toBe(1);
    expect(
      (await prisma.activeVessel.findUniqueOrThrow({ where: { imo: '9074729' } }))
        .activeContainerCount,
    ).toBe(1);

    // Org B: cannot see A's shipment (404), its own list is empty, its map is empty;
    // the webhook never gave B an event because B does not track that number.
    const b = await signIn('owner-b', '198.51.100.32');
    const cookieB = await onboard(b.cookie, 'Tracking Org B');
    const userB = await prisma.user.findUniqueOrThrow({ where: { email: b.email } });
    const orgB = (await listUserOrganizations(prisma, userB.id))[0]!.organization.id;
    orgIds.push(orgB);
    const foreign = await runWith(
      detailLoader,
      makeRequest(`/app/tracking/${shipmentId}`, { cookie: cookieB }),
      { id: shipmentId },
    );
    expect(foreign.status).toBe(404);
    expect(pageErrorSchema.safeParse(foreign.data).success).toBe(true);
    const csrfB = await csrfFor(cookieB);
    const foreignEvent = await runWith(
      detailAction,
      makeRequest(`/app/tracking/${shipmentId}`, {
        cookie: cookieB,
        form: {
          _csrf: csrfB,
          containerId,
          milestone: 'VESSEL_DEPARTED',
          occurredAt: '2026-09-24T00:00',
        },
      }),
      { id: shipmentId },
    );
    expect(foreignEvent.status).toBe(400); // container not in B → "pick a container"
    expect(await withOrgTransaction(prisma, orgA, (tx) => tx.shipmentEvent.count())).toBe(2);
    const listB = await run(trackingLoader, makeRequest('/app/tracking', { cookie: cookieB }));
    expect((listB.data as { shipments: unknown[] }).shipments).toEqual([]);
    const mapB = (await (
      await mapStateLoader({
        request: makeRequest('/app/api/map-state', { cookie: cookieB }),
        params: {},
        context: {},
      } as unknown as Parameters<typeof mapStateLoader>[0])
    ).json()) as MapState;
    expect(mapB.containers).toEqual([]);
    expect(await withOrgTransaction(prisma, orgB, (tx) => tx.shipmentEvent.count())).toBe(0);

    // VIEWER in org A: can view the list and detail, cannot track or add events (403).
    const v = await signIn('viewer-a', '198.51.100.33');
    const userV = await prisma.user.findUniqueOrThrow({ where: { email: v.email } });
    await withOrgTransaction(prisma, orgA, (tx) =>
      tx.membership.create({ data: { organizationId: orgA, userId: userV.id, role: 'VIEWER' } }),
    );
    const viewerList = await run(
      trackingLoader,
      makeRequest('/app/tracking', { cookie: v.cookie }),
    );
    // First request after sign-in selects the organisation and rotates the session.
    const cookieV = viewerList.location ? sessionCookieFrom(viewerList.setCookie)! : v.cookie;
    const viewerList2 = await run(
      trackingLoader,
      makeRequest('/app/tracking', { cookie: cookieV }),
    );
    expect(viewerList2.status).toBe(200);
    expect(viewerList2.data).toMatchObject({ canTrack: false });
    expect(
      (viewerList2.data as { shipments: Array<{ id: string }> }).shipments.map((s) => s.id),
    ).toEqual([shipmentId]);
    const csrfV = await csrfFor(cookieV);
    const viewerTrack = await run(
      trackAction,
      makeRequest('/app/tracking', {
        cookie: cookieV,
        form: { _csrf: csrfV, reference: 'nope', containerNumbers: 'TGHU9876542' },
      }),
    );
    expect(viewerTrack.status).toBe(403);
    const viewerEvent = await runWith(
      detailAction,
      makeRequest(`/app/tracking/${shipmentId}`, {
        cookie: cookieV,
        form: {
          _csrf: csrfV,
          containerId,
          milestone: 'VESSEL_DEPARTED',
          occurredAt: '2026-09-24T00:00',
        },
      }),
      { id: shipmentId },
    );
    expect(viewerEvent.status).toBe(403);

    // Rate limit: 60/min per user on map-state (B already made one request above).
    for (let i = 0; i < 60; i += 1)
      await run(mapStateLoader, makeRequest('/app/api/map-state', { cookie: cookieB }));
    const limited = await run(
      mapStateLoader,
      makeRequest('/app/api/map-state', { cookie: cookieB }),
    );
    expect(limited.status).toBe(429);

    // No PII in logs: no addresses, IPs, organisation names, the manual note or the secret.
    const text = JSON.stringify(t.logs.slice(firstLog));
    for (const needle of [
      a.email,
      b.email,
      v.email,
      '198.51.100.31',
      'Tracking Org A',
      'From the carrier portal',
      SECRET,
      sign(fixture),
    ]) {
      expect(text).not.toContain(needle);
    }
    expect(text).toContain('tracking.shipment_tracked');
    expect(text).toContain('tracking.manual_event_added');
    expect(text).toContain('tracking.webhook_accepted');
  }, 60_000);
});
