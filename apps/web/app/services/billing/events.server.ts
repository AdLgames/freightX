import type { Plan, SubscriptionStatus } from '@harbour/db';
import { z } from 'zod';
import {
  isHandledEventType,
  stripeCheckoutSessionObjectSchema,
  stripeInvoiceObjectSchema,
  stripeSubscriptionObjectSchema,
  type PaidPlan,
  type StripeEventEnvelope,
  type StripeInvoiceObject,
  type StripeSubscriptionObject,
  type StripeSubscriptionStatus,
} from '../../validators/billing';
import type { EmailTransport } from '../email.server';
import type { Logger } from '../logger.server';
import type { BillingPatch, BillingRepository, OrganizationBilling } from './repository.server';

/**
 * Stripe webhook processor (M6). `processStripeEvent` is a pure function over a validated event
 * and the `BillingRepository`; `handleStripeEvent` wraps it with the idempotency-row bookkeeping
 * and is what the queue (queue.server.ts) and the worker job run.
 *
 * Rules (§6.4, §7.2, §9):
 *   - The organisation comes ONLY from the event: `client_reference_id` / `metadata.organizationId`
 *     that we set at checkout (and that Stripe copies onto the subscription and its invoices). No
 *     cross-tenant lookup by customer id. An event that names no organisation, or whose customer
 *     does not match the organisation's stored customer, is recorded as `unresolved` — visible to
 *     ops, never retried, never applied.
 *   - Idempotent: applying the same event twice yields the same organisation state (plus one more
 *     audit row). Duplicate deliveries never reach here (the route drops them).
 *   - Every change writes `billing.subscription_updated` with metadata `{ plan, status }` only.
 *   - Unknown event types are acknowledged and ignored. Unknown price ids and repository failures
 *     THROW so the queue retries (5 attempts, then the dead-letter alert).
 *   - Nothing here logs an email address, a name or a payload. Ids and enum values only.
 */

export const AUDIT_SUBSCRIPTION_UPDATED = 'billing.subscription_updated';

/** Which Stripe price is which plan; the only place a price id meets the Plan enum. */
export interface PlanPriceMap {
  STARTER: string | null;
  PRO: string | null;
}

export interface ProcessorDeps {
  repo: BillingRepository;
  prices: PlanPriceMap;
  /** null → the payment-failed notice is logged as skipped (sign-in is unavailable too). */
  email: EmailTransport | null;
  /** Canonical origin for links in email; null in dev when APP_URL is unset. */
  appUrl: string | null;
  logger: Logger;
  now?: () => Date;
}

export type ProcessOutcome =
  | { outcome: 'applied'; organizationId: string; plan: Plan; status: SubscriptionStatus }
  | { outcome: 'ignored'; reason: IgnoredReason; organizationId?: string }
  | { outcome: 'unresolved'; reason: UnresolvedReason };

export type IgnoredReason =
  'unhandled_type' | 'not_subscription_mode' | 'stale_subscription' | 'no_change';

export type UnresolvedReason =
  'no_organization' | 'organization_missing' | 'customer_mismatch' | 'no_price';

/** A price id Stripe sent that is neither STRIPE_PRICE_STARTER nor STRIPE_PRICE_PRO: config gap. */
export class UnknownPriceError extends Error {
  override readonly name = 'UnknownPriceError';
  constructor(readonly priceId: string) {
    super(`price ${priceId} is not mapped to a plan (STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO)`);
  }
}

// ---------- mapping tables ----------

/** Stripe status → our enum. `incomplete_expired` is a subscription that never started. */
export const SUBSCRIPTION_STATUS_MAP: Readonly<
  Record<StripeSubscriptionStatus, SubscriptionStatus>
> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELED',
  paused: 'PAUSED',
};

/**
 * Statuses under which the paid plan stays in force. PAST_DUE is a grace period (Stripe is
 * retrying the card); everything else drops the organisation to FREE. Provisional — decision (z).
 */
