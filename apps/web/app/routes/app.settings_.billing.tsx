import { recordAudit } from '@harbour/db';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.settings_.billing';
import { CsrfInput } from '../components/csrf';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { PLAN_LABELS } from '../services/billing/plan';
import type { PriceDisplay } from '../services/billing/stripe.server';
import { expectedOrigin, requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import { billingActionSchema, type PaidPlan } from '../validators/billing';

/**
 * /app/settings/billing (M6, UX spec "Settings and billing": OWNER only). Shows the current plan,
 * subscription status and renewal date, and:
 *
 *   - "Choose Starter" / "Choose Pro" → POST intent=checkout: a Stripe Checkout Session (mode
 *     subscription) for the organisation's Stripe customer (created first if needed, with the
 *     organisation id in metadata and the owner's address as billing email), then a redirect.
 *   - "Manage subscription" → POST intent=portal: a Billing Portal session, then a redirect.
 *
 * The file is `app.settings_.billing.tsx` (not `app.settings.billing.tsx`): with flat routes the
 * latter would nest under M2's settings page, which owns its own layout; the URL is the same.
 * Prices and plan names are read from Stripe at request time (cached 5 min); none are in code.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Billing — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const SELECT = {
  plan: true,
  subscriptionStatus: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
} as const;

const STATUS_LABELS: Record<string, string> = {
  NONE: 'No subscription',
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCELED: 'Cancelled',
  UNPAID: 'Unpaid',
  INCOMPLETE: 'Payment incomplete',
  PAUSED: 'Paused',
};

/** Whether the organisation currently has a Stripe subscription to manage in the portal. */
const hasLiveSubscription = (org: { stripeSubscriptionId: string | null }): boolean =>
  org.stripeSubscriptionId !== null;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'billing.manage' });
  const app = await getApp();
  const url = new URL(request.url);
  const org = await withOrg(ctx, (tx) =>
    tx.organization.findUniqueOrThrow({ where: { id: ctx.org.id }, select: SELECT }),
  );
  const prices = app.billing.configured ? await app.billing.priceDisplays() : [];
  return data(
    {
      configured: app.billing.configured,
      plan: org.plan,
      status: org.subscriptionStatus,
      statusLabel: STATUS_LABELS[org.subscriptionStatus] ?? org.subscriptionStatus,
      renewsAt: org.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      canManage: org.stripeCustomerId !== null,
      subscribed: hasLiveSubscription(org),
      prices,
      cancelled: url.searchParams.get('cancelled') === '1',
    },
    { headers: ctx.headers },
  );
};

export type BillingActionData = { error: string };

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'billing.manage' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const { billing } = app;
  const fail = (status: number, error: string) => data<BillingActionData>({ error }, { status });

  if (!billing.configured || !billing.gateway) {
    return fail(503, 'Billing is not configured on this server yet.');
  }
  const parsed = billingActionSchema.safeParse({
    intent: form?.get('intent'),
    plan: form?.get('plan') ?? undefined,
  });
  if (!parsed.success) return fail(400, 'Choose a plan and try again.');

  const origin = expectedOrigin(request, app.auth.appUrl);
  const billingUrl = `${origin}/app/settings/billing`;
  const org = await withOrg(ctx, (tx) =>
    tx.organization.findUniqueOrThrow({ where: { id: ctx.org.id }, select: SELECT }),
  );

  if (parsed.data.intent === 'portal') {
    if (!org.stripeCustomerId) {
      return fail(400, 'There is no subscription to manage yet. Choose a plan first.');
    }
    const session = await billing.gateway.createPortalSession({
      customerId: org.stripeCustomerId,
      returnUrl: billingUrl,
    });
    await withOrg(ctx, (tx) =>
      recordAudit(tx, {
        organizationId: ctx.org.id,
        userId: ctx.user.id,
        action: 'billing.portal_opened',
        targetType: 'Organization',
        targetId: ctx.org.id,
      }),
    );
    log.info('billing.portal_opened', { orgId: ctx.org.id, userId: ctx.user.id });
    return redirect(session.url);
  }

  const plan: PaidPlan = parsed.data.plan;
  const priceId = billing.prices[plan];
  if (!priceId) return fail(503, 'That plan is not available right now.');
  if (hasLiveSubscription(org)) {
    return fail(400, 'You already have a subscription. Use "Manage subscription" to change plan.');
  }

  let customerId = org.stripeCustomerId;
  if (!customerId) {
    const created = await billing.gateway.createCustomer({
      organizationId: ctx.org.id,
      email: ctx.user.email,
      name: ctx.org.name,
    });
    customerId = created.id;
    const id = customerId;
    await withOrg(ctx, async (tx) => {
      await tx.organization.update({
        where: { id: ctx.org.id },
        data: { stripeCustomerId: id, billingEmail: ctx.user.email.toLowerCase() },
      });
      // The customer id is an identifier, not PII; the billing email never goes in metadata.
      await recordAudit(tx, {
        organizationId: ctx.org.id,
        userId: ctx.user.id,
        action: 'billing.customer_created',
        targetType: 'Organization',
        targetId: ctx.org.id,
        metadata: { stripeCustomerId: id },
      });
    });
  }

  const session = await billing.gateway.createCheckoutSession({
    organizationId: ctx.org.id,
    customerId,
    priceId,
    plan,
    successUrl: `${billingUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${billingUrl}?cancelled=1`,
  });
  await withOrg(ctx, (tx) =>
    recordAudit(tx, {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      action: 'billing.checkout_started',
      targetType: 'Organization',
      targetId: ctx.org.id,
      metadata: { plan },
    }),
  );
  log.info('billing.checkout_started', { orgId: ctx.org.id, userId: ctx.user.id, plan });
  return redirect(session.url);
};

