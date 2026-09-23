-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "plan" AS ENUM ('FREE', 'STARTER', 'PRO');

-- CreateEnum
CREATE TYPE "quote_status" AS ENUM ('DRAFT', 'INDICATIVE', 'READY', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "incoterm" AS ENUM ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP');

-- CreateEnum
CREATE TYPE "mode" AS ENUM ('SEA_LCL', 'SEA_FCL', 'AIR', 'ROAD', 'RAIL');

-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('PENDING_DOCS', 'PENDING_BOOKING', 'BOOKED', 'DISPATCHED', 'IN_TRANSIT', 'AT_DESTINATION', 'CUSTOMS', 'CLEARED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('COMMERCIAL_INVOICE', 'PACKING_LIST', 'BILL_OF_LADING', 'AIRWAY_BILL', 'CERTIFICATE_OF_ORIGIN', 'INSURANCE_CERT', 'OTHER');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('UPLOADED', 'SCANNING', 'CLEAN', 'REJECTED', 'VERIFIED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "eori_number" TEXT,
    "vat_number" TEXT,
    "vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "base_currency" TEXT NOT NULL DEFAULT 'GBP',
    "plan" "plan" NOT NULL DEFAULT 'FREE',
    "stripe_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "role" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "magic_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_signups" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "default_incoterm" "incoterm",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hs_code" TEXT NOT NULL,
    "hs_code_verified_at" TIMESTAMP(3),
    "origin_country" TEXT NOT NULL,
    "unit_value" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "weight_kg" DECIMAL(10,3) NOT NULL,
    "volume_cbm" DECIMAL(10,4) NOT NULL,
    "units_per_carton" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "quote_status" NOT NULL DEFAULT 'DRAFT',
    "incoterm" "incoterm" NOT NULL,
    "mode" "mode" NOT NULL,
    "origin_country" TEXT NOT NULL,
    "origin_port" TEXT,
    "destination_port" TEXT,
    "delivery_postcode" TEXT,
    "fx_rate" DECIMAL(14,6) NOT NULL,
    "fx_source" TEXT NOT NULL,
    "fx_date" TIMESTAMP(3) NOT NULL,
    "fx_snapshots" JSONB NOT NULL,
    "rate_source" TEXT NOT NULL,
    "rate_fetched_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "goods_value_gbp" DECIMAL(14,2) NOT NULL,
    "freight_cost" DECIMAL(14,2) NOT NULL,
    "freight_to_border_gbp" DECIMAL(14,2) NOT NULL,
    "freight_post_border_gbp" DECIMAL(14,2) NOT NULL,
    "origin_fees" DECIMAL(14,2) NOT NULL,
    "destination_fees" DECIMAL(14,2) NOT NULL,
    "insurance_premium" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "customs_value" DECIMAL(14,2) NOT NULL,
    "total_duty" DECIMAL(14,2) NOT NULL,
    "total_vat" DECIMAL(14,2) NOT NULL,
    "vat_recoverable" BOOLEAN NOT NULL,
    "platform_fee" DECIMAL(14,2) NOT NULL,
    "total_landed_cost" DECIMAL(14,2) NOT NULL,
    "total_landed_cost_ex_vat" DECIMAL(14,2) NOT NULL,
    "supplier_borne_duty" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supplier_borne_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "apportionment_basis" TEXT NOT NULL,
    "warnings" JSONB NOT NULL,
    "calc_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "hs_code" TEXT NOT NULL,
    "origin_country" TEXT NOT NULL,
    "unit_value" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "unit_value_gbp" DECIMAL(14,4) NOT NULL,
    "line_goods_value_gbp" DECIMAL(14,2) NOT NULL,
    "line_weight_kg" DECIMAL(10,3) NOT NULL,
    "line_volume_cbm" DECIMAL(10,4) NOT NULL,
    "chargeable_weight" DECIMAL(14,4) NOT NULL,
    "tariff_measure_id" TEXT,
    "duty_type" TEXT NOT NULL,
    "duty_rate_pct" DECIMAL(7,4),
    "duty_specific" JSONB,
    "preference_claimed" BOOLEAN NOT NULL DEFAULT false,
    "add_rate_pct" DECIMAL(7,4),
    "vat_rate_pct" DECIMAL(5,2) NOT NULL,
    "allocated_freight_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_freight_to_border_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_freight_post_border_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_origin_fees_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_destination_fees_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_insurance_gbp" DECIMAL(14,2) NOT NULL,
    "allocated_platform_fee_gbp" DECIMAL(14,2) NOT NULL,
    "line_customs_value_gbp" DECIMAL(14,2) NOT NULL,
    "line_duty_gbp" DECIMAL(14,2) NOT NULL,
    "line_vat_gbp" DECIMAL(14,2) NOT NULL,
    "supplier_borne_duty_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supplier_borne_vat_gbp" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_landed_cost_ex_vat_gbp" DECIMAL(14,2) NOT NULL,
    "line_landed_cost_gbp" DECIMAL(14,2) NOT NULL,
    "landed_cost_per_unit" DECIMAL(14,4) NOT NULL,
    "landed_cost_per_unit_inc_vat" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "status" "shipment_status" NOT NULL DEFAULT 'PENDING_DOCS',
    "forwarder_id" TEXT,
    "forwarder_ref" TEXT,
    "container_no" TEXT,
    "vessel_or_flight" TEXT,
    "etd" TIMESTAMP(3),
    "eta" TIMESTAMP(3),
    "atd" TIMESTAMP(3),
    "ata" TIMESTAMP(3),
    "booking_idempotency_key" TEXT,
    "last_polled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "provider_event_id" TEXT,
    "event_type" TEXT NOT NULL,
    "status_after" "shipment_status",
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID,
    "type" "document_type" NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'UPLOADED',
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by_id" UUID NOT NULL,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_cache" (
    "hs_code" TEXT NOT NULL,
    "origin_country" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "tariff_cache_pkey" PRIMARY KEY ("hs_code","origin_country")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate_to_gbp" DECIMAL(14,6) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_stripe_customer_id_key" ON "organizations"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_organization_id_idx" ON "memberships"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_tokens_token_hash_key" ON "magic_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "magic_link_tokens_email_created_at_idx" ON "magic_link_tokens"("email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_signups_email_key" ON "email_signups"("email");

-- CreateIndex
CREATE INDEX "suppliers_organization_id_idx" ON "suppliers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_id_organization_id_key" ON "suppliers"("id", "organization_id");

-- CreateIndex
CREATE INDEX "products_organization_id_idx" ON "products"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_sku_key" ON "products"("organization_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_id_organization_id_key" ON "products"("id", "organization_id");

-- CreateIndex
CREATE INDEX "quotes_organization_id_status_idx" ON "quotes"("organization_id", "status");

-- CreateIndex
CREATE INDEX "quotes_organization_id_valid_until_idx" ON "quotes"("organization_id", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_id_organization_id_key" ON "quotes"("id", "organization_id");

-- CreateIndex
CREATE INDEX "quote_lines_organization_id_idx" ON "quote_lines"("organization_id");

-- CreateIndex
CREATE INDEX "quote_lines_quote_id_idx" ON "quote_lines"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_quote_id_key" ON "shipments"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_booking_idempotency_key_key" ON "shipments"("booking_idempotency_key");

-- CreateIndex
CREATE INDEX "shipments_organization_id_status_idx" ON "shipments"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_id_organization_id_key" ON "shipments"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_quote_id_organization_id_key" ON "shipments"("quote_id", "organization_id");

-- CreateIndex
CREATE INDEX "shipment_events_organization_id_idx" ON "shipment_events"("organization_id");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_occurred_at_idx" ON "shipment_events"("shipment_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_source_provider_event_id_key" ON "shipment_events"("source", "provider_event_id");

-- CreateIndex
CREATE INDEX "documents_organization_id_idx" ON "documents"("organization_id");

-- CreateIndex
CREATE INDEX "documents_shipment_id_idx" ON "documents"("shipment_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_next_attempt_at_idx" ON "outbox_events"("processed_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_organization_id_idx" ON "outbox_events"("organization_id");

-- CreateIndex
CREATE INDEX "fx_rates_currency_valid_from_idx" ON "fx_rates"("currency", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_source_currency_valid_from_key" ON "fx_rates"("source", "currency", "valid_from");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_organization_id_fkey" FOREIGN KEY ("quote_id", "organization_id") REFERENCES "quotes"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_id_organization_id_fkey" FOREIGN KEY ("product_id", "organization_id") REFERENCES "products"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_quote_id_organization_id_fkey" FOREIGN KEY ("quote_id", "organization_id") REFERENCES "quotes"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_organization_id_fkey" FOREIGN KEY ("shipment_id", "organization_id") REFERENCES "shipments"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_shipment_id_organization_id_fkey" FOREIGN KEY ("shipment_id", "organization_id") REFERENCES "shipments"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

