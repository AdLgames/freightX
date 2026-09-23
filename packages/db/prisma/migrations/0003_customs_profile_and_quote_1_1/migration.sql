-- =============================================================================================
-- 0003_customs_profile_and_quote_1_1
--
-- Part 1 (generated) — `prisma migrate diff --from-schema-datamodel <schema as of 0002>
--   --to-schema-datamodel prisma/schema.prisma --script`. (`--from-migrations` needs a shadow
--   database and cannot replay 0002, whose `REVOKE ... ON "_prisma_migrations"` assumes the
--   bookkeeping table exists; see README "Migrations".) Not idempotent, like 0001: Prisma records
--   it in _prisma_migrations and never re-runs it.
--     * enum payment_method (additive-only rule applies: append values, never rename/remove)
--     * customs_profiles (1:1 with organizations) — tenant table
--     * engine calcVersion 1.1 snapshot columns on quotes / quote_lines, all NOT NULL with a
--       constant DEFAULT (or nullable), so the migration is additive.
--
-- Part 2 (hand-written, idempotent) — CHECKs, the PVA trigger, RLS and grants for
--   customs_profiles.
--
-- Accepted-quote immutability (§5.9) and the new quote columns: `ALTER TABLE ... ADD COLUMN` is
-- DDL, not an UPDATE, so row triggers (quotes_accepted_immutable, quote_lines_accepted_immutable)
-- do not fire. With a constant default Postgres 11+ does not even rewrite the table; existing rows
-- read the default. Afterwards OLD and NEW row images both carry the new columns, so the trigger's
-- whole-row comparison keeps working: status -> CANCELLED/EXPIRED on an old accepted quote is still
-- allowed and changing a new column on it is rejected (test/customs-profile.db.test.ts).
--
-- ## Rollback
-- - Reversible: yes (additive)
-- - Down steps: re-deploy previous release; old code ignores the new table/columns. To remove
--   physically: DROP TABLE "customs_profiles"; DROP FUNCTION customs_profiles_pva_requires_vat(),
--   organizations_vat_required_by_pva(); DROP TRIGGER organizations_vat_required_by_pva ON
--   "organizations"; ALTER TABLE "quotes" DROP COLUMN ... (6); ALTER TABLE "quote_lines" DROP
--   COLUMN ... (3); DROP TYPE "payment_method". Dropping the quote columns is destructive for
--   quotes computed with calcVersion >= 1.1 (needs a backup snapshot ID).
-- - Data impact: none on existing rows (defaults only).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('OWN_DEFERMENT', 'BROKER_DEFERMENT', 'CDS_CASH_ACCOUNT');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "assists_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "border_outlay" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "financing_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "inland_vat_adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "payment_method" "payment_method",
ADD COLUMN     "vat_postponed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "allocated_financing_fee_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "allocated_inland_vat_adjustment_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "assists_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customs_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "use_pva" BOOLEAN NOT NULL DEFAULT false,
    "payment_method" "payment_method" NOT NULL DEFAULT 'BROKER_DEFERMENT',
    "dan_number" TEXT,
    "dan_limit" DECIMAL(14,2),
    "cds_authority_granted" BOOLEAN NOT NULL DEFAULT false,
    "cds_authority_confirmed_at" TIMESTAMP(3),
    "cds_authority_confirmed_by_id" UUID,
    "broker_deferment_fee_pct" DECIMAL(5,2),
    "broker_deferment_minimum_gbp" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customs_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customs_profiles_organization_id_key" ON "customs_profiles"("organization_id");

