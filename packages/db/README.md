# @harbour/db

Prisma schema, migrations, tenant-scoped client, RBAC matrix and audit helper for Harbour.
Implements §4 (data model), §5.9 (accepted-quote immutability) and §7.2 (tenancy, RLS, RBAC) of
the engineering brief. Prisma 6.19.x, Postgres 16.

```
prisma/schema.prisma                         the model (brief §4 + marked additions)
prisma/migrations/0001_init                  generated from the schema (prisma migrate diff)
prisma/migrations/0002_rls_and_guards        hand-written: role, RLS policies, triggers
src/client.ts     createPrismaClient()       one pool per process
src/tenancy.ts    forOrganization(), withOrgTransaction(), scopeArgs()
src/rbac.ts       can(role, action), assertCan()
src/audit.ts      recordAudit(tx, entry)
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
  decide that when Phase 2 is built.

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

- `test/rbac.test.ts` — every cell of the §7.2 matrix.
- `test/tenancy.test.ts` — `scopeArgs` rewriting, no database.
- `test/migrations.test.ts` — migration files present, every tenant table has RLS + policy +
  `@@map`, every schema model is classified, triggers present.
- `test/cross-tenant.db.test.ts` — runs only with `DATABASE_URL` against a migrated database:
  scoped client cannot see/update/delete/redirect to another org, raw `SELECT` under
  `withOrgTransaction` returns only that org's rows, no context → no rows, raw cross-tenant
  `INSERT` rejected by `WITH CHECK`, accepted quote update/delete/line insert rejected, audit rows
  append-only. When the connection is a superuser (typical local Docker), the raw checks
  `SET LOCAL ROLE harbour_app` so RLS is actually exercised.

```sh
docker run -d --name harbour-pg -e POSTGRES_PASSWORD=harbour -e POSTGRES_USER=harbour -e POSTGRES_DB=harbour -p 5432:5432 postgres:16
DATABASE_URL=postgresql://harbour:harbour@localhost:5432/harbour pnpm --filter @harbour/db run migrate:deploy
DATABASE_URL=postgresql://harbour:harbour@localhost:5432/harbour pnpm --filter @harbour/db run test
```

## Schema additions vs the brief

All marked `(NEW vs brief)` in `schema.prisma`. In short: engine output fields on `Quote`
(`apportionmentBasis`, `freightToBorderGbp`, `freightPostBorderGbp`, `supplierBorneDuty/Vat`,
`fxSnapshots`) and `QuoteLine` (`chargeableWeight`, the six `allocated*Gbp` splits,
`supplierBorne*Gbp`, `lineLandedCost[ExVat]Gbp`, `landedCostPerUnitIncVat`, denormalised
`organizationId`); `MagicLinkToken`, `EmailSignup`, `OutboxEvent` (Phase 2, unused);
`Document.uploadedBy/verifiedBy`; denormalised `ShipmentEvent.organizationId`; `@db.Uuid` on all
internal ids (TEXT cannot be compared with `::uuid` in policies); snake_case `@@map`/`@map`; and
composite foreign keys `(child_fk, organization_id) → parent(id, organization_id)` so a
denormalised `organization_id` can never disagree with its parent — the trigger on `quote_lines`
relies on that.
