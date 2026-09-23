import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripeEventEnvelopeSchema, type StripeEventEnvelope } from '../../../validators/billing';

/**
 * HAND-AUTHORED fixtures in Stripe's documented shape (see README.md): test inputs, not recorded
 * evidence. `loadFixture` substitutes the tenant-specific ids so every test can use its own
 * organisation and the cross-tenant assertions are meaningful.
 */
export const FIXTURE_NAMES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.updated.past_due',
  'customer.subscription.updated.canceled',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
  'unhandled.charge.succeeded',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureIds {
  organizationId: string;
  customerId?: string;
  subscriptionId?: string;
  priceId?: string;
  eventId?: string;
  email?: string;
}

export const DEFAULT_FIXTURE_IDS = {
  customerId: 'cus_FixtureCustomer001',
  subscriptionId: 'sub_FixtureSubscription001',
  priceId: 'price_FakeStarter001',
  eventId: 'evt_FixtureEvent001',
  email: 'owner@example.test',
} as const;

const dir = import.meta.dirname;

/** The raw JSON text with placeholders substituted (what a test signs and POSTs). */
export const fixtureText = (name: FixtureName, ids: FixtureIds): string => {
  const values = { ...DEFAULT_FIXTURE_IDS, ...ids };
  return readFileSync(join(dir, `${name}.json`), 'utf8')
    .replaceAll('{{ORG_ID}}', values.organizationId)
    .replaceAll('{{CUSTOMER_ID}}', values.customerId)
    .replaceAll('{{SUBSCRIPTION_ID}}', values.subscriptionId)
    .replaceAll('{{PRICE_ID}}', values.priceId)
    .replaceAll('{{EVENT_ID}}', values.eventId)
    .replaceAll('{{EMAIL}}', values.email);
};

/** The parsed, validated event envelope. */
export const loadFixture = (name: FixtureName, ids: FixtureIds): StripeEventEnvelope =>
  stripeEventEnvelopeSchema.parse(JSON.parse(fixtureText(name, ids)));
