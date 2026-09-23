import type { Prisma, PrismaClient } from '../generated/client/index.js';
import type { ITXClientDenyList } from '../generated/client/runtime/library.js';

/**
 * Tenant scoping — first line of defence (§7.2). Postgres RLS (migration 0002) is the second.
 *
 * Two layers, use both:
 *   1. `forOrganization(prisma, orgId)` — a Prisma client extension that rewrites the arguments of
 *      every model operation so it can only touch rows of one organisation (`scopeArgs` below).
 *   2. `withOrgTransaction(prisma, orgId, fn)` — runs `fn` on a scoped *transaction* client after
 *      `set_config('app.current_org', orgId, true)`, which is what the RLS policies read.
 *
 * Because the tenant tables have FORCE ROW LEVEL SECURITY and the app connects as a non-superuser,
 * a bare `forOrganization(...)` client outside `withOrgTransaction` sees NO rows: the DB context is
 * missing and the policies fail closed. Every loader/action therefore does its DB work inside
 * `withOrgTransaction`. That is deliberate.
 *
 * Known limits of layer 1 (all caught by layer 2):
 *   - Nested relation reads/writes (`include`, `select`, nested `connect`/`create`) do not pass
 *     through `$allOperations`. They start from an already-scoped row, but are not re-filtered.
 *   - `$queryRaw` / `$executeRaw` are not scoped. They run under RLS only.
 *
 * `scopeArgs` is a pure function so the rewriting is unit-tested without a database.
 */

// ---------- Allow-lists ----------

/** Every model that carries organizationId (or IS the organisation). Prisma model names. */
export const TENANT_MODELS = [
  'Organization',
  'Membership',
  'Supplier',
  'Product',
  'Quote',
  'QuoteLine',
  'Shipment',
  'ShipmentEvent',
  'Document',
  'AuditLog',
  'OutboxEvent',
] as const;
export type TenantModel = (typeof TENANT_MODELS)[number];

/** Global models: no organizationId, no RLS. Queried unchanged through a scoped client. */
export const PASSTHROUGH_MODELS = [
  'User',
  'FxRate',
  'TariffCache',
  'MagicLinkToken',
  'EmailSignup',
] as const;
export type PassthroughModel = (typeof PASSTHROUGH_MODELS)[number];

/** Prisma model → Postgres table (`@@map`). test/migrations.test.ts checks this against the schema and RLS. */
export const TENANT_TABLES: Readonly<Record<TenantModel, string>> = {
  Organization: 'organizations',
  Membership: 'memberships',
  Supplier: 'suppliers',
  Product: 'products',
  Quote: 'quotes',
  QuoteLine: 'quote_lines',
  Shipment: 'shipments',
  ShipmentEvent: 'shipment_events',
  Document: 'documents',
  AuditLog: 'audit_logs',
  OutboxEvent: 'outbox_events',
};

export const isTenantModel = (model: string): model is TenantModel =>
  (TENANT_MODELS as readonly string[]).includes(model);
export const isPassthroughModel = (model: string): model is PassthroughModel =>
  (PASSTHROUGH_MODELS as readonly string[]).includes(model);

// ---------- Errors ----------

export type TenantScopeErrorCode =
  | 'MODEL_NOT_ALLOWLISTED'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_ORGANIZATION_ID'
  | 'CROSS_TENANT_WRITE'
  | 'NOT_FOUND_IN_SCOPE';