export const PLAN_KEEPING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
]);

export const planForPrice = (priceId: string, prices: PlanPriceMap): PaidPlan | null =>
  prices.STARTER !== null && priceId === prices.STARTER
    ? 'STARTER'
    : prices.PRO !== null && priceId === prices.PRO
      ? 'PRO'
      : null;

export const effectivePlan = (paidPlan: PaidPlan, status: SubscriptionStatus): Plan =>
  PLAN_KEEPING_STATUSES.has(status) ? paidPlan : 'FREE';

/** Period end = the latest item period end (items on one subscription share a billing cycle). */
export const periodEndOf = (sub: StripeSubscriptionObject): Date | null => {
  let max: number | null = null;
  for (const item of sub.items.data) {
    if (item.current_period_end !== undefined && (max === null || item.current_period_end > max)) {
      max = item.current_period_end;
    }
  }
  return max === null ? null : new Date(max * 1000);
};

// ---------- helpers ----------

const orgIdSchema = z.uuid();

const organizationIdOf = (...candidates: Array<string | null | undefined>): string | null => {
  for (const c of candidates) {
    const parsed = orgIdSchema.safeParse(c);
    if (parsed.success) return parsed.data;
  }
  return null;
};

const customerMismatch = (org: OrganizationBilling, customer: string | null): boolean =>
  org.stripeCustomerId !== null && customer !== null && org.stripeCustomerId !== customer;

const invoiceDetails = (invoice: StripeInvoiceObject) =>
  invoice.parent?.subscription_details ?? invoice.subscription_details ?? null;

const auditFor = (plan: Plan, status: SubscriptionStatus) => ({
  action: AUDIT_SUBSCRIPTION_UPDATED,
  userId: null,
  metadata: { plan, status },
});

// ---------- processor ----------

