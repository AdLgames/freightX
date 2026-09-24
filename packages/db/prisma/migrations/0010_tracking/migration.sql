-- =============================================================================================
-- 0010_tracking  (M9: shipment tracking — ADR-0017)
--
-- Part 1 (generated) — `prisma migrate diff --from-migrations prisma/migrations
--   --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script`.
--   Not idempotent, like 0001/0003/0004: Prisma records it and never re-runs it.
--     * enums container_size_type, vessel_poll_state (additive-only rule applies)
--     * containers (tenant table, composite FK to shipments)
--     * shipments: quote_id becomes NULLABLE (a container can be tracked before any quote exists;
--       the unique index stays — Postgres allows many NULLs), plus reference, master_bill_number,
--       origin/destination_locode, tracking_provider, tracking_request_ref, tracking_subscribed_at
--     * shipment_events: container_id, location_locode/name, latitude/longitude (Decimal(9,6):
--       coordinates, not money), vessel_imo, payload_sha256. The idempotency key moves from
--       (source, provider_event_id) to (organization_id, source, provider_event_id): one provider
--       event fans out to every organisation tracking that container number.
--     * active_vessels, ports (shared, non-tenant)
--
-- Part 2 (hand-written, idempotent) — CHECKs, RLS + the two narrow lookup policies, grants and
--   the Port seed.
--
-- ROLE NOTE (TODO — split app/worker roles). ADR-0017 says the app role reads active_vessels
-- and only the worker writes it. In this repo the worker and the web app connect as the same
-- `harbour_app` member for now, so INSERT/UPDATE on active_vessels is granted to harbour_app.
-- When a `harbour_worker` role exists: REVOKE INSERT, UPDATE ON active_vessels FROM harbour_app
-- and grant them to the worker role, and move the `app.tracking_sweep` policies below to it.
--
-- ## Rollback
-- - Reversible: yes (additive). Re-deploy the previous release: old code ignores the new tables
--   and columns; quote_id NULLs only appear in rows the new code created.
-- - Down steps (physical): DROP TABLE containers, active_vessels, ports; ALTER TABLE
--   shipment_events DROP COLUMN container_id, location_locode, location_name, latitude, longitude,
--   vessel_imo, payload_sha256; ALTER TABLE shipments DROP COLUMN reference, master_bill_number,
--   origin_locode, destination_locode, tracking_provider, tracking_request_ref,
--   tracking_subscribed_at; recreate the (source, provider_event_id) unique index after deleting
--   fan-out duplicates; ALTER TABLE shipments ALTER COLUMN quote_id SET NOT NULL after deleting
--   quote-less shipments; DROP TYPE container_size_type, vessel_poll_state; DROP FUNCTION
--   app_tracking_container(), app_tracking_sweep(). Destructive for tracked shipments — needs a
--   backup snapshot ID.
-- - Data impact: none on existing rows.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "container_size_type" AS ENUM ('C20GP', 'C40GP', 'C40HC', 'C45HC');

-- CreateEnum
CREATE TYPE "vessel_poll_state" AS ENUM ('AT_SEA', 'COASTAL', 'APPROACHING', 'DOCKED', 'STALE');

-- DropIndex
DROP INDEX "shipment_events_source_provider_event_id_key";

-- AlterTable
ALTER TABLE "shipment_events" ADD COLUMN     "container_id" UUID,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "location_locode" TEXT,
ADD COLUMN     "location_name" TEXT,
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "payload_sha256" TEXT,
ADD COLUMN     "vessel_imo" TEXT;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "destination_locode" TEXT,
ADD COLUMN     "master_bill_number" TEXT,
ADD COLUMN     "origin_locode" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "tracking_provider" TEXT,
ADD COLUMN     "tracking_request_ref" TEXT,
ADD COLUMN     "tracking_subscribed_at" TIMESTAMP(3),
ALTER COLUMN "quote_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "containers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "container_number" TEXT NOT NULL,
    "size_type" "container_size_type",
    "vessel_imo" TEXT,
    "vessel_name" TEXT,
    "voyage_number" TEXT,
    "provider_ref" TEXT,
    "last_milestone" TEXT,
    "last_milestone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_vessels" (
    "imo" TEXT NOT NULL,
    "name" TEXT,
    "last_latitude" DECIMAL(9,6),
    "last_longitude" DECIMAL(9,6),
    "speed_knots" DECIMAL(5,1),
    "heading_deg" DECIMAL(5,1),
    "position_at" TIMESTAMP(3),
    "position_source" TEXT,
    "provider_eta_at" TIMESTAMP(3),
    "destination_locode" TEXT,
    "poll_state" "vessel_poll_state" NOT NULL DEFAULT 'AT_SEA',
    "next_poll_at" TIMESTAMP(3),
    "last_error" TEXT,
    "active_container_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "active_vessels_pkey" PRIMARY KEY ("imo")
);

