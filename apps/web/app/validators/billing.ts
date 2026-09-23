import { z } from 'zod';

/**
 * Billing boundaries (M6, §3 "zod at every boundary … webhooks"). Two kinds of schema:
 *
 * 1. Our own forms and query strings on /app/settings/billing.
 * 2. The Stripe objects we read. Stripe adds fields freely, so every object schema is `loose`
 *    (unknown keys pass through) and only the fields the processor uses are declared. Shapes follow
 *    the API version pinned in services/billing/stripe.server.ts (2026-08-26): a subscription's
 *    period end lives on its items, and an invoice references its subscription through `parent`.
 *
 * Money never appears here: Stripe amounts are integer minor units and are only read (as
 * `MinorUnits`) for display in stripe.server.ts. Nothing in a webhook payload is treated as a price.
 */

// ---------- our forms ----------

/** The two paid plans a user can pick. FREE is the absence of a subscription. */
export const PAID_PLANS = ['STARTER', 'PRO'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

export const billingActionSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('checkout'),
    plan: z.enum(PAID_PLANS, { error: 'Choose a plan.' }),
  }),
  z.object({ intent: z.literal('portal') }),
]);
export type BillingAction = z.infer<typeof billingActionSchema>;

/** `?session_id=cs_…` on the success page. Bounded, Stripe-shaped, nothing else accepted. */
export const checkoutSessionIdSchema = z
  .string()
  .trim()
  .regex(/^cs_(test|live)_[A-Za-z0-9]{1,200}$/, 'That checkout reference is not valid.');

// ---------- Stripe ids ----------

const stripeId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`), `Expected a ${prefix}_ id.`);

export const stripeEventIdSchema = stripeId('evt');
export const stripeCustomerIdSchema = stripeId('cus');
export const stripeSubscriptionIdSchema = stripeId('sub');
export const stripePriceIdSchema = stripeId('price');

/** Stripe may send an id or an expanded object; we only ever need the id. */
const idOrObject = (schema: z.ZodString) =>
  z.union([
    schema,
    z
      .object({ id: schema })
      .loose()
      .transform((o) => o.id),
  ]);

/** Expanded customers may be `{ deleted: true, id }`; the id is still what we want. */
const customerRef = idOrObject(stripeCustomerIdSchema).nullable();

/** Organisation id carried in Stripe metadata (set by us at checkout). */
export const stripeMetadataSchema = z
  .object({ organizationId: z.uuid().optional() })
  .loose()
  .nullable()
  .optional();

// ---------- Stripe objects ----------

/** Subscription statuses as Stripe names them (documented list; unknown strings fail closed). */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

export const stripeSubscriptionObjectSchema = z
  .object({
    id: stripeSubscriptionIdSchema,
    object: z.literal('subscription'),
    customer: customerRef,
    status: z.enum(STRIPE_SUBSCRIPTION_STATUSES),
    cancel_at_period_end: z.boolean(),
    metadata: stripeMetadataSchema,
    items: z
      .object({
        data: z.array(
          z
            .object({
              price: idOrObject(stripePriceIdSchema),
              /** Unix seconds. Per-item since API 2025-03-31 (was on the subscription). */
              current_period_end: z.number().int().nonnegative().optional(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();
export type StripeSubscriptionObject = z.infer<typeof stripeSubscriptionObjectSchema>;

export const stripeCheckoutSessionObjectSchema = z
  .object({
    id: z.string().regex(/^cs_/),
    object: z.literal('checkout.session'),
    mode: z.string(),
    status: z.enum(['open', 'complete', 'expired']).nullable(),
    payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
    client_reference_id: z.string().nullable(),
    customer: customerRef,
    subscription: idOrObject(stripeSubscriptionIdSchema).nullable(),
    metadata: stripeMetadataSchema,
    customer_details: z.object({ email: z.string().nullable().optional() }).loose().nullable(),
  })
  .loose();
export type StripeCheckoutSessionObject = z.infer<typeof stripeCheckoutSessionObjectSchema>;

const invoiceSubscriptionDetails = z
  .object({
    subscription: idOrObject(stripeSubscriptionIdSchema).nullable().optional(),
    metadata: stripeMetadataSchema,
  })
  .loose();

export const stripeInvoiceObjectSchema = z
  .object({
    id: z.string().regex(/^in_/),
    object: z.literal('invoice'),
    customer: customerRef,
    status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).nullable(),
    /** API ≥ 2025-03-31: the subscription that generated the invoice. */
    parent: z
      .object({
        type: z.string().optional(),
        subscription_details: invoiceSubscriptionDetails.nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    /** Pre-2025-03-31 shape, accepted so an account pinned to an older webhook version still works. */
    subscription: idOrObject(stripeSubscriptionIdSchema).nullable().optional(),
    subscription_details: invoiceSubscriptionDetails.nullable().optional(),
  })
  .loose();
export type StripeInvoiceObject = z.infer<typeof stripeInvoiceObjectSchema>;

/** The envelope every webhook delivery has, after signature verification. */
export const stripeEventEnvelopeSchema = z
  .object({
    id: stripeEventIdSchema,
    object: z.literal('event'),
    type: z.string().min(1).max(100),
    created: z.number().int().nonnegative(),
    livemode: z.boolean(),
    data: z.object({ object: z.record(z.string(), z.unknown()) }).loose(),
  })
  .loose();
export type StripeEventEnvelope = z.infer<typeof stripeEventEnvelopeSchema>;

/** Event types the processor handles. Everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export const isHandledEventType = (type: string): type is HandledEventType =>
  (HANDLED_EVENT_TYPES as readonly string[]).includes(type);

/** Stripe price for display: what the billing page shows, read from Stripe, never from code. */
export const stripePriceObjectSchema = z
  .object({
    id: stripePriceIdSchema,
    object: z.literal('price'),
    active: z.boolean(),
    currency: z.string().length(3),
    /** Integer minor units (pence). Null for tiered/metered prices. */
    unit_amount: z.number().int().nonnegative().nullable(),
    nickname: z.string().nullable(),
    recurring: z
      .object({
        interval: z.enum(['day', 'week', 'month', 'year']),
        interval_count: z.number().int().positive(),
      })
      .loose()
      .nullable(),
    product: z.union([z.string(), z.object({ name: z.string().optional() }).loose()]),
  })
  .loose();
export type StripePriceObject = z.infer<typeof stripePriceObjectSchema>;
