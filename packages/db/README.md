# @harbour/db

Prisma schema, migrations, tenant-scoped client, RBAC matrix and audit helper for Harbour.
Implements §4 (data model), §5.9 (accepted-quote immutability) and §7.2 (tenancy, RLS, RBAC) of
the engineering brief. Prisma 6.19.x, Postgres 16.

```
prisma/schema.prisma                         the model (brief §4 + marked additions)
prisma/migrations/0001_init                  generated from the schema (prisma migrate diff)
prisma/migrations/0002_rls_and_guards        hand-written: role, RLS policies, triggers
prisma/migrations/0003_customs_profile_and_quote_1_1
                                             generated DDL + hand-written CHECKs/trigger/RLS
prisma/migrations/0004_auth_sessions         generated: index on magic_link_tokens(expires_at)
prisma/migrations/0005_documents_quote_link  M5: generated DDL (quote link, scope, scan columns) + hand-written CHECKs
prisma/migrations/0008_org_identity_and_encryption
                                             M2: generated DDL + hand-written CHECKs/RLS (invitations)
src/client.ts     createPrismaClient()       one pool per process
src/tenancy.ts    forOrganization(), withOrgTransaction(), scopeArgs()
src/rbac.ts       can(role, action), assertCan()
src/audit.ts      recordAudit(tx, entry)
src/documents.ts  PrismaDocumentScanStore (M5: the scan pipeline's persistence seam)
src/crypto.ts     M2: envelope field encryption (encryptField, KeyProvider, rewrapDataKey)
src/stores.ts     PrismaTariffCacheStore, PrismaFxRateStore, PrismaEmailSignupRepository
generated/        Prisma client output — gitignored, run `pnpm generate`
```

## Commands

```sh
pnpm --filter @harbour/db run generate         # prisma generate → generated/client
pnpm --filter @harbour/db run typecheck
pnpm --filter @harbour/db run test             # unit tests; DB tests run only when DATABASE_URL is set
pnpm --filter @harbour/db run migrate:deploy   # apply pending migrations (the only way to change prod/staging)
pnpm --filter @harbour/db run migrate:dev      # local only: create + apply a new migration
pnpm --filter @harbour/db run migrate:status
```

Copy `.env.example` to `.env` for local work. Prisma reads `DATABASE_URL` from it.

## Migrations

- **Deploy with `prisma migrate deploy`, never `prisma db push`** outside a throwaway local
  database (brief §4 migration rules). `db push` skips the migration history and would silently
  drop the hand-written policies and triggers.
- Every migration is reviewed by two people. Enums are additive only; never rename a value in place.
- To add a schema migration: edit `schema.prisma`, run `migrate:dev --name <thing>` against a
  local DB, review the generated SQL, commit `prisma/migrations/<stamp>_<thing>/migration.sql`.
  If you add a **tenant table**, also add it to `TENANT_MODELS`/`TENANT_TABLES` in
  `src/tenancy.ts` and write the `ENABLE/FORCE ROW LEVEL SECURITY` + policy block in a new
  migration — `test/migrations.test.ts` fails until all three agree.
- `0001_init` was produced with
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
  `0002_rls_and_guards` is hand-written and idempotent (`DROP ... IF EXISTS` / `CREATE OR REPLACE`
  / `DO $$ IF NOT EXISTS $$`), so it can be re-applied to repair a database.
- `0003_customs_profile_and_quote_1_1` = generated DDL (part 1) + hand-written, idempotent rules
  (part 2). Part 1 came from `prisma migrate diff --from-schema-datamodel <schema.prisma as of 0002>
--to-schema-datamodel prisma/schema.prisma --script`.
- `0004_auth_sessions` (M1) was produced with `prisma migrate diff --from-migrations
prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow>
--script`. Sessions live in Redis, so the only change is an index for the magic-link cleanup
  below.
