import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryEmailTransport } from '../email.server';
import { createLogger } from '../logger.server';
import {
  AUDIT_SUBSCRIPTION_UPDATED,
  PAYMENT_FAILED_SUBJECT,
  SUBSCRIPTION_STATUS_MAP,
  UnknownPriceError,
  effectivePlan,
  handleStripeEvent,
  periodEndOf,
  processStripeEvent,
  type ProcessorDeps,
} from './events.server';
import { DEFAULT_FIXTURE_IDS, loadFixture, type FixtureName } from './fixtures';
import { InMemoryBillingRepository, type OrganizationBilling } from './repository.server';

const PRICES = { STARTER: 'price_FakeStarter001', PRO: 'price_FakePro001' };
const OWNER_EMAIL = 'owner-a@example.test';

const freshOrg = (id: string): OrganizationBilling => ({
  id,
  plan: 'FREE',
  subscriptionStatus: 'NONE',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  billingEmail: null,
});

describe('processStripeEvent', () => {
  let repo: InMemoryBillingRepository;
  let email: MemoryEmailTransport;
  let lines: string[];
  let deps: ProcessorDeps;
  const orgA = randomUUID();
  const orgB = randomUUID();
  let counter = 0;
  const fixture = (name: FixtureName, organizationId: string, extra: Record<string, string> = {}) =>
    loadFixture(name, {
      organizationId,
      eventId: `evt_Test${String(++counter).padStart(4, '0')}`,
      ...extra,
    });

  beforeEach(() => {
    repo = new InMemoryBillingRepository();
    repo.seed(freshOrg(orgA), [OWNER_EMAIL]);
    repo.seed(freshOrg(orgB), ['owner-b@example.test']);
    email = new MemoryEmailTransport();
    lines = [];
    deps = {
      repo,
      prices: PRICES,
      email,
      appUrl: 'https://app.example.test',
      logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
      now: () => new Date('2026-09-23T12:00:00Z'),
    };
  });

  it('checkout.session.completed links customer, subscription and (lower-cased) billing email', async () => {
    const out = await processStripeEvent(
      fixture('checkout.session.completed', orgA, { email: 'Owner-A@Example.TEST' }),
      deps,
    );
    expect(out).toMatchObject({ outcome: 'applied', organizationId: orgA, plan: 'FREE' });
    const org = repo.organizations.get(orgA)!;
    expect(org.stripeCustomerId).toBe(DEFAULT_FIXTURE_IDS.customerId);
    expect(org.stripeSubscriptionId).toBe(DEFAULT_FIXTURE_IDS.subscriptionId);
    expect(org.billingEmail).toBe('owner-a@example.test');
    expect(org.plan).toBe('FREE'); // the subscription event sets the plan
    expect(repo.audits).toEqual([
      {
        organizationId: orgA,
        action: AUDIT_SUBSCRIPTION_UPDATED,
        userId: null,
        metadata: { plan: 'FREE', status: 'NONE' },
      },
    ]);
  });

  it('customer.subscription.created (active) → plan STARTER, ACTIVE, period end, audit {plan,status}', async () => {
    const out = await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    expect(out).toEqual({
      outcome: 'applied',
      organizationId: orgA,
      plan: 'STARTER',
      status: 'ACTIVE',
    });
    const org = repo.organizations.get(orgA)!;
    expect(org).toMatchObject({
      plan: 'STARTER',
      subscriptionStatus: 'ACTIVE',
      stripeSubscriptionId: DEFAULT_FIXTURE_IDS.subscriptionId,
      stripeCustomerId: DEFAULT_FIXTURE_IDS.customerId,
      cancelAtPeriodEnd: false,
    });
    expect(org.currentPeriodEnd?.toISOString()).toBe(new Date(1792678401 * 1000).toISOString());
    expect(repo.audits.at(-1)?.metadata).toEqual({ plan: 'STARTER', status: 'ACTIVE' });
  });

  it('maps the PRO price to PRO', async () => {
    await processStripeEvent(
      fixture('customer.subscription.created', orgA, { priceId: PRICES.PRO }),
      deps,
    );
    expect(repo.organizations.get(orgA)?.plan).toBe('PRO');
  });

  it('customer.subscription.updated: cancel_at_period_end is recorded; past_due keeps the plan; canceled drops to FREE', async () => {
    await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    await processStripeEvent(fixture('customer.subscription.updated', orgA), deps);
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'STARTER',
      cancelAtPeriodEnd: true,
    });

    await processStripeEvent(fixture('customer.subscription.updated.past_due', orgA), deps);
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'STARTER',
      subscriptionStatus: 'PAST_DUE',
    });

    await processStripeEvent(fixture('customer.subscription.updated.canceled', orgA), deps);
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'FREE',
      subscriptionStatus: 'CANCELED',
    });
    expect(repo.audits.map((a) => a.metadata)).toEqual([
      { plan: 'STARTER', status: 'ACTIVE' },
      { plan: 'STARTER', status: 'ACTIVE' },
      { plan: 'STARTER', status: 'PAST_DUE' },
      { plan: 'FREE', status: 'CANCELED' },
    ]);
  });

  it('customer.subscription.deleted → FREE, CANCELED, ids cleared', async () => {
    await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    const out = await processStripeEvent(fixture('customer.subscription.deleted', orgA), deps);
    expect(out).toMatchObject({ outcome: 'applied', plan: 'FREE', status: 'CANCELED' });
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'FREE',
      subscriptionStatus: 'CANCELED',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: DEFAULT_FIXTURE_IDS.customerId, // kept: the portal still works
    });
  });

  it('a stale (previous) subscription cannot overwrite the current one', async () => {
    await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    await processStripeEvent(
      fixture('customer.subscription.created', orgA, {
        subscriptionId: 'sub_Newer002',
        priceId: PRICES.PRO,
      }),
      deps,
    );
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'PRO',
      stripeSubscriptionId: 'sub_Newer002',
    });
    const deleted = await processStripeEvent(fixture('customer.subscription.deleted', orgA), deps);
    expect(deleted).toEqual({
      outcome: 'ignored',
      reason: 'stale_subscription',
      organizationId: orgA,
    });
    const canceled = await processStripeEvent(
      fixture('customer.subscription.updated.canceled', orgA),
      deps,
    );
    expect(canceled).toMatchObject({ outcome: 'ignored', reason: 'stale_subscription' });
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'PRO',
      subscriptionStatus: 'ACTIVE',
    });
  });

  it('invoice.payment_failed → PAST_DUE, plan kept, OWNER emailed with a portal link; invoice.paid clears it', async () => {
    await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    const failed = await processStripeEvent(fixture('invoice.payment_failed', orgA), deps);
    expect(failed).toEqual({
      outcome: 'applied',
      organizationId: orgA,
      plan: 'STARTER',
      status: 'PAST_DUE',
    });
    expect(repo.organizations.get(orgA)).toMatchObject({
      plan: 'STARTER',
      subscriptionStatus: 'PAST_DUE',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: PAYMENT_FAILED_SUBJECT });
    expect(email.sent[0]?.text).toContain('https://app.example.test/app/settings/billing');
    expect(email.sent[0]?.text).toMatch(/update your card/i);

    const paid = await processStripeEvent(fixture('invoice.paid', orgA), deps);
    expect(paid).toMatchObject({ outcome: 'applied', status: 'ACTIVE' });
    expect(repo.organizations.get(orgA)?.subscriptionStatus).toBe('ACTIVE');
    // A second invoice.paid changes nothing.
    expect(await processStripeEvent(fixture('invoice.paid', orgA), deps)).toMatchObject({
      outcome: 'ignored',
      reason: 'no_change',
    });
  });

  it('payment-failed without a transport is logged as skipped, never thrown', async () => {
    await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
    const out = await processStripeEvent(fixture('invoice.payment_failed', orgA), {
      ...deps,
      email: null,
    });
    expect(out).toMatchObject({ outcome: 'applied', status: 'PAST_DUE' });
    expect(lines.some((l) => l.includes('billing.payment_failed_email_skipped'))).toBe(true);
  });

  it('unknown event types are ignored', async () => {
    expect(await processStripeEvent(fixture('unhandled.charge.succeeded', orgA), deps)).toEqual({
      outcome: 'ignored',
      reason: 'unhandled_type',
    });
    expect(repo.audits).toEqual([]);
  });

  it('an unmapped price id throws (retry → dead letter), nothing is written', async () => {
    await expect(
      processStripeEvent(
        fixture('customer.subscription.created', orgA, { priceId: 'price_Unknown9' }),
        deps,
      ),
    ).rejects.toBeInstanceOf(UnknownPriceError);
    expect(repo.organizations.get(orgA)?.plan).toBe('FREE');
  });

  it('is idempotent: applying the same event twice leaves the same state', async () => {
    const ev = fixture('customer.subscription.created', orgA);
    await processStripeEvent(ev, deps);
    const first = { ...repo.organizations.get(orgA)! };
    await processStripeEvent(ev, deps);
    expect(repo.organizations.get(orgA)).toEqual(first);
  });

  describe('tenancy (§7.2)', () => {
    it('an event for org B never touches org A', async () => {
      await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
      const before = { ...repo.organizations.get(orgA)! };
      await processStripeEvent(
        fixture('customer.subscription.created', orgB, {
          customerId: 'cus_B',
          subscriptionId: 'sub_B',
          priceId: PRICES.PRO,
        }),
        deps,
      );
      await processStripeEvent(
        fixture('invoice.payment_failed', orgB, { customerId: 'cus_B', subscriptionId: 'sub_B' }),
        deps,
      );
      expect(repo.organizations.get(orgA)).toEqual(before);
      expect(repo.organizations.get(orgB)).toMatchObject({
        plan: 'PRO',
        subscriptionStatus: 'PAST_DUE',
      });
      expect(repo.audits.filter((a) => a.organizationId === orgA)).toHaveLength(1);
      expect(email.sent.map((m) => m.to)).toEqual(['owner-b@example.test']);
    });

    it("an event naming a customer that is not the organisation's is unresolved, not applied", async () => {
      await processStripeEvent(fixture('customer.subscription.created', orgA), deps);
      const out = await processStripeEvent(
        fixture('customer.subscription.updated.canceled', orgA, { customerId: 'cus_Attacker' }),
        deps,
      );
      expect(out).toEqual({ outcome: 'unresolved', reason: 'customer_mismatch' });
      expect(repo.organizations.get(orgA)?.plan).toBe('STARTER');
    });

    it('an event without an organisation id, or for an unknown organisation, is unresolved', async () => {
      const ev = fixture('customer.subscription.created', orgA);
      const noOrg = { ...ev, data: { object: { ...ev.data.object, metadata: {} } } };
      expect(await processStripeEvent(noOrg, deps)).toEqual({
        outcome: 'unresolved',
        reason: 'no_organization',
      });
      expect(
        await processStripeEvent(fixture('customer.subscription.created', randomUUID()), deps),
      ).toEqual({
        outcome: 'unresolved',
        reason: 'organization_missing',
      });
      expect(repo.audits).toEqual([]);
    });
  });

  describe('handleStripeEvent (bookkeeping)', () => {
    it('marks applied / ignored / unresolved as processed and a thrown error as unprocessed', async () => {
      const applied = fixture('customer.subscription.created', orgA);
      await handleStripeEvent(applied, deps);
      expect(repo.marks.get(applied.id)).toEqual({ processedAt: deps.now!(), error: null });

      const ignored = fixture('unhandled.charge.succeeded', orgA);
      await handleStripeEvent(ignored, deps);
      expect(repo.marks.get(ignored.id)?.error).toBeNull();

      const unresolved = fixture('customer.subscription.created', randomUUID());
      await handleStripeEvent(unresolved, deps);
      expect(repo.marks.get(unresolved.id)?.error).toBe('unresolved: organization_missing');

      const broken = fixture('customer.subscription.created', orgA, { priceId: 'price_Unknown9' });
      await expect(handleStripeEvent(broken, deps)).rejects.toBeInstanceOf(UnknownPriceError);
      expect(repo.marks.get(broken.id)).toMatchObject({ processedAt: null });
      expect(repo.marks.get(broken.id)?.error).toMatch(/UnknownPriceError/);

      repo.failWrites = new Error('db down');
      const dbDown = fixture('customer.subscription.created', orgA);
      await expect(handleStripeEvent(dbDown, deps)).rejects.toThrow('db down');
      expect(repo.marks.get(dbDown.id)?.error).toBe('Error: db down');
    });

    it('logs ids and enum values only: never the billing email, never the payload', async () => {
      await handleStripeEvent(
        fixture('checkout.session.completed', orgA, { email: 'Secret.Person@example.test' }),
        deps,
      );
      await handleStripeEvent(fixture('customer.subscription.created', orgA), deps);
      await handleStripeEvent(fixture('invoice.payment_failed', orgA), deps);
      const text = lines.join('\n');
      expect(text).not.toContain('secret.person');
      expect(text).not.toContain('Secret.Person');
      expect(text).not.toContain(OWNER_EMAIL);
      expect(text).not.toContain('@example.test');
      expect(text).not.toContain('Fixture Owner');
      expect(text).not.toContain('"data"');
      expect(text).toContain('billing.event_processed');
      expect(text).toContain('billing.payment_failed_notified');
    });
  });
});

