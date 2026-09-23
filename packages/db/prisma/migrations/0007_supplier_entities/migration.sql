-- =============================================================================================
-- 0007_supplier_entities  (M3: products and suppliers — the catalogue; ADR-0012)
--
-- Part 1 (generated, then hand-adjusted) — produced with
--   prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script
--   Two hand adjustments, both on "suppliers": Prisma emits `legal_name TEXT NOT NULL` and
--   `country_of_incorporation TEXT NOT NULL`, which would fail on a table with rows. They are added
--   nullable, BACKFILLED from `name` / `country_code` (ADR-0012: "the migration copies it across"),
--   then set NOT NULL. Everything else is verbatim.
--     * enums payment_term_type, balance_trigger, payout_partner, payout_method_type (additive-only
--       rule applies: append values, never rename/remove)
--     * suppliers: legal entity columns + archived_at; `country_code` is KEPT as a deprecated alias
--       of `country_of_incorporation` (the app writes both) until M4 lands — decisions-needed (w)
--     * products: carton dimensions, hs_description, preference_eligible, archived_at
--     * pickup_locations, payment_terms, payout_methods — tenant tables with a denormalised
--       organization_id and a composite FK (supplier_id, organization_id) → suppliers
--
-- Part 2 (hand-written, idempotent) — CHECKs, the one-default-per-supplier partial unique index,
--   RLS and grants for the three new tables.
--
-- payout_methods holds partner references only (§7.3): the CHECK on account_last4 makes it
-- impossible to store more than four characters of an account identifier.
--
-- ## Rollback
-- - Reversible: yes (additive). Old code ignores the new columns and tables; the backfilled
--   suppliers columns carry defaults for old INSERTs only through the app (the columns are NOT
--   NULL), so a rollback of the CODE without the schema must be to a release that still writes
--   `name`/`country_code` — every release does, since both columns are kept.
-- - Down steps: re-deploy previous release. To remove physically:
--     DROP TABLE "payout_methods"; DROP TABLE "payment_terms"; DROP TABLE "pickup_locations";
--     ALTER TABLE "suppliers" DROP COLUMN "legal_name", DROP COLUMN "trading_name",
--       DROP COLUMN "registration_number", DROP COLUMN "country_of_incorporation",
--       DROP COLUMN "default_currency", DROP COLUMN "archived_at";
--     ALTER TABLE "products" DROP COLUMN "carton_length_cm", DROP COLUMN "carton_width_cm",
--       DROP COLUMN "carton_height_cm", DROP COLUMN "hs_description",
--       DROP COLUMN "preference_eligible", DROP COLUMN "archived_at";
--     DROP TYPE "payout_method_type"; DROP TYPE "payout_partner"; DROP TYPE "balance_trigger";
--     DROP TYPE "payment_term_type";
--   Dropping the tables/columns is destructive once catalogue data exists (needs a backup
--   snapshot ID).
-- - Data impact: suppliers rows get legal_name = name and country_of_incorporation = country_code;
--   nothing else changes on existing rows (defaults / NULLs only).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated (hand-adjusted: suppliers NOT NULL columns are backfilled)
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "payment_term_type" AS ENUM ('PREPAID', 'NET', 'DEPOSIT_BALANCE');

-- CreateEnum
CREATE TYPE "balance_trigger" AS ENUM ('ON_SHIPMENT', 'AGAINST_BILL_OF_LADING', 'ON_ARRIVAL');

-- CreateEnum
CREATE TYPE "payout_partner" AS ENUM ('AIRWALLEX');

-- CreateEnum
CREATE TYPE "payout_method_type" AS ENUM ('LOCAL', 'SWIFT');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "carton_height_cm" DECIMAL(8,2),
ADD COLUMN     "carton_length_cm" DECIMAL(8,2),
ADD COLUMN     "carton_width_cm" DECIMAL(8,2),
ADD COLUMN     "hs_description" TEXT,
ADD COLUMN     "preference_eligible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable (hand-adjusted: legal_name / country_of_incorporation added nullable, backfilled,
-- then made NOT NULL — see the header)
ALTER TABLE "suppliers" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "country_of_incorporation" TEXT,
ADD COLUMN     "default_currency" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "registration_number" TEXT,
ADD COLUMN     "trading_name" TEXT;

-- Backfill (ADR-0012): the brief's single name/country become the legal entity's.
UPDATE "suppliers" SET "legal_name" = "name" WHERE "legal_name" IS NULL;
UPDATE "suppliers" SET "country_of_incorporation" = "country_code" WHERE "country_of_incorporation" IS NULL;
ALTER TABLE "suppliers" ALTER COLUMN "legal_name" SET NOT NULL;
ALTER TABLE "suppliers" ALTER COLUMN "country_of_incorporation" SET NOT NULL;

-- CreateTable
CREATE TABLE "pickup_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "country" TEXT NOT NULL,
    "closest_port_code" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_terms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "term_type" "payment_term_type" NOT NULL,
    "deposit_pct" DECIMAL(5,2),
    "balance_trigger" "balance_trigger",
    "net_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_methods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "partner" "payout_partner" NOT NULL,
    "partner_beneficiary_id" TEXT NOT NULL,
    "type" "payout_method_type" NOT NULL,
    "currency" TEXT NOT NULL,
    "bank_country" TEXT NOT NULL,
    "bank_name" TEXT,
    "account_last4" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pickup_locations_organization_id_idx" ON "pickup_locations"("organization_id");

