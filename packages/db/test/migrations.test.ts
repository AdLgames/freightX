import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASSTHROUGH_MODELS, TENANT_MODELS, TENANT_TABLES } from '../src/tenancy.js';

const PRISMA_DIR = join(import.meta.dirname, '..', 'prisma');
const MIGRATIONS_DIR = join(PRISMA_DIR, 'migrations');
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');

const migrationDirs = readdirSync(MIGRATIONS_DIR)
  .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
  .sort();
const readMigration = (dir: string) =>
  readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
/** Everything after 0001_init: where tenant tables get their RLS block (0002, then per new table). */
const laterMigrationsSql = () =>
  migrationDirs
    .filter((d) => d !== '0001_init')
    .map(readMigration)
    .join('\n');
const allMigrationsSql = () => migrationDirs.map(readMigration).join('\n');

/** Parses `model X { ... }` blocks out of schema.prisma. */
const modelBlocks = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    out[m[1]!] = m[2]!;
  }
  return out;
};

describe('migration directories', () => {
  it('has a migration_lock.toml for postgresql', () => {
    expect(readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8')).toMatch(
      /provider\s*=\s*"postgresql"/,
    );
  });

  it('every migration directory contains migration.sql and names are ordered', () => {
    expect(migrationDirs.length).toBeGreaterThanOrEqual(2);
    for (const dir of migrationDirs) {
      expect(dir).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(readMigration(dir).length).toBeGreaterThan(0);
    }
    expect(migrationDirs[0]).toBe('0001_init');
    expect(migrationDirs[1]).toBe('0002_rls_and_guards');
    expect(migrationDirs[2]).toBe('0003_customs_profile_and_quote_1_1');
  });
});

