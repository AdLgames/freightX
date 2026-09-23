# 0009. Tenancy defence in depth

- **Status:** Accepted
- **Date:** 2026-09-23
- **Brief:** §1 ("Tenant isolation is absolute"), §7.2, §8

## Context

Every tenant table carries `organizationId`. One missed `where` clause in a loader is a
cross-tenant leak. The brief requires a Prisma layer, a Postgres RLS layer, an RBAC helper and
tests that attempt cross-org reads — four independent controls so that a bug in one is caught
by another.

## Decision

Implemented in `packages/db`:

1. **Prisma tenancy client.** A `$extends` client created per request with the current
   `organizationId`. For every model on the tenant allow-list it injects
   `where: { organizationId }` into reads, updates and deletes, and `data.organizationId` into
   creates; it throws if a caller passes a different `organizationId`. Models not on the list
   (`User`, `TariffCache`, `FxRate`) are reachable only through explicit, reviewed helpers.
2. **Postgres row-level security.** RLS is enabled and forced on all tenant tables. Policies
   compare `organization_id` with `current_setting('app.current_org', true)`. The tenancy
   client wraps each unit of work in a transaction and runs
   `SELECT set_config('app.current_org', $1, true)` first (`true` = transaction-local, so the
   setting cannot leak across pooled connections). The application role is not the table
   owner, so `FORCE ROW LEVEL SECURITY` applies.
3. **RBAC.** A single `can(role, action)` helper encodes the §7.2 matrix and is unit-tested
   cell by cell. Loaders and actions resolve `currentOrg` from the session and membership,
   never from a URL parameter alone.
4. **Cross-tenant negative tests.** The db test suite creates two organisations and, for each
   tenant model, asserts that org A cannot read, update or delete org B's rows through the
   tenancy client, and that raw SQL under org A's `app.current_org` returns no org B rows.
   These tests run in CI against the Postgres service container.

There is **no admin bypass** in the customer app. Support access is a separate internal app
with its own audit trail (brief §7.2); it does not exist yet and nothing in `apps/web` may be
extended to fill that role.

## Consequences

- A forgotten `where` in application code is caught by the extension; a query that bypasses
  the extension (raw SQL, a model outside the allow-list) is caught by RLS; both are exercised
  by tests on every PR.
- Migrations that add a tenant table must add the RLS policy in the same migration and the
  model to the allow-list and to the negative-test table in the same PR (CONTRIBUTING.md).
- Background jobs that legitimately span organisations (expiry cron, GDPR deletion) run
  under a distinct role with explicit per-org loops, never under a "bypass RLS" setting.
