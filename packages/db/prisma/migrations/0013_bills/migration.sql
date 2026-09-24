-- =============================================================================================
-- 0013_bills  (Phase 1 M8: actual costs as an accounts-payable sub-ledger — ADR-0014)
--
-- Part 1 (generated, verbatim) — produced with
--   prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script
--     * enums vendor_type, bill_type, bill_status, cost_category (one-to-one with the engine's
--       COST_CATEGORIES), unplanned_reason — additive-only rule applies: append values, never
--       rename/remove
--     * bills, bill_lines, bill_payments — tenant tables with a denormalised organization_id and
--       composite FKs: bills (supplier_id, organization_id) → suppliers and
--       (document_id, organization_id) → documents; bill_lines (bill_id, organization_id) → bills
--       ON DELETE CASCADE, (purchase_order_id, organization_id) → purchase_orders ON DELETE RESTRICT
--       and the three-column (purchase_order_item_id, purchase_order_id, organization_id) →
--       purchase_order_items, so a line's item always belongs to the line's order AND tenant;
--       bill_payments (bill_id, organization_id) → bills ON DELETE CASCADE
--     * documents (id, organization_id) and purchase_order_items (id, purchase_order_id,
--       organization_id) unique indexes — targets of the new composite FKs
--
-- Part 2 (hand-written, idempotent) — CHECKs, the reference-per-vendor partial unique indexes,
--   the post/freeze trigger on bills, the frozen-lines trigger, the payments trigger, RLS and grants.
--
-- LEDGER RULES (ADR-0014), enforced by the triggers:
--   * A bill is DRAFT until posted. Posting (DRAFT → POSTED) requires at least one line and lines
--     that add up to total_amount exactly (trigger bills_guard compares sum(bill_lines.amount)).
--   * Once a bill is not DRAFT, only status, paid_at, document_id, notes and updated_at may change
--     (same to_jsonb technique as the accepted-quote and purchase-order triggers, so new columns are
--     protected automatically) and its lines cannot be inserted, updated or deleted. Corrections
--     are credit notes (is_credit_note), never edits.
--   * Transitions: DRAFT → POSTED → PAID, and PAID → POSTED (a payment removed). DELETE only for
--     DRAFT (cascades to its lines and payments).
--   * Payments are recorded on posted (or paid) bills only, never on drafts; a payment row is
--     never updated — delete it and record it again. Exchange rates live on payments
--     (fx_rate = GBP per 1 unit of the bill currency, amount_gbp = what was paid), not on the bill.
--
-- ## Rollback
-- - Reversible: yes (additive). Old code ignores the new tables and the two unique indexes.
-- - Backup snapshot ID: not required
-- - Down steps: re-deploy previous release. To remove physically (destructive once bills exist):
--     DROP TABLE "bill_payments"; DROP TABLE "bill_lines"; DROP TABLE "bills";
--     DROP INDEX IF EXISTS "documents_id_organization_id_key";
--     DROP INDEX IF EXISTS "purchase_order_items_id_purchase_order_id_organization_id_key";
--     DROP FUNCTION IF EXISTS bills_guard(); DROP FUNCTION IF EXISTS bill_lines_frozen();
--     DROP FUNCTION IF EXISTS bill_payments_guard();
--     DROP TYPE "unplanned_reason"; DROP TYPE "cost_category"; DROP TYPE "bill_status";
--     DROP TYPE "bill_type"; DROP TYPE "vendor_type";
-- - Data impact: none on existing rows (new tables; the unique indexes on documents and
--   purchase_order_items are implied by their primary keys and cannot fail on existing data).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "vendor_type" AS ENUM ('SUPPLIER', 'FORWARDER', 'CUSTOMS_BROKER', 'HMRC', 'OTHER');

