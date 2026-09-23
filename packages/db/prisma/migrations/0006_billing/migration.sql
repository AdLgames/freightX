-- =============================================================================================
-- 0006_billing  (M6: Stripe Billing subscriptions)
--
-- Part 1 (generated) — `prisma migrate diff --from-migrations prisma/migrations
--   --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script`.
--     * enum subscription_status (additive-only rule applies: append values, never rename/remove)
--     * organizations: stripe_subscription_id (unique), subscription_status (default NONE),
--       current_period_end, cancel_at_period_end (default false), billing_email, plan_updated_at.
--       All nullable or with a constant default, so existing rows read "never subscribed".
--     * stripe_events: webhook idempotency (§6.4 "duplicates are no-ops"). Keyed by the Stripe
--       event id; holds only the event type, timestamps, the last error and the payload's sha256 —
--       never the payload itself. Not a tenant table: the organisation is only known once the
--       event has been processed, and the row must exist before that. No RLS, like
--       magic_link_tokens / email_signups (PASSTHROUGH_MODELS in src/tenancy.ts).
--
-- Part 2 (hand-written, idempotent) — billing_email is stored lower-cased (CHECK), and an
--   explicit grant on stripe_events for harbour_app (0002's default privileges cover it when the
--   same role runs the migration; the grant makes the result independent of that).
--
-- Independent of 0005 (M5 documents): both are additive and touch different tables/columns.
--
-- ## Rollback
-- - Reversible: yes (additive)
-- - Down steps: re-deploy previous release; old code ignores the new table, columns and enum.
--   To remove physically: DROP TABLE "stripe_events"; ALTER TABLE "organizations" DROP COLUMN
--   "stripe_subscription_id", "subscription_status", "current_period_end", "cancel_at_period_end",
--   "billing_email", "plan_updated_at"; DROP TYPE "subscription_status". Dropping the columns
--   loses the subscription state of every organisation (recoverable from Stripe by replaying
--   `customer.subscription.updated`, but treat as destructive: backup snapshot ID required).
-- - Data impact: none on existing rows (defaults only).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'INCOMPLETE', 'PAUSED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billing_email" TEXT,
ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "current_period_end" TIMESTAMP(3),
ADD COLUMN     "plan_updated_at" TIMESTAMP(3),
ADD COLUMN     "stripe_subscription_id" TEXT,
ADD COLUMN     "subscription_status" "subscription_status" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "payload_sha256" TEXT NOT NULL,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stripe_events_processed_at_received_at_idx" ON "stripe_events"("processed_at", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_stripe_subscription_id_key" ON "organizations"("stripe_subscription_id");

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS)
-- ---------------------------------------------------------------------------------------------

-- billing_email is the OWNER's address at checkout time (PII, §7.3: never logged, never in audit
-- metadata). Stored lower-cased so it compares like User.email; the app lower-cases before writing,
-- this makes the database refuse anything else.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS organizations_billing_email_lowercase;
ALTER TABLE "organizations" ADD CONSTRAINT organizations_billing_email_lowercase
  CHECK (billing_email IS NULL OR billing_email = lower(billing_email));

-- ---------- Grants ----------
-- The webhook route inserts the idempotency row and the processor updates it; the app role needs
-- both. No UPDATE/DELETE revoke: rows are corrected in place (processed_at / error), not appended.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "stripe_events" TO harbour_app;
