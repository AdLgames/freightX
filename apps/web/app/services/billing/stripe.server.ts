import Stripe from 'stripe';
import { z } from 'zod';
import {
  stripeCheckoutSessionObjectSchema,
  stripeEventEnvelopeSchema,
  stripePriceObjectSchema,
  stripeSubscriptionObjectSchema,
  type PaidPlan,
  type StripeCheckoutSessionObject,
  type StripeEventEnvelope,
  type StripePriceObject,
  type StripeSubscriptionObject,
} from '../../validators/billing';

/**
 * Stripe client wrapper (M6, brief §3 "Stripe Billing for subscriptions").
 *
 * - `BillingGateway` is the only surface the routes and the processor see; `StripeGateway` talks
 *   to Stripe, `FakeBillingGateway` is the in-memory double for tests (build plan: "tests use
 *   recorded webhook payloads and a fake client").
 * - The API version is pinned HERE, in code, and the SDK's types only know that version, so a
 *   mismatch fails typecheck rather than production.
 * - Every response we rely on is validated with zod (§7.5 "including third-party API responses").
 * - Plan names and prices come from Stripe (`retrievePrices`), never from code; the UX spec's
 *   example price is deliberately not written anywhere.
 * - Webhook verification (`verifyStripeWebhook`) needs no API key and no network: it is a static
 *   HMAC check with the SDK's constant-time comparison and a 300 s replay window (§6.4).
 */

/** Pinned Stripe API version. Must equal the installed SDK's version (typed, see StripeConfig). */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

/** §6.4: reject timestamps older than 5 minutes (also the SDK default). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * An integer amount in a currency's minor units (pence), exactly as Stripe sends it. This is an
 * identifier-like value for DISPLAY only: it is never added, multiplied or compared, and it is
 * converted to a decimal string (`minorUnitsToDecimalString`) before it reaches a template. Money
 * we compute is always `Decimal` / decimal strings (ADR-0003).
 */
export type MinorUnits = number;

// ---------- gateway contract ----------

export interface CreateCustomerInput {
  organizationId: string;
  /** The OWNER's address, becomes the billing email. PII: never logged. */
  email: string;
  name: string;
}

export interface CreateCheckoutSessionInput {
  organizationId: string;
  customerId: string;
  priceId: string;
  plan: PaidPlan;
  successUrl: string;
  cancelUrl: string;
}

export interface CreatePortalSessionInput {
  customerId: string;
  returnUrl: string;
}

export interface WebhookVerifyOptions {
  toleranceSeconds?: number;
  /** Clock for the replay check (ms since epoch). Tests inject it. */
  now?: () => number;
}

export interface BillingGateway {
  readonly name: 'stripe' | 'fake';
  createCustomer(input: CreateCustomerInput): Promise<{ id: string }>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionObject>;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionObject>;
  /** Prices in the order asked for; a missing id is simply absent (the page copes). */
  retrievePrices(priceIds: readonly string[]): Promise<StripePriceObject[]>;
  /** Signature + timestamp check, then envelope validation. Throws `WebhookSignatureError`. */
  constructWebhookEvent(
    rawBody: Uint8Array | string,
    signatureHeader: string,
    secret: string,
    opts?: WebhookVerifyOptions,
  ): StripeEventEnvelope;
}

// ---------- webhook verification (static, keyless) ----------

export type WebhookRejectReason = 'signature' | 'timestamp' | 'malformed';

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
  constructor(
    readonly reason: WebhookRejectReason,
    message: string,
  ) {
    super(message);
  }
}

const classifySdkError = (err: unknown): WebhookRejectReason => {
  const message = err instanceof Error ? err.message : '';
  return /timestamp|tolerance/i.test(message) ? 'timestamp' : 'signature';
};

/**
 * `Stripe.webhooks.constructEvent` (HMAC-SHA256 over `${t}.${body}`, constant-time compare,
 * timestamp tolerance) followed by our envelope schema. The SDK's static helper needs no key.
 */