describe('schema ↔ allow-lists', () => {
  const blocks = modelBlocks();

  it('the tenant table list is exactly the expected set (removing one needs a deliberate edit here)', () => {
    expect(Object.values(TENANT_TABLES).sort()).toEqual(
      [
        'audit_logs',
        'containers', // M9
        'customs_profiles',
        'documents',
        'invitations', // M2
        'memberships',
        'organizations',
        'outbox_events',
        'products',
        'quote_lines',
        'quotes',
        'shipment_events',
        'shipments',
        'suppliers',
        // M3 (ADR-0012)
        'pickup_locations',
        'payment_terms',
        'payout_methods',
        // M7 (ADR-0013)
        'purchase_orders',
        'purchase_order_items',
        'po_counters',
        // M8 (ADR-0014)
        'bills',
        'bill_lines',
        'bill_payments',
      ].sort(),
    );
  });

  it('every model in schema.prisma is classified as tenant or pass-through', () => {
    const classified = new Set<string>([...TENANT_MODELS, ...PASSTHROUGH_MODELS]);
    for (const model of Object.keys(blocks)) {
      expect(
        classified.has(model),
        `${model} must be added to TENANT_MODELS or PASSTHROUGH_MODELS`,
      ).toBe(true);
    }
    for (const model of classified) {
      expect(
        blocks[model],
        `${model} is allow-listed but missing from schema.prisma`,
      ).toBeDefined();
    }
  });

  it('every tenant model has organizationId, an index starting with it, and the expected @@map', () => {
    for (const model of TENANT_MODELS) {
      const body = blocks[model]!;
      expect(body).toMatch(new RegExp(`@@map\\("${TENANT_TABLES[model]}"\\)`));
      if (model === 'Organization') continue;
      expect(body, `${model}.organizationId`).toMatch(
        /^\s+organizationId\s+String\??\s.*@map\("organization_id"\)/m,
      );
      expect(body, `${model} index on organizationId`).toMatch(
        /@@(index|unique)\(\[organizationId[,\]]/,
      );
    }
  });

  it('pass-through models have no organizationId', () => {
    for (const model of PASSTHROUGH_MODELS) {
      expect(blocks[model]).not.toMatch(/^\s+organizationId\s/m);
    }
  });
});

describe('table creation (0001_init and later)', () => {
  const sql = allMigrationsSql();

  it('creates every tenant table with a uuid organization_id', () => {
    for (const table of Object.values(TENANT_TABLES)) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      if (table !== 'organizations') {
        expect(sql).toMatch(
          new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?"organization_id" UUID`),
        );
      }
    }
  });
});

describe('0002_rls_and_guards', () => {
  const sql = readMigration('0002_rls_and_guards');

  it('creates the harbour_app role idempotently', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'harbour_app'\)/);
    expect(sql).toMatch(/CREATE ROLE harbour_app NOLOGIN/);
  });

  it('enables and forces row level security on every tenant table (0002 or later)', () => {
    const sql = laterMigrationsSql();
    for (const table of Object.values(TENANT_TABLES)) {
      expect(sql, `${table} ENABLE RLS`).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql, `${table} FORCE RLS`).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      );
      expect(sql, `${table} policy`).toMatch(
        new RegExp(`CREATE POLICY ${table}_tenant ON "${table}"`),
      );
    }
  });

  it('reads the tenant from app.current_org and fails closed when it is empty', () => {
    expect(sql).toMatch(/NULLIF\(current_setting\('app\.current_org', true\), ''\)::uuid/);
    expect(sql).toContain('USING (id = app_current_org())');
    expect(sql).toContain('USING (organization_id = app_current_org())');
    expect(sql).toContain('WITH CHECK (organization_id = app_current_org())');
  });

  it('installs the immutability and append-only triggers', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER quotes_accepted_immutable\s+BEFORE UPDATE OR DELETE ON "quotes"/,
    );
    expect(sql).toContain(
      "(to_jsonb(OLD) - 'status' - 'updated_at') <> (to_jsonb(NEW) - 'status' - 'updated_at')",
    );
    expect(sql).toMatch(
      /CREATE TRIGGER quote_lines_accepted_immutable\s+BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines"/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER shipment_events_append_only\s+BEFORE UPDATE OR DELETE ON "shipment_events"/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER audit_logs_append_only\s+BEFORE UPDATE OR DELETE ON "audit_logs"/,
    );
  });

  it('does not use non-idempotent CREATE POLICY / CREATE TRIGGER without a matching DROP IF EXISTS', () => {
    for (const m of sql.matchAll(/CREATE POLICY (\w+) ON "(\w+)"/g)) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of sql.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+ ON "(\w+)"/g)) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
  });
});

describe('0003_customs_profile_and_quote_1_1', () => {
  const sql = readMigration('0003_customs_profile_and_quote_1_1');
  const [, handWritten = ''] = sql.split('Part 2 — hand-written');

  it('adds the payment_method enum and the engine 1.1 quote columns additively', () => {
    expect(sql).toContain(
      `CREATE TYPE "payment_method" AS ENUM ('OWN_DEFERMENT', 'BROKER_DEFERMENT', 'CDS_CASH_ACCOUNT');`,
    );
    for (const col of ['assists_gbp', 'border_outlay', 'financing_fee', 'inland_vat_adjustment']) {
      expect(sql).toMatch(new RegExp(`"${col}" DECIMAL\\(14,2\\) NOT NULL DEFAULT 0`));
    }
    expect(sql).toContain('"vat_postponed" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toMatch(/ADD COLUMN\s+"payment_method" "payment_method",/);
    for (const col of [
      'assists_gbp',
      'allocated_financing_fee_gbp',
      'allocated_inland_vat_adjustment_gbp',
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}" DECIMAL\\(14,2\\) NOT NULL DEFAULT 0`));
    }
    // Additive only: nothing dropped, renamed or narrowed (comments — the rollback note — aside).
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b|ALTER COLUMN/);
  });

  it('installs the customs_profiles CHECK constraints', () => {
    expect(handWritten).toContain("CHECK (dan_number IS NULL OR dan_number ~ '^[0-9]{7}$')");
    expect(handWritten).toContain(
      "CHECK (payment_method <> 'OWN_DEFERMENT' OR dan_number IS NOT NULL)",
    );
    expect(handWritten).toMatch(
      /broker_deferment_fee_pct >= 0 AND broker_deferment_fee_pct <= 100/,
    );
    expect(handWritten).toMatch(/broker_deferment_minimum_gbp >= 0/);
    expect(handWritten).toContain(
      'CHECK (NOT cds_authority_granted OR cds_authority_confirmed_at IS NOT NULL)',
    );
  });

  it('installs the PVA trigger pair and grants customs_profiles to harbour_app', () => {
    expect(handWritten).toMatch(
      /CREATE TRIGGER customs_profiles_pva_requires_vat\s+BEFORE INSERT OR UPDATE ON "customs_profiles"/,
    );
    expect(handWritten).toMatch(
      /CREATE TRIGGER organizations_vat_required_by_pva\s+BEFORE UPDATE OF vat_registered, vat_number ON "organizations"/,
    );
    expect(handWritten).toContain('IF eligible IS NOT TRUE THEN'); // NULL (row hidden by RLS) rejects
    expect(handWritten).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "customs_profiles" TO harbour_app;',
    );
  });

  it('the hand-written part is idempotent', () => {
    for (const m of handWritten.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(handWritten).toContain(`DROP CONSTRAINT IF EXISTS ${m[1]};`);
    }
    for (const m of handWritten.matchAll(/CREATE POLICY (\w+) ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP POLICY IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(
      /CREATE TRIGGER (\w+)\s+BEFORE [A-Z ,_a-z]+? ON "(\w+)"/g,
    )) {
      expect(handWritten).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    expect(handWritten).not.toMatch(/CREATE FUNCTION/); // only CREATE OR REPLACE
  });
});