describe('mapping helpers', () => {
  it('maps every documented Stripe status; incomplete_expired counts as CANCELED', () => {
    expect(SUBSCRIPTION_STATUS_MAP).toEqual({
      trialing: 'TRIALING',
      active: 'ACTIVE',
      past_due: 'PAST_DUE',
      canceled: 'CANCELED',
      unpaid: 'UNPAID',
      incomplete: 'INCOMPLETE',
      incomplete_expired: 'CANCELED',
      paused: 'PAUSED',
    });
  });

  it('effectivePlan keeps the paid plan only while trialing/active/past_due', () => {
    expect(effectivePlan('PRO', 'TRIALING')).toBe('PRO');
    expect(effectivePlan('PRO', 'PAST_DUE')).toBe('PRO');
    for (const s of ['CANCELED', 'UNPAID', 'INCOMPLETE', 'PAUSED', 'NONE'] as const) {
      expect(effectivePlan('PRO', s)).toBe('FREE');
    }
  });

  it('periodEndOf takes the latest item period end, or null when items carry none', () => {
    const sub = loadFixture('customer.subscription.created', { organizationId: randomUUID() }).data
      .object as { items: { data: Array<{ price: string; current_period_end?: number }> } };
    const items = sub.items.data.map((i) => ({ ...i }));
    const base = {
      id: 'sub_1',
      object: 'subscription' as const,
      customer: null,
      status: 'active' as const,
      cancel_at_period_end: false,
      metadata: null,
    };
    expect(
      periodEndOf({
        ...base,
        items: {
          data: [
            { price: 'price_1', current_period_end: 10 },
            { price: 'price_2', current_period_end: 20 },
          ],
        },
      })?.getTime(),
    ).toBe(20_000);
    expect(periodEndOf({ ...base, items: { data: [{ price: 'price_1' }] } })).toBeNull();
    expect(items.length).toBe(1);
  });
});
