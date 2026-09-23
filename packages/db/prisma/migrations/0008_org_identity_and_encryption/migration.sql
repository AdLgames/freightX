-- =============================================================================================
-- 0008_org_identity_and_encryption  (M2: settings — field encryption, identity checks, invitations)
--
-- Part 1 (generated) — `prisma migrate diff --from-migrations prisma/migrations
--   --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow> --script`.
--   Not idempotent, like 0001/0003/0004: Prisma records it and never re-runs it.
--     * enum verification_status (additive-only rule applies)
--     * organizations: data_key_ciphertext (wrapped per-organisation data key, §7.3),
--       eori_last4 / vat_last4 (display), eori_/vat_verification_status + _verified_at (HMRC
--       checks, §5.6), companies_house_* + company_type (ADR-0015 finance gate)
--     * users.session_epoch (session invalidation on member removal, §7.1)
--     * invitations — tenant table
--   eori_number / vat_number keep their TEXT type: they now hold `v1:<iv>:<tag>:<data>`
--   ciphertext (src/crypto.ts). No column is widened, renamed or dropped.
--
-- Part 2 (hand-written, idempotent) — CHECKs, RLS and grants for invitations, a CHECK on
--   users.session_epoch.
--
-- NOT in this migration (deliberately): a CHECK that eori_number / vat_number look like ciphertext.
--   0003's tests write plaintext VAT numbers directly to exercise the PVA trigger; the app layer
--   (apps/web settings services) is the only writer of those columns and its tests assert the
--   stored value is ciphertext. Revisit with the DAN encryption migration (README, "Customs
--   profile"), which must also drop customs_profiles_dan_number_format.
--
-- The triggers from 0003 keep working unchanged: customs_profiles_pva_requires_vat only asks
-- `vat_number IS NOT NULL`, which holds for ciphertext.
--
-- ## Rollback
-- - Reversible: yes (additive: nullable columns / columns with constant defaults, one new table,
--   one new enum)
-- - Down steps: re-deploy previous release; old code ignores the new columns and table. To remove
--   physically: DROP TABLE "invitations"; ALTER TABLE "organizations" DROP COLUMN
--   data_key_ciphertext, eori_last4, vat_last4, eori_verification_status, eori_verified_at,
--   vat_verification_status, vat_verified_at, companies_house_number, companies_house_status,
--   company_type, companies_house_checked_at, companies_house_name; ALTER TABLE "users" DROP
--   COLUMN session_epoch; DROP TYPE "verification_status". Dropping data_key_ciphertext is
--   DESTRUCTIVE once any organisation has an encrypted EORI/VAT (the field ciphertexts become
--   unreadable): take a backup snapshot ID first.
-- - Data impact: none on existing rows (defaults only). Existing eori_number / vat_number values
--   written before this migration (there are none outside tests) would be plaintext; the settings
--   page treats a non-ciphertext value as "not set" and overwrites it on the next save.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Part 1 — generated
-- ---------------------------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('UNVERIFIED', 'PENDING', 'VALID', 'INVALID', 'ERROR');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "companies_house_checked_at" TIMESTAMP(3),
ADD COLUMN     "companies_house_name" TEXT,
ADD COLUMN     "companies_house_number" TEXT,
ADD COLUMN     "companies_house_status" TEXT,
ADD COLUMN     "company_type" TEXT,
ADD COLUMN     "data_key_ciphertext" TEXT,
ADD COLUMN     "eori_last4" TEXT,
ADD COLUMN     "eori_verification_status" "verification_status" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "eori_verified_at" TIMESTAMP(3),
ADD COLUMN     "vat_last4" TEXT,
ADD COLUMN     "vat_verification_status" "verification_status" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "vat_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "session_epoch" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "role" "role" NOT NULL DEFAULT 'MEMBER',
    "invited_by_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_hash_idx" ON "invitations"("organization_id", "email_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_created_at_idx" ON "invitations"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Part 2 — hand-written (idempotent: DROP ... IF EXISTS / CREATE OR REPLACE)
-- ---------------------------------------------------------------------------------------------

-- ---------- organizations: row rules ----------
-- The display suffixes are at most 4 characters and exist only alongside an encrypted value.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS organizations_eori_last4_shape;
ALTER TABLE "organizations" ADD CONSTRAINT organizations_eori_last4_shape
  CHECK (eori_last4 IS NULL OR (char_length(eori_last4) <= 4 AND eori_number IS NOT NULL));

ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS organizations_vat_last4_shape;
ALTER TABLE "organizations" ADD CONSTRAINT organizations_vat_last4_shape
  CHECK (vat_last4 IS NULL OR (char_length(vat_last4) <= 4 AND vat_number IS NOT NULL));

-- A wrapped data key is a v1 envelope: `v1:<iv>:<tag>:<data>` (src/crypto.ts).
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS organizations_data_key_ciphertext_format;
ALTER TABLE "organizations" ADD CONSTRAINT organizations_data_key_ciphertext_format
  CHECK (data_key_ciphertext IS NULL OR data_key_ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$');

-- Companies House: a number is 8 characters (digits, or a 2-letter prefix + 6 digits).
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS organizations_companies_house_number_format;
ALTER TABLE "organizations" ADD CONSTRAINT organizations_companies_house_number_format
  CHECK (companies_house_number IS NULL OR companies_house_number ~ '^[A-Z0-9]{8}$');

-- ---------- users: session epoch ----------
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS users_session_epoch_nonnegative;
ALTER TABLE "users" ADD CONSTRAINT users_session_epoch_nonnegative
  CHECK (session_epoch >= 0);

-- ---------- invitations: row rules ----------
-- Lower-cased address, sha256 hex of it, a sha256 hex token hash, 7-day expiry window at most.
ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS invitations_email_lower;
ALTER TABLE "invitations" ADD CONSTRAINT invitations_email_lower
  CHECK (email = lower(email) AND email <> '' AND char_length(email) <= 254);

ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS invitations_email_hash_format;
ALTER TABLE "invitations" ADD CONSTRAINT invitations_email_hash_format
  CHECK (email_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS invitations_token_hash_format;
ALTER TABLE "invitations" ADD CONSTRAINT invitations_token_hash_format
  CHECK (token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS invitations_expiry_window;
ALTER TABLE "invitations" ADD CONSTRAINT invitations_expiry_window
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days');

-- An invitation is accepted or revoked, never both.
ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS invitations_accepted_xor_revoked;
ALTER TABLE "invitations" ADD CONSTRAINT invitations_accepted_xor_revoked
  CHECK (accepted_at IS NULL OR revoked_at IS NULL);

-- ---------- invitations: row-level security (same shape as 0002) ----------
-- Acceptance runs inside withOrgTransaction(<organisation id from the link>): the link carries the
-- organisation id next to the secret so the lookup by token_hash happens under that tenant's
-- policy; a token from another organisation matches nothing (fail closed).
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitations_tenant ON "invitations";
CREATE POLICY invitations_tenant ON "invitations"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------- Grants ----------
-- 0002's ALTER DEFAULT PRIVILEGES covers tables created by the same role; grant explicitly anyway
-- so the result does not depend on which role runs the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invitations" TO harbour_app;