export const verifyStripeWebhook = (
  rawBody: Uint8Array | string,
  signatureHeader: string,
  secret: string,
  opts: WebhookVerifyOptions = {},
): StripeEventEnvelope => {
  let parsed: unknown;
  try {
    parsed = Stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      secret,
      opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS,
      undefined,
      opts.now ? opts.now() : undefined,
    );
  } catch (err) {
    throw new WebhookSignatureError(classifySdkError(err), 'webhook signature rejected');
  }
  const envelope = stripeEventEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new WebhookSignatureError('malformed', 'webhook payload is not a Stripe event');
  }
  return envelope.data;
};

/** Test helper: the `Stripe-Signature` header the SDK would accept for `payload`. */
export const signWebhookPayload = (
  payload: string,
  secret: string,
  opts: { timestampSeconds?: number } = {},
): string =>
  Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(opts.timestampSeconds === undefined ? {} : { timestamp: opts.timestampSeconds }),
  });

// ---------- display helpers ----------

/** ISO 4217 currencies Stripe treats as zero-decimal (amounts are whole units). */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** "2900" + "gbp" → "29.00"; "500" + "jpy" → "500". String arithmetic only, no floats. */
export const minorUnitsToDecimalString = (amountMinor: MinorUnits, currency: string): string => {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error('minor units must be a non-negative integer');
  }
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return String(amountMinor);
  const digits = String(amountMinor).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

export interface PriceDisplay {
  plan: PaidPlan;
  priceId: string;
  /** Decimal string in `currency`, or null when Stripe has no flat unit amount (tiered/metered). */
  amount: string | null;
  /** Upper-case ISO 4217. */
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year' | null;
  intervalCount: number;
  /** Stripe product name (or price nickname), the label users see; null when not expanded. */
  productName: string | null;
}

export const priceDisplayFrom = (price: StripePriceObject, plan: PaidPlan): PriceDisplay => ({
  plan,
  priceId: price.id,
  amount:
    price.unit_amount === null
      ? null
      : minorUnitsToDecimalString(price.unit_amount, price.currency),
  currency: price.currency.toUpperCase(),
  interval: price.recurring?.interval ?? null,
  intervalCount: price.recurring?.interval_count ?? 1,
  productName:
    (typeof price.product === 'object' ? (price.product.name ?? null) : null) ?? price.nickname,
});

// ---------- Stripe ----------

const createdSessionSchema = z.object({ id: z.string().min(1), url: z.string().url() });
const createdPortalSchema = z.object({ url: z.string().url() });
const createdCustomerSchema = z.object({ id: z.string().regex(/^cus_/) });

export interface StripeGatewayOptions {
  /** Per-request timeout (ms). Stripe is in the request path only for checkout/portal/success. */
  timeoutMs?: number;
}

export class StripeGateway implements BillingGateway {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(secretKey: string, opts: StripeGatewayOptions = {}) {
    this.stripe = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 1,
      timeout: opts.timeoutMs ?? 10_000,
      appInfo: { name: 'harbour' },
      // Stripe's own telemetry header is opt-out; keep requests minimal.
      telemetry: false,
    });
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.name,
      metadata: { organizationId: input.organizationId },
    });
    return createdCustomerSchema.parse(customer);
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<{ id: string; url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.organizationId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Copied onto the subscription (and from there onto its invoices): how webhook events find
      // the organisation without a cross-tenant lookup.
      subscription_data: { metadata: { organizationId: input.organizationId, plan: input.plan } },
      metadata: { organizationId: input.organizationId, plan: input.plan },
    });
    return createdSessionSchema.parse(session);
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return createdPortalSchema.parse(session);
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionObject> {
    return stripeSubscriptionObjectSchema.parse(
      await this.stripe.subscriptions.retrieve(subscriptionId),
    );
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionObject> {
    return stripeCheckoutSessionObjectSchema.parse(
      await this.stripe.checkout.sessions.retrieve(sessionId),
    );
  }

  async retrievePrices(priceIds: readonly string[]): Promise<StripePriceObject[]> {
    const out: StripePriceObject[] = [];
    for (const id of priceIds) {
      const price = await this.stripe.prices.retrieve(id, { expand: ['product'] });
      out.push(stripePriceObjectSchema.parse(price));
    }
    return out;
  }

  constructWebhookEvent(
    rawBody: Uint8Array | string,
    signatureHeader: string,
    secret: string,
    opts?: WebhookVerifyOptions,
  ): StripeEventEnvelope {
    return verifyStripeWebhook(rawBody, signatureHeader, secret, opts);
  }
}