export class TenantScopeError extends Error {
  override readonly name = 'TenantScopeError';
  constructor(
    readonly code: TenantScopeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------- UUID guard ----------

/** Hex + dashes only. Anything that reaches SQL (even parameterised) is validated first. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, what = 'organizationId'): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TenantScopeError('INVALID_ORGANIZATION_ID', `${what} must be a UUID`);
  }
}

// ---------- Pure argument rewriting ----------

type Args = Record<string, unknown>;

/** Operations whose `where` is an ordinary (non-unique) filter. */
const FILTER_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

/**
 * Operations whose `where` is a WhereUniqueInput. Since Prisma 5 (`extendedWhereUnique`) a unique
 * where may carry non-unique filters and `AND`, so the tenant clause is AND-ed in and the operation
 * is left as-is (rewriting findUnique → findFirst would escape an interactive transaction).
 */
const UNIQUE_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);

const CREATE_MANY_OPERATIONS = new Set(['createMany', 'createManyAndReturn']);

/** The column the tenant clause targets: organisations are keyed by their own id. */
export const scopeField = (model: TenantModel): 'id' | 'organizationId' =>
  model === 'Organization' ? 'id' : 'organizationId';

const asObject = (value: unknown, what: string): Args => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantScopeError('UNSUPPORTED_OPERATION', `${what} must be an object`);
  }
  return value as Args;
};

const toArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/** Filter where: `{ AND: [callerWhere, tenantClause] }` — the caller can only narrow, never widen. */
const scopeFilterWhere = (where: unknown, clause: Args): Args =>
  where === undefined || where === null ? clause : { AND: [asObject(where, 'where'), clause] };

/** Unique where: keep the caller's unique selector at the top level, AND the tenant clause in. */
const scopeUniqueWhere = (where: unknown, clause: Args): Args => {
  const w = asObject(where, 'where');
  return { ...w, AND: [...toArray(w.AND), clause] };
};

/**
 * Create data: set the tenant column. The generated types still require `organizationId` on
 * unchecked create input, so callers usually pass it; a value naming another tenant is a bug and
 * is rejected loudly rather than silently rewritten. A relation-style
 * `organization: { connect: { id } }` is accepted only for the same id and normalised to the scalar
 * (the scalar form is what the composite FKs and RLS need).
 */
const scopeCreateData = (model: TenantModel, data: unknown, organizationId: string): Args => {
  const { organization, ...rest } = asObject(data, 'data');
  const field = scopeField(model);
  if (field in rest && rest[field] !== organizationId) {
    throw new TenantScopeError(
      'CROSS_TENANT_WRITE',
      `${model}: ${field} must be the current organization`,
    );
  }
  if (organization !== undefined) {
    const relation: { connect?: { id?: unknown } } =
      typeof organization === 'object' && organization !== null ? organization : {};
    if (Object.keys(relation).length !== 1 || relation.connect?.id !== organizationId) {
      throw new TenantScopeError(
        'CROSS_TENANT_WRITE',
        `${model}: organization relation must connect to the current organization (prefer the organizationId scalar)`,
      );
    }
  }
  return { ...rest, [field]: organizationId };
};

/** Update data must not try to re-home a row (RLS WITH CHECK would also reject it). */
const guardUpdateData = (model: TenantModel, data: unknown, organizationId: string): void => {
  const d = asObject(data, 'data');
  const field = scopeField(model);
  if (field in d && d[field] !== organizationId) {
    throw new TenantScopeError('CROSS_TENANT_WRITE', `${model}: ${field} cannot be changed`);
  }
  if ('organization' in d) {
    throw new TenantScopeError(
      'CROSS_TENANT_WRITE',
      `${model}: organization relation cannot be changed`,
    );
  }
};