-- CreateEnum
CREATE TYPE "bill_type" AS ENUM ('SUPPLIER_INVOICE', 'FREIGHT_INVOICE', 'CUSTOMS_CHARGES', 'CUSTOMS_STATEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "bill_status" AS ENUM ('DRAFT', 'POSTED', 'PAID');

-- CreateEnum
CREATE TYPE "cost_category" AS ENUM ('GOODS', 'ASSISTS', 'FREIGHT_TO_BORDER', 'FREIGHT_POST_BORDER', 'ORIGIN_FEES', 'DESTINATION_FEES', 'CLEARANCE', 'INSURANCE', 'DUTY', 'IMPORT_VAT', 'DEFERMENT_FEE', 'UNPLANNED', 'OTHER');

-- CreateEnum
CREATE TYPE "unplanned_reason" AS ENUM ('DEMURRAGE', 'DETENTION', 'STORAGE', 'CUSTOMS_EXAMINATION', 'OTHER');

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "vendor_type" "vendor_type" NOT NULL,
    "supplier_id" UUID,
    "vendor_name" TEXT,
    "bill_type" "bill_type" NOT NULL,
    "reference_number" TEXT NOT NULL,
    "is_credit_note" BOOLEAN NOT NULL DEFAULT false,
    "status" "bill_status" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE,
    "document_id" UUID,
    "notes" TEXT,
    "posted_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "cost_category" "cost_category" NOT NULL,
    "unplanned_reason" "unplanned_reason",
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "fx_rate" DECIMAL(14,6) NOT NULL,
    "amount_gbp" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bills_organization_id_status_idx" ON "bills"("organization_id", "status");

-- CreateIndex
CREATE INDEX "bills_organization_id_supplier_id_idx" ON "bills"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "bills_id_organization_id_key" ON "bills"("id", "organization_id");

-- CreateIndex
CREATE INDEX "bill_lines_organization_id_purchase_order_id_idx" ON "bill_lines"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE INDEX "bill_lines_bill_id_idx" ON "bill_lines"("bill_id");

-- CreateIndex
CREATE INDEX "bill_payments_organization_id_idx" ON "bill_payments"("organization_id");

-- CreateIndex
CREATE INDEX "bill_payments_bill_id_idx" ON "bill_payments"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_organization_id_key" ON "documents"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_id_purchase_order_id_organization_id_key" ON "purchase_order_items"("id", "purchase_order_id", "organization_id");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_document_id_organization_id_fkey" FOREIGN KEY ("document_id", "organization_id") REFERENCES "documents"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_organization_id_fkey" FOREIGN KEY ("bill_id", "organization_id") REFERENCES "bills"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_purchase_order_item_id_purchase_order_id_organi_fkey" FOREIGN KEY ("purchase_order_item_id", "purchase_order_id", "organization_id") REFERENCES "purchase_order_items"("id", "purchase_order_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bill_id_organization_id_fkey" FOREIGN KEY ("bill_id", "organization_id") REFERENCES "bills"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS / CREATE OR REPLACE)
-- ---------------------------------------------------------------------------------------------

-- ---------- bills: row rules ----------
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_currency_format;
ALTER TABLE "bills" ADD CONSTRAINT bills_currency_format
  CHECK (currency ~ '^[A-Z]{3}$');

-- A credit note is flagged, not negative: totals are never negative.
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_total_nonnegative;
ALTER TABLE "bills" ADD CONSTRAINT bills_total_nonnegative
  CHECK (total_amount >= 0);

ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_reference_not_blank;
ALTER TABLE "bills" ADD CONSTRAINT bills_reference_not_blank
  CHECK (btrim(reference_number) <> '');

-- A supplier bill names the supplier row; every other vendor is named in vendor_name.
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_vendor_identified;
ALTER TABLE "bills" ADD CONSTRAINT bills_vendor_identified
  CHECK (
    (vendor_type = 'SUPPLIER' AND supplier_id IS NOT NULL)
    OR (vendor_type <> 'SUPPLIER' AND supplier_id IS NULL AND vendor_name IS NOT NULL AND btrim(vendor_name) <> '')
  );

-- The status and its timestamps agree.
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_status_dates;
ALTER TABLE "bills" ADD CONSTRAINT bills_status_dates
  CHECK (
    (status = 'DRAFT' AND posted_at IS NULL AND paid_at IS NULL)
    OR (status = 'POSTED' AND posted_at IS NOT NULL AND paid_at IS NULL)
    OR (status = 'PAID' AND posted_at IS NOT NULL AND paid_at IS NOT NULL)
  );

ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS bills_due_after_issue;
ALTER TABLE "bills" ADD CONSTRAINT bills_due_after_issue
  CHECK (due_on IS NULL OR due_on >= issued_on);

-- The vendor's reference is unique per vendor within the organisation (the same invoice keyed
-- in twice is refused). Partial unique indexes (Prisma cannot express them): one for supplier
-- bills, one for named vendors (case-insensitive name).
DROP INDEX IF EXISTS bills_one_reference_per_supplier;
CREATE UNIQUE INDEX bills_one_reference_per_supplier
  ON "bills" ("organization_id", "supplier_id", "reference_number") WHERE supplier_id IS NOT NULL;
