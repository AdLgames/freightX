/**
 * Plan gating table (M6). Pure and importable from the client (the <PlanNotice/> banner); the
 * server-side guard `requirePlan` lives in plan.server.ts and re-exports everything here.
 *
 * PROVISIONAL (docs/decisions-needed.md row (z)): the plan names, prices and these limits are a
 * working assumption until the founder signs them off. Change the numbers in ONE place — this
 * table — and the notice copy follows. Prices are never here; they live in Stripe.
 */

/** Mirrors the Prisma `Plan` enum without importing the generated client (client-safe). */
export const PLANS = ['FREE', 'STARTER', 'PRO'] as const;
export type PlanName = (typeof PLANS)[number];

export const PLAN_LABELS: Readonly<Record<PlanName, string>> = {
  FREE: 'Free',
  STARTER: 'Starter',
  PRO: 'Pro',
};

/** Ordering for "at least this plan" checks. */
export const PLAN_RANK: Readonly<Record<PlanName, number>> = { FREE: 0, STARTER: 1, PRO: 2 };

export interface PlanLimits {
  /** The landed-cost calculator (public and in-app). */
  calculator: boolean;
  /** Saved quotes per organisation; null = unlimited. */
  savedQuotes: number | null;
  /** Catalogue products per organisation; null = unlimited. */
  products: number | null;
  /** The document vault. */
  documents: boolean;
  /** Members per organisation (all roles); null = unlimited. */
  members: number | null;
}

/**
 * The one table. FREE: calculator + 3 saved quotes + 10 products. STARTER: unlimited quotes and
 * products, documents. PRO: everything, including more than 3 members.
 */
export const PLAN_LIMITS: Readonly<Record<PlanName, PlanLimits>> = {
  FREE: { calculator: true, savedQuotes: 3, products: 10, documents: false, members: 3 },
  STARTER: { calculator: true, savedQuotes: null, products: null, documents: true, members: 3 },
  PRO: { calculator: true, savedQuotes: null, products: null, documents: true, members: null },
};

export type PlanFeature = keyof PlanLimits;

export const isPlanName = (value: unknown): value is PlanName =>
  typeof value === 'string' && (PLANS as readonly string[]).includes(value);

/**
 * May an organisation on `plan` use `feature`? For counted features pass the CURRENT count (before
 * adding one more): allowed while `count < limit`. Unknown plan → false (fail closed).
 */
export const planAllows = (plan: PlanName, feature: PlanFeature, currentCount = 0): boolean => {
  if (!isPlanName(plan)) return false;
  const limit = PLAN_LIMITS[plan][feature];
  if (typeof limit === 'boolean') return limit;
  if (limit === null) return true;
  return currentCount < limit;
};

/** The cheapest plan that allows `feature` at `currentCount`, or null if none does. */
export const minimumPlanFor = (feature: PlanFeature, currentCount = 0): PlanName | null => {
  for (const plan of PLANS) {
    if (planAllows(plan, feature, currentCount)) return plan;
  }
  return null;
};

export const planAtLeast = (plan: PlanName, minPlan: PlanName): boolean =>
  isPlanName(plan) && isPlanName(minPlan) && PLAN_RANK[plan] >= PLAN_RANK[minPlan];

/** Copy for the upgrade banner, e.g. "Upgrade to Starter to save more than 3 quotes." */
export const planNoticeText = (feature: PlanFeature, requiredPlan: PlanName): string => {
  const label = PLAN_LABELS[requiredPlan];
  const free = PLAN_LIMITS.FREE;
  switch (feature) {
    case 'savedQuotes':
      return `Upgrade to ${label} to save more than ${free.savedQuotes ?? 0} quotes.`;
    case 'products':
      return `Upgrade to ${label} to keep more than ${free.products ?? 0} products.`;
    case 'documents':
      return `Upgrade to ${label} to store documents.`;
    case 'members':
      return `Upgrade to ${label} to add more than ${PLAN_LIMITS.STARTER.members ?? 0} members.`;
    case 'calculator':
      return `Upgrade to ${label} to use the calculator.`;
  }
};
