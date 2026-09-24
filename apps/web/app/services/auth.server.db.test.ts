/**
 * Tenancy guards against a real Postgres (§7.2, §9 "cross-tenant negative test"): the organisation
 * comes from the session and is re-checked against memberships on every request; a tampered
 * session, a foreign org switch, and cross-org reads through `withOrg` are all rejected.
 *
 * Runs only with DATABASE_URL. As a superuser the raw-SQL checks `SET LOCAL ROLE harbour_app` so
 * RLS is exercised; as a harbour_app login (production-like) RLS applies throughout.
 */
import { randomUUID } from 'node:crypto';
import { disposePrismaClient, withOrgTransaction, type PrismaClient, type Role } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loader as appLoader } from '../routes/app';
import { action as switchOrgAction } from '../routes/app.switch-org';
import { loader as quotesLoader } from '../routes/app.quotes';
import {
  cookieFor,
  createTestApp,
  makeRequest,
  run,
  sessionCookieFrom,
  sessionIdFrom,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { setAppForTests } from './app.server';
import { requireOrgContext, requireUser, withOrg, withUser } from './auth.server';
import { createOrganization, userOrganizationsQuery } from './organizations.server';
import { pageErrorSchema } from './page-error';
import type { SessionManager } from './session.server';

const DATABASE_URL = process.env.DATABASE_URL;

/** Runs `fn` and returns what it threw (a redirect Response or data()), or null. */
const thrownBy = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof Response) {
      return {
        status: err.status,
        location: err.headers.get('location'),
        setCookie: err.headers.getSetCookie(),
        data: null as unknown,
      };
    }
    const e = err as { init?: { status?: number }; data?: unknown };
    if (e.init) return { status: e.init.status ?? 0, location: null, setCookie: [], data: e.data };
    throw err;
  }
};

