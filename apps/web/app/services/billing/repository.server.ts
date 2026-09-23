import {
  recordAudit,
  withOrgTransaction,
  type Plan,
  type PrismaClient,
  type SubscriptionStatus,
} from '@harbour/db';

/**
 * Persistence seam for billing (M6). The webhook processor (events.server.ts) is a pure function
 * over this interface; `PrismaBillingRepository` is the real thing and `InMemoryBillingRepository`
 * the test double.
 *
 * Tenancy: every organisation read/write runs inside `withOrgTransaction(orgId)` — Prisma scope +
 * RLS — with the organisation id taken from the event's metadata. There is deliberately NO
 * "find organisation by Stripe customer id" across tenants: with FORCE RLS that query would return
 * nothing anyway, and an event that names no organisation is recorded as unresolved, not guessed.
 *
 * `stripe_events` is a global table (no RLS): the row exists before the organisation is known.
 */

export interface OrganizationBilling {
  id: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** PII (§7.3): never logged, never in audit metadata. */
  billingEmail: string | null;
}

export interface BillingPatch {
  plan?: Plan;
  subscriptionStatus?: SubscriptionStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  billingEmail?: string | null;
  planUpdatedAt?: Date;
}

export interface BillingAudit {
  action: string;
  /** null for webhook-driven (system) changes. */
  userId: string | null;
  /** IDs and enum values only — never PII. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface StripeEventMark {
  processedAt: Date | null;
  error: string | null;
}

export interface BillingRepository {
  findOrganization(organizationId: string): Promise<OrganizationBilling | null>;
  /** Applies `patch` and writes the audit row in ONE transaction. */
  updateOrganization(
    organizationId: string,
    patch: BillingPatch,
    audit: BillingAudit,
  ): Promise<void>;
  /** Email addresses of the organisation's OWNER members (PII: for sending, never for logging). */
  ownerEmails(organizationId: string): Promise<string[]>;
  /** Records the processing result on the idempotency row (created by the webhook route). */
  markStripeEvent(eventId: string, mark: StripeEventMark): Promise<void>;
}

// ---------- Prisma ----------

const BILLING_SELECT = {
  id: true,
  plan: true,
  subscriptionStatus: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  billingEmail: true,
} as const;

export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOrganization(organizationId: string): Promise<OrganizationBilling | null> {
    const org = await withOrgTransaction(this.prisma, organizationId, (tx) =>
      tx.organization.findUnique({ where: { id: organizationId }, select: BILLING_SELECT }),
    );
    return org && org.id === organizationId ? org : null;
  }

  async updateOrganization(
    organizationId: string,
    patch: BillingPatch,
    audit: BillingAudit,
  ): Promise<void> {
    await withOrgTransaction(this.prisma, organizationId, async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          ...patch,
          ...(patch.billingEmail === undefined
            ? {}
            : { billingEmail: patch.billingEmail?.toLowerCase() ?? null }),
        },
      });
      await recordAudit(tx, {
        organizationId,
        userId: audit.userId,
        action: audit.action,
        targetType: 'Organization',
        targetId: organizationId,
        metadata: audit.metadata ?? null,
      });
    });
  }

  async ownerEmails(organizationId: string): Promise<string[]> {
    const rows = await withOrgTransaction(this.prisma, organizationId, (tx) =>
      tx.membership.findMany({
        where: { role: 'OWNER' },
        select: { user: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((r) => r.user.email);
  }

  async markStripeEvent(eventId: string, mark: StripeEventMark): Promise<void> {
    await this.prisma.stripeEvent.updateMany({
      where: { id: eventId },
      data: { processedAt: mark.processedAt, error: mark.error },
    });
  }
}

// ---------- in-memory (tests) ----------

export interface InMemoryAuditRow extends BillingAudit {
  organizationId: string;
}

export class InMemoryBillingRepository implements BillingRepository {
  readonly organizations = new Map<string, OrganizationBilling>();
  readonly owners = new Map<string, string[]>();
  readonly audits: InMemoryAuditRow[] = [];
  readonly marks = new Map<string, StripeEventMark>();
  /** When set, every organisation write throws it (simulates a database failure). */
  failWrites: Error | null = null;

  seed(org: OrganizationBilling, ownerEmails: string[] = []): void {
    this.organizations.set(org.id, { ...org });
    this.owners.set(org.id, [...ownerEmails]);
  }

  async findOrganization(organizationId: string): Promise<OrganizationBilling | null> {
    const org = this.organizations.get(organizationId);
    return org ? { ...org } : null;
  }

  async updateOrganization(
    organizationId: string,
    patch: BillingPatch,
    audit: BillingAudit,
  ): Promise<void> {
    if (this.failWrites) throw this.failWrites;
    const org = this.organizations.get(organizationId);
    if (!org) throw new Error('NOT_FOUND_IN_SCOPE');
    const { planUpdatedAt: _ignored, ...rest } = patch;
    this.organizations.set(organizationId, {
      ...org,
      ...rest,
      ...(rest.billingEmail === undefined
        ? {}
        : { billingEmail: rest.billingEmail?.toLowerCase() ?? null }),
    });
    this.audits.push({ organizationId, ...audit });
  }

  async ownerEmails(organizationId: string): Promise<string[]> {
    return [...(this.owners.get(organizationId) ?? [])];
  }

  async markStripeEvent(eventId: string, mark: StripeEventMark): Promise<void> {
    this.marks.set(eventId, mark);
  }
}
