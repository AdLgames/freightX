import { Link } from 'react-router';
import { planNoticeText, type PlanFeature, type PlanName } from '../services/billing/plan';

/**
 * Upgrade banner a route renders when a plan limit is hit (M6). The route decides WHEN (using
 * `planAllows` / `minimumPlanFor` from services/billing/plan.ts); this only renders the copy and
 * a link to the billing page. Non-owners are told to ask an owner, because only OWNER may manage
 * billing (§7.2).
 */
export interface PlanNoticeProps {
  feature: PlanFeature;
  requiredPlan: PlanName;
  /** Whether the viewer can open the billing page (role OWNER). Default true. */
  canManageBilling?: boolean;
}

export function PlanNotice({ feature, requiredPlan, canManageBilling = true }: PlanNoticeProps) {
  return (
    <section className="banner notice plan-notice" role="status">
      <p>
        {planNoticeText(feature, requiredPlan)}{' '}
        {canManageBilling ? (
          <Link to="/app/settings/billing">See plans</Link>
        ) : (
          <span>Ask an owner of your organisation to upgrade.</span>
        )}
      </p>
    </section>
  );
}