- `0006_billing` (M6) = generated DDL (part 1, `migrate diff --from-migrations … --shadow-database-url`)
  followed by a hand-written, idempotent part 2. Adds enum `subscription_status`, the subscription
  columns on `organizations` (`stripe_subscription_id` unique, `subscription_status` default `NONE`,
  `current_period_end`, `cancel_at_period_end`, `billing_email` with a lower-case CHECK,
  `plan_updated_at`) and the global table `stripe_events` (webhook idempotency: Stripe event id PK,
  type, received/processed timestamps, last error, payload sha256 — never the payload). `StripeEvent`
  is a `PASSTHROUGH_MODELS` entry (no organisation until processed, no RLS), granted to `harbour_app`.
  `billing_email` is PII like the EORI: never logged, never in audit metadata. Independent of 0005.
- `0005_documents_quote_link` (M5) = generated DDL (`prisma migrate diff --from-migrations … --shadow-database-url <shadow> --script`,
  edited only to add `scope` with a temporary default + backfill) + hand-written, idempotent CHECKs.
  Adds `Document.quoteId` (composite FK `(quote_id, organization_id) → quotes`, `ON DELETE RESTRICT`),
  `scope` (`document_scope`: `SHIPMENT | QUOTE | ORGANISATION`, must agree with which of
  `shipment_id`/`quote_id` is set), the scan columns `scan_engine` (`clamav` | `none`), `scan_result`,
  `scanned_at`, `rejected_reason` (set iff status is `REJECTED`), soft-delete `deleted_at`, index
  `(organization_id, quote_id)`, `document_type` values `EORI_CONFIRMATION`, `VAT_CERTIFICATE`,
  `REPRESENTATION_AUTHORITY` (additive), and CHECKs: `size_bytes ≤ 26214400` (§7.4), `version ≥ 1`,
  and `CLEAN`/`VERIFIED` only with `scan_engine = 'clamav'` (no scanner → the row stays `UPLOADED`).
  Rollback note is in the migration header (additive: re-deploy the previous release).
- `0008_org_identity_and_encryption` (M2) = generated part (`prisma migrate diff
--from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma
--shadow-database-url <shadow> --script`) + hand-written CHECKs, RLS and grants for the new tenant
  table `invitations`. Numbered 0008 to leave 0005–0007 to the parallel M5/M6 milestones.
- **Shadow database (fixed).** 0002's `REVOKE ... "_prisma_migrations"` is guarded with
  `to_regclass`, so `migrate dev` and `migrate diff --from-migrations` can replay all migrations
  into a shadow database. The guard was added before any non-throwaway database applied 0002.
- Adding a column to `quotes`/`quote_lines` is safe for accepted quotes: `ALTER TABLE ... ADD
COLUMN` is DDL, so the row triggers do not fire, and with a constant default the new column reads
  the same in `OLD` and `NEW`. Verified for 0003 on a database with an accepted quote created under
  0002: after `migrate deploy`, changing a new column on it is rejected and status → `CANCELLED` is
  allowed (plus `test/customs-profile.db.test.ts`, which repeats the DDL in a rolled-back
  transaction when the connection owns `quotes`).

### Rollback note (required in every migration PR)

Every PR that touches `prisma/migrations` ends its description with:

```
## Rollback
- Reversible: yes | no (destructive)
- Backup snapshot ID: <required when destructive, e.g. pg-snap-2026-09-23-0412>
- Down steps: <SQL or "re-deploy previous release; migration is additive and ignored by old code">
- Data impact: <rows/tables affected, or none>
```

Additive migrations (new nullable column, new table, new enum value) roll back by re-deploying the
previous release. Destructive ones (drop/rename column, narrowing type) need the snapshot ID and
the explicit down SQL before review.

## Tenancy contract

Two layers; use both. Every loader/action resolves `currentOrg` from the session + membership
(never from a URL param) and then does _all_ DB work inside `withOrgTransaction`:

```ts
import { createPrismaClient, withOrgTransaction, assertCan, recordAudit } from '@harbour/db';

const prisma = createPrismaClient();

const quote = await withOrgTransaction(
  prisma,
  session.orgId,
  async (tx) => {
    const q = await tx.quote.findUniqueOrThrow({ where: { id: quoteId } }); // scoped to the org
    await tx.quote.update({
      where: { id: quoteId },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await recordAudit(tx, {
      organizationId: session.orgId,
      userId: session.userId,
      action: 'quote.accept',
      targetType: 'Quote',
      targetId: quoteId,
    });
    return q;
  },
  { userId: session.userId },
);
```