export const processStripeEvent = async (
  event: StripeEventEnvelope,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> => {
  if (!isHandledEventType(event.type)) return { outcome: 'ignored', reason: 'unhandled_type' };
  const now = deps.now ?? (() => new Date());

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = stripeCheckoutSessionObjectSchema.parse(event.data.object);
      if (session.mode !== 'subscription') {
        return { outcome: 'ignored', reason: 'not_subscription_mode' };
      }
      const orgId = organizationIdOf(session.client_reference_id, session.metadata?.organizationId);
      if (!orgId) return { outcome: 'unresolved', reason: 'no_organization' };
      const org = await deps.repo.findOrganization(orgId);
      if (!org) return { outcome: 'unresolved', reason: 'organization_missing' };
      if (customerMismatch(org, session.customer)) {
        return { outcome: 'unresolved', reason: 'customer_mismatch' };
      }
      const patch: BillingPatch = {};
      if (org.stripeCustomerId === null && session.customer) {
        patch.stripeCustomerId = session.customer;
      }
      if (session.subscription && org.stripeSubscriptionId !== session.subscription) {
        patch.stripeSubscriptionId = session.subscription;
      }
      const email = session.customer_details?.email;
      if (org.billingEmail === null && typeof email === 'string' && email.includes('@')) {
        patch.billingEmail = email.trim().toLowerCase();
      }
      if (Object.keys(patch).length === 0) {
        return { outcome: 'ignored', reason: 'no_change', organizationId: orgId };
      }
      // The plan/status themselves arrive with customer.subscription.created; this only links ids.
      await deps.repo.updateOrganization(orgId, patch, auditFor(org.plan, org.subscriptionStatus));
      return {
        outcome: 'applied',
        organizationId: orgId,
        plan: org.plan,
        status: org.subscriptionStatus,
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = stripeSubscriptionObjectSchema.parse(event.data.object);
      const orgId = organizationIdOf(sub.metadata?.organizationId);
      if (!orgId) return { outcome: 'unresolved', reason: 'no_organization' };
      const org = await deps.repo.findOrganization(orgId);
      if (!org) return { outcome: 'unresolved', reason: 'organization_missing' };
      if (customerMismatch(org, sub.customer)) {
        return { outcome: 'unresolved', reason: 'customer_mismatch' };
      }
      const status = SUBSCRIPTION_STATUS_MAP[sub.status];
      // A previous subscription winding down must not overwrite the organisation's current one.
      if (
        org.stripeSubscriptionId !== null &&
        org.stripeSubscriptionId !== sub.id &&
        !PLAN_KEEPING_STATUSES.has(status)
      ) {
        return { outcome: 'ignored', reason: 'stale_subscription', organizationId: orgId };
      }
      const priceId = sub.items.data[0]?.price;
      if (priceId === undefined) return { outcome: 'unresolved', reason: 'no_price' };
      const paidPlan = planForPrice(priceId, deps.prices);
      if (paidPlan === null) throw new UnknownPriceError(priceId);
      const plan = effectivePlan(paidPlan, status);
      await deps.repo.updateOrganization(
        orgId,
        {
          plan,
          subscriptionStatus: status,
          stripeSubscriptionId: sub.id,
          ...(org.stripeCustomerId === null && sub.customer
            ? { stripeCustomerId: sub.customer }
            : {}),
          currentPeriodEnd: periodEndOf(sub),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          planUpdatedAt: now(),
        },
        auditFor(plan, status),
      );
      return { outcome: 'applied', organizationId: orgId, plan, status };
    }

    case 'customer.subscription.deleted': {
      const sub = stripeSubscriptionObjectSchema.parse(event.data.object);
      const orgId = organizationIdOf(sub.metadata?.organizationId);
      if (!orgId) return { outcome: 'unresolved', reason: 'no_organization' };
      const org = await deps.repo.findOrganization(orgId);
      if (!org) return { outcome: 'unresolved', reason: 'organization_missing' };
      if (customerMismatch(org, sub.customer)) {
        return { outcome: 'unresolved', reason: 'customer_mismatch' };
      }
      if (org.stripeSubscriptionId !== null && org.stripeSubscriptionId !== sub.id) {
        return { outcome: 'ignored', reason: 'stale_subscription', organizationId: orgId };
      }
      await deps.repo.updateOrganization(
        orgId,
        {
          plan: 'FREE',
          subscriptionStatus: 'CANCELED',
          stripeSubscriptionId: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          planUpdatedAt: now(),
        },
        auditFor('FREE', 'CANCELED'),
      );
      return { outcome: 'applied', organizationId: orgId, plan: 'FREE', status: 'CANCELED' };
    }

    case 'invoice.payment_failed': {
      const invoice = stripeInvoiceObjectSchema.parse(event.data.object);
      const orgId = organizationIdOf(invoiceDetails(invoice)?.metadata?.organizationId);
      if (!orgId) return { outcome: 'unresolved', reason: 'no_organization' };
      const org = await deps.repo.findOrganization(orgId);
      if (!org) return { outcome: 'unresolved', reason: 'organization_missing' };
      if (customerMismatch(org, invoice.customer)) {
        return { outcome: 'unresolved', reason: 'customer_mismatch' };
      }
      // Plan is kept (grace period); status flags the problem.
      await deps.repo.updateOrganization(
        orgId,
        { subscriptionStatus: 'PAST_DUE', planUpdatedAt: now() },
        auditFor(org.plan, 'PAST_DUE'),
      );
      await notifyPaymentFailed(orgId, deps);
      return { outcome: 'applied', organizationId: orgId, plan: org.plan, status: 'PAST_DUE' };
    }

    case 'invoice.paid': {
      const invoice = stripeInvoiceObjectSchema.parse(event.data.object);
      const orgId = organizationIdOf(invoiceDetails(invoice)?.metadata?.organizationId);
      if (!orgId) return { outcome: 'unresolved', reason: 'no_organization' };
      const org = await deps.repo.findOrganization(orgId);
      if (!org) return { outcome: 'unresolved', reason: 'organization_missing' };
      if (customerMismatch(org, invoice.customer)) {
        return { outcome: 'unresolved', reason: 'customer_mismatch' };
      }
      // Only clears a PAST_DUE flag; any plan change comes with customer.subscription.updated.
      if (org.subscriptionStatus !== 'PAST_DUE') {
        return { outcome: 'ignored', reason: 'no_change', organizationId: orgId };
      }
      await deps.repo.updateOrganization(
        orgId,
        { subscriptionStatus: 'ACTIVE', planUpdatedAt: now() },
        auditFor(org.plan, 'ACTIVE'),
      );
      return { outcome: 'applied', organizationId: orgId, plan: org.plan, status: 'ACTIVE' };
    }
  }
};