// M6
describe('0006_billing', () => {
  const sql = readMigration('0006_billing');
  const [, handWritten = ''] = sql.split('Part 2 — hand-written');

  it('adds the subscription_status enum, the organisation columns and stripe_events additively', () => {
    expect(sql).toContain(
      `CREATE TYPE "subscription_status" AS ENUM ('NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'INCOMPLETE', 'PAUSED');`,
    );
    expect(sql).toContain(`"subscription_status" "subscription_status" NOT NULL DEFAULT 'NONE'`);
    expect(sql).toContain('"cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false');
    for (const col of [
      'billing_email',
      'current_period_end',
      'plan_updated_at',
      'stripe_subscription_id',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN\\s+"${col}"`));
    }
    expect(sql).toContain('CREATE TABLE "stripe_events"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "organizations_stripe_subscription_id_key" ON "organizations"("stripe_subscription_id");',
    );
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b|ALTER COLUMN/);
  });

  it('stripe_events is a pass-through table: no RLS, granted to harbour_app; billing_email lower-cased', () => {
    expect(PASSTHROUGH_MODELS).toContain('StripeEvent');
    expect(sql).not.toContain('ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY');
    expect(handWritten).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "stripe_events" TO harbour_app;',
    );
    expect(handWritten).toContain(
      'CHECK (billing_email IS NULL OR billing_email = lower(billing_email))',
    );
    for (const m of handWritten.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(handWritten).toContain(`DROP CONSTRAINT IF EXISTS ${m[1]};`);
    }
  });

  it('carries the rollback note', () => {
    expect(sql).toMatch(/## Rollback/);
    expect(sql).toMatch(/Reversible: yes/);
  });
});
// end M6
// M3 (ADR-0012)
describe('0007_supplier_entities', () => {
  const sql = readMigration('0007_supplier_entities');
  const [generated = '', handWritten = ''] = sql.split('Part 2 — hand-written');

  it('adds the four enums, the supplier legal-entity columns (backfilled) and the product columns additively', () => {
    expect(sql).toContain(
      `CREATE TYPE "payment_term_type" AS ENUM ('PREPAID', 'NET', 'DEPOSIT_BALANCE');`,
    );
    expect(sql).toContain(
      `CREATE TYPE "balance_trigger" AS ENUM ('ON_SHIPMENT', 'AGAINST_BILL_OF_LADING', 'ON_ARRIVAL');`,
    );
    expect(sql).toContain(`CREATE TYPE "payout_partner" AS ENUM ('AIRWALLEX');`);
    expect(sql).toContain(`CREATE TYPE "payout_method_type" AS ENUM ('LOCAL', 'SWIFT');`);
    // NOT NULL columns on an existing table are added nullable, backfilled, then constrained.
    expect(generated).toMatch(/ADD COLUMN\s+"legal_name" TEXT,/);
    expect(generated).toContain(
      `UPDATE "suppliers" SET "legal_name" = "name" WHERE "legal_name" IS NULL;`,
    );
    expect(generated).toContain(
      `UPDATE "suppliers" SET "country_of_incorporation" = "country_code" WHERE "country_of_incorporation" IS NULL;`,
    );
    expect(generated).toContain(`ALTER TABLE "suppliers" ALTER COLUMN "legal_name" SET NOT NULL;`);
    expect(generated).toContain(
      `ALTER TABLE "suppliers" ALTER COLUMN "country_of_incorporation" SET NOT NULL;`,
    );
    for (const col of ['carton_length_cm', 'carton_width_cm', 'carton_height_cm']) {
      expect(generated).toMatch(new RegExp(`"${col}" DECIMAL\\(8,2\\)`));
    }
    expect(generated).toContain('"preference_eligible" BOOLEAN NOT NULL DEFAULT false');
    expect(generated).toMatch(/ALTER TABLE "products" ADD COLUMN\s+"archived_at" TIMESTAMP\(3\)/);
    // Additive only: nothing dropped, renamed or narrowed (comments — the rollback note — aside).
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b/);
    expect(statements).not.toMatch(/ALTER COLUMN "(?!legal_name|country_of_incorporation)/);
  });

  it('creates the three supplier sub-entity tables with composite FKs to (supplier_id, organization_id)', () => {
    for (const table of ['pickup_locations', 'payment_terms', 'payout_methods']) {
      expect(generated).toContain(`CREATE TABLE "${table}"`);
      expect(generated).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    }
    expect(generated).toContain(
      `CREATE UNIQUE INDEX "payment_terms_supplier_id_key" ON "payment_terms"("supplier_id");`,
    );
  });

  it('installs the CHECKs, the one-default-per-supplier partial index, RLS and grants', () => {
    expect(handWritten).toContain(`CHECK (closest_port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$')`);
    expect(handWritten).toMatch(
      /CREATE UNIQUE INDEX pickup_locations_one_default_per_supplier\s+ON "pickup_locations" \("supplier_id"\) WHERE is_default;/,
    );
    expect(handWritten).toContain(
      'CHECK (deposit_pct IS NULL OR (deposit_pct >= 0 AND deposit_pct <= 100))',
    );
    expect(handWritten).toContain('CHECK (net_days IS NULL OR net_days >= 0)');
    expect(handWritten).toContain(
      "CHECK (term_type <> 'DEPOSIT_BALANCE' OR (deposit_pct IS NOT NULL AND balance_trigger IS NOT NULL))",
    );
    expect(handWritten).toContain("CHECK (term_type <> 'NET' OR net_days IS NOT NULL)");
    // §7.3: never more than a masked suffix of an account identifier.
    expect(handWritten).toContain(
      `CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9A-Za-z]{1,4}$')`,
    );
    for (const table of ['pickup_locations', 'payment_terms', 'payout_methods']) {
      expect(handWritten).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO harbour_app;`,
      );
    }
  });
});

// M9
describe('0010_tracking', () => {
  const sql = readMigration('0010_tracking');
  const [, handWritten = ''] = sql.split('Part 2 — hand-written');

  it('is additive: new tables, nullable columns, enums; quote_id relaxed to nullable', () => {
    expect(sql).toContain(
      `CREATE TYPE "container_size_type" AS ENUM ('C20GP', 'C40GP', 'C40HC', 'C45HC');`,
    );
    expect(sql).toContain(
      `CREATE TYPE "vessel_poll_state" AS ENUM ('AT_SEA', 'COASTAL', 'APPROACHING', 'DOCKED', 'STALE');`,
    );
    expect(sql).toContain('CREATE TABLE "containers"');
    expect(sql).toContain('CREATE TABLE "active_vessels"');
    expect(sql).toContain('CREATE TABLE "ports"');
    expect(sql).toContain('ALTER COLUMN "quote_id" DROP NOT NULL');
    for (const col of [
      'container_id',
      'location_locode',
      'location_name',
      'latitude',
      'longitude',
      'vessel_imo',
      'payload_sha256',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN\\s+"${col}"`));
    }
    // Idempotency key becomes per organisation (fan-out to every tenant tracking a number).
    expect(sql).toContain('DROP INDEX "shipment_events_source_provider_event_id_key";');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "shipment_events_organization_id_source_provider_event_id_key"',
    );
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b/);
    expect(statements).not.toMatch(/SET NOT NULL/);
  });

  it('composite tenant FKs on containers and shipment_events.container_id', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("shipment_id", "organization_id") REFERENCES "shipments"("id", "organization_id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("container_id", "organization_id") REFERENCES "containers"("id", "organization_id")',
    );
  });

  it('installs the format CHECKs and the RLS block for containers', () => {
    expect(handWritten).toContain("CHECK (container_number ~ '^[A-Z]{4}[0-9]{7}$')");
    expect(handWritten).toContain("CHECK (imo ~ '^[0-9]{7}$')");
    expect(handWritten).toContain("CHECK (locode ~ '^[A-Z]{2}[A-Z0-9]{3}$')");
    expect(handWritten).toContain('CHECK (active_container_count >= 0)');
    expect(handWritten).toContain('ALTER TABLE "containers" ENABLE ROW LEVEL SECURITY;');
    expect(handWritten).toContain('ALTER TABLE "containers" FORCE ROW LEVEL SECURITY;');
    expect(handWritten).toMatch(/CREATE POLICY containers_tenant ON "containers"/);
  });

  it('the cross-tenant lookups are narrow, setting-gated SELECT policies', () => {
    expect(handWritten).toMatch(
      /CREATE POLICY containers_tracking_lookup ON "containers" FOR SELECT\s+USING \(app_tracking_container\(\) IS NOT NULL AND container_number = app_tracking_container\(\)\)/,
    );
    expect(handWritten).toMatch(
      /CREATE POLICY shipments_tracking_sweep ON "shipments" FOR SELECT\s+USING \(app_tracking_sweep\(\) AND tracking_request_ref IS NOT NULL\)/,
    );
    expect(handWritten).toMatch(
      /CREATE POLICY shipment_events_tracking_sweep ON "shipment_events" FOR SELECT/,
    );
    expect(handWritten).toContain("NULLIF(current_setting('app.tracking_container', true), '')");
    expect(handWritten).toContain("current_setting('app.tracking_sweep', true) = 'on'");
  });

  it('grants: containers full, ports read-only, active_vessels no DELETE (role split TODO noted)', () => {
    expect(handWritten).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "containers" TO harbour_app;',
    );
    expect(handWritten).toContain('GRANT SELECT ON TABLE "ports" TO harbour_app;');
    expect(handWritten).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE "ports" FROM harbour_app;',
    );
    expect(handWritten).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "active_vessels" TO harbour_app;',
    );
    expect(handWritten).toContain('REVOKE DELETE ON TABLE "active_vessels" FROM harbour_app;');
    expect(sql).toMatch(/TODO — split app\/worker roles/);
  });

  it('seeds the Port table with the rate-sheet ports and the choke points', () => {
    for (const locode of [
      'CNSHA',
      'CNNGB',
      'CNSZX',
      'INNSA',
      'TRIST',
      'GBFXT',
      'GBSOU',
      'GBLGP',
      'SGSIN',
      'EGSUZ',
      'EGPSD',
      'MYPKG',
      'AEJEA',
      'NLRTM',
      'DEHAM',
      'BEANR',
      'LKCMB',
    ]) {
      expect(handWritten, locode).toMatch(new RegExp(`\\('${locode}',`));
    }
    expect(handWritten).toContain('ON CONFLICT (locode) DO NOTHING;');
  });

  it('the hand-written part is idempotent', () => {
    for (const m of handWritten.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(handWritten).toContain(`DROP CONSTRAINT IF EXISTS ${m[1]};`);
    }
    for (const m of handWritten.matchAll(/CREATE POLICY (\w+) ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP POLICY IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(/CREATE UNIQUE INDEX (\w+)/g)) {
      expect(handWritten).toContain(`DROP INDEX IF EXISTS ${m[1]};`);
    }
    expect(handWritten).not.toMatch(/CREATE FUNCTION/); // only CREATE OR REPLACE
    expect(handWritten).not.toMatch(/CREATE TRIGGER/);
  });
});

