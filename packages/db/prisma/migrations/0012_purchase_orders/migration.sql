-- =============================================================================================
-- 0012_purchase_orders  (Phase 1 M7: purchase orders — ADR-0013)
--
-- Part 1 (generated, verbatim) — produced with
--   prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script
--     * enum purchase_order_status (additive-only rule applies: append values, never rename/remove)
--     * purchase_orders, purchase_order_items, po_counters — tenant tables with a denormalised
--       organization_id and composite FKs: (supplier_id, organization_id) → suppliers,
--       (pickup_location_id, supplier_id, organization_id) → pickup_locations (so a PO's pickup
--       location always belongs to the PO's supplier AND tenant), items → (purchase_order_id,
--       organization_id) and (product_id, organization_id)
--     * quotes.purchase_order_id (nullable) + composite FK → purchase_orders, ON DELETE RESTRICT
--       (a PO with quotes is cancelled, never deleted), index (organization_id, purchase_order_id)
--     * pickup_locations (id, supplier_id, organization_id) unique index — target of the 3-column FK
--
-- Part 2 (hand-written, idempotent) — CHECKs, the one-ACCEPTED-quote-per-PO partial unique index,
--   the freeze/transition trigger on purchase_orders, the frozen-items trigger, RLS and grants.
--
-- PO NUMBERING
--   `po_number` is `PO-<year>-<NNN>` (NNN zero-padded to at least 3 digits, unbounded above), unique
--   per organisation. Numbers come from po_counters (one row per organisation and year, `next` = the
--   next NNN). apps/web services/orders/orders.server.ts allocates one INSIDE the create transaction:
--
--       INSERT INTO po_counters (id, organization_id, year, next) VALUES (gen_random_uuid(), $1, $2, 2)
--       ON CONFLICT (organization_id, year) DO UPDATE SET next = po_counters.next + 1
--       RETURNING next - 1
--
--   The upsert takes a row lock, so two concurrent creates serialise and get distinct numbers; the
--   number is consumed even if the transaction later rolls back (gaps are acceptable, duplicates are
--   not). The year is the UTC year of creation.
--
-- TRANSITIONS (ADR-0013), enforced by trigger purchase_orders_guard:
--   DRAFT→ISSUED→IN_PRODUCTION→READY_TO_SHIP→SHIPPED→CLOSED, ISSUED→READY_TO_SHIP (production may
--   be skipped), and any status except CLOSED/CANCELLED → CANCELLED. Nothing leaves CLOSED or
--   CANCELLED. Once a PO is not DRAFT, only status, deposit_due_at, deposit_paid_at,
--   balance_due_at, balance_paid_at, notes and updated_at may change (same to_jsonb technique as
--   the accepted-quote trigger in 0002, so new columns are protected automatically) and its items
--   cannot be inserted, updated or deleted. Payment is NOT a status: the deposit/balance amounts
--   are computed from the supplier's payment terms when the PO is issued and are frozen with it.
--
-- ## Rollback
-- - Reversible: yes (additive). Old code ignores the new tables and the nullable column.
-- - Backup snapshot ID: not required
-- - Down steps: re-deploy previous release. To remove physically (destructive once POs exist):
--     DROP INDEX IF EXISTS quotes_one_accepted_per_po;
--     ALTER TABLE "quotes" DROP COLUMN "purchase_order_id";
--     DROP TABLE "purchase_order_items"; DROP TABLE "purchase_orders"; DROP TABLE "po_counters";
--     DROP INDEX IF EXISTS "pickup_locations_id_supplier_id_organization_id_key";
--     DROP FUNCTION IF EXISTS purchase_orders_guard(); DROP FUNCTION IF EXISTS purchase_order_items_frozen();
--     DROP TYPE "purchase_order_status";
-- - Data impact: none on existing rows (new tables; quotes gain a NULL column, which is DDL and does
--   not fire the accepted-quote trigger — see 0003/0011 for the same reasoning).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'ISSUED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "purchase_order_id" UUID;

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "po_number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "pickup_location_id" UUID,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "incoterm" "incoterm" NOT NULL,
    "total_goods_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deposit_pct" DECIMAL(5,2),
    "deposit_amount" DECIMAL(14,2),
    "deposit_due_at" TIMESTAMP(3),
    "deposit_paid_at" TIMESTAMP(3),
    "balance_amount" DECIMAL(14,2),
    "balance_trigger" "balance_trigger",
    "balance_due_at" TIMESTAMP(3),
    "balance_paid_at" TIMESTAMP(3),
    "expected_ship_month" DATE,
    "issued_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_counters" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "po_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_status_idx" ON "purchase_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_po_number_key" ON "purchase_orders"("organization_id", "po_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_id_organization_id_key" ON "purchase_orders"("id", "organization_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_organization_id_idx" ON "purchase_order_items"("organization_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_counters_organization_id_year_key" ON "po_counters"("organization_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_locations_id_supplier_id_organization_id_key" ON "pickup_locations"("id", "supplier_id", "organization_id");

-- CreateIndex
CREATE INDEX "quotes_organization_id_purchase_order_id_idx" ON "quotes"("organization_id", "purchase_order_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_pickup_location_id_supplier_id_organizatio_fkey" FOREIGN KEY ("pickup_location_id", "supplier_id", "organization_id") REFERENCES "pickup_locations"("id", "supplier_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_organization_id_fkey" FOREIGN KEY ("product_id", "organization_id") REFERENCES "products"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_counters" ADD CONSTRAINT "po_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS / CREATE OR REPLACE)
-- ---------------------------------------------------------------------------------------------

-- ---------- purchase_orders: row rules ----------
ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_po_number_format;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_po_number_format
  CHECK (po_number ~ '^PO-[0-9]{4}-[0-9]{3,}$');

ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_currency_format;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_currency_format
  CHECK (currency ~ '^[A-Z]{3}$');

-- Percent convention ("30.00" = 30%), so 0–100 inclusive.
ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_deposit_pct_range;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_deposit_pct_range
  CHECK (deposit_pct IS NULL OR (deposit_pct >= 0 AND deposit_pct <= 100));

ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_amounts_nonnegative;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_amounts_nonnegative
  CHECK (total_goods_value >= 0
    AND (deposit_amount IS NULL OR deposit_amount >= 0)
    AND (balance_amount IS NULL OR balance_amount >= 0));

-- Deposit + balance is the goods total (both are set together on issue).
ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_split_adds_up;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_split_adds_up
  CHECK (deposit_amount IS NULL OR balance_amount IS NULL OR deposit_amount + balance_amount = total_goods_value);

-- An issued (or later) PO records when it was issued; a cancelled draft has no issue date.
ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_issued_has_issued_at;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_issued_has_issued_at
  CHECK (status IN ('DRAFT', 'CANCELLED') OR issued_at IS NOT NULL);

-- The expected ship month names an HMRC rate month: always the first of the month.
ALTER TABLE "purchase_orders" DROP CONSTRAINT IF EXISTS purchase_orders_expected_ship_month_first_day;
ALTER TABLE "purchase_orders" ADD CONSTRAINT purchase_orders_expected_ship_month_first_day
  CHECK (expected_ship_month IS NULL OR EXTRACT(DAY FROM expected_ship_month) = 1);

-- ---------- purchase_order_items: row rules ----------
ALTER TABLE "purchase_order_items" DROP CONSTRAINT IF EXISTS purchase_order_items_quantity_positive;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT purchase_order_items_quantity_positive
  CHECK (quantity > 0);

ALTER TABLE "purchase_order_items" DROP CONSTRAINT IF EXISTS purchase_order_items_money_nonnegative;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT purchase_order_items_money_nonnegative
  CHECK (unit_cost >= 0 AND line_total >= 0);

ALTER TABLE "purchase_order_items" DROP CONSTRAINT IF EXISTS purchase_order_items_position_nonnegative;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT purchase_order_items_position_nonnegative
  CHECK (position >= 0);

-- ---------- po_counters: row rules ----------
ALTER TABLE "po_counters" DROP CONSTRAINT IF EXISTS po_counters_next_positive;
ALTER TABLE "po_counters" ADD CONSTRAINT po_counters_next_positive
  CHECK (next >= 1);

ALTER TABLE "po_counters" DROP CONSTRAINT IF EXISTS po_counters_year_range;
ALTER TABLE "po_counters" ADD CONSTRAINT po_counters_year_range
  CHECK (year >= 2000 AND year <= 9999);

-- ---------- quotes: at most one ACCEPTED quote per purchase order (ADR-0013) ----------
-- Partial unique index (Prisma cannot express it). Quotes without a PO (NULL) never collide.
DROP INDEX IF EXISTS quotes_one_accepted_per_po;
CREATE UNIQUE INDEX quotes_one_accepted_per_po
  ON "quotes" ("purchase_order_id") WHERE status = 'ACCEPTED';

-- ---------- purchase_orders: transitions + frozen once issued ----------
-- BEFORE UPDATE OR DELETE. DELETE is allowed for DRAFT only (cascades to items). A status change is
-- checked against the ADR-0013 table. Once OLD.status <> 'DRAFT' the only columns that may change
-- are status, the four payment dates, notes and updated_at (the to_jsonb comparison strips exactly
-- those, so every other column — present or future — is protected). The Prisma no-op update (only
-- updated_at moved) is tolerated.
CREATE OR REPLACE FUNCTION purchase_orders_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  changed text;
  move text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'harbour: purchase order % is % and cannot be deleted; DELETE rejected', OLD.po_number, OLD.status
        USING HINT = 'Set status to CANCELLED instead.';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status <> OLD.status THEN
    move := OLD.status::text || '>' || NEW.status::text;
    IF NOT (
      move = ANY (ARRAY[
        'DRAFT>ISSUED',
        'ISSUED>IN_PRODUCTION',
        'ISSUED>READY_TO_SHIP',
        'IN_PRODUCTION>READY_TO_SHIP',
        'READY_TO_SHIP>SHIPPED',
        'SHIPPED>CLOSED'
      ])
      OR (NEW.status = 'CANCELLED' AND OLD.status NOT IN ('CLOSED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'harbour: purchase order % status % -> % is not an allowed transition', OLD.po_number, OLD.status, NEW.status
        USING HINT = 'DRAFT>ISSUED>IN_PRODUCTION>READY_TO_SHIP>SHIPPED>CLOSED (IN_PRODUCTION may be skipped); anything but CLOSED/CANCELLED may be CANCELLED.';
    END IF;
  END IF;

  IF OLD.status <> 'DRAFT' THEN
    IF (to_jsonb(OLD) - 'status' - 'deposit_due_at' - 'deposit_paid_at' - 'balance_due_at' - 'balance_paid_at' - 'notes' - 'updated_at')
       <> (to_jsonb(NEW) - 'status' - 'deposit_due_at' - 'deposit_paid_at' - 'balance_due_at' - 'balance_paid_at' - 'notes' - 'updated_at') THEN
      SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO changed
      FROM jsonb_each(to_jsonb(NEW) - 'status' - 'deposit_due_at' - 'deposit_paid_at' - 'balance_due_at' - 'balance_paid_at' - 'notes' - 'updated_at') AS n
      WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value;
      RAISE EXCEPTION 'harbour: purchase order % is % and frozen; UPDATE rejected (changed columns: %)', OLD.po_number, OLD.status, changed
        USING HINT = 'Only status, the payment dates and notes may change on an issued purchase order.';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS purchase_orders_guard ON "purchase_orders";
CREATE TRIGGER purchase_orders_guard
  BEFORE UPDATE OR DELETE ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();

-- ---------- purchase_order_items: frozen once the PO is not DRAFT ----------
-- No INSERT/UPDATE/DELETE while the parent is anything but DRAFT. The lookup runs under the
-- caller's RLS context; the composite FK (purchase_order_id, organization_id) guarantees a visible
-- item always has a visible parent, so a hidden parent can never read as "still a draft". A parent
-- that no longer exists (cascade from a DRAFT's DELETE) yields NULL and is allowed.
CREATE OR REPLACE FUNCTION purchase_order_items_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  frozen_po text;
  frozen_status text;
BEGIN
  SELECT po.po_number, po.status::text INTO frozen_po, frozen_status
  FROM "purchase_orders" po
  WHERE po.status <> 'DRAFT'
    AND (
      (TG_OP IN ('UPDATE', 'DELETE') AND po.id = OLD.purchase_order_id)
      OR (TG_OP IN ('INSERT', 'UPDATE') AND po.id = NEW.purchase_order_id)
    )
  LIMIT 1;

  IF frozen_po IS NOT NULL THEN
    RAISE EXCEPTION 'harbour: purchase order % is % and frozen; % on purchase_order_items rejected', frozen_po, frozen_status, TG_OP;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS purchase_order_items_frozen ON "purchase_order_items";
CREATE TRIGGER purchase_order_items_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_items"
  FOR EACH ROW EXECUTE FUNCTION purchase_order_items_frozen();

-- ---------- row-level security (same shape as 0002) ----------
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_orders_tenant ON "purchase_orders";
CREATE POLICY purchase_orders_tenant ON "purchase_orders"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_order_items_tenant ON "purchase_order_items";
CREATE POLICY purchase_order_items_tenant ON "purchase_order_items"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "po_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "po_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_counters_tenant ON "po_counters";
CREATE POLICY po_counters_tenant ON "po_counters"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Grants ----------
-- 0002's ALTER DEFAULT PRIVILEGES covers tables created by the same role; grant explicitly anyway
-- so the result does not depend on which role runs the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "purchase_orders" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "purchase_order_items" TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "po_counters" TO harbour_app;
