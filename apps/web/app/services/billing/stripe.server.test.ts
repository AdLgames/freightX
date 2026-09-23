import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureText } from './fixtures';
import {
  FakeBillingGateway,
  STRIPE_API_VERSION,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookSignatureError,
  minorUnitsToDecimalString,
  priceDisplayFrom,
  signWebhookPayload,
  verifyStripeWebhook,
} from './stripe.server';

const SECRET = 'whsec_test_secret';
const organizationId = randomUUID();
const body = fixtureText('customer.subscription.updated', { organizationId });

describe('verifyStripeWebhook', () => {
  it('accepts a payload signed with generateTestHeaderString', () => {
    const event = verifyStripeWebhook(body, signWebhookPayload(body, SECRET), SECRET);
    expect(event.id).toBe('evt_FixtureEvent001');
    expect(event.type).toBe('customer.subscription.updated');
    // Bytes and string are equivalent inputs (the route passes the raw bytes).
    const bytes = new TextEncoder().encode(body);
    expect(verifyStripeWebhook(bytes, signWebhookPayload(body, SECRET), SECRET).id).toBe(event.id);
  });

  it('rejects a wrong secret, a tampered body and a garbage header (reason: signature)', () => {
    const header = signWebhookPayload(body, SECRET);
    for (const [payload, sig, secret] of [
      [body, header, 'whsec_other'],
      [body.replace('"active"', '"paused"'), header, SECRET],
      [body, 't=1,v1=deadbeef', SECRET],
      [body, '', SECRET],
    ] as const) {
      let caught: unknown;
      try {
        verifyStripeWebhook(payload, sig, secret);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WebhookSignatureError);
      expect((caught as WebhookSignatureError).reason).toBe('signature');
    }
  });

  it('rejects a timestamp older than the 300 s tolerance (reason: timestamp)', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stale = signWebhookPayload(body, SECRET, {
      timestampSeconds: nowSeconds - WEBHOOK_TOLERANCE_SECONDS - 5,
    });
    let caught: unknown;
    try {
      verifyStripeWebhook(body, stale, SECRET);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WebhookSignatureError);
    expect((caught as WebhookSignatureError).reason).toBe('timestamp');
    // Just inside the window is fine; the clock is injectable.
    const fresh = signWebhookPayload(body, SECRET, { timestampSeconds: nowSeconds - 100 });
    expect(verifyStripeWebhook(body, fresh, SECRET, { now: () => nowSeconds * 1000 }).id).toBe(
      'evt_FixtureEvent001',
    );
  });

  it('rejects a validly signed body that is not a Stripe event (reason: malformed)', () => {
    const notAnEvent = JSON.stringify({ hello: 'world' });
    let caught: unknown;
    try {
      verifyStripeWebhook(notAnEvent, signWebhookPayload(notAnEvent, SECRET), SECRET);
    } catch (err) {
      caught = err;
    }
    expect((caught as WebhookSignatureError).reason).toBe('malformed');
  });

  it('pins the API version the SDK types were generated for', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });
});

describe('minorUnitsToDecimalString', () => {
  it('converts pence to a decimal string without floating point', () => {
    expect(minorUnitsToDecimalString(2900, 'gbp')).toBe('29.00');
    expect(minorUnitsToDecimalString(5, 'GBP')).toBe('0.05');
    expect(minorUnitsToDecimalString(0, 'eur')).toBe('0.00');
    expect(minorUnitsToDecimalString(123456789, 'usd')).toBe('1234567.89');
    expect(minorUnitsToDecimalString(500, 'jpy')).toBe('500');
  });

  it('refuses non-integers and negatives', () => {
    expect(() => minorUnitsToDecimalString(1.5, 'gbp')).toThrow();
    expect(() => minorUnitsToDecimalString(-1, 'gbp')).toThrow();
  });
});

describe('priceDisplayFrom', () => {
  it('uses the Stripe product name and interval; never a hard-coded price', () => {
    const display = priceDisplayFrom(
      {
        id: 'price_FakeStarter001',
        object: 'price',
        active: true,
        currency: 'gbp',
        unit_amount: 1234,
        nickname: null,
        recurring: { interval: 'month', interval_count: 1 },
        product: { name: 'Starter (from Stripe)' },
      },
      'STARTER',
    );
    expect(display).toEqual({
      plan: 'STARTER',
      priceId: 'price_FakeStarter001',
      amount: '12.34',
      currency: 'GBP',
      interval: 'month',
      intervalCount: 1,
      productName: 'Starter (from Stripe)',
    });
  });

  it('tiered price (no unit amount) → amount null, product id → name null', () => {
    const display = priceDisplayFrom(
      {
        id: 'price_FakePro001',
        object: 'price',
        active: true,
        currency: 'gbp',
        unit_amount: null,
        nickname: 'Pro monthly',
        recurring: null,
        product: 'prod_x',
      },
      'PRO',
    );
    expect(display.amount).toBeNull();
    expect(display.interval).toBeNull();
    expect(display.productName).toBe('Pro monthly');
  });
});

describe('FakeBillingGateway', () => {
  it('hands out deterministic sessions and records calls', async () => {
    const fake = new FakeBillingGateway();
    const customer = await fake.createCustomer({
      organizationId,
      email: 'o@example.test',
      name: 'X',
    });
    const checkout = await fake.createCheckoutSession({
      organizationId,
      customerId: customer.id,
      priceId: 'price_FakeStarter001',
      plan: 'STARTER',
      successUrl: 'http://localhost/s',
      cancelUrl: 'http://localhost/c',
    });
    expect(checkout.url).toContain('checkout.stripe.com');
    const session = await fake.retrieveCheckoutSession(checkout.id);
    expect(session.client_reference_id).toBe(organizationId);
    expect(session.status).toBe('open');
    fake.completeCheckoutSession(checkout.id, 'sub_FixtureSubscription001');
    expect((await fake.retrieveCheckoutSession(checkout.id)).status).toBe('complete');
    expect(fake.calls.map((c) => c.method)).toEqual([
      'createCustomer',
      'createCheckoutSession',
      'retrieveCheckoutSession',
      'retrieveCheckoutSession',
    ]);
    fake.failWith = new Error('stripe down');
    await expect(fake.createPortalSession({ customerId: 'cus_x', returnUrl: 'x' })).rejects.toThrow(
      'stripe down',
    );
  });
});