// M7 (ADR-0013)
describe('0012_purchase_orders', () => {
  const sql = readMigration('0012_purchase_orders');
  const [generated = '', handWritten = ''] = sql.split('Part 2 — hand-written');

  it('is additive: the status enum, three tenant tables, quotes.purchase_order_id and the composite FKs', () => {
    expect(generated).toContain(
      `CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'ISSUED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'CLOSED', 'CANCELLED');`,
    );
    for (const table of ['purchase_orders', 'purchase_order_items', 'po_counters']) {
      expect(generated).toContain(`CREATE TABLE "${table}"`);
    }
    expect(generated).toMatch(/ALTER TABLE "quotes" ADD COLUMN\s+"purchase_order_id" UUID;/);
    // Money: Decimal(14,4) unit costs, Decimal(14,2) totals, Decimal(5,2) percent (ADR-0013).
    expect(generated).toContain('"unit_cost" DECIMAL(14,4) NOT NULL');
    expect(generated).toContain('"line_total" DECIMAL(14,2) NOT NULL');
    expect(generated).toContain('"total_goods_value" DECIMAL(14,2) NOT NULL DEFAULT 0');
    expect(generated).toContain('"deposit_pct" DECIMAL(5,2)');
    expect(generated).toContain('"expected_ship_month" DATE');
    // Composite tenant FKs.
    expect(generated).toContain(
      'FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id")',
    );
    expect(generated).toContain(
      'FOREIGN KEY ("pickup_location_id", "supplier_id", "organization_id") REFERENCES "pickup_locations"("id", "supplier_id", "organization_id")',
    );
    expect(generated).toContain(
      'ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'FOREIGN KEY ("product_id", "organization_id") REFERENCES "products"("id", "organization_id")',
    );
    expect(generated).toContain(
      'ALTER TABLE "quotes" ADD CONSTRAINT "quotes_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'CREATE UNIQUE INDEX "purchase_orders_organization_id_po_number_key" ON "purchase_orders"("organization_id", "po_number");',
    );
    expect(generated).toContain(
      'CREATE UNIQUE INDEX "po_counters_organization_id_year_key" ON "po_counters"("organization_id", "year");',
    );
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b|ALTER COLUMN/);
  });

  it('installs the CHECKs, the one-accepted-quote-per-PO partial index and the triggers', () => {
    expect(handWritten).toContain("CHECK (po_number ~ '^PO-[0-9]{4}-[0-9]{3,}$')");
    expect(handWritten).toContain("CHECK (currency ~ '^[A-Z]{3}$')");
    expect(handWritten).toContain(
      'CHECK (deposit_pct IS NULL OR (deposit_pct >= 0 AND deposit_pct <= 100))',
    );
    expect(handWritten).toContain(
      'CHECK (deposit_amount IS NULL OR balance_amount IS NULL OR deposit_amount + balance_amount = total_goods_value)',
    );
    expect(handWritten).toContain(
      "CHECK (status IN ('DRAFT', 'CANCELLED') OR issued_at IS NOT NULL)",
    );
    expect(handWritten).toContain(
      'CHECK (expected_ship_month IS NULL OR EXTRACT(DAY FROM expected_ship_month) = 1)',
    );
    expect(handWritten).toContain('CHECK (quantity > 0)');
    expect(handWritten).toContain('CHECK (unit_cost >= 0 AND line_total >= 0)');
    expect(handWritten).toMatch(
      /CREATE UNIQUE INDEX quotes_one_accepted_per_po\s+ON "quotes" \("purchase_order_id"\) WHERE status = 'ACCEPTED';/,
    );
    expect(handWritten).toMatch(
      /CREATE TRIGGER purchase_orders_guard\s+BEFORE UPDATE OR DELETE ON "purchase_orders"/,
    );
    expect(handWritten).toMatch(
      /CREATE TRIGGER purchase_order_items_frozen\s+BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_items"/,
    );
    // The frozen-row comparison strips exactly status, the payment dates, notes and updated_at.
    expect(handWritten).toContain(
      "(to_jsonb(OLD) - 'status' - 'deposit_due_at' - 'deposit_paid_at' - 'balance_due_at' - 'balance_paid_at' - 'notes' - 'updated_at')",
    );
    // The ADR-0013 transition table.
    for (const move of [
      'DRAFT>ISSUED',
      'ISSUED>IN_PRODUCTION',
      'ISSUED>READY_TO_SHIP',
      'IN_PRODUCTION>READY_TO_SHIP',
      'READY_TO_SHIP>SHIPPED',
      'SHIPPED>CLOSED',
    ]) {
      expect(handWritten).toContain(`'${move}'`);
    }
    expect(handWritten).toContain(
      "(NEW.status = 'CANCELLED' AND OLD.status NOT IN ('CLOSED', 'CANCELLED'))",
    );
  });

  it('installs RLS and grants for the three tables', () => {
    for (const table of ['purchase_orders', 'purchase_order_items', 'po_counters']) {
      expect(handWritten).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(handWritten).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(handWritten).toMatch(new RegExp(`CREATE POLICY ${table}_tenant ON "${table}"`));
      expect(handWritten).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO harbour_app;`,
      );
    }
    expect(sql).toMatch(/## Rollback/);
    expect(sql).toMatch(/Reversible: yes/);
  });

  it('the hand-written part is idempotent', () => {
    for (const m of handWritten.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(handWritten).toContain(`DROP CONSTRAINT IF EXISTS ${m[1]};`);
    }
    for (const m of handWritten.matchAll(/CREATE POLICY (\w+) ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP POLICY IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+ ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(/CREATE UNIQUE INDEX (\w+)/g)) {
      expect(handWritten).toContain(`DROP INDEX IF EXISTS ${m[1]};`);
    }
    expect(handWritten).not.toMatch(/CREATE FUNCTION/); // only CREATE OR REPLACE
  });
});

// M8 (ADR-0014)
describe('0013_bills', () => {
  const sql = readMigration('0013_bills');
  const [generated = '', handWritten = ''] = sql.split('Part 2 — hand-written');

  it('is additive: five enums, three tenant tables, the composite FKs and the two new unique targets', () => {
    expect(generated).toContain(
      `CREATE TYPE "vendor_type" AS ENUM ('SUPPLIER', 'FORWARDER', 'CUSTOMS_BROKER', 'HMRC', 'OTHER');`,
    );
    expect(generated).toContain(
      `CREATE TYPE "bill_type" AS ENUM ('SUPPLIER_INVOICE', 'FREIGHT_INVOICE', 'CUSTOMS_CHARGES', 'CUSTOMS_STATEMENT', 'OTHER');`,
    );
    expect(generated).toContain(`CREATE TYPE "bill_status" AS ENUM ('DRAFT', 'POSTED', 'PAID');`);
    // One-to-one with the engine's COST_CATEGORIES.
    expect(generated).toContain(
      `CREATE TYPE "cost_category" AS ENUM ('GOODS', 'ASSISTS', 'FREIGHT_TO_BORDER', 'FREIGHT_POST_BORDER', 'ORIGIN_FEES', 'DESTINATION_FEES', 'CLEARANCE', 'INSURANCE', 'DUTY', 'IMPORT_VAT', 'DEFERMENT_FEE', 'UNPLANNED', 'OTHER');`,
    );
    expect(generated).toContain(
      `CREATE TYPE "unplanned_reason" AS ENUM ('DEMURRAGE', 'DETENTION', 'STORAGE', 'CUSTOMS_EXAMINATION', 'OTHER');`,
    );
    for (const table of ['bills', 'bill_lines', 'bill_payments']) {
      expect(generated).toContain(`CREATE TABLE "${table}"`);
    }
    // Money: Decimal(14,2) amounts in the bill currency, Decimal(14,6) FX on payments (ADR-0014).
    expect(generated).toContain('"total_amount" DECIMAL(14,2) NOT NULL');
    expect(generated).toContain('"amount" DECIMAL(14,2) NOT NULL');
    expect(generated).toContain('"fx_rate" DECIMAL(14,6) NOT NULL');
    expect(generated).toContain('"amount_gbp" DECIMAL(14,2) NOT NULL');
    expect(generated).toContain('"issued_on" DATE NOT NULL');
    expect(generated).toContain('"paid_on" DATE NOT NULL');
    // Composite tenant FKs.
    expect(generated).toContain(
      'ALTER TABLE "bills" ADD CONSTRAINT "bills_supplier_id_organization_id_fkey" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "suppliers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'ALTER TABLE "bills" ADD CONSTRAINT "bills_document_id_organization_id_fkey" FOREIGN KEY ("document_id", "organization_id") REFERENCES "documents"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_organization_id_fkey" FOREIGN KEY ("bill_id", "organization_id") REFERENCES "bills"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_purchase_order_id_organization_id_fkey" FOREIGN KEY ("purchase_order_id", "organization_id") REFERENCES "purchase_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'FOREIGN KEY ("purchase_order_item_id", "purchase_order_id", "organization_id") REFERENCES "purchase_order_items"("id", "purchase_order_id", "organization_id")',
    );
    expect(generated).toContain(
      'ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bill_id_organization_id_fkey" FOREIGN KEY ("bill_id", "organization_id") REFERENCES "bills"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
    expect(generated).toContain(
      'CREATE UNIQUE INDEX "documents_id_organization_id_key" ON "documents"("id", "organization_id");',
    );
    expect(generated).toContain(
      'CREATE UNIQUE INDEX "purchase_order_items_id_purchase_order_id_organization_id_key" ON "purchase_order_items"("id", "purchase_order_id", "organization_id");',
    );
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\bDROP (COLUMN|TABLE|TYPE)\b/);
    expect(statements).not.toMatch(/\bRENAME\b|ALTER COLUMN/);
  });

  it('installs the CHECKs, the reference-per-vendor partial indexes and the three triggers', () => {
    expect(handWritten).toContain("CHECK (currency ~ '^[A-Z]{3}$')");
    expect(handWritten).toContain('CHECK (total_amount >= 0)');
    expect(handWritten).toContain("(vendor_type = 'SUPPLIER' AND supplier_id IS NOT NULL)");
    expect(handWritten).toContain(
      "(vendor_type <> 'SUPPLIER' AND supplier_id IS NULL AND vendor_name IS NOT NULL AND btrim(vendor_name) <> '')",
    );
    expect(handWritten).toContain("(status = 'DRAFT' AND posted_at IS NULL AND paid_at IS NULL)");
    expect(handWritten).toContain(
      "(status = 'PAID' AND posted_at IS NOT NULL AND paid_at IS NOT NULL)",
    );
    expect(handWritten).toContain('CHECK (due_on IS NULL OR due_on >= issued_on)');
    expect(handWritten).toContain(
      "CHECK ((cost_category = 'UNPLANNED') = (unplanned_reason IS NOT NULL))",
    );
    expect(handWritten).toContain('CHECK (amount > 0 AND fx_rate > 0 AND amount_gbp >= 0)');
    expect(handWritten).toMatch(
      /CREATE UNIQUE INDEX bills_one_reference_per_supplier\s+ON "bills" \("organization_id", "supplier_id", "reference_number"\) WHERE supplier_id IS NOT NULL;/,
    );
    expect(handWritten).toMatch(
      /CREATE UNIQUE INDEX bills_one_reference_per_vendor\s+ON "bills" \("organization_id", lower\("vendor_name"\), "reference_number"\) WHERE supplier_id IS NULL;/,
    );
    expect(handWritten).toMatch(/CREATE TRIGGER bills_guard\s+BEFORE UPDATE OR DELETE ON "bills"/);
    expect(handWritten).toMatch(
      /CREATE TRIGGER bill_lines_frozen\s+BEFORE INSERT OR UPDATE OR DELETE ON "bill_lines"/,
    );
    expect(handWritten).toMatch(
      /CREATE TRIGGER bill_payments_guard\s+BEFORE INSERT OR UPDATE OR DELETE ON "bill_payments"/,
    );
    // Posting compares the lines with the total; the frozen-row comparison strips exactly
    // status, paid_at, document_id, notes and updated_at.
    expect(handWritten).toContain('IF line_sum <> NEW.total_amount THEN');
    expect(handWritten).toContain(
      "(to_jsonb(OLD) - 'status' - 'paid_at' - 'document_id' - 'notes' - 'updated_at')",
    );
    expect(handWritten).toContain("ARRAY['DRAFT>POSTED', 'POSTED>PAID', 'PAID>POSTED']");
  });

  it('installs RLS and grants for the three tables', () => {
    for (const table of ['bills', 'bill_lines', 'bill_payments']) {
      expect(handWritten).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(handWritten).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(handWritten).toMatch(new RegExp(`CREATE POLICY ${table}_tenant ON "${table}"`));
      expect(handWritten).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO harbour_app;`,
      );
    }
    expect(sql).toMatch(/## Rollback/);
    expect(sql).toMatch(/Reversible: yes/);
  });

  it('the hand-written part is idempotent', () => {
    for (const m of handWritten.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(handWritten).toContain(`DROP CONSTRAINT IF EXISTS ${m[1]};`);
    }
    for (const m of handWritten.matchAll(/CREATE POLICY (\w+) ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP POLICY IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE [A-Z ]+ ON "(\w+)"/g)) {
      expect(handWritten).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON "${m[2]}";`);
    }
    for (const m of handWritten.matchAll(/CREATE UNIQUE INDEX (\w+)/g)) {
      expect(handWritten).toContain(`DROP INDEX IF EXISTS ${m[1]};`);
    }
    expect(handWritten).not.toMatch(/CREATE FUNCTION/); // only CREATE OR REPLACE
  });
});
