/**
 * Magic-link sign-in → onboarding → Home → sign-out against a real Postgres (§7.1, §9).
 * Runs only with DATABASE_URL (migrations applied). Works as a superuser or as a non-superuser
 * member of harbour_app (production-like: RLS enforced).
 */
import { randomUUID } from 'node:crypto';
import { disposePrismaClient, withOrgTransaction, type PrismaClient } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { consumeMagicLink, hashToken, issueMagicLink } from '../services/magic-link.server';
import { createOrganization, listUserOrganizations } from '../services/organizations.server';
import { pageErrorSchema } from '../services/page-error';
import { sha256Hex } from '../services/session.server';
import {
  createTestApp,
  lastLinkPath,
  makeRequest,
  run,
  sessionCookieFrom,
  sessionIdFrom,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { loader as homeLoader } from './app._index';
import { action as loginAction, loader as loginLoader } from './login';
import { action as verifyAction, loader as verifyLoader } from './login_.verify';
import { action as logoutAction } from './logout';
import { action as onboardingAction, loader as onboardingLoader } from './onboarding.organization';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('sign-in, onboarding and sign-out (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  const emails: string[] = [];
  const orgIds: string[] = [];

  const newEmail = (label: string) => {
    const e = uniqueEmail(label);
    emails.push(e);
    return e;
  };

  /** POST /login from a given client IP. */
  const requestLink = (email: string, ip = '203.0.113.7', next?: string) =>
    run(
      loginAction,
      makeRequest('/login', {
        form: { email, ...(next ? { next } : {}) },
        headers: { 'x-forwarded-for': ip },
      }),
    );

  /** Full sign-in for `email`; returns the session cookie. */
  const signIn = async (email: string, ip = '198.51.100.9') => {
    const sent = await requestLink(email, ip);
    expect(sent.data).toMatchObject({ status: 'sent' });
    const link = lastLinkPath(t.logs)!;
    const token = new URL(link, 'http://x').searchParams.get('token')!;
    const res = await run(verifyAction, makeRequest('/login/verify', { form: { token } }));
    return { res, cookie: sessionCookieFrom(res.setCookie)!, token };
  };

  beforeAll(async () => {
    t = await createTestApp({ databaseUrl: DATABASE_URL });
    prisma = t.prisma!;
  });

  afterAll(async () => {
    for (const orgId of orgIds) {
      await withOrgTransaction(prisma, orgId, async (tx) => {
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await prisma.magicLinkToken.deleteMany({ where: { email: { in: emails } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    setAppForTests(null);
    await disposePrismaClient();
  });

  describe('requesting a link', () => {
    it('answers identically for unknown and known addresses, and creates no user', async () => {
      const known = newEmail('known');
      await signIn(known);
      const unknown = newEmail('unknown');

      const a = await requestLink(known, '192.0.2.10');
      const b = await requestLink(unknown, '192.0.2.11');
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.data).toEqual(b.data);
      expect(a.data).toEqual({ status: 'sent', next: '/app' });
      expect(await prisma.user.count({ where: { email: unknown } })).toBe(0);
    });

    it('stores only sha256(token), expiring in 15 minutes', async () => {
      const email = newEmail('hash');
      const before = Date.now();
      await requestLink(email, '192.0.2.12');
      const token = new URL(lastLinkPath(t.logs)!, 'http://x').searchParams.get('token')!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await prisma.magicLinkToken.findMany({ where: { email } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(hashToken(token));
      expect(rows[0]!.tokenHash).not.toContain(token);
      expect(rows[0]!.ip).toBe(sha256Hex('192.0.2.12'));
      const ttl = rows[0]!.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(14 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
      expect(rows[0]!.usedAt).toBeNull();
    });

    it('rate-limits 5 requests per hour per address (across IPs)', async () => {
      const email = newEmail('rl-email');
      for (let i = 0; i < 5; i += 1) {
        expect((await requestLink(email, `192.0.2.${100 + i}`)).status).toBe(200);
      }
      const sixth = await requestLink(email, '192.0.2.200');
      expect(sixth.status).toBe(429);
      expect(await prisma.magicLinkToken.count({ where: { email } })).toBe(5);
    });

    it('rate-limits 20 requests per hour per IP (across addresses)', async () => {
      const ip = '198.51.100.77';
      for (let i = 0; i < 20; i += 1) {
        expect((await requestLink(newEmail(`rl-ip-${i}`), ip)).status).toBe(200);
      }
      const twentyFirst = await requestLink(newEmail('rl-ip-21'), ip);
      expect(twentyFirst.status).toBe(429);
      // A different IP is unaffected.
      expect((await requestLink(newEmail('rl-ip-other'), '198.51.100.78')).status).toBe(200);
    });

    it('rejects an invalid address and a cross-site POST', async () => {
      expect((await requestLink('not-an-email')).status).toBe(400);
      const cross = await run(
        loginAction,
        makeRequest('/login', {
          form: { email: newEmail('cross') },
          headers: { origin: 'https://evil.example' },
        }),
      );
      expect(cross.status).toBe(403);
    });
  });

  describe('confirming a link', () => {
    it('GET only renders a confirm button; it never consumes the token', async () => {
      const email = newEmail('prefetch');
      await requestLink(email, '192.0.2.30');
      const link = lastLinkPath(t.logs)!;
      const page = await run(verifyLoader, makeRequest(link));
      const token = new URL(link, 'http://x').searchParams.get('token');
      expect(page.data).toMatchObject({ token, next: '/app' });
      const row = await prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
      expect(row.usedAt).toBeNull();
    });

    it('POST signs in once: new user, Secure HttpOnly cookie; the second use fails', async () => {
      const email = newEmail('single-use');
      const { res, cookie, token } = await signIn(email);
      expect(res.status).toBe(302);
      expect(res.location).toBe('/onboarding/organization');
      expect(res.setCookie[0]).toMatch(
        /^__Host-harbour_sid=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
      );
      expect(cookie).toBeTruthy();
      expect(await prisma.user.count({ where: { email } })).toBe(1);

      const replay = await run(verifyAction, makeRequest('/login/verify', { form: { token } }));
      expect(replay.status).toBe(400);
      expect(replay.setCookie).toEqual([]);
    });

    it('a wrong or malformed token fails', async () => {
      for (const token of ['A'.repeat(43), 'short', '']) {
        const res = await run(verifyAction, makeRequest('/login/verify', { form: { token } }));
        expect(res.status, token).toBe(400);
      }
    });

    it('an expired token fails, and a used token cannot be replayed concurrently', async () => {
      const email = newEmail('expiry');
      const old = await issueMagicLink(prisma, {
        email,
        ipHash: null,
        now: new Date(Date.now() - 16 * 60 * 1000),
      });
      expect(await consumeMagicLink(prisma, old.token, new Date())).toBeNull();

      const fresh = await issueMagicLink(prisma, { email, ipHash: null, now: new Date() });
      const results = await Promise.all([
        consumeMagicLink(prisma, fresh.token, new Date()),
        consumeMagicLink(prisma, fresh.token, new Date()),
        consumeMagicLink(prisma, fresh.token, new Date()),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('keeps a safe `next` through the link and drops an unsafe one', async () => {
      const email = newEmail('next');
      await requestLink(email, '192.0.2.40', '/app/quotes');
      expect(lastLinkPath(t.logs)).toMatch(/&next=%2Fapp%2Fquotes$/);
      await requestLink(email, '192.0.2.41', '//evil.com');
      expect(lastLinkPath(t.logs)).not.toContain('next=');
    });
  });

  describe('onboarding, Home and sign-out', () => {
    it('creates org + OWNER membership + customs profile, rotates the session, shows the EORI banner, signs out', async () => {
      const email = newEmail('onboard');
      const firstLog = t.logs.length;
      const { cookie } = await signIn(email, '198.51.100.20');

      // Signed in, no organisation yet → Home sends the user to onboarding.
      const home0 = await run(homeLoader, makeRequest('/app', { cookie }));
      expect(home0.location).toBe('/onboarding/organization');

      const page = await run(onboardingLoader, makeRequest('/onboarding/organization', { cookie }));
      const { csrfToken } = page.data as { csrfToken: string };

      const noCsrf = await run(
        onboardingAction,
        makeRequest('/onboarding/organization', { cookie, form: { name: 'Acme Imports' } }),
      );
      expect(noCsrf.status).toBe(403);

      const tooShort = await run(
        onboardingAction,
        makeRequest('/onboarding/organization', {
          cookie,
          form: { name: ' A ', _csrf: csrfToken },
        }),
      );
      expect(tooShort.status).toBe(400);

      const created = await run(
        onboardingAction,
        makeRequest('/onboarding/organization', {
          cookie,
          form: { name: '  Acme Imports Ltd  ', _csrf: csrfToken },
        }),
      );
      expect(created.status).toBe(302);
      expect(created.location).toBe('/app');
      const rotated = sessionCookieFrom(created.setCookie)!;
      expect(sessionIdFrom(rotated)).not.toBe(sessionIdFrom(cookie));

      // Old cookie no longer works.
      expect((await run(homeLoader, makeRequest('/app', { cookie }))).location).toBe('/login');

      const home = await run(homeLoader, makeRequest('/app', { cookie: rotated }));
      expect(home.status).toBe(200);
      const homeData = home.data as {
        orgName: string;
        actions: Array<{ id: string; text: string }>;
      };
      expect(homeData.orgName).toBe('Acme Imports Ltd');
      expect(homeData.actions.map((a) => a.id)).toEqual(['eori_missing']);
      expect(homeData.actions[0]!.text).toBe('Add your EORI number — you need it before booking');

      // Database state, read in the new organisation's context.
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const orgId = (await listUserOrganizations(prisma, user.id))[0]!.organization.id;
      orgIds.push(orgId);
      const rows = await withOrgTransaction(
        prisma,
        orgId,
        async (tx) => ({
          org: await tx.organization.findUniqueOrThrow({ where: { id: orgId } }),
          memberships: await tx.membership.findMany(),
          profiles: await tx.customsProfile.findMany(),
          audits: await tx.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
        }),
        { userId: user.id },
      );
      expect(rows.org).toMatchObject({ name: 'Acme Imports Ltd', eoriNumber: null });
      expect(rows.memberships).toEqual([
        expect.objectContaining({ userId: user.id, role: 'OWNER', organizationId: orgId }),
      ]);
      expect(rows.profiles).toEqual([
        expect.objectContaining({
          organizationId: orgId,
          paymentMethod: 'BROKER_DEFERMENT',
          usePva: false,
          cdsAuthorityGranted: false,
          danNumber: null,
        }),
      ]);
      expect(rows.audits.map((a) => [a.action, a.targetType, a.userId])).toEqual([
        ['org.create', 'Organization', user.id],
        ['membership.create', 'Membership', user.id],
      ]);
      expect(JSON.stringify(rows.audits)).not.toContain('Acme');
      expect(JSON.stringify(rows.audits)).not.toContain(email);

      // Own deferment without CDS authority adds the second action.
      await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.updateMany({
          data: { paymentMethod: 'OWN_DEFERMENT', danNumber: '1234567' },
        }),
      );
      const home2 = await run(homeLoader, makeRequest('/app', { cookie: rotated }));
      expect((home2.data as typeof homeData).actions.map((a) => a.id)).toEqual([
        'eori_missing',
        'cds_authority_missing',
      ]);
      // The EORI value itself never reaches the page data.
      expect(JSON.stringify(home2.data)).not.toMatch(/eoriNumber/);

      // Sign out: CSRF required, then the session is gone.
      const csrf2 = (await t.app.auth.sessions!.read(sessionIdFrom(rotated)))!.data.csrfToken;
      expect(
        (await run(logoutAction, makeRequest('/logout', { cookie: rotated, form: {} }))).status,
      ).toBe(403);
      const out = await run(
        logoutAction,
        makeRequest('/logout', { cookie: rotated, form: { _csrf: csrf2 } }),
      );
      expect(out.location).toBe('/login?signed-out=1');
      expect(out.setCookie[0]).toMatch(
        /^__Host-harbour_sid=; Path=\/; Max-Age=0; HttpOnly; Secure/,
      );
      expect(await t.app.auth.sessions!.read(sessionIdFrom(rotated))).toBeNull();
      const after = await run(homeLoader, makeRequest('/app', { cookie: rotated }));
      expect(after.location).toBe('/login');

      // Log snapshot (§9 "no PII in logs"): the flow's events, and no address or IP anywhere.
      const flow = t.logs.slice(firstLog);
      const text = JSON.stringify(flow);
      expect(text).not.toContain(email);
      expect(text).not.toContain(email.split('@')[0]);
      expect(text).not.toContain('198.51.100.20');
      expect(text).not.toContain('Acme');
      expect(
        flow.map((l) => l.event).filter((e) => typeof e === 'string' && !e.startsWith('prisma')),
      ).toMatchInlineSnapshot(`
        [
          "email.console",
          "auth.link_sent",
          "auth.signed_in",
          "onboarding.invalid",
          "onboarding.org_created",
          "auth.signed_out",
        ]
      `);
    });

    it('a signed-in visitor to /login goes straight to `next`', async () => {
      const email = newEmail('already');
      const { cookie } = await signIn(email);
      const res = await run(loginLoader, makeRequest('/login?next=%2Fapp%2Fproducts', { cookie }));
      expect(res.location).toBe('/app/products');
    });
  });

  describe('createOrganization', () => {
    it('is atomic: a failing membership insert leaves no organisation or profile behind', async () => {
      const organizationId = randomUUID();
      await expect(
        createOrganization(prisma, {
          userId: randomUUID(), // no such user → membership FK violation after the org insert
          name: 'Rolled Back Ltd',
          organizationId,
        }),
      ).rejects.toThrow();
      const left = await withOrgTransaction(prisma, organizationId, async (tx) => ({
        orgs: await tx.organization.count(),
        profiles: await tx.customsProfile.count(),
        audits: await tx.auditLog.count(),
      }));
      expect(left).toEqual({ orgs: 0, profiles: 0, audits: 0 });
    });
  });

  it('errors are page errors, not stack traces', async () => {
    const res = await run(
      verifyAction,
      makeRequest('/login/verify', {
        form: { token: 'A'.repeat(43) },
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    expect(pageErrorSchema.safeParse(res.data).success).toBe(true);
  });
});
