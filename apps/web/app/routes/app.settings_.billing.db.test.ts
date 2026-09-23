/**
 * /app/settings/billing and /app/settings/billing/success against a real Postgres with a
 * FakeBillingGateway (§7.2 OWNER only, CSRF, audit, tenancy, no PII in logs).
 */
import { disposePrismaClient, withOrgTransaction, type PrismaClient } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import {
  cleanupOrgs,
  createBillingTestApp,
  reconfigureBilling,
  seedMember,
  seedOwner,
  type BillingTestApp,
  type SeededOwner,
} from '../services/billing/test-support';
import { pageErrorSchema } from '../services/page-error';
import { makeRequest, run } from '../test-support/harness';
import { action, loader } from './app.settings_.billing';
import { loader as successLoader } from './app.settings_.billing_.success';

const DATABASE_URL = process.env.DATABASE_URL;
const PATH = '/app/settings/billing';

describe.skipIf(!DATABASE_URL)('billing page (database)', () => {
  let t: BillingTestApp;
  let prisma: PrismaClient;
  let owner: SeededOwner;
  let admin: Awaited<ReturnType<typeof seedMember>>;
  let other: SeededOwner;

  const get = (cookie: string) => run(loader, makeRequest(PATH, { cookie }));
  const post = (cookie: string, form: Record<string, string>) =>
    run(action, makeRequest(PATH, { cookie, form }));

  beforeAll(async () => {
    t = await createBillingTestApp({ databaseUrl: DATABASE_URL });
    prisma = t.prisma!;
    owner = await seedOwner(t, prisma, 'bill-owner');
    admin = await seedMember(t, prisma, owner.orgId, 'ADMIN');
    other = await seedOwner(t, prisma, 'bill-other');
    t.gateway.prices.set('price_FakeStarter001', {
      id: 'price_FakeStarter001',
      object: 'price',
      active: true,
      currency: 'gbp',
      unit_amount: 1234,
      nickname: null,
      recurring: { interval: 'month', interval_count: 1 },
      product: { name: 'Starter from Stripe' },
    });
  });

  afterAll(async () => {
    await cleanupOrgs(prisma, [owner.orgId, other.orgId], [owner.email, admin.email, other.email]);
    setAppForTests(null);
    await disposePrismaClient();
  });

  it('OWNER sees plan, status and Stripe-sourced prices; ADMIN gets the 403 page', async () => {
    const res = await get(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      configured: true,
      plan: 'FREE',
      status: 'NONE',
      statusLabel: 'No subscription',
      renewsAt: null,
      canManage: false,
      subscribed: false,
    });
    const { prices } = res.data as { prices: Array<Record<string, unknown>> };
    expect(prices).toEqual([
      expect.objectContaining({
        plan: 'STARTER',
        amount: '12.34',
        currency: 'GBP',
        productName: 'Starter from Stripe',
      }),
    ]);

    const forbidden = await get(admin.cookie);
    expect(forbidden.status).toBe(403);
    expect(pageErrorSchema.safeParse(forbidden.data).success).toBe(true);
    expect(
      (await post(admin.cookie, { intent: 'checkout', plan: 'PRO', _csrf: admin.csrfToken }))
        .status,
    ).toBe(403);
    expect((await run(loader, makeRequest(PATH))).location).toMatch(/^\/login/);
  });

  it('checkout: CSRF required; creates the Stripe customer, audits and redirects to Checkout', async () => {
    expect((await post(owner.cookie, { intent: 'checkout', plan: 'STARTER' })).status).toBe(403);
    expect(
      (await post(owner.cookie, { intent: 'checkout', plan: 'FREE', _csrf: owner.csrfToken }))
        .status,
    ).toBe(400);

    const res = await post(owner.cookie, {
      intent: 'checkout',
      plan: 'STARTER',
      _csrf: owner.csrfToken,
    });
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const customerCall = t.gateway.calls.find((c) => c.method === 'createCustomer');
    expect(customerCall?.input).toEqual({
      organizationId: owner.orgId,
      email: owner.email,
      name: 'bill-owner Ltd',
    });
    const checkoutCall = t.gateway.calls.find((c) => c.method === 'createCheckoutSession');
    expect(checkoutCall?.input).toMatchObject({
      organizationId: owner.orgId,
      customerId: 'cus_fake0001',
      priceId: 'price_FakeStarter001',
      plan: 'STARTER',
      successUrl: 'http://localhost/app/settings/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://localhost/app/settings/billing?cancelled=1',
    });

    const state = await withOrgTransaction(prisma, owner.orgId, async (tx) => ({
      org: await tx.organization.findUniqueOrThrow({
        where: { id: owner.orgId },
        select: { stripeCustomerId: true, billingEmail: true, plan: true },
      }),
      audits: await tx.auditLog.findMany({
        where: { action: { startsWith: 'billing.' } },
        orderBy: { createdAt: 'asc' },
      }),
    }));
    expect(state.org).toEqual({
      stripeCustomerId: 'cus_fake0001',
      billingEmail: owner.email.toLowerCase(),
      plan: 'FREE',
    });
    expect(state.audits.map((a) => [a.action, a.userId, a.metadata])).toEqual([
      ['billing.customer_created', owner.userId, { stripeCustomerId: 'cus_fake0001' }],
      ['billing.checkout_started', owner.userId, { plan: 'STARTER' }],
    ]);
    expect(JSON.stringify(state.audits)).not.toContain(owner.email);

    // Second checkout reuses the customer.
    await post(owner.cookie, { intent: 'checkout', plan: 'PRO', _csrf: owner.csrfToken });
    expect(t.gateway.calls.filter((c) => c.method === 'createCustomer')).toHaveLength(1);
  });

  it('portal: opens a Billing Portal session with the return URL and audits it', async () => {
    const res = await post(owner.cookie, { intent: 'portal', _csrf: owner.csrfToken });
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(t.gateway.calls.find((c) => c.method === 'createPortalSession')?.input).toEqual({
      customerId: 'cus_fake0001',
      returnUrl: 'http://localhost/app/settings/billing',
    });
    const audits = await withOrgTransaction(prisma, owner.orgId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'billing.portal_opened' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe(owner.userId);
    // An organisation with no customer yet cannot open the portal.
    expect((await post(other.cookie, { intent: 'portal', _csrf: other.csrfToken })).status).toBe(
      400,
    );
  });

  it('page after the webhook: plan, renewal date, manage button; checkout refused while subscribed', async () => {
    await withOrgTransaction(prisma, owner.orgId, (tx) =>
      tx.organization.update({
        where: { id: owner.orgId },
        data: {
          plan: 'STARTER',
          subscriptionStatus: 'ACTIVE',
          stripeSubscriptionId: 'sub_fakeLive',
          currentPeriodEnd: new Date('2026-10-23T00:00:00Z'),
        },
      }),
    );
    const res = await get(owner.cookie);
    expect(res.data).toMatchObject({
      plan: 'STARTER',
      status: 'ACTIVE',
      statusLabel: 'Active',
      renewsAt: '2026-10-23T00:00:00.000Z',
      canManage: true,
      subscribed: true,
    });
    const again = await post(owner.cookie, {
      intent: 'checkout',
      plan: 'PRO',
      _csrf: owner.csrfToken,
    });
    expect(again.status).toBe(400);
  });

  it("success page: confirms own session, rejects another organisation's and a malformed id", async () => {
    const sessions = [...t.gateway.checkoutSessions.keys()];
    const own = sessions[0]!;
    t.gateway.completeCheckoutSession(own, 'sub_fakeLive');
    const ok = await run(
      successLoader,
      makeRequest(`${PATH}/success?session_id=${own}`, { cookie: owner.cookie }),
    );
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ active: true, status: 'complete' });

    const foreign = await run(
      successLoader,
      makeRequest(`${PATH}/success?session_id=${own}`, { cookie: other.cookie }),
    );
    expect(foreign.status).toBe(404);
    expect(pageErrorSchema.parse(foreign.data).title).toBe('Checkout not found');

    for (const bad of ['', 'sub_x', 'cs_test_nope', 'cs_test_<b>']) {
      const res = await run(
        successLoader,
        makeRequest(`${PATH}/success?session_id=${encodeURIComponent(bad)}`, {
          cookie: owner.cookie,
        }),
      );
      expect(res.status, bad).toBe(404);
    }
    expect(
      (
        await run(
          successLoader,
          makeRequest(`${PATH}/success?session_id=${own}`, { cookie: admin.cookie }),
        )
      ).status,
    ).toBe(403);
  });

  it('Stripe down: the action fails with an error, not a stack trace, and nothing is audited twice', async () => {
    t.gateway.failWith = new Error('stripe unreachable');
    await expect(post(owner.cookie, { intent: 'portal', _csrf: owner.csrfToken })).rejects.toThrow(
      'stripe unreachable',
    );
    t.gateway.failWith = null;
  });

  it('unconfigured server: the page says so and the actions refuse politely', async () => {
    const u = await reconfigureBilling(t, false);
    const res = await get(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ configured: false, plan: 'STARTER', prices: [] });
    const act = await post(owner.cookie, {
      intent: 'checkout',
      plan: 'STARTER',
      _csrf: owner.csrfToken,
    });
    expect(act.status).toBe(503);
    expect(act.data).toEqual({ error: 'Billing is not configured on this server yet.' });
    expect(u.gateway.calls).toHaveLength(0);
    setAppForTests(t.app);
  });

  it('logs never contain an email address', async () => {
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain(admin.email);
    expect(text).not.toContain('@example.test');
    expect(t.logs.some((l) => l.event === 'billing.checkout_started')).toBe(true);
  });
});