1. **Prisma extension (`forOrganization`)** rewrites the arguments of every model operation:
   `where` gets `AND: [..., { organizationId }]` (organisations: `{ id }`), `create` data gets
   `organizationId`, `update`/`delete` verify ownership in the same statement and throw
   `TenantScopeError('NOT_FOUND_IN_SCOPE')` when nothing matched, and any attempt to write a
   different `organizationId` throws `CROSS_TENANT_WRITE`. Models in neither `TENANT_MODELS` nor
   `PASSTHROUGH_MODELS` throw `MODEL_NOT_ALLOWLISTED`. The generated types still require
   `organizationId` on create data — pass the current org's id; anything else is rejected.
   `scopeArgs()` is the pure function behind this and is unit-tested without a database.
2. **Postgres RLS (`app.current_org`)**. `withOrgTransaction` opens an interactive transaction and
   runs `SELECT set_config('app.current_org', $1, true)` (= `SET LOCAL`) before your callback. Every
   tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy of the form
   `organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid` for reads and
   writes (`WITH CHECK`). No setting → `NULL` → nothing matches: **fail closed**. This is why a
   scoped client used _outside_ `withOrgTransaction` returns no rows in any environment with a
   correctly configured role — that is intended, not a bug.

Extras:

- `app.current_user` (set via `withOrgTransaction(..., { userId })` or `withUserTransaction`)
  additionally lets a user read their own `memberships` rows and the `organizations` they belong
  to — the minimum needed to pick an organisation after login. Nothing else.
- Creating an organisation: RLS requires `app.current_org = <new id>` for the insert, so generate
  the id first and create inside `withOrgTransaction(prisma, newId, tx => tx.organization.create(...))`
  (the scope injects `id`).
- Not scoped by layer 1 (RLS still applies): nested `include`/`select`/nested writes, `$queryRaw`,
  `$executeRaw`.
- `audit_logs` / `outbox_events` rows with a `NULL` organisation may only be inserted when no
  tenant context is set and are never readable through the app role (support tooling reads them
  with its own role and audit trail). The Phase 2 outbox worker will need its own role/policy —
  decide that when Phase 2 is built. Because Postgres applies the SELECT policy to `RETURNING`,
  `recordAudit` inserts with `createMany` (no `RETURNING`); a `create` of a tenant-less audit row
  fails under the app role with "new row violates row-level security policy".

## Database roles

`0002_rls_and_guards` creates `harbour_app` (`NOLOGIN NOSUPERUSER NOBYPASSRLS`) and grants it
`SELECT/INSERT/UPDATE/DELETE` on all tables (minus `UPDATE/DELETE` on the append-only ones). It owns
nothing. Infra creates the login role — passwords never live in migrations:

```sql
CREATE ROLE harbour_web LOGIN PASSWORD '...' IN ROLE harbour_app;   -- inherits harbour_app's grants
```

Rules:

- The application connection **must not** be a superuser, must not have `BYPASSRLS`, and must not
  own the tables. Superusers and `BYPASSRLS` roles ignore RLS entirely. The migration role (table
  owner) is also bound by the policies thanks to `FORCE ROW LEVEL SECURITY`.
- `prisma migrate deploy` runs as the owner/admin role, which needs `CREATEROLE` for the `DO`
  block; if it lacks it, create `harbour_app` by hand first and the block is a no-op.
- Seeds and maintenance jobs running as the owner must still set `app.current_org`. Hard-deleting
  an organisation (GDPR, §7.3) is a maintenance job that disables the append-only trigger on
  `shipment_events` for its run; `audit_logs` keep their rows with `organization_id` set to `NULL`
  by the FK (`ON DELETE SET NULL` — the one `UPDATE` shape the audit trigger allows).

## Customs profile (migration 0003)

`CustomsProfile` (`customs_profiles`, tenant table, 1:1 with `Organization`) holds how duty/VAT is
paid at the border: `usePva` (postponed VAT accounting), `paymentMethod` (`PaymentMethod`:
`OWN_DEFERMENT` | `BROKER_DEFERMENT` (default) | `CDS_CASH_ACCOUNT` — additive-only like every enum),
`danNumber`/`danLimit`, the CDS authority confirmation (`cdsAuthorityGranted`,
`cdsAuthorityConfirmedAt`, `cdsAuthorityConfirmedById`) and the forwarder's deferment terms
(`brokerDefermentFeePct`, `brokerDefermentMinimumGbp`; `null` = unknown) that feed the engine's
`brokerDeferment` input.

