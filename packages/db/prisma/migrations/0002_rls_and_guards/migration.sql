-- =============================================================================================
-- 0002_rls_and_guards  (hand-written; idempotent where Postgres allows it)
--
-- Second line of defence for tenant isolation (§7.2) and the "quotes are immutable snapshots"
-- principle (§1, §5.9). Nothing here replaces the Prisma tenancy extension; it catches any bug
-- that bypasses it.
--
-- ROLE MODEL
--   `harbour_app` is a NOLOGIN role that the application *acts as*. It owns nothing. Infra (not a
--   migration — passwords never live in migrations) creates the login role as a member of it:
--
--       CREATE ROLE harbour_web LOGIN PASSWORD '...' IN ROLE harbour_app;
--
--   A member inherits harbour_app's grants, or may `SET ROLE harbour_app` explicitly. The login
--   role MUST NOT be a superuser, MUST NOT have BYPASSRLS and MUST NOT own the tables — superusers
--   and BYPASSRLS roles ignore RLS entirely. The table owner (the role that runs migrations) is
--   also subject to the policies because every tenant table has FORCE ROW LEVEL SECURITY.
--   Creating the role needs CREATEROLE; if the migration user lacks it, create `harbour_app`
--   beforehand and the DO block below is a no-op.
--
-- TENANCY CONTRACT
--   Every transaction that touches tenant tables sets the tenant first, transaction-locally:
--
--       SELECT set_config('app.current_org', '<organization uuid>', true);   -- i.e. SET LOCAL
--
--   (src/tenancy.ts `withOrgTransaction` does this with a bound parameter.) When the setting is
--   absent or empty, app_current_org() is NULL, `organization_id = NULL` is never true, and every
--   tenant table appears empty: we fail closed. Optionally `app.current_user` (the user's uuid)
--   lets a pre-org flow (just logged in, choosing an organisation) read that user's own
--   memberships and the organisations they belong to — nothing else.
-- =============================================================================================

-- ---------- Role ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harbour_app') THEN
    CREATE ROLE harbour_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO harbour_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO harbour_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harbour_app;
-- The app never touches Prisma's bookkeeping table.
-- Guarded: Prisma's shadow database (used by `prisma migrate dev`) has no _prisma_migrations
-- table when replaying, so an unguarded REVOKE fails with P3006. Edited before any
-- non-throwaway database applied this migration.
DO $$
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM harbour_app;
  END IF;
END
$$;
-- Append-only tables: belt (grants) and braces (triggers below, which also bind the owner).
REVOKE UPDATE, DELETE ON TABLE "shipment_events", "audit_logs" FROM harbour_app;

-- ---------- Context helpers ----------
-- NULLIF(...) so a missing/empty setting yields NULL (matches nothing) instead of a cast error.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::uuid
$$;

-- ---------- Row-level security ----------
-- Policies are PERMISSIVE and OR-ed together; each table gets exactly the policies listed here.
-- No `TO role` clause: the policies bind every role that is subject to RLS (owner included).

-- organizations: the tenant row itself is keyed by id, not organization_id.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant ON "organizations";
CREATE POLICY organizations_tenant ON "organizations"
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());
-- Pre-org flow: a user may read (only) the organisations they are a member of. The subquery on
-- memberships is itself filtered by memberships_self_read below.
DROP POLICY IF EXISTS organizations_member_read ON "organizations";
CREATE POLICY organizations_member_read ON "organizations" FOR SELECT
  USING (
    app_current_user() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m.organization_id = "organizations".id AND m.user_id = app_current_user()
    )
  );

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_tenant ON "memberships";
CREATE POLICY memberships_tenant ON "memberships"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
DROP POLICY IF EXISTS memberships_self_read ON "memberships";
CREATE POLICY memberships_self_read ON "memberships" FOR SELECT
  USING (app_current_user() IS NOT NULL AND user_id = app_current_user());

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppliers_tenant ON "suppliers";
CREATE POLICY suppliers_tenant ON "suppliers"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_tenant ON "products";
CREATE POLICY products_tenant ON "products"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quotes_tenant ON "quotes";
CREATE POLICY quotes_tenant ON "quotes"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "quote_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_lines_tenant ON "quote_lines";
CREATE POLICY quote_lines_tenant ON "quote_lines"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shipments_tenant ON "shipments";
CREATE POLICY shipments_tenant ON "shipments"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- shipment_events carries a denormalised organization_id (kept consistent by the composite FK
-- (shipment_id, organization_id) → shipments), so no join is needed here.
ALTER TABLE "shipment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shipment_events_tenant ON "shipment_events";
CREATE POLICY shipment_events_tenant ON "shipment_events"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_tenant ON "documents";
CREATE POLICY documents_tenant ON "documents"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- audit_logs / outbox_events have a NULLABLE organization_id. Tenant rows follow the usual rule.
-- Tenant-less rows (login events, system jobs) may only be INSERTed when no tenant context is set,
-- and are never readable through the app role — the internal support app (§7.2) reads those with
-- its own role and audit trail. The Phase 2 outbox worker will likewise need its own role/policy
-- to claim rows across tenants; decide that when Phase 2 is built, not before.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant ON "audit_logs";
CREATE POLICY audit_logs_tenant ON "audit_logs"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
DROP POLICY IF EXISTS audit_logs_system_insert ON "audit_logs";
CREATE POLICY audit_logs_system_insert ON "audit_logs" FOR INSERT
  WITH CHECK (organization_id IS NULL AND app_current_org() IS NULL);

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_events_tenant ON "outbox_events";
CREATE POLICY outbox_events_tenant ON "outbox_events"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
DROP POLICY IF EXISTS outbox_events_system_insert ON "outbox_events";
CREATE POLICY outbox_events_system_insert ON "outbox_events" FOR INSERT
  WITH CHECK (organization_id IS NULL AND app_current_org() IS NULL);

