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
  });
});

describe('schema ↔ allow-lists', () => {
  const blocks = modelBlocks();

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

describe('0001_init', () => {
  const sql = readMigration('0001_init');

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

  it('enables and forces row level security on every tenant table', () => {
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