/**
 * Rewrites `args` of `model.operation` so the call is confined to `organizationId`.
 * Pure: no I/O, never mutates its input. Throws TenantScopeError for models outside both
 * allow-lists and for operations it does not know how to scope (fail closed).
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  organizationId: string,
): Args {
  if (isPassthroughModel(model)) return asObject(args, 'args');
  if (!isTenantModel(model)) {
    throw new TenantScopeError(
      'MODEL_NOT_ALLOWLISTED',
      `model ${model} is not allow-listed as tenant or pass-through; add it to src/tenancy.ts`,
    );
  }
  assertUuid(organizationId);

  const a = asObject(args, 'args');
  const clause: Args = { [scopeField(model)]: organizationId };

  if (FILTER_OPERATIONS.has(operation)) {
    if (operation === 'updateMany' || operation === 'updateManyAndReturn') {
      guardUpdateData(model, a.data, organizationId);
    }
    return { ...a, where: scopeFilterWhere(a.where, clause) };
  }
  if (UNIQUE_OPERATIONS.has(operation)) {
    if (operation === 'update') guardUpdateData(model, a.data, organizationId);
    return { ...a, where: scopeUniqueWhere(a.where, clause) };
  }
  if (operation === 'create') {
    return { ...a, data: scopeCreateData(model, a.data, organizationId) };
  }
  if (CREATE_MANY_OPERATIONS.has(operation)) {
    const data = Array.isArray(a.data)
      ? a.data.map((d) => scopeCreateData(model, d, organizationId))
      : scopeCreateData(model, a.data, organizationId);
    return { ...a, data };
  }
  if (operation === 'upsert') {
    guardUpdateData(model, a.update, organizationId);
    return {
      ...a,
      where: scopeUniqueWhere(a.where, clause),
      create: scopeCreateData(model, a.create, organizationId),
    };
  }
  throw new TenantScopeError(
    'UNSUPPORTED_OPERATION',
    `${model}.${operation} is not a scoped operation; use withOrgTransaction and raw SQL under RLS if it is really needed`,
  );
}

// ---------- Runtime: client extension ----------

const isRecordNotFound = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';

/**
 * A Prisma client that can only address one organisation. Combine with `withOrgTransaction` so the
 * RLS context is set too; see the module comment.
 */
export function forOrganization(prisma: PrismaClient, organizationId: string) {
  assertUuid(organizationId);
  return prisma.$extends({
    name: 'harbour-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scoped = scopeArgs(model, operation, args, organizationId);
          try {
            return await query(scoped);
          } catch (err) {
            if (isRecordNotFound(err) && (operation === 'update' || operation === 'delete')) {
              // Prisma's "record not found" here means "not found in this tenant"; that is all a
              // caller may learn about rows outside its organisation.
              throw new TenantScopeError(
                'NOT_FOUND_IN_SCOPE',
                `${model}.${operation}: no row matched within the current organization`,
                { cause: err },
              );
            }
            throw err;
          }
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof forOrganization>;
export type TenantTransactionClient = Omit<TenantClient, ITXClientDenyList>;

export interface OrgTransactionOptions {
  /** Also sets `app.current_user` (lets the organizations/memberships "own membership" policies apply). */
  userId?: string;
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Runs `fn(tx)` in one interactive transaction whose first statement is
 * `SELECT set_config('app.current_org', $1, true)` — the parameterised equivalent of
 * `SET LOCAL app.current_org = '...'`. `tx` is also argument-scoped via `forOrganization`.
 */
export async function withOrgTransaction<T>(
  prisma: PrismaClient,
  organizationId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>,
  options: OrgTransactionOptions = {},
): Promise<T> {
  assertUuid(organizationId);
  const { userId, ...txOptions } = options;
  if (userId !== undefined) assertUuid(userId, 'userId');

  const scoped = forOrganization(prisma, organizationId);
  return scoped.$transaction(async (tx) => {
    // Raw SQL (reviewed): Prisma has no API for session settings; the value is a bound parameter.
    await tx.$queryRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
    if (userId !== undefined) {
      await tx.$queryRaw`SELECT set_config('app.current_user', ${userId}, true)`;
    }
    return fn(tx);
  }, txOptions);
}

/**
 * Pre-organisation flows only (just logged in, listing the user's organisations). Sets
 * `app.current_user` and nothing else: under RLS the user sees their own memberships and the
 * organisations those point at, and no other tenant row. Not argument-scoped.
 */
export async function withUserTransaction<T>(
  prisma: PrismaClient,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: Omit<OrgTransactionOptions, 'userId'> = {},
): Promise<T> {
  assertUuid(userId, 'userId');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_user', ${userId}, true)`;
    return fn(tx);
  }, options);
}