-- Not tenant-scoped, no RLS: users, magic_link_tokens, email_signups, tariff_cache, fx_rates.

-- ---------- Accepted quotes are immutable (§5.9) ----------
-- BEFORE UPDATE: once OLD.status = 'ACCEPTED' the only permitted change is status → CANCELLED or
-- EXPIRED (plus the updated_at bump that comes with it). A no-op update (only updated_at moved)
-- is tolerated because Prisma bumps updated_at on every update. BEFORE DELETE: always rejected.
-- The comparison strips exactly those two columns from the row images, so any new column added
-- to quotes is automatically protected.
CREATE OR REPLACE FUNCTION quotes_accepted_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  IF OLD.status <> 'ACCEPTED' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'harbour: quote % is ACCEPTED and immutable; DELETE rejected', OLD.id
      USING HINT = 'Set status to CANCELLED instead.';
  END IF;

  IF (to_jsonb(OLD) - 'status' - 'updated_at') <> (to_jsonb(NEW) - 'status' - 'updated_at') THEN
    SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO changed
    FROM jsonb_each(to_jsonb(NEW) - 'status' - 'updated_at') AS n
    WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value;
    RAISE EXCEPTION 'harbour: quote % is ACCEPTED and immutable; UPDATE rejected (changed columns: %)', OLD.id, changed
      USING HINT = 'Only status -> CANCELLED or EXPIRED is allowed on an accepted quote.';
  END IF;

  IF NEW.status NOT IN ('ACCEPTED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'harbour: quote % is ACCEPTED and immutable; status -> % rejected', OLD.id, NEW.status
      USING HINT = 'Only status -> CANCELLED or EXPIRED is allowed on an accepted quote.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS quotes_accepted_immutable ON "quotes";
CREATE TRIGGER quotes_accepted_immutable
  BEFORE UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION quotes_accepted_immutable();

-- quote_lines: no INSERT/UPDATE/DELETE while the parent quote is ACCEPTED. (INSERT is included
-- beyond the brief's wording: adding a line changes an accepted quote just as much as editing one.)
-- The lookup runs under the caller's RLS context; the composite FK (quote_id, organization_id)
-- guarantees a visible line always has a visible parent, so a hidden parent can never read as
-- "not accepted". A parent that no longer exists (cascade from a non-accepted quote's DELETE)
-- yields NULL and is allowed.
CREATE OR REPLACE FUNCTION quote_lines_accepted_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  accepted_quote uuid;
BEGIN
  SELECT q.id INTO accepted_quote
  FROM "quotes" q
  WHERE q.status = 'ACCEPTED'
    AND (
      (TG_OP IN ('UPDATE', 'DELETE') AND q.id = OLD.quote_id)
      OR (TG_OP IN ('INSERT', 'UPDATE') AND q.id = NEW.quote_id)
    )
  LIMIT 1;

  IF accepted_quote IS NOT NULL THEN
    RAISE EXCEPTION 'harbour: quote % is ACCEPTED and immutable; % on quote_lines rejected', accepted_quote, TG_OP;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS quote_lines_accepted_immutable ON "quote_lines";
CREATE TRIGGER quote_lines_accepted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines"
  FOR EACH ROW EXECUTE FUNCTION quote_lines_accepted_immutable();

-- ---------- Append-only tables ----------
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'harbour: % is append-only; % rejected', TG_TABLE_NAME, TG_OP;
END
$$;

DROP TRIGGER IF EXISTS shipment_events_append_only ON "shipment_events";
CREATE TRIGGER shipment_events_append_only
  BEFORE UPDATE OR DELETE ON "shipment_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- audit_logs are retained for 6 years after an organisation is hard-deleted (§7.3). The FK is
-- ON DELETE SET NULL, which Postgres executes as an UPDATE of organization_id only — that single
-- shape is allowed; everything else is rejected.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS NULL
     AND OLD.organization_id IS NOT NULL
     AND (to_jsonb(OLD) - 'organization_id') = (to_jsonb(NEW) - 'organization_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'harbour: audit_logs is append-only; % rejected', TG_OP;
END
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
