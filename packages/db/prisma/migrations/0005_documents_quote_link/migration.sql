-- 0005_documents_quote_link (Phase 1 M5: document vault)
--
-- Part 1 was generated with
--   prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma
--     --shadow-database-url <shadow> --script
-- and then edited in ONE place: the NOT NULL `scope` column is added with a temporary default and
-- backfilled from shipment_id, so the migration also applies to a documents table that already has
-- rows (none is expected: no code created documents before M5). Part 2 is hand-written.
--
-- Additive only: new enum values, new nullable columns, one new NOT NULL column with a backfill, a
-- new index, a new FK and CHECK constraints that hold for every row an older release can write.
--
-- ## Rollback
-- - Reversible: yes
-- - Backup snapshot ID: not required (additive)
-- - Down steps: re-deploy the previous release; it ignores the new columns. To remove them:
--     ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_scope_target",
--       DROP CONSTRAINT IF EXISTS "documents_rejected_reason_status",
--       DROP CONSTRAINT IF EXISTS "documents_scan_engine_known",
--       DROP CONSTRAINT IF EXISTS "documents_clean_requires_scanner",
--       DROP CONSTRAINT IF EXISTS "documents_size_bytes_limit",
--       DROP CONSTRAINT IF EXISTS "documents_version_positive",
--       DROP CONSTRAINT IF EXISTS "documents_quote_id_organization_id_fkey";
--     DROP INDEX IF EXISTS "documents_organization_id_quote_id_idx";
--     ALTER TABLE "documents" DROP COLUMN "deleted_at", DROP COLUMN "quote_id", DROP COLUMN "rejected_reason",
--       DROP COLUMN "scan_engine", DROP COLUMN "scan_result", DROP COLUMN "scanned_at", DROP COLUMN "scope";
--     DROP TYPE "document_scope";
--   Enum values added to document_type cannot be removed (Postgres); they are harmless to old code.
-- - Data impact: documents rows gain columns; no rows are deleted or rewritten except the backfill
--   of `scope` (SHIPMENT when shipment_id is set, else ORGANISATION).

-- ======================================================================================
-- Part 1: generated DDL (edited: `scope` default + backfill)
-- ======================================================================================

-- CreateEnum
CREATE TYPE "document_scope" AS ENUM ('SHIPMENT', 'QUOTE', 'ORGANISATION');

-- AlterEnum (additive; Postgres 16 accepts several ADD VALUE statements in one migration)
ALTER TYPE "document_type" ADD VALUE 'EORI_CONFIRMATION';
ALTER TYPE "document_type" ADD VALUE 'VAT_CERTIFICATE';
ALTER TYPE "document_type" ADD VALUE 'REPRESENTATION_AUTHORITY';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "quote_id" UUID,
ADD COLUMN     "rejected_reason" TEXT,
ADD COLUMN     "scan_engine" TEXT,
ADD COLUMN     "scan_result" TEXT,
ADD COLUMN     "scanned_at" TIMESTAMP(3),
ADD COLUMN     "scope" "document_scope" NOT NULL DEFAULT 'ORGANISATION';

-- Backfill for any pre-existing rows (expected: none), then drop the temporary default so the
-- application must always say what a document is attached to.
UPDATE "documents" SET "scope" = 'SHIPMENT' WHERE "shipment_id" IS NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "scope" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "documents_organization_id_quote_id_idx" ON "documents"("organization_id", "quote_id");

-- AddForeignKey (composite: a document can only point at its own tenant's quote; RESTRICT so a
-- quote with documents cannot be deleted from under them)
ALTER TABLE "documents" ADD CONSTRAINT "documents_quote_id_organization_id_fkey" FOREIGN KEY ("quote_id", "organization_id") REFERENCES "quotes"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================
-- Part 2: hand-written rules (idempotent)
-- ======================================================================================

-- The scope must agree with the target columns (§7.4 keys are per target).
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_scope_target";
ALTER TABLE "documents" ADD CONSTRAINT "documents_scope_target" CHECK (
  ("scope" = 'SHIPMENT'     AND "shipment_id" IS NOT NULL) OR
  ("scope" = 'QUOTE'        AND "quote_id" IS NOT NULL AND "shipment_id" IS NULL) OR
  ("scope" = 'ORGANISATION' AND "quote_id" IS NULL AND "shipment_id" IS NULL)
);

-- A rejected document always says why, and only a rejected document carries a reason.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_rejected_reason_status";
ALTER TABLE "documents" ADD CONSTRAINT "documents_rejected_reason_status" CHECK (
  ("status" = 'REJECTED') = ("rejected_reason" IS NOT NULL)
);

-- Only known scan engines; 'none' means "not a virus scan" and never accompanies CLEAN/VERIFIED.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_scan_engine_known";
ALTER TABLE "documents" ADD CONSTRAINT "documents_scan_engine_known" CHECK (
  "scan_engine" IS NULL OR "scan_engine" IN ('clamav', 'none')
);
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_clean_requires_scanner";
ALTER TABLE "documents" ADD CONSTRAINT "documents_clean_requires_scanner" CHECK (
  "status" NOT IN ('CLEAN', 'VERIFIED') OR "scan_engine" = 'clamav'
);

-- §7.4: 25 MB limit, enforced here as well as on the presign.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_size_bytes_limit";
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_bytes_limit" CHECK (
  "size_bytes" >= 0 AND "size_bytes" <= 26214400
);

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_version_positive";
ALTER TABLE "documents" ADD CONSTRAINT "documents_version_positive" CHECK ("version" >= 1);