-- CreateIndex
CREATE INDEX "pickup_locations_supplier_id_idx" ON "pickup_locations"("supplier_id");

-- CreateIndex
CREATE INDEX "payment_terms_organization_id_idx" ON "payment_terms"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_terms_supplier_id_key" ON "payment_terms"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_terms_supplier_id_organization_id_key" ON "payment_terms"("supplier_id", "organization_id");

-- CreateIndex
CREATE INDEX "payout_methods_organization_id_idx" ON "payout_methods"("organization_id");

-- CreateIndex
CREATE INDEX "payout_methods_supplier_id_idx" ON "payout_methods"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_methods_partner_partner_beneficiary_id_key" ON "payout_methods"("partner", "partner_beneficiary_id");

-- AddForeignKey
ALTER TABLE "pickup_locations" ADD CONSTRAINT "pickup_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_locations" ADD CONSTRAINT "pickup_locations_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS)
-- ---------------------------------------------------------------------------------------------

-- ---------- suppliers: country codes are ISO alpha-2 ----------
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS suppliers_country_of_incorporation_format;
ALTER TABLE "suppliers" ADD CONSTRAINT suppliers_country_of_incorporation_format
  CHECK (country_of_incorporation ~ '^[A-Z]{2}$');

-- ---------- pickup_locations: row rules ----------
-- UN/LOCODE: two-letter country + three alphanumerics (the validator is stricter: digits 2–9).
ALTER TABLE "pickup_locations" DROP CONSTRAINT IF EXISTS pickup_locations_closest_port_code_format;
ALTER TABLE "pickup_locations" ADD CONSTRAINT pickup_locations_closest_port_code_format
  CHECK (closest_port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$');

ALTER TABLE "pickup_locations" DROP CONSTRAINT IF EXISTS pickup_locations_country_format;
ALTER TABLE "pickup_locations" ADD CONSTRAINT pickup_locations_country_format
  CHECK (country ~ '^[A-Z]{2}$');

-- At most one default pickup location per supplier (partial unique index; Prisma cannot express it).
DROP INDEX IF EXISTS pickup_locations_one_default_per_supplier;
CREATE UNIQUE INDEX pickup_locations_one_default_per_supplier
  ON "pickup_locations" ("supplier_id") WHERE is_default;

-- ---------- payment_terms: row rules ----------
-- Percent convention ("30.00" = 30%), so 0–100 inclusive.
ALTER TABLE "payment_terms" DROP CONSTRAINT IF EXISTS payment_terms_deposit_pct_range;
ALTER TABLE "payment_terms" ADD CONSTRAINT payment_terms_deposit_pct_range
  CHECK (deposit_pct IS NULL OR (deposit_pct >= 0 AND deposit_pct <= 100));

ALTER TABLE "payment_terms" DROP CONSTRAINT IF EXISTS payment_terms_net_days_nonnegative;
ALTER TABLE "payment_terms" ADD CONSTRAINT payment_terms_net_days_nonnegative
  CHECK (net_days IS NULL OR net_days >= 0);

-- A deposit/balance split needs the deposit share and what releases the balance.
ALTER TABLE "payment_terms" DROP CONSTRAINT IF EXISTS payment_terms_deposit_balance_complete;
ALTER TABLE "payment_terms" ADD CONSTRAINT payment_terms_deposit_balance_complete
  CHECK (term_type <> 'DEPOSIT_BALANCE' OR (deposit_pct IS NOT NULL AND balance_trigger IS NOT NULL));

-- Net terms need the number of days.
ALTER TABLE "payment_terms" DROP CONSTRAINT IF EXISTS payment_terms_net_needs_days;
ALTER TABLE "payment_terms" ADD CONSTRAINT payment_terms_net_needs_days
  CHECK (term_type <> 'NET' OR net_days IS NOT NULL);

-- ---------- payout_methods: never more than a masked suffix (§7.3) ----------
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS payout_methods_account_last4_masked;
ALTER TABLE "payout_methods" ADD CONSTRAINT payout_methods_account_last4_masked
  CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9A-Za-z]{1,4}$');

ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS payout_methods_currency_format;
ALTER TABLE "payout_methods" ADD CONSTRAINT payout_methods_currency_format
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS payout_methods_bank_country_format;
ALTER TABLE "payout_methods" ADD CONSTRAINT payout_methods_bank_country_format
  CHECK (bank_country ~ '^[A-Z]{2}$');

-- ---------- row-level security (same shape as 0002) ----------
ALTER TABLE "pickup_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pickup_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pickup_locations_tenant ON "pickup_locations";
CREATE POLICY pickup_locations_tenant ON "pickup_locations"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "payment_terms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_terms" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_terms_tenant ON "payment_terms";
CREATE POLICY payment_terms_tenant ON "payment_terms"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "payout_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payout_methods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payout_methods_tenant ON "payout_methods";
CREATE POLICY payout_methods_tenant ON "payout_methods"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Grants ----------
-- 0002's ALTER DEFAULT PRIVILEGES covers tables created by the same role; grant explicitly anyway
-- so the result does not depend on which role runs the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pickup_locations" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment_terms" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payout_methods" TO harbour_app;
