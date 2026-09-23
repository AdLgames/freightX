/**
 * POST /webhooks/stripe against a real Postgres (§6.4 rules, §7.2 tenancy, §9 no PII). Runs only
 * with DATABASE_URL; works as a superuser or as a harbour_app member (RLS enforced).
 */
import { disposePrismaClient, withOrgTransaction, type PrismaClient } from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { fixtureText, type FixtureName } from '../services/billing/fixtures';
import { signWebhookPayload } from '../services/billing/stripe.server';
import {
  cleanupOrgs,
  createBillingTestApp,
  reconfigureBilling,
  seedOwner,
  type BillingTestApp,
  type SeededOwner,
} from '../services/billing/test-support';
import { MemoryEmailTransport } from '../services/email.server';
import { ORIGIN, run } from '../test-support/harness';
import { MAX_WEBHOOK_BYTES, action, loader } from './webhooks.stripe';

const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = 'whsec_test';

describe.skipIf(!DATABASE_URL)('POST /webhooks/stripe (database)', () => {
  let t: BillingTestApp;
  let prisma: PrismaClient;
  let a: SeededOwner;
  let b: SeededOwner;
  const email = new MemoryEmailTransport();
  const eventIds: string[] = [];
  let seq = 0;

  const post = (body: string, headers: Record<string, string> = {}) =>
    run(
      action,
      new Request(`${ORIGIN}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      }),
    );

  const signed = (body: string, opts?: { timestampSeconds?: number }) =>
    post(body, { 'stripe-signature': signWebhookPayload(body, SECRET, opts) });

  const event = (name: FixtureName, orgId: string, extra: Record<string, string> = {}) => {
    seq += 1;
    const eventId = `evt_DbTest${String(seq).padStart(4, '0')}${Date.now().toString(36)}`;
    eventIds.push(eventId);
    return fixtureText(name, { organizationId: orgId, eventId, ...extra });
  };

  const orgState = (orgId: string) =>
    withOrgTransaction(prisma, orgId, async (tx) => ({
      org: await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: {
          plan: true,
          subscriptionStatus: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          billingEmail: true,
          planUpdatedAt: true,
        },
      }),
      audits: await tx.auditLog.findMany({
        where: { action: 'billing.subscription_updated' },
        orderBy: { createdAt: 'asc' },
      }),
    }));

  beforeAll(async () => {
    t = await createBillingTestApp({ databaseUrl: DATABASE_URL, email });
    prisma = t.prisma!;
    a = await seedOwner(t, prisma, 'wh-a');
    b = await seedOwner(t, prisma, 'wh-b');
  });

  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
    await cleanupOrgs(prisma, [a.orgId, b.orgId], [a.email, b.email]);
    setAppForTests(null);
    await disposePrismaClient();
  });

  it('GET is 405; POST without a signature is 400; nothing is recorded', async () => {
    expect((await run(loader, new Request(`${ORIGIN}/webhooks/stripe`))).status).toBe(405);
    const res = await post(event('customer.subscription.created', a.orgId));
    expect(res.status).toBe(400);
    expect(await prisma.stripeEvent.count({ where: { id: { in: eventIds } } })).toBe(0);
  });

  it('rejects a bad signature and a stale timestamp with 400, and an oversized body with 413', async () => {
    const body = event('customer.subscription.created', a.orgId);
    expect((await post(body, { 'stripe-signature': 't=1,v1=00' })).status).toBe(400);
    expect(
      (await post(body, { 'stripe-signature': signWebhookPayload(body, 'whsec_wrong') })).status,
    ).toBe(400);
    expect(
      (await signed(body, { timestampSeconds: Math.floor(Date.now() / 1000) - 600 })).status,
    ).toBe(400);

    const huge = `${body.slice(0, -1)},"pad":"${'x'.repeat(MAX_WEBHOOK_BYTES)}"}`;
    const streamed = await signed(huge);
    expect(streamed.status).toBe(413);
    const declared = await post(huge, {
      'stripe-signature': signWebhookPayload(huge, SECRET),
      'content-length': String(huge.length),
    });
    expect(declared.status).toBe(413);
    expect((await orgState(a.orgId)).org.plan).toBe('FREE');
  });

  it('applies a signed customer.subscription.updated: plan, status, period end and an audit row', async () => {
    const before = Date.now();
    const res = await signed(event('customer.subscription.created', a.orgId));
    expect(res.status).toBe(200);
    const { org, audits } = await orgState(a.orgId);
    expect(org).toMatchObject({
      plan: 'STARTER',
      subscriptionStatus: 'ACTIVE',
      stripeCustomerId: 'cus_FixtureCustomer001',
      stripeSubscriptionId: 'sub_FixtureSubscription001',
      cancelAtPeriodEnd: false,
    });
    expect(org.currentPeriodEnd?.getTime()).toBe(1792678401 * 1000);
    expect(org.planUpdatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: a.orgId,
      userId: null,
      targetType: 'Organization',
      targetId: a.orgId,
      metadata: { plan: 'STARTER', status: 'ACTIVE' },
    });

    const updated = await signed(event('customer.subscription.updated', a.orgId));
    expect(updated.status).toBe(200);
    expect((await orgState(a.orgId)).org.cancelAtPeriodEnd).toBe(true);
    const rows = await prisma.stripeEvent.findMany({ where: { id: { in: eventIds } } });
    expect(rows.filter((r) => r.processedAt !== null && r.error === null).length).toBe(2);
    expect(rows.every((r) => r.payloadSha256.length === 64)).toBe(true);
  });

  it('a duplicate delivery is acknowledged and is a no-op', async () => {
    const body = event('customer.subscription.updated.past_due', a.orgId);
    const first = await signed(body);
    expect(first.status).toBe(200);
    const auditsBefore = (await orgState(a.orgId)).audits.length;
    const again = await signed(body);
    expect(again.status).toBe(200);
    const { org, audits } = await orgState(a.orgId);
    expect(org.subscriptionStatus).toBe('PAST_DUE');
    expect(audits).toHaveLength(auditsBefore);
    expect(t.logs.filter((l) => l.event === 'billing.webhook_duplicate')).toHaveLength(1);
  });

  it('invoice.payment_failed emails the OWNER; invoice.paid clears PAST_DUE', async () => {
    await signed(event('invoice.paid', a.orgId));
    expect((await orgState(a.orgId)).org.subscriptionStatus).toBe('ACTIVE');
    const failed = await signed(event('invoice.payment_failed', a.orgId));
    expect(failed.status).toBe(200);
    expect((await orgState(a.orgId)).org.subscriptionStatus).toBe('PAST_DUE');
    expect(email.sent.map((m) => m.to)).toEqual([a.email]);
    expect(email.sent[0]?.text).toContain(`${ORIGIN}/app/settings/billing`);
  });

  it('cross-tenant: an event for org B never touches org A, and its audit row lands in B only', async () => {
    const stateA = await orgState(a.orgId);
    const res = await signed(
      event('customer.subscription.created', b.orgId, {
        customerId: 'cus_FixtureCustomerB',
        subscriptionId: 'sub_FixtureSubscriptionB',
        priceId: 'price_FakePro001',
      }),
    );
    expect(res.status).toBe(200);
    expect(await orgState(a.orgId)).toEqual(stateA);
    const stateB = await orgState(b.orgId);
    expect(stateB.org).toMatchObject({ plan: 'PRO', subscriptionStatus: 'ACTIVE' });
    expect(stateB.audits).toHaveLength(1);
    expect(stateB.audits[0]?.organizationId).toBe(b.orgId);

    // An event for A that names B's customer is unresolved and changes nothing.
    const spoof = await signed(
      event('customer.subscription.deleted', a.orgId, { customerId: 'cus_FixtureCustomerB' }),
    );
    expect(spoof.status).toBe(200);
    expect((await orgState(a.orgId)).org.plan).toBe('STARTER');
    const spoofRow = await prisma.stripeEvent.findUniqueOrThrow({
      where: { id: eventIds.at(-1)! },
    });
    expect(spoofRow.error).toBe('unresolved: customer_mismatch');
  });

  it('a processing failure releases the claim so Stripe can redeliver, and is recorded', async () => {
    const body = event('customer.subscription.updated', a.orgId, { priceId: 'price_NotMapped' });
    const res = await signed(body);
    expect(res.status).toBe(500);
    expect(await prisma.stripeEvent.count({ where: { id: eventIds.at(-1)! } })).toBe(0);
    expect(t.logs.some((l) => l.event === 'billing.webhook_enqueue_failed')).toBe(true);
  });

  it('unknown event types are acknowledged and marked processed', async () => {
    const res = await signed(event('unhandled.charge.succeeded', a.orgId));
    expect(res.status).toBe(200);
    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventIds.at(-1)! } });
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toBeNull();
  });

  it('without a webhook secret the endpoint answers 503 so Stripe retries later', async () => {
    const unconfigured = await reconfigureBilling(t, false);
    const body = event('customer.subscription.created', a.orgId);
    expect((await signed(body)).status).toBe(503);
    expect(unconfigured.app.billing.configured).toBe(false);
    expect(await prisma.stripeEvent.count({ where: { id: eventIds.at(-1)! } })).toBe(0);
    setAppForTests(t.app);
  });

  it('logs never contain the billing email, the owner address or payload fields', async () => {
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain(a.email);
    expect(text).not.toContain(b.email);
    expect(text).not.toContain('owner@example.test');
    expect(text).not.toContain('Fixture Owner');
    expect(text).not.toContain('hosted_invoice_url');
    expect(text).toContain('billing.webhook_received');
  });
});
