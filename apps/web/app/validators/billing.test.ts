import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  billingActionSchema,
  checkoutSessionIdSchema,
  isHandledEventType,
  stripeEventEnvelopeSchema,
  stripeInvoiceObjectSchema,
  stripeSubscriptionObjectSchema,
} from './billing';

describe('billing form schemas', () => {
  it('checkout needs a paid plan; portal needs nothing else', () => {
    expect(billingActionSchema.safeParse({ intent: 'checkout', plan: 'STARTER' }).success).toBe(
      true,
    );
    expect(billingActionSchema.safeParse({ intent: 'checkout', plan: 'FREE' }).success).toBe(false);
    expect(billingActionSchema.safeParse({ intent: 'checkout' }).success).toBe(false);
    expect(billingActionSchema.safeParse({ intent: 'portal' }).success).toBe(true);
    expect(billingActionSchema.safeParse({ intent: 'refund' }).success).toBe(false);
  });

  it('checkout session ids are Stripe-shaped and bounded', () => {
    expect(checkoutSessionIdSchema.safeParse(' cs_test_a1B2c3 ').data).toBe('cs_test_a1B2c3');
    expect(checkoutSessionIdSchema.safeParse('cs_live_x').success).toBe(true);
    expect(checkoutSessionIdSchema.safeParse('sub_123').success).toBe(false);
    expect(checkoutSessionIdSchema.safeParse(`cs_test_${'a'.repeat(201)}`).success).toBe(false);
    expect(checkoutSessionIdSchema.safeParse('cs_test_<script>').success).toBe(false);
  });
});

describe('Stripe object schemas', () => {
  it('accepts an id or an expanded object for customer/price/subscription references', () => {
    const base = {
      id: 'sub_1',
      object: 'subscription',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { organizationId: randomUUID() },
      items: { data: [{ price: { id: 'price_1', object: 'price' }, current_period_end: 1 }] },
    };
    const expanded = stripeSubscriptionObjectSchema.parse({
      ...base,
      customer: { id: 'cus_1', object: 'customer', deleted: true },
    });
    expect(expanded.customer).toBe('cus_1');
    expect(expanded.items.data[0]?.price).toBe('price_1');
    expect(stripeSubscriptionObjectSchema.parse({ ...base, customer: 'cus_2' }).customer).toBe(
      'cus_2',
    );
  });

  it('fails closed on an unknown subscription status', () => {
    expect(
      stripeSubscriptionObjectSchema.safeParse({
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        status: 'mystery',
        cancel_at_period_end: false,
        items: { data: [] },
      }).success,
    ).toBe(false);
  });

  it('reads the subscription from either the current or the legacy invoice shape', () => {
    const current = stripeInvoiceObjectSchema.parse({
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_1',
      status: 'open',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
    });
    expect(current.parent?.subscription_details?.subscription).toBe('sub_1');
    const legacy = stripeInvoiceObjectSchema.parse({
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_1',
      status: 'open',
      subscription: { id: 'sub_9' },
    });
    expect(legacy.subscription).toBe('sub_9');
  });

  it('envelope: requires the event id, type, created, livemode and data.object', () => {
    expect(
      stripeEventEnvelopeSchema.safeParse({
        id: 'evt_1',
        object: 'event',
        type: 'x.y',
        created: 1,
        livemode: false,
        data: { object: {} },
      }).success,
    ).toBe(true);
    expect(stripeEventEnvelopeSchema.safeParse({ id: 'evt_1', object: 'event' }).success).toBe(
      false,
    );
    expect(stripeEventEnvelopeSchema.safeParse({ id: 'nope', object: 'event' }).success).toBe(
      false,
    );
  });

  it('knows which event types are handled', () => {
    expect(isHandledEventType('invoice.paid')).toBe(true);
    expect(isHandledEventType('charge.succeeded')).toBe(false);
  });
});