DROP INDEX IF EXISTS bills_one_reference_per_vendor;
CREATE UNIQUE INDEX bills_one_reference_per_vendor
  ON "bills" ("organization_id", lower("vendor_name"), "reference_number") WHERE supplier_id IS NULL;

-- ---------- bill_lines: row rules ----------
ALTER TABLE "bill_lines" DROP CONSTRAINT IF EXISTS bill_lines_position_nonnegative;
ALTER TABLE "bill_lines" ADD CONSTRAINT bill_lines_position_nonnegative
  CHECK (position >= 0);

ALTER TABLE "bill_lines" DROP CONSTRAINT IF EXISTS bill_lines_description_not_blank;
ALTER TABLE "bill_lines" ADD CONSTRAINT bill_lines_description_not_blank
  CHECK (btrim(description) <> '');

-- An unplanned cost says why (the reason enum has OTHER); every other category has no reason.
ALTER TABLE "bill_lines" DROP CONSTRAINT IF EXISTS bill_lines_unplanned_reason_matches_category;
ALTER TABLE "bill_lines" ADD CONSTRAINT bill_lines_unplanned_reason_matches_category
  CHECK ((cost_category = 'UNPLANNED') = (unplanned_reason IS NOT NULL));

-- ---------- bill_payments: row rules ----------
ALTER TABLE "bill_payments" DROP CONSTRAINT IF EXISTS bill_payments_amounts_positive;
ALTER TABLE "bill_payments" ADD CONSTRAINT bill_payments_amounts_positive
  CHECK (amount > 0 AND fx_rate > 0 AND amount_gbp >= 0);

-- ---------- bills: post, transitions, frozen once posted ----------
-- BEFORE UPDATE OR DELETE. DELETE is allowed for DRAFT only (cascades to lines and payments).
-- DRAFT → POSTED checks the lines add up to the total; POSTED ↔ PAID follows the payments. Once
-- OLD.status <> 'DRAFT' the only columns that may change are status, paid_at, document_id, notes
-- and updated_at. The Prisma no-op update (only updated_at moved) is tolerated.
CREATE OR REPLACE FUNCTION bills_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  changed text;
  move text;
  line_count integer;
  line_sum numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'harbour: bill % is % and cannot be deleted; DELETE rejected', OLD.reference_number, OLD.status
        USING HINT = 'Posted bills are corrected with a credit note.';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status <> OLD.status THEN
    move := OLD.status::text || '>' || NEW.status::text;
    IF NOT (move = ANY (ARRAY['DRAFT>POSTED', 'POSTED>PAID', 'PAID>POSTED'])) THEN
      RAISE EXCEPTION 'harbour: bill % status % -> % is not an allowed transition', OLD.reference_number, OLD.status, NEW.status
        USING HINT = 'DRAFT>POSTED>PAID; PAID>POSTED when a payment is removed.';
    END IF;
    IF move = 'DRAFT>POSTED' THEN
      SELECT count(*), coalesce(sum(amount), 0) INTO line_count, line_sum
      FROM "bill_lines" WHERE bill_id = NEW.id;
      IF line_count = 0 THEN
        RAISE EXCEPTION 'harbour: bill % has no lines and cannot be posted', NEW.reference_number;
      END IF;
      IF line_sum <> NEW.total_amount THEN
        RAISE EXCEPTION 'harbour: bill % lines add up to % but the total is %; cannot be posted', NEW.reference_number, line_sum, NEW.total_amount
          USING HINT = 'Adjust the lines or the total so they agree, then post.';
      END IF;
    END IF;
  END IF;

  IF OLD.status <> 'DRAFT' THEN
    IF (to_jsonb(OLD) - 'status' - 'paid_at' - 'document_id' - 'notes' - 'updated_at')
       <> (to_jsonb(NEW) - 'status' - 'paid_at' - 'document_id' - 'notes' - 'updated_at') THEN
      SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO changed
      FROM jsonb_each(to_jsonb(NEW) - 'status' - 'paid_at' - 'document_id' - 'notes' - 'updated_at') AS n
      WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value;
      RAISE EXCEPTION 'harbour: bill % is % and posted; UPDATE rejected (changed columns: %)', OLD.reference_number, OLD.status, changed
        USING HINT = 'Posted bills are corrected with a credit note.';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bills_guard ON "bills";