-- CreateTable
CREATE TABLE "ports" (
    "locode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "choke_point" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ports_pkey" PRIMARY KEY ("locode")
);

-- CreateIndex
CREATE INDEX "containers_organization_id_idx" ON "containers"("organization_id");

-- CreateIndex
CREATE INDEX "containers_container_number_idx" ON "containers"("container_number");

-- CreateIndex
CREATE INDEX "containers_shipment_id_idx" ON "containers"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "containers_organization_id_container_number_shipment_id_key" ON "containers"("organization_id", "container_number", "shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "containers_id_organization_id_key" ON "containers"("id", "organization_id");

-- CreateIndex
CREATE INDEX "active_vessels_next_poll_at_poll_state_idx" ON "active_vessels"("next_poll_at", "poll_state");

-- CreateIndex
CREATE INDEX "shipment_events_container_id_idx" ON "shipment_events"("container_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_organization_id_source_provider_event_id_key" ON "shipment_events"("organization_id", "source", "provider_event_id");

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_container_id_organization_id_fkey" FOREIGN KEY ("container_id", "organization_id") REFERENCES "containers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "containers" ADD CONSTRAINT "containers_shipment_id_organization_id_fkey" FOREIGN KEY ("shipment_id", "organization_id") REFERENCES "shipments"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written, idempotent
-- ---------------------------------------------------------------------------------------------

-- ---------- Format / sanity CHECKs (the check digits themselves are validated in code) ----------
ALTER TABLE "containers" DROP CONSTRAINT IF EXISTS containers_container_number_format;
ALTER TABLE "containers" ADD CONSTRAINT containers_container_number_format
  CHECK (container_number ~ '^[A-Z]{4}[0-9]{7}$');
ALTER TABLE "containers" DROP CONSTRAINT IF EXISTS containers_vessel_imo_format;
ALTER TABLE "containers" ADD CONSTRAINT containers_vessel_imo_format
  CHECK (vessel_imo IS NULL OR vessel_imo ~ '^[0-9]{7}$');

ALTER TABLE "active_vessels" DROP CONSTRAINT IF EXISTS active_vessels_imo_format;
ALTER TABLE "active_vessels" ADD CONSTRAINT active_vessels_imo_format
  CHECK (imo ~ '^[0-9]{7}$');
ALTER TABLE "active_vessels" DROP CONSTRAINT IF EXISTS active_vessels_count_non_negative;
ALTER TABLE "active_vessels" ADD CONSTRAINT active_vessels_count_non_negative
  CHECK (active_container_count >= 0);
ALTER TABLE "active_vessels" DROP CONSTRAINT IF EXISTS active_vessels_position_range;
ALTER TABLE "active_vessels" ADD CONSTRAINT active_vessels_position_range
  CHECK (
    (last_latitude IS NULL OR (last_latitude >= -90 AND last_latitude <= 90))
    AND (last_longitude IS NULL OR (last_longitude >= -180 AND last_longitude <= 180))
    AND (speed_knots IS NULL OR speed_knots >= 0)
    AND (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360))
  );

ALTER TABLE "ports" DROP CONSTRAINT IF EXISTS ports_locode_format;
ALTER TABLE "ports" ADD CONSTRAINT ports_locode_format
  CHECK (locode ~ '^[A-Z]{2}[A-Z0-9]{3}$');
ALTER TABLE "ports" DROP CONSTRAINT IF EXISTS ports_position_range;
ALTER TABLE "ports" ADD CONSTRAINT ports_position_range
  CHECK (latitude >= -90 AND latitude <= 90 AND longitude >= -180 AND longitude <= 180);

ALTER TABLE "shipment_events" DROP CONSTRAINT IF EXISTS shipment_events_position_range;
ALTER TABLE "shipment_events" ADD CONSTRAINT shipment_events_position_range
  CHECK (
    (latitude IS NULL OR (latitude >= -90 AND latitude <= 90))
    AND (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
  );

ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS shipments_locode_format;
ALTER TABLE "shipments" ADD CONSTRAINT shipments_locode_format
  CHECK (
    (origin_locode IS NULL OR origin_locode ~ '^[A-Z]{2}[A-Z0-9]{3}$')
    AND (destination_locode IS NULL OR destination_locode ~ '^[A-Z]{2}[A-Z0-9]{3}$')
  );

-- ---------- Row-level security: containers (tenant table) ----------
ALTER TABLE "containers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "containers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS containers_tenant ON "containers";
CREATE POLICY containers_tenant ON "containers"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Narrow cross-tenant reads for the webhook processor and the poll sweep ----------
-- A provider webhook names a container NUMBER, not an organisation. The processor must find
-- every organisation tracking that number and then work per organisation under the normal
-- tenant context (ADR-0017; packages/db src/tracking.ts `withTrackingLookup`). This policy
-- exposes ONLY container rows whose number equals the transaction-local setting
-- `app.tracking_container` — no setting, nothing extra is visible. It is not a bypass: it
-- cannot enumerate containers, and it reveals no other table.
CREATE OR REPLACE FUNCTION app_tracking_container() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tracking_container', true), '')
$$;
DROP POLICY IF EXISTS containers_tracking_lookup ON "containers";
CREATE POLICY containers_tracking_lookup ON "containers" FOR SELECT
  USING (app_tracking_container() IS NOT NULL AND container_number = app_tracking_container());

-- The 6-hourly milestone fallback (brief §6.4) lists shipments with a provider subscription and
-- no event in 24 h across organisations. Gated by `app.tracking_sweep = 'on'`, set only by the
-- worker's sweep transaction (packages/db src/tracking.ts `withTrackingSweep`), and limited to
-- subscribed shipments and their events. TODO(role split): move these two policies to the
-- worker role (`TO harbour_worker`) once it exists; see the ROLE NOTE above.
CREATE OR REPLACE FUNCTION app_tracking_sweep() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT current_setting('app.tracking_sweep', true) = 'on'
$$;
DROP POLICY IF EXISTS shipments_tracking_sweep ON "shipments";
CREATE POLICY shipments_tracking_sweep ON "shipments" FOR SELECT
  USING (app_tracking_sweep() AND tracking_request_ref IS NOT NULL);
DROP POLICY IF EXISTS shipment_events_tracking_sweep ON "shipment_events";
CREATE POLICY shipment_events_tracking_sweep ON "shipment_events" FOR SELECT
  USING (app_tracking_sweep());

-- ---------- Grants ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "containers" TO harbour_app;
-- ports is reference data: read-only for the app; seeded here, maintained by migrations.
GRANT SELECT ON TABLE "ports" TO harbour_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE "ports" FROM harbour_app;
-- active_vessels: SELECT for the app; INSERT/UPDATE for the worker. Same role for now (ROLE NOTE).
GRANT SELECT, INSERT, UPDATE ON TABLE "active_vessels" TO harbour_app;
REVOKE DELETE ON TABLE "active_vessels" FROM harbour_app;
-- shipment_events stays append-only (0002 REVOKE + trigger); the new columns inherit that.

-- ---------- Port seed ----------
-- Approximate coordinates (about ±0.01°, port centre or terminal), for distance calculations and
-- display only — never for navigation. choke_point marks hubs where polling tightens (COASTAL).
INSERT INTO "ports" (locode, name, country_code, latitude, longitude, choke_point) VALUES
  ('CNSHA', 'Shanghai',                'CN', 31.230000, 121.490000, false),
  ('CNNGB', 'Ningbo',                  'CN', 29.870000, 121.550000, false),
  ('CNSZX', 'Shenzhen (Yantian)',      'CN', 22.500000, 113.900000, false),
  ('CNPVG', 'Shanghai Pudong (air)',   'CN', 31.140000, 121.810000, false),
  ('INNSA', 'Nhava Sheva (Mumbai)',    'IN', 18.950000,  72.950000, false),
  ('INBOM', 'Mumbai',                  'IN', 18.940000,  72.840000, false),
  ('TRIST', 'Istanbul',                'TR', 41.000000,  28.950000, false),
  ('GBFXT', 'Felixstowe',              'GB', 51.950000,   1.350000, false),
  ('GBSOU', 'Southampton',             'GB', 50.900000,  -1.400000, false),
  ('GBLGP', 'London Gateway',          'GB', 51.500000,   0.450000, false),
  ('GBLHR', 'London Heathrow (air)',   'GB', 51.470000,  -0.460000, false),
  ('SGSIN', 'Singapore',               'SG',  1.260000, 103.850000, true),
  ('MYPKG', 'Port Klang',              'MY',  3.000000, 101.350000, true),
  ('LKCMB', 'Colombo',                 'LK',  6.950000,  79.850000, true),
  ('AEJEA', 'Jebel Ali',               'AE', 25.000000,  55.060000, true),
  ('EGSUZ', 'Suez',                    'EG', 29.970000,  32.550000, true),
  ('EGPSD', 'Port Said',               'EG', 31.260000,  32.300000, true),
  ('NLRTM', 'Rotterdam',               'NL', 51.950000,   4.050000, true),
  ('BEANR', 'Antwerp',                 'BE', 51.300000,   4.300000, true),
  ('DEHAM', 'Hamburg',                 'DE', 53.550000,   9.950000, true)
ON CONFLICT (locode) DO NOTHING;
