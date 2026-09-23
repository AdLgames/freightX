import type { Plan } from '@harbour/db';
import { withOrg, type OrgContext } from '../auth.server';
import { pageError } from '../page-error';
import { PLAN_LABELS, planAtLeast, type PlanName } from './plan';

export * from './plan';

/**
 * Plan gating for loaders and actions (M6). Not wired into other milestones' routes (they are
 * built in parallel); a route that needs it does:
 *
 *   const ctx = await requireOrgContext(request, { permission: 'doc.upload' });
 *   await requirePlan(ctx, 'STARTER');                      // 402 page below Starter
 *
 * or, for a counted limit, reads the plan and renders <PlanNotice/> when `planAllows` says no:
 *
 *   const plan = await currentPlan(ctx);
 *   if (!planAllows(plan, 'savedQuotes', existingCount)) return { notice: { feature: 'savedQuotes', requiredPlan: 'STARTER' } };
 *
 * The effective plan is `Organization.plan`, which only the Stripe webhook processor writes: it
 * is already FREE for cancelled/unpaid subscriptions and kept during PAST_DUE (grace).
 */

/** The organisation's effective plan, read inside the tenant transaction. */
export const currentPlan = async (ctx: OrgContext): Promise<Plan> => {
  const org = await withOrg(ctx, (tx) =>
    tx.organization.findUnique({ where: { id: ctx.org.id }, select: { plan: true } }),
  );
  return org?.plan ?? 'FREE';
};

/** Throws a 402 page unless the organisation is on `minPlan` or higher. Returns the plan. */
export const requirePlan = async (ctx: OrgContext, minPlan: PlanName): Promise<Plan> => {
  const plan = await currentPlan(ctx);
  if (planAtLeast(plan, minPlan)) return plan;
  throw pageError(
    402,
    `This needs the ${PLAN_LABELS[minPlan]} plan`,
    `Your organisation is on the ${PLAN_LABELS[plan]} plan. An owner can upgrade under Settings & billing.`,
  );
};