CREATE TRIGGER bills_guard
  BEFORE UPDATE OR DELETE ON "bills"
  FOR EACH ROW EXECUTE FUNCTION bills_guard();

-- ---------- bill_lines: frozen once the bill is posted ----------
-- No INSERT/UPDATE/DELETE while the parent is anything but DRAFT. The lookup runs under the
-- caller's RLS context; the composite FK (bill_id, organization_id) guarantees a visible line
-- always has a visible parent. A parent that no longer exists (cascade from a DRAFT's DELETE)
-- yields NULL and is allowed.
CREATE OR REPLACE FUNCTION bill_lines_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  posted_ref text;
  posted_status text;
BEGIN
  SELECT b.reference_number, b.status::text INTO posted_ref, posted_status
  FROM "bills" b
  WHERE b.status <> 'DRAFT'
    AND (
      (TG_OP IN ('UPDATE', 'DELETE') AND b.id = OLD.bill_id)
      OR (TG_OP IN ('INSERT', 'UPDATE') AND b.id = NEW.bill_id)
    )
  LIMIT 1;

  IF posted_ref IS NOT NULL THEN
    RAISE EXCEPTION 'harbour: bill % is % and posted; % on bill_lines rejected', posted_ref, posted_status, TG_OP;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS bill_lines_frozen ON "bill_lines";
CREATE TRIGGER bill_lines_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "bill_lines"
  FOR EACH ROW EXECUTE FUNCTION bill_lines_frozen();

-- ---------- bill_payments: posted bills only, append-only rows ----------
-- INSERT needs a POSTED or PAID parent (a draft has nothing to pay). UPDATE is never allowed:
-- delete the row and record the payment again (the app audits both). DELETE is allowed.
CREATE OR REPLACE FUNCTION bill_payments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_ref text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'harbour: bill payments are append-only; UPDATE rejected'
      USING HINT = 'Delete the payment and record it again.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT b.status::text, b.reference_number INTO parent_status, parent_ref
  FROM "bills" b WHERE b.id = NEW.bill_id;
  IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
    RAISE EXCEPTION 'harbour: bill % is not posted; a payment cannot be recorded against it', coalesce(parent_ref, NEW.bill_id::text)
      USING HINT = 'Post the bill first.';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bill_payments_guard ON "bill_payments";
CREATE TRIGGER bill_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "bill_payments"
  FOR EACH ROW EXECUTE FUNCTION bill_payments_guard();

-- ---------- row-level security (same shape as 0002) ----------
ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bills" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bills_tenant ON "bills";
CREATE POLICY bills_tenant ON "bills"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "bill_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bill_lines_tenant ON "bill_lines";
CREATE POLICY bill_lines_tenant ON "bill_lines"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "bill_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bill_payments_tenant ON "bill_payments";
CREATE POLICY bill_payments_tenant ON "bill_payments"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Grants ----------
-- 0002's ALTER DEFAULT PRIVILEGES covers tables created by the same role; grant explicitly anyway
-- so the result does not depend on which role runs the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bills" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bill_lines" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bill_payments" TO harbour_app;