- `danNumber` is sensitive like the EORI: never logged or put in audit metadata, and encrypted at
  rest (§7.3) once the field-encryption extension lands. That migration must drop the
  `customs_profiles_dan_number_format` CHECK (ciphertext does not match `^[0-9]{7}$`) and rely on
  the zod validator instead.
- Database rules: DAN is 7 digits; `OWN_DEFERMENT` needs a DAN; fee pct in [0, 100], minimum and
  DAN limit ≥ 0; `cdsAuthorityGranted` needs `cdsAuthorityConfirmedAt`.
- Trigger `customs_profiles_pva_requires_vat`: `usePva = true` only when the owning organisation has
  `vat_registered = true AND vat_number IS NOT NULL`. It reads `organizations` under the caller's
  RLS; if the row is not visible the write is rejected (fail closed). The mirror trigger
  `organizations_vat_required_by_pva` stops an organisation clearing its VAT registration/number
  while PVA is on — turn PVA off first.
- Hard-deleting an organisation (§7.3 maintenance job) must delete its `customs_profiles` row first
  (FK `ON DELETE RESTRICT`).
- `Quote.paymentMethod` is a snapshot of the routing in force when the quote was computed, not a
  reference; the engine 1.1 columns (`vatPostponed`, `borderOutlay`, `assistsGbp`, `financingFee`,
  `inlandVatAdjustment`; per line `assistsGbp`, `allocatedFinancingFeeGbp`,
  `allocatedInlandVatAdjustmentGbp`) default to false/0 so older quotes stay valid.

### Phase 2 booking preconditions (additions to brief §6.1 — design only, nothing is built)

To be enforced server-side in the booking transaction alongside §6.1 items 1–7:

8. If `customsProfile.paymentMethod = OWN_DEFERMENT`, then `customsProfile.cdsAuthorityGranted` must
   be true: CDS only lets the forwarder use the importer's DAN once the importer has authorised the
   forwarder's EORI against that DAN in their CDS account.
9. If the quote was computed with PVA (`quote.vatPostponed` / `customsProfile.usePva`), the
   organisation must still be VAT-registered with a VAT number (the triggers above keep the profile
   consistent; re-check at booking time because registration can lapse between quote and booking).
10. The quote's snapshotted `paymentMethod` must equal the profile's current one; otherwise
    recompute the quote (the financing fee / border outlay depend on it).

## Magic-link cleanup (TODO for the worker)

`magic_link_tokens` rows (M1 sign-in, apps/web `magic-link.server.ts`) are single-use and expire
after 15 minutes, but nothing deletes them yet. When `apps/worker` exists, add a daily job (as the
owner/maintenance role; the table has no RLS) running:

```sql
DELETE FROM magic_link_tokens WHERE expires_at < now() - interval '1 day';
```

`magic_link_tokens_expires_at_idx` (migration 0004) keeps it an index range scan. Keeping a day of
expired rows leaves a short window for abuse investigation; the rows hold the email address, the
token hash and a hash of the requesting IP, never the token itself.

## Prisma stores (src/stores.ts)

Implementations of the persistence seams used by `apps/web` (`app/services/db.server.ts`). The
three tables are global — `TariffCache`, `FxRate`, `EmailSignup` are `PASSTHROUGH_MODELS` with no
RLS — so the stores take the plain `PrismaClient`.

- `PrismaTariffCacheStore` (adapters `TariffCacheStore`). The interface is keyed by commodity code
  only, the table by `(hs_code, origin_country)`: rows are stored with `origin_country = '*'`
  (`TARIFF_CACHE_ANY_ORIGIN`) because the cached `NormalisedCommodity` holds the measures for every
  origin and the engine filters by origin. `get` validates `payload` with a zod schema mirroring
  `NormalisedCommodity` (type-checked against it both ways); a corrupt row is a miss (optional
  `onCorruptRow` callback) and gets overwritten by the next fetch. TTL is the caller's (24h, §5.2);
  `get` returns expired rows like the in-memory cache and the client compares `expiresAt`.