// ---------- fake (tests) ----------

export interface FakeGatewayCall {
  method: keyof BillingGateway;
  input: unknown;
}

/**
 * In-memory Stripe. Records every call, hands out deterministic ids and URLs, and serves whatever
 * objects a test seeds. Webhook verification is the real static check (it is pure crypto).
 */
export class FakeBillingGateway implements BillingGateway {
  readonly name = 'fake' as const;
  readonly calls: FakeGatewayCall[] = [];
  readonly checkoutSessions = new Map<string, StripeCheckoutSessionObject>();
  readonly subscriptions = new Map<string, StripeSubscriptionObject>();
  readonly prices = new Map<string, StripePriceObject>();
  /** When set, every API method throws it (simulates Stripe being down). */
  failWith: Error | null = null;
  private seq = 0;

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${String(this.seq).padStart(4, '0')}`;
  }

  private record(method: keyof BillingGateway, input: unknown): void {
    this.calls.push({ method, input });
    if (this.failWith) throw this.failWith;
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    this.record('createCustomer', input);
    return { id: this.next('cus') };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<{ id: string; url: string }> {
    this.record('createCheckoutSession', input);
    const id = `cs_test_${this.next('s').replace('s_', '')}`;
    this.checkoutSessions.set(id, {
      id,
      object: 'checkout.session',
      mode: 'subscription',
      status: 'open',
      payment_status: 'unpaid',
      client_reference_id: input.organizationId,
      customer: input.customerId,
      subscription: null,
      metadata: { organizationId: input.organizationId, plan: input.plan },
      customer_details: null,
    });
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
    this.record('createPortalSession', input);
    return { url: `https://billing.stripe.com/p/session/${this.next('bps')}` };
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionObject> {
    this.record('retrieveSubscription', subscriptionId);
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`No such subscription: ${subscriptionId}`);
    return sub;
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionObject> {
    this.record('retrieveCheckoutSession', sessionId);
    const session = this.checkoutSessions.get(sessionId);
    if (!session) throw new Error(`No such checkout.session: ${sessionId}`);
    return session;
  }

  async retrievePrices(priceIds: readonly string[]): Promise<StripePriceObject[]> {
    this.record('retrievePrices', priceIds);
    return priceIds.flatMap((id) => {
      const p = this.prices.get(id);
      return p ? [p] : [];
    });
  }

  constructWebhookEvent(
    rawBody: Uint8Array | string,
    signatureHeader: string,
    secret: string,
    opts?: WebhookVerifyOptions,
  ): StripeEventEnvelope {
    return verifyStripeWebhook(rawBody, signatureHeader, secret, opts);
  }

  /** Test seam: mark a checkout session as completed (what Stripe does after payment). */
  completeCheckoutSession(sessionId: string, subscriptionId: string): void {
    const s = this.checkoutSessions.get(sessionId);
    if (!s) throw new Error(`No such checkout.session: ${sessionId}`);
    this.checkoutSessions.set(sessionId, {
      ...s,
      status: 'complete',
      payment_status: 'paid',
      subscription: subscriptionId,
    });
  }
}
