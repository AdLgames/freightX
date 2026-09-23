import { Link, data } from 'react-router';
import type { Route } from './+types/app.settings_.billing_.success';
import { getApp } from '../services/app.server';
import { requireOrgContext } from '../services/auth.server';
import { requestLogger } from '../services/logger.server';
import { pageError } from '../services/page-error';
import { checkoutSessionIdSchema } from '../validators/billing';

/**
 * /app/settings/billing/success?session_id=cs_… (M6). Stripe sends the owner here after Checkout.
 * The session is retrieved server-side and must belong to THIS organisation
 * (`client_reference_id`); otherwise a 404, so a session id from another tenant reveals nothing.
 * The page only confirms; the webhook (customer.subscription.created/updated) is what changes the
 * plan, so the copy says the plan updates shortly.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Subscription — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const notFound = () =>
  pageError(
    404,
    'Checkout not found',
    'We could not find that checkout for your organisation. If you have just paid, open Billing to see your plan.',
  );

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'billing.manage' });
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const { billing } = app;
  if (!billing.configured || !billing.gateway) throw notFound();

  const sessionId = checkoutSessionIdSchema.safeParse(
    new URL(request.url).searchParams.get('session_id'),
  );
  if (!sessionId.success) throw notFound();

  let session;
  try {
    session = await billing.gateway.retrieveCheckoutSession(sessionId.data);
  } catch (err) {
    log.warn('billing.success_lookup_failed', {
      orgId: ctx.org.id,
      error: err instanceof Error ? err.name : 'unknown',
    });
    throw notFound();
  }
  if (session.client_reference_id !== ctx.org.id) {
    log.warn('billing.success_wrong_org', { orgId: ctx.org.id });
    throw notFound();
  }
  const active =
    session.status === 'complete' &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  log.info('billing.success_viewed', { orgId: ctx.org.id, active });
  return data({ active, status: session.status }, { headers: ctx.headers });
};

export default function BillingSuccess({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <h1>{loaderData.active ? 'Subscription active' : 'Payment being confirmed'}</h1>
      {loaderData.active ? (
        <p>
          Thank you. Your plan updates within a minute once Stripe confirms the payment to us; the
          Billing page shows the current plan.
        </p>
      ) : (
        <p>
          Stripe has not confirmed the payment yet. Check the Billing page in a minute, or open the
          billing portal to see the invoice.
        </p>
      )}
      <p>
        <Link to="/app/settings/billing">Go to Billing</Link>
      </p>
    </>
  );
}