- `PrismaFxRateStore` (adapters `FxRateStore`). `validFrom`/`validTo` are `YYYY-MM-DD` calendar days
  stored as UTC midnight; `validTo` is inclusive of its whole UTC day (`find` matches
  `validFrom <= at AND validTo >= start of at's UTC day`). Latest `validFrom` wins. Rates stay
  decimal strings (`Prisma.Decimal` in between, `toString()` out — no padding); a record with more
  than 6 dp, a non-positive rate or an impossible date is rejected before anything is written.
  `upsert` is idempotent on `(source, currency, validFrom)` and runs in one transaction.
- `PrismaEmailSignupRepository` (web `EmailSignupRepository`). `add` is one
  `INSERT ... ON CONFLICT DO NOTHING` (`createMany({ skipDuplicates })`): a duplicate email returns
  `created: false` and does not overwrite. `email_signups.source` is NOT NULL, so a missing source
  is stored as `'unknown'` (`SIGNUP_SOURCE_UNKNOWN`).

## Accepted-quote trigger (§5.9)

`quotes_accepted_immutable` (BEFORE UPDATE OR DELETE ON `quotes`):

- `OLD.status <> 'ACCEPTED'` → no-op.
- `DELETE` of an accepted quote → **rejected**. Cancel it instead.
- `UPDATE` where anything other than `status` and `updated_at` changed → **rejected**, message
  lists the changed columns (`to_jsonb(OLD) - 'status' - 'updated_at' <> to_jsonb(NEW) - ...`).
  New columns are covered automatically.
- `UPDATE` that changes `status` to anything but `CANCELLED` or `EXPIRED` → **rejected**.
- `UPDATE` that only bumps `updated_at` (Prisma does this on `data: {}`) → allowed no-op.

`quote_lines_accepted_immutable` rejects `INSERT`, `UPDATE` and `DELETE` on lines whose quote is
accepted. `shipment_events` and `audit_logs` are append-only: for `harbour_app` the revoked
`UPDATE`/`DELETE` grant rejects first (`permission denied for table ...`), the trigger catches
every other role. All trigger errors carry `harbour: ...` messages; Prisma surfaces them as
`PrismaClientUnknownRequestError` with the message intact — match on `/ACCEPTED and immutable/`
or `/append-only|permission denied/`.

## Tests

- `test/rbac.test.ts` — every cell of the §7.2 matrix (+ M5 `doc.verify`: OWNER/ADMIN).
- `test/tenancy.test.ts` — `scopeArgs` rewriting, no database.
- `test/migrations.test.ts` — migration files present, every tenant table has RLS + policy +
  `@@map`, every schema model is classified, triggers present.
- `test/stores.test.ts` — the Prisma stores against a stub client (argument shapes, validation,
  date/decimal helpers), no database.
- `test/customs-profile.db.test.ts`, `test/stores.db.test.ts` — with `DATABASE_URL`: 0003 CHECKs,
  the PVA trigger pair, customs_profiles isolation, engine 1.1 quote columns and immutability, and
  the three stores round-tripping. The DDL probe is skipped when the connection does not own
  `quotes` (e.g. a `harbour_app` login).
- `test/cross-tenant.db.test.ts` — runs only with `DATABASE_URL` against a migrated database:
  scoped client cannot see/update/delete/redirect to another org, raw `SELECT` under
  `withOrgTransaction` returns only that org's rows, no context → no rows, raw cross-tenant
  `INSERT` rejected by `WITH CHECK`, accepted quote update/delete/line insert rejected, audit rows
  append-only, a tenant-less audit row (sign-in) insertable but not readable by the app role. When the connection is a superuser (typical local Docker), the raw checks
  `SET LOCAL ROLE harbour_app` so RLS is actually exercised.

```sh
docker run -d --name harbour-pg -e POSTGRES_PASSWORD=harbour -e POSTGRES_USER=harbour -e POSTGRES_DB=harbour -p 5432:5432 postgres:16
DATABASE_URL=postgresql://harbour:harbour@localhost:5432/harbour pnpm --filter @harbour/db run migrate:deploy
DATABASE_URL=postgresql://harbour:harbour@localhost:5432/harbour pnpm --filter @harbour/db run test
```