// ---------- payment-failed email ----------

export const PAYMENT_FAILED_SUBJECT = 'Payment failed — update your card';

/** Links to our billing page (auth-gated), which opens the Stripe Billing Portal. */
export const paymentFailedEmailText = (billingUrl: string): string =>
  [
    'Your latest subscription payment for Harbour did not go through.',
    '',
    'To keep your plan, update your card in the Stripe billing portal:',
    billingUrl,
    '',
    'Stripe will retry the payment automatically over the next few days. If it keeps failing, your organisation moves to the Free plan.',
  ].join('\n');

const notifyPaymentFailed = async (organizationId: string, deps: ProcessorDeps): Promise<void> => {
  const log = deps.logger;
  if (!deps.email) {
    log.warn('billing.payment_failed_email_skipped', {
      orgId: organizationId,
      reason: 'no_transport',
    });
    return;
  }
  const recipients = await deps.repo.ownerEmails(organizationId);
  if (recipients.length === 0) {
    log.warn('billing.payment_failed_email_skipped', { orgId: organizationId, reason: 'no_owner' });
    return;
  }
  if (deps.appUrl === null) {
    // Development without APP_URL: the link would be relative, which is useless in an email.
    log.warn('billing.payment_failed_email_relative_link', { orgId: organizationId });
  }
  const billingUrl = `${deps.appUrl ?? ''}/app/settings/billing`;
  let sent = 0;
  for (const to of recipients) {
    try {
      await deps.email.send({
        to,
        subject: PAYMENT_FAILED_SUBJECT,
        text: paymentFailedEmailText(billingUrl),
      });
      sent += 1;
    } catch (err) {
      // The status change is already committed; a mail failure is logged, not retried, so the
      // organisation is not audited twice.
      log.error('billing.payment_failed_email_error', {
        orgId: organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('billing.payment_failed_notified', { orgId: organizationId, recipients: sent });
};

// ---------- bookkeeping wrapper ----------

export interface HandleResult {
  eventId: string;
  type: string;
  outcome: ProcessOutcome;
}

/**
 * Runs the processor and records the result on the `stripe_events` row: `processedAt` for
 * applied / ignored / unresolved (none of these should be retried), `error` and no `processedAt`
 * when the processor threw (the queue retries; after the last attempt the job is dead-lettered).
 */
export const handleStripeEvent = async (
  event: StripeEventEnvelope,
  deps: ProcessorDeps,
): Promise<HandleResult> => {
  const now = deps.now ?? (() => new Date());
  const base = { eventId: event.id, type: event.type };
  let outcome: ProcessOutcome;
  try {
    outcome = await processStripeEvent(event, deps);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    deps.logger.error('billing.event_failed', { ...base, error: message });
    await deps.repo.markStripeEvent(event.id, { processedAt: null, error: message.slice(0, 1000) });
    throw err;
  }
  const mark =
    outcome.outcome === 'unresolved'
      ? { processedAt: now(), error: `unresolved: ${outcome.reason}` }
      : { processedAt: now(), error: null };
  await deps.repo.markStripeEvent(event.id, mark);
  deps.logger[outcome.outcome === 'unresolved' ? 'warn' : 'info']('billing.event_processed', {
    ...base,
    ...outcome,
  });
  return { ...base, outcome };
};
