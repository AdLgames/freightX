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
        'customs_profiles',
        'documents',
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
  });
});