## Schema additions vs the brief

All marked `(NEW vs brief)` in `schema.prisma`. Migration 0003 adds `CustomsProfile` +
`PaymentMethod` and the engine calcVersion 1.1 snapshot columns (see "Customs profile"). Before that:
engine output fields on `Quote`
(`apportionmentBasis`, `freightToBorderGbp`, `freightPostBorderGbp`, `supplierBorneDuty/Vat`,
`fxSnapshots`) and `QuoteLine` (`chargeableWeight`, the six `allocated*Gbp` splits,
`supplierBorne*Gbp`, `lineLandedCost[ExVat]Gbp`, `landedCostPerUnitIncVat`, denormalised
`organizationId`); `MagicLinkToken`, `EmailSignup`, `OutboxEvent` (Phase 2, unused);
`Document.uploadedBy/verifiedBy`; denormalised `ShipmentEvent.organizationId`; `@db.Uuid` on all
internal ids (TEXT cannot be compared with `::uuid` in policies); snake_case `@@map`/`@map`; and
composite foreign keys `(child_fk, organization_id) → parent(id, organization_id)` so a
denormalised `organization_id` can never disagree with its parent — the trigger on `quote_lines`
relies on that.

## Supplier entities (migration 0007, M3, ADR-0012)

`0007_supplier_entities` = generated DDL (part 1, `prisma migrate diff --from-migrations … --shadow-database-url`)

- hand-written, idempotent rules (part 2). Two hand adjustments in part 1: `suppliers.legal_name` and
  `suppliers.country_of_incorporation` are added nullable, **backfilled** from `name` / `country_code`,
  then set `NOT NULL`, so the migration applies to a table with rows. Additive otherwise; rollback note
  in the file.

* `suppliers`: legal entity columns (`legal_name`, `trading_name`, `registration_number`,
  `country_of_incorporation` with an ISO alpha-2 CHECK, `default_currency`) and `archived_at`.
  `country_code` is **kept as a deprecated alias** that the app writes in step with
  `country_of_incorporation`; it is removed after M4 (decisions-needed (w)). `name` is the display
  name (trading name, else legal name), maintained by the app.
* `products`: `carton_length_cm/width_cm/height_cm Decimal(8,2)`, `hs_description`,
  `preference_eligible` (default false), `archived_at`.
* New tenant tables, each with a denormalised `organization_id`, a composite FK
  `(supplier_id, organization_id) → suppliers(id, organization_id)` (`ON DELETE CASCADE`), RLS
  (`ENABLE` + `FORCE`, `<table>_tenant` policy) and grants to `harbour_app`; all three are in
  `TENANT_MODELS`/`TENANT_TABLES`:
  - `pickup_locations` — `closest_port_code` CHECK `^[A-Z]{2}[A-Z0-9]{3}$`, `country` CHECK alpha-2,
    and the partial unique index `pickup_locations_one_default_per_supplier` (`supplier_id`
    `WHERE is_default`): at most one default per supplier, whatever the app does.
  - `payment_terms` — one row per supplier (`supplier_id` unique); enums `payment_term_type`
    (`PREPAID`, `NET`, `DEPOSIT_BALANCE`) and `balance_trigger` (`ON_SHIPMENT`,
    `AGAINST_BILL_OF_LADING`, `ON_ARRIVAL`); CHECKs: `deposit_pct` in [0, 100] (percent
    convention, "30.00" = 30%), `net_days >= 0`, `DEPOSIT_BALANCE` needs `deposit_pct` +
    `balance_trigger`, `NET` needs `net_days`.
  - `payout_methods` — partner references only (§7.3): enums `payout_partner` (`AIRWALLEX`) and
    `payout_method_type` (`LOCAL`, `SWIFT`), `partner_beneficiary_id` (unique per partner),
    `currency`/`bank_country` format CHECKs and `account_last4` limited to four characters by CHECK.
    No account number, routing code or account name can be stored. **No code writes this table in
    M3.**