// ---------- view ----------

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  });

const formatPrice = (p: PriceDisplay): string => {
  if (p.amount === null) return 'Price shown at checkout';
  const every =
    p.interval === null
      ? ''
      : p.intervalCount === 1
        ? ` / ${p.interval}`
        : ` / ${p.intervalCount} ${p.interval}s`;
  return `${p.currency} ${p.amount}${every}`;
};

export default function BillingPage({ loaderData, actionData }: Route.ComponentProps) {
  const d = loaderData;
  return (
    <>
      <p>
        <Link to="/app/settings">‹ Settings</Link>
      </p>
      <h1>Billing</h1>

      {!d.configured ? (
        <section className="banner notice" role="status">
          <h2>Billing is not configured</h2>
          <p>
            Subscriptions are not set up on this server yet. Your organisation is on the{' '}
            {PLAN_LABELS[d.plan]} plan. Everything else in the workspace works as normal.
          </p>
        </section>
      ) : null}

      {actionData?.error ? (
        <section className="banner error" role="alert">
          <p>{actionData.error}</p>
        </section>
      ) : null}
      {d.cancelled ? (
        <section className="banner notice" role="status">
          <p>Checkout was cancelled. Nothing has changed.</p>
        </section>
      ) : null}
      {d.status === 'PAST_DUE' ? (
        <section className="banner indicative" role="alert">
          <h2>Payment overdue</h2>
          <p>
            Your last payment failed. Update your card under "Manage subscription" to keep the{' '}
            {PLAN_LABELS[d.plan]} plan.
          </p>
        </section>
      ) : null}

      <dl className="meta">
        <dt>Current plan</dt>
        <dd>
          <strong>{PLAN_LABELS[d.plan]}</strong>
        </dd>
        <dt>Status</dt>
        <dd>{d.statusLabel}</dd>
        {d.renewsAt ? (
          <>
            <dt>{d.cancelAtPeriodEnd ? 'Ends on' : 'Renews on'}</dt>
            <dd>{formatDate(d.renewsAt)}</dd>
          </>
        ) : null}
      </dl>

      {d.configured && d.canManage ? (
        <Form method="post" className="billing-actions">
          <CsrfInput />
          <input type="hidden" name="intent" value="portal" />
          <button type="submit" className="button">
            Manage subscription
          </button>
          <p className="hint">
            Change plan, update your card, download invoices or cancel — in the Stripe billing
            portal.
          </p>
        </Form>
      ) : null}

      {d.configured && !d.subscribed ? (
        <section className="plan-options" aria-labelledby="choose-plan">
          <h2 id="choose-plan">Choose a plan</h2>
          <p className="hint">
            You will be taken to Stripe to pay. Promotion codes can be entered there.
          </p>
          <ul className="plan-list">
            {(['STARTER', 'PRO'] as const).map((plan) => {
              const price = d.prices.find((p) => p.plan === plan);
              return (
                <li key={plan} className="plan-card">
                  <h3>{price?.productName ?? PLAN_LABELS[plan]}</h3>
                  <p className="plan-price">
                    {price ? formatPrice(price) : 'Price shown at checkout'}
                  </p>
                  <Form method="post">
                    <CsrfInput />
                    <input type="hidden" name="intent" value="checkout" />
                    <input type="hidden" name="plan" value={plan} />
                    <button type="submit" className="button">
                      Choose {PLAN_LABELS[plan]}
                    </button>
                  </Form>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