describe.skipIf(!DATABASE_URL)('tenancy-aware loaders (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  let sessions: SessionManager;
  let bypassesRls = false;
  const userIds: string[] = [];
  const orgIds: string[] = [];

  let owner: string; // OWNER of A, MEMBER of A2
  let viewer: string; // VIEWER of A
  let outsider: string; // OWNER of B only
  let orgA: string;
  let orgA2: string;
  let orgB: string;
  let productA: string;
  let productB: string;

  const createUser = async (label: string) => {
    const user = await prisma.user.create({ data: { email: uniqueEmail(label) } });
    userIds.push(user.id);
    return user.id;
  };
  const createOrg = async (userId: string, name: string) => {
    const { organizationId } = await createOrganization(prisma, { userId, name });
    orgIds.push(organizationId);
    return organizationId;
  };
  const addMember = (organizationId: string, userId: string, role: Role) =>
    withOrgTransaction(prisma, organizationId, (tx) =>
      tx.membership.create({ data: { organizationId, userId, role } }),
    );
  const sessionFor = async (userId: string, currentOrgId: string | null, role: Role | null) => {
    const s = await sessions.create({ userId, currentOrgId, role });
    return { session: s, cookie: cookieFor(s.id) };
  };
  const addProduct = (organizationId: string, sku: string) =>
    withOrgTransaction(prisma, organizationId, (tx) =>
      tx.product.create({
        data: {
          organizationId,
          sku,
          name: `Widget ${sku}`,
          hsCode: '6404199000',
          originCountry: 'CN',
          unitValue: '10.0000',
          currency: 'USD',
          weightKg: '0.500',
          volumeCbm: '0.0020',
        },
        select: { id: true },
      }),
    );

  beforeAll(async () => {
    t = await createTestApp({ databaseUrl: DATABASE_URL });
    prisma = t.prisma!;
    sessions = t.app.auth.sessions!;
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    bypassesRls = who?.bypass === true;

    owner = await createUser('owner');
    viewer = await createUser('viewer');
    outsider = await createUser('outsider');
    orgA = await createOrg(owner, 'Org A');
    orgA2 = await createOrg(outsider, 'Org A2');
    await addMember(orgA2, owner, 'MEMBER');
    orgB = await createOrg(outsider, 'Org B');
    await addMember(orgA, viewer, 'VIEWER');
    productA = (await addProduct(orgA, `A-${randomUUID().slice(0, 6)}`)).id;
    productB = (await addProduct(orgB, `B-${randomUUID().slice(0, 6)}`)).id;
  });

  afterAll(async () => {
    for (const orgId of orgIds) {
      await withOrgTransaction(prisma, orgId, async (tx) => {
        await tx.product.deleteMany();
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    setAppForTests(null);
    await disposePrismaClient();
  });

  describe('requireUser', () => {
    it('redirects to /login with a safe `next`, clearing a stale cookie', async () => {
      const none = await thrownBy(() => requireUser(makeRequest('/app/quotes?x=1')));
      expect(none?.location).toBe('/login?next=%2Fapp%2Fquotes%3Fx%3D1');
      expect(none?.setCookie).toEqual([]);

      const stale = await thrownBy(() =>
        requireUser(makeRequest('/app', { cookie: cookieFor('Z'.repeat(43)) })),
      );
      expect(stale?.location).toBe('/login');
      expect(stale?.setCookie[0]).toMatch(/^__Host-harbour_sid=; .*Max-Age=0/);
    });
  });

  describe('requireOrgContext', () => {
    it('resolves the organisation from the session and re-checks the membership', async () => {
      const { cookie } = await sessionFor(owner, orgA, 'OWNER');
      const ctx = await requireOrgContext(makeRequest('/app', { cookie }));
      expect(ctx.org).toEqual({ id: orgA, name: 'Org A' });
      expect(ctx.role).toBe('OWNER');
      expect(ctx.user.id).toBe(owner);
    });

    it('is memoised per request (layout + child loaders share one resolution)', async () => {
      const { cookie } = await sessionFor(owner, orgA, 'OWNER');
      const req = makeRequest('/app', { cookie });
      const [a, b] = await Promise.all([requireOrgContext(req), requireOrgContext(req)]);
      expect(a).toBe(b);
    });

    it('CROSS-TENANT: a session tampered to another org is rejected and re-pointed', async () => {
      // owner is not a member of B. The tampered value must never produce an org-B context.
      const { session, cookie } = await sessionFor(owner, orgB, 'OWNER');
      const res = await thrownBy(() => requireOrgContext(makeRequest('/app/quotes', { cookie })));
      expect(res?.status).toBe(302);
      expect(res?.location).toBe('/app');
      const rotated = sessionIdFrom(sessionCookieFrom(res!.setCookie)!);
      expect(rotated).not.toBe(session.id);
      expect(await sessions.read(session.id)).toBeNull();
      const now = await sessions.read(rotated);
      expect(now?.data.currentOrgId).toBe(orgA); // the owner's own first organisation
      expect(t.logs.some((l) => l.event === 'auth.membership_missing' && l.orgId === orgB)).toBe(
        true,
      );
    });

    it('CROSS-TENANT: a user with no membership anywhere goes to onboarding, with no org', async () => {
      const loner = await createUser('loner');
      const { cookie } = await sessionFor(loner, orgB, 'OWNER');
      const res = await thrownBy(() => requireOrgContext(makeRequest('/app', { cookie })));
      expect(res?.location).toBe('/onboarding/organization');
      const id = sessionIdFrom(sessionCookieFrom(res!.setCookie)!);
      expect((await sessions.read(id))?.data).toMatchObject({ currentOrgId: null, role: null });
    });

    it('RBAC: a VIEWER is refused an action that needs quote.edit (403), allowed quote.view', async () => {
      const { cookie } = await sessionFor(viewer, orgA, 'VIEWER');
      const denied = await thrownBy(() =>
        requireOrgContext(makeRequest('/app/quotes/new', { cookie }), { permission: 'quote.edit' }),
      );
      expect(denied?.status).toBe(403);
      expect(pageErrorSchema.parse(denied?.data).title).toBe('You do not have access to this');

      const ok = await requireOrgContext(makeRequest('/app/quotes', { cookie }), {
        permission: 'quote.view',
      });
      expect(ok.role).toBe('VIEWER');
      expect((await run(quotesLoader, makeRequest('/app/quotes', { cookie }))).status).toBe(200);
    });

    it('a role change since the last request rotates the session (privilege change)', async () => {
      const member = await createUser('promoted');
      await addMember(orgA, member, 'MEMBER');
      const { session, cookie } = await sessionFor(member, orgA, 'MEMBER');
      expect((await requireOrgContext(makeRequest('/app', { cookie }))).role).toBe('MEMBER');

      await withOrgTransaction(prisma, orgA, (tx) =>
        tx.membership.updateMany({ where: { userId: member }, data: { role: 'ADMIN' } }),
      );
      const res = await thrownBy(() =>
        requireOrgContext(makeRequest('/app/products?page=2', { cookie })),
      );
      expect(res?.location).toBe('/app/products?page=2');
      const rotatedId = sessionIdFrom(sessionCookieFrom(res!.setCookie)!);
      expect(rotatedId).not.toBe(session.id);
      expect(await sessions.read(session.id)).toBeNull();
      const ctx = await requireOrgContext(
        makeRequest('/app/products', { cookie: cookieFor(rotatedId) }),
      );
      expect(ctx.role).toBe('ADMIN');
    });

    it('a removed membership clears currentOrgId and redirects', async () => {
      const temp = await createUser('removed');
      await addMember(orgA, temp, 'MEMBER');
      const { cookie } = await sessionFor(temp, orgA, 'MEMBER');
      await withOrgTransaction(prisma, orgA, (tx) =>
        tx.membership.deleteMany({ where: { userId: temp } }),
      );
      const res = await thrownBy(() => requireOrgContext(makeRequest('/app', { cookie })));
      expect(res?.location).toBe('/onboarding/organization');
      const id = sessionIdFrom(sessionCookieFrom(res!.setCookie)!);
      expect((await sessions.read(id))?.data.currentOrgId).toBeNull();
    });
  });

  describe('withOrg', () => {
    it("CROSS-TENANT: org A's context cannot read org B's products or customs profiles", async () => {
      const { cookie } = await sessionFor(owner, orgA, 'OWNER');
      const ctx = await requireOrgContext(makeRequest('/app', { cookie }));
      const seen = await withOrg(ctx, async (tx) => ({
        products: (await tx.product.findMany({ select: { id: true } })).map((p) => p.id),
        explicitB: await tx.product.findMany({ where: { organizationId: orgB } }),
        byIdB: await tx.product.findUnique({ where: { id: productB } }),
        profiles: (await tx.customsProfile.findMany()).map((p) => p.organizationId),
        profileB: await tx.customsProfile.findFirst({ where: { organizationId: orgB } }),
      }));
      expect(seen.products).toEqual([productA]);
      expect(seen.explicitB).toEqual([]);
      expect(seen.byIdB).toBeNull();
      expect(seen.profiles).toEqual([orgA]);
      expect(seen.profileB).toBeNull();

      // Second layer: raw SQL (not argument-scoped) under the same transaction sees only org A.
      const raw = await withOrg(ctx, async (tx) => {
        if (bypassesRls) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
        const products = await tx.$queryRaw<{ organization_id: string }[]>`
          SELECT organization_id::text FROM products`;
        const profiles = await tx.$queryRaw<{ organization_id: string }[]>`
          SELECT organization_id::text FROM customs_profiles`;
        return { products, profiles };
      });
      expect(new Set(raw.products.map((r) => r.organization_id))).toEqual(new Set([orgA]));
      expect(raw.profiles.map((r) => r.organization_id)).toEqual([orgA]);
    });

    it("withUser lists only the user's own organisations", async () => {
      const { cookie } = await sessionFor(owner, orgA, 'OWNER');
      const ctx = await requireOrgContext(makeRequest('/app', { cookie }));
      const orgs = await withUser(ctx, (tx) => userOrganizationsQuery(tx, ctx.user.id));
      expect(orgs.map((o) => [o.organization.id, o.role])).toEqual([
        [orgA, 'OWNER'],
        [orgA2, 'MEMBER'],
      ]);
    });
  });

  describe('organisation switcher', () => {
    it('lists both organisations in the shell for a multi-org user', async () => {
      const { cookie } = await sessionFor(owner, orgA, 'OWNER');
      const res = await run(appLoader, makeRequest('/app', { cookie }));
      const shell = res.data as { orgs: Array<{ id: string }>; nav: Array<{ to: string }> };
      expect(shell.orgs.map((o) => o.id)).toEqual([orgA, orgA2]);
      expect(shell.nav.map((n) => n.to)).toEqual([
        '/app',
        '/app/quotes',
        '/app/orders', // M7
        '/app/tracking', // M9
        '/app/products',
        '/app/suppliers', // M3
        '/app/documents',
        '/app/settings',
      ]);
    });

    it('CROSS-TENANT: switching to an org the user is not a member of is refused', async () => {
      const { session, cookie } = await sessionFor(owner, orgA, 'OWNER');
      const res = await run(
        switchOrgAction,
        makeRequest('/app/switch-org', {
          cookie,
          form: { organizationId: orgB, _csrf: session.data.csrfToken },
        }),
      );
      expect(res.status).toBe(403);
      expect(res.setCookie).toEqual([]);
      expect((await sessions.read(session.id))?.data.currentOrgId).toBe(orgA);
    });

    it('requires the CSRF token', async () => {
      const { session, cookie } = await sessionFor(owner, orgA, 'OWNER');
      const res = await run(
        switchOrgAction,
        makeRequest('/app/switch-org', { cookie, form: { organizationId: orgA2 } }),
      );
      expect(res.status).toBe(403);
      expect((await sessions.read(session.id))?.data.currentOrgId).toBe(orgA);
    });

    it('switches to a member org: verified, rotated, audited', async () => {
      const { session, cookie } = await sessionFor(owner, orgA, 'OWNER');
      const res = await run(
        switchOrgAction,
        makeRequest('/app/switch-org', {
          cookie,
          form: { organizationId: orgA2, _csrf: session.data.csrfToken },
        }),
      );
      expect(res.status).toBe(302);
      expect(res.location).toBe('/app');
      const newId = sessionIdFrom(sessionCookieFrom(res.setCookie)!);
      expect(newId).not.toBe(session.id);
      expect(await sessions.read(session.id)).toBeNull();
      const now = await sessions.read(newId);
      expect(now?.data).toMatchObject({ currentOrgId: orgA2, role: 'MEMBER' });
      expect(now?.data.csrfToken).not.toBe(session.data.csrfToken);

      const audits = await withOrgTransaction(prisma, orgA2, (tx) =>
        tx.auditLog.findMany({ where: { action: 'session.org_switch', userId: owner } }),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ targetType: 'Organization', targetId: orgA2 });
    });
  });
});