* Enums are additive only, as everywhere. `test/migrations.test.ts` checks the DDL shape, the
  backfill, the CHECKs, the partial index, the policies, the grants and idempotency;
  `apps/web/app/routes/catalogue.db.test.ts` exercises the constraints and RLS against a database.

## Field encryption (M2, §7.3)

`src/crypto.ts` implements envelope encryption for sensitive columns; today
`organizations.eori_number` and `vat_number` (written only by apps/web
`settings/identity.server.ts`, read by the worker's `eori-verify` / `vat-verify` jobs).

```
FIELD_ENCRYPTION_KEY (32 bytes, base64; KeyProvider = EnvKeyProvider)
  └─ wraps ─▶ per-organisation data key  →  organizations.data_key_ciphertext
                └─ encrypts ─▶ field values  →  eori_number, vat_number
```

- AES-256-GCM, random 12-byte IV, 16-byte tag. Ciphertext format `v1:<b64 iv>:<b64 tag>:<b64 data>`
  (`CIPHERTEXT_RE`; the `v1` prefix lets a later format coexist). AAD = `<organizationId>:<field>`
  (field names in `ORGANIZATION_ENCRYPTED_FIELDS`, part of the AAD, never rename), so a ciphertext
  copied to another organisation or column fails to decrypt. Wrapped data keys use a fixed AAD.
- The data key is generated on first use and stored with a conditional
  `UPDATE … WHERE data_key_ciphertext IS NULL` (`prismaDataKeyStore`), so concurrent first uses
  converge. `orgFieldCipher(provider, store, orgId)` resolves it once per transaction.
- `eori_last4` / `vat_last4` are kept in clear for display; audit metadata carries the last four
  only. Nothing here logs; never log plaintext or ciphertext.
- **Key rotation:** `rewrapDataKey(wrapped, fromProvider, toProvider)` re-wraps one organisation's
  data key under a new master key; field ciphertexts are untouched. A rotation job iterates
  organisations as the maintenance role (setting `app.current_org` per row) and writes the result
  back. Deploy the new key to web and worker, run the job, retire the old key.
- **KMS (TODO, decision (v)):** `KeyProvider` is the seam. A `KmsKeyProvider` implements only
  `wrapDataKey` / `unwrapDataKey` (KMS Encrypt/Decrypt); field encryption stays local.
- Production without `FIELD_ENCRYPTION_KEY` closes the workspace (apps/web README "Settings (M2)").
  Development/test without it get an ephemeral key; values encrypted under it are unreadable after
  a restart, and the app treats an undecryptable or non-ciphertext value as "not set".
- The DAN (`customs_profiles.dan_number`) is **not** encrypted yet. The migration that encrypts it
  must drop `customs_profiles_dan_number_format` (ciphertext does not match `^[0-9]{7}$`) and give
  `CustomsProfile` its own encrypted-field list. Until then it is validated by zod, never logged,
  never in audit metadata.
- `eori_number` / `vat_number` have no ciphertext CHECK on purpose: 0003's tests write plaintext
  VAT numbers to exercise the PVA trigger, which only asks `vat_number IS NOT NULL` and keeps
  working with ciphertext.

## Invitations and session epochs (M2)

- `invitations` (tenant table, RLS as the others): `email` lower-cased, `email_hash` = sha256 for
  "already invited?" lookups, `token_hash` = sha256 of the link secret (the link is
  `/invite/accept?token=<organisation id>.<secret>`; the id selects the RLS context for the
  lookup), 7-day expiry (`invitations_expiry_window`), accepted xor revoked.
- `users.session_epoch`: every session records the epoch it started under; removing a member
  increments it, and `requireUser` signs out any session with a stale epoch. Bump it for any
  future "sign out everywhere" (email change, §7.1).
- Cross-tenant tests: `apps/web/app/routes/settings-flow.db.test.ts` (invitations and audit rows
  invisible from another organisation; a token under another organisation's id finds nothing).

## Worker database access (M2)

The worker's identity jobs read and write `organizations` through `withOrgTransaction(orgId)` —
the same RLS context the web app uses — so its login role is a member of `harbour_app`, not a
BYPASSRLS service role. A future cross-organisation sweep (quote expiry, key rotation) needs its
own maintenance role and policy, as noted under "Tenancy contract".