-- AddForeignKey
ALTER TABLE "customs_profiles" ADD CONSTRAINT "customs_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_profiles" ADD CONSTRAINT "customs_profiles_cds_authority_confirmed_by_id_fkey" FOREIGN KEY ("cds_authority_confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS / CREATE OR REPLACE)
-- ---------------------------------------------------------------------------------------------

-- ---------- customs_profiles: row rules ----------
-- DAN = 7-digit Deferment Approval Number. NOTE: when the §7.3 field-encryption extension lands,
-- dan_number holds ciphertext and this CHECK must be dropped in that migration (validation moves to
-- the zod schema, before encryption). Error messages never echo the value.
ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_dan_number_format;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_dan_number_format
  CHECK (dan_number IS NULL OR dan_number ~ '^[0-9]{7}$');

-- Paying through the importer's own deferment account needs the account number.
ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_own_deferment_needs_dan;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_own_deferment_needs_dan
  CHECK (payment_method <> 'OWN_DEFERMENT' OR dan_number IS NOT NULL);

ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_broker_fee_pct_range;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_broker_fee_pct_range
  CHECK (broker_deferment_fee_pct IS NULL OR (broker_deferment_fee_pct >= 0 AND broker_deferment_fee_pct <= 100));

ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_broker_minimum_nonnegative;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_broker_minimum_nonnegative
  CHECK (broker_deferment_minimum_gbp IS NULL OR broker_deferment_minimum_gbp >= 0);

ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_dan_limit_nonnegative;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_dan_limit_nonnegative
  CHECK (dan_limit IS NULL OR dan_limit >= 0);

-- A granted CDS authority is a user's explicit confirmation; record when it happened.
ALTER TABLE "customs_profiles" DROP CONSTRAINT IF EXISTS customs_profiles_cds_authority_confirmed;
ALTER TABLE "customs_profiles" ADD CONSTRAINT customs_profiles_cds_authority_confirmed
  CHECK (NOT cds_authority_granted OR cds_authority_confirmed_at IS NOT NULL);

-- ---------- customs_profiles: PVA requires VAT registration ----------
-- Postponed VAT accounting is only available to VAT-registered importers. The lookup runs under the
-- caller's RLS (SECURITY INVOKER, the default): the customs_profiles WITH CHECK already requires
-- organization_id = app.current_org and the FK ties the row to that organisation, so the owning
-- organisation is visible whenever the write itself is allowed. If it is NOT visible (no context,
-- wrong context) the lookup yields NULL and the write is rejected: fail closed.
CREATE OR REPLACE FUNCTION customs_profiles_pva_requires_vat() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  eligible boolean;
BEGIN
  IF NOT NEW.use_pva THEN
    RETURN NEW;
  END IF;

  SELECT (o.vat_registered AND o.vat_number IS NOT NULL) INTO eligible
  FROM "organizations" o
  WHERE o.id = NEW.organization_id;

  IF eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'harbour: postponed VAT accounting requires a VAT-registered organisation; % on customs_profiles rejected', TG_OP
      USING HINT = 'Set organizations.vat_registered and vat_number first, or keep use_pva = false.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS customs_profiles_pva_requires_vat ON "customs_profiles";
CREATE TRIGGER customs_profiles_pva_requires_vat
  BEFORE INSERT OR UPDATE ON "customs_profiles"
  FOR EACH ROW EXECUTE FUNCTION customs_profiles_pva_requires_vat();

-- The other half of the same invariant: an organisation cannot drop its VAT registration (or VAT
-- number) while its customs profile still uses PVA. Updating organizations requires
-- app.current_org = id (organizations_tenant), under which that organisation's customs_profiles
-- row is visible.
CREATE OR REPLACE FUNCTION organizations_vat_required_by_pva() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.vat_registered AND NEW.vat_number IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM "customs_profiles" c WHERE c.organization_id = NEW.id AND c.use_pva) THEN
    RAISE EXCEPTION 'harbour: organisation % uses postponed VAT accounting; clearing its VAT registration rejected', NEW.id
      USING HINT = 'Set customs_profiles.use_pva = false first.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS organizations_vat_required_by_pva ON "organizations";
CREATE TRIGGER organizations_vat_required_by_pva
  BEFORE UPDATE OF vat_registered, vat_number ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION organizations_vat_required_by_pva();

-- ---------- customs_profiles: row-level security (same shape as 0002) ----------
ALTER TABLE "customs_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customs_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customs_profiles_tenant ON "customs_profiles";
CREATE POLICY customs_profiles_tenant ON "customs_profiles"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Grants ----------
-- 0002's ALTER DEFAULT PRIVILEGES covers tables created by the same role; grant explicitly anyway
-- so the result does not depend on which role runs the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "customs_profiles" TO harbour_app;
