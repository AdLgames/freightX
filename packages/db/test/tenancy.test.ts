import { describe, expect, it } from 'vitest';
import {
  PASSTHROUGH_MODELS,
  TENANT_MODELS,
  TENANT_TABLES,
  TenantScopeError,
  assertUuid,
  scopeArgs,
} from '../src/tenancy.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER_ORG = '99999999-8888-4777-8666-555555555555';

const scoped = (op: string, args: unknown, model = 'Product') => scopeArgs(model, op, args, ORG);

describe('scopeArgs — filter operations', () => {
  it('injects where on findMany without an existing where', () => {
    expect(scoped('findMany', undefined)).toEqual({ where: { organizationId: ORG } });
    expect(scoped('findMany', {})).toEqual({ where: { organizationId: ORG } });
  });

  it('ANDs the tenant clause with an existing where (caller can narrow, never widen)', () => {
    const out = scoped('findMany', { where: { sku: 'A-1' }, take: 10, orderBy: { sku: 'asc' } });
    expect(out).toEqual({
      where: { AND: [{ sku: 'A-1' }, { organizationId: ORG }] },
      take: 10,
      orderBy: { sku: 'asc' },
    });
  });

  it('a caller-supplied organizationId for another org is ANDed away, not honoured', () => {
    const out = scoped('findMany', { where: { organizationId: OTHER_ORG } });
    expect(out.where).toEqual({ AND: [{ organizationId: OTHER_ORG }, { organizationId: ORG }] });
  });

  it.each([
    'findFirst',
    'findFirstOrThrow',
    'count',
    'aggregate',
    'groupBy',
    'deleteMany',
    'updateManyAndReturn',
  ])('%s gets the tenant where', (op) => {
    const out = scoped(op, { where: { name: 'x' } });
    expect(out.where).toEqual({ AND: [{ name: 'x' }, { organizationId: ORG }] });
  });

  it('updateMany scopes where and rejects re-homing data', () => {
    expect(scoped('updateMany', { where: { sku: 'A' }, data: { name: 'n' } })).toEqual({
      where: { AND: [{ sku: 'A' }, { organizationId: ORG }] },
      data: { name: 'n' },
    });
    expect(() => scoped('updateMany', { data: { organizationId: OTHER_ORG } })).toThrow(
      TenantScopeError,
    );
  });

  it('does not mutate the caller args', () => {
    const args = { where: { sku: 'A' } };
    scoped('findMany', args);
    expect(args).toEqual({ where: { sku: 'A' } });
  });
});

describe('scopeArgs — unique operations', () => {
  it('findUnique keeps its operation shape and ANDs organizationId into the unique where', () => {
    const out = scoped('findUnique', { where: { id: 'p1' }, select: { id: true } });
    expect(out).toEqual({
      where: { id: 'p1', AND: [{ organizationId: ORG }] },
      select: { id: true },
    });
  });

  it('findUnique via a compound unique key that names another org still cannot escape', () => {
    const out = scoped('findUnique', {
      where: { organizationId_sku: { organizationId: OTHER_ORG, sku: 'A' } },
    });
    expect(out.where).toEqual({
      organizationId_sku: { organizationId: OTHER_ORG, sku: 'A' },
      AND: [{ organizationId: ORG }],
    });
  });

  it('preserves an existing AND on the unique where', () => {
    const out = scoped('findUniqueOrThrow', { where: { id: 'p1', AND: { name: 'x' } } });
    expect(out.where).toEqual({ id: 'p1', AND: [{ name: 'x' }, { organizationId: ORG }] });
  });

  it('update / delete are verified in the same statement via the unique where', () => {
    expect(scoped('update', { where: { id: 'p1' }, data: { name: 'n' } })).toEqual({
      where: { id: 'p1', AND: [{ organizationId: ORG }] },
      data: { name: 'n' },
    });
    expect(scoped('delete', { where: { id: 'p1' } })).toEqual({
      where: { id: 'p1', AND: [{ organizationId: ORG }] },
    });
  });

  it('update refuses to move a row to another tenant', () => {
    expect(() =>
      scoped('update', { where: { id: 'p1' }, data: { organizationId: OTHER_ORG } }),
    ).toThrow(/organizationId cannot be changed/);
    expect(() =>
      scoped('update', {
        where: { id: 'p1' },
        data: { organization: { connect: { id: OTHER_ORG } } },
      }),
    ).toThrow(TenantScopeError);
    // Same value is a harmless no-op.
    expect(() =>
      scoped('update', { where: { id: 'p1' }, data: { organizationId: ORG } }),
    ).not.toThrow();
  });
});

describe('scopeArgs — writes', () => {
  it('create injects organizationId into data', () => {
    const out = scoped('create', { data: { sku: 'A', name: 'n' } });
    expect(out).toEqual({ data: { sku: 'A', name: 'n', organizationId: ORG } });
  });

  it('create accepts the same organizationId (types require it) and rejects another tenant', () => {
    expect(scoped('create', { data: { sku: 'A', organizationId: ORG } }).data).toEqual({
      sku: 'A',
      organizationId: ORG,
    });
    expect(() => scoped('create', { data: { sku: 'A', organizationId: OTHER_ORG } })).toThrow(
      /must be the current organization/,
    );
  });

  it('create normalises organization.connect for the same org and rejects any other relation write', () => {
    expect(
      scoped('create', { data: { sku: 'A', organization: { connect: { id: ORG } } } }).data,
    ).toEqual({
      sku: 'A',
      organizationId: ORG,
    });
    expect(() =>
      scoped('create', { data: { sku: 'A', organization: { connect: { id: OTHER_ORG } } } }),
    ).toThrow(TenantScopeError);
    expect(() =>
      scoped('create', { data: { sku: 'A', organization: { create: { name: 'x' } } } }),
    ).toThrow(TenantScopeError);
  });

  it('createMany / createManyAndReturn inject into every row and reject a foreign row', () => {
    const out = scoped('createMany', { data: [{ sku: 'A' }, { sku: 'B', organizationId: ORG }] });
    expect(out.data).toEqual([
      { sku: 'A', organizationId: ORG },
      { sku: 'B', organizationId: ORG },
    ]);
    expect(() =>
      scoped('createMany', { data: [{ sku: 'A' }, { sku: 'B', organizationId: OTHER_ORG }] }),
    ).toThrow(TenantScopeError);
    expect(scoped('createManyAndReturn', { data: { sku: 'C' } }).data).toEqual({
      sku: 'C',
      organizationId: ORG,
    });
  });

  it('upsert scopes where, injects into create and guards update', () => {
    const out = scoped('upsert', {
      where: { id: 'p1' },
      create: { sku: 'A' },
      update: { name: 'n' },
    });
    expect(out).toEqual({
      where: { id: 'p1', AND: [{ organizationId: ORG }] },
      create: { sku: 'A', organizationId: ORG },
      update: { name: 'n' },
    });
    expect(() =>
      scoped('upsert', { where: { id: 'p1' }, create: {}, update: { organizationId: OTHER_ORG } }),
    ).toThrow(TenantScopeError);
  });
});

describe('scopeArgs — Organization is keyed by id', () => {
  it('reads are pinned to the current org id', () => {
    expect(scoped('findMany', undefined, 'Organization')).toEqual({ where: { id: ORG } });
    expect(scoped('findUnique', { where: { id: OTHER_ORG } }, 'Organization').where).toEqual({
      id: OTHER_ORG,
      AND: [{ id: ORG }],
    });
  });

  it('create forces the id (RLS requires app.current_org = id for the insert)', () => {
    expect(scoped('create', { data: { name: 'Acme' } }, 'Organization').data).toEqual({
      name: 'Acme',
      id: ORG,
    });
  });
});

describe('scopeArgs — allow-lists', () => {
  it('pass-through models are returned untouched', () => {
    for (const model of PASSTHROUGH_MODELS) {
      const args = { where: { id: 'x' }, data: { a: 1 } };
      expect(scopeArgs(model, 'findMany', args, ORG)).toEqual(args);
      expect(scopeArgs(model, 'create', args, ORG)).toEqual(args);
    }
  });

  it('a model in neither list throws MODEL_NOT_ALLOWLISTED', () => {
    expect(() => scopeArgs('Invoice', 'findMany', {}, ORG)).toThrow(TenantScopeError);
    try {
      scopeArgs('Invoice', 'findMany', {}, ORG);
    } catch (err) {
      expect((err as TenantScopeError).code).toBe('MODEL_NOT_ALLOWLISTED');
    }
  });

  it('an operation it cannot scope throws rather than passing through', () => {
    expect(() => scoped('findRaw', {})).toThrow(/not a scoped operation/);
  });

  it('every tenant model has a table mapping and the lists do not overlap', () => {
    for (const m of TENANT_MODELS) expect(TENANT_TABLES[m]).toMatch(/^[a-z_]+$/);
    const overlap = TENANT_MODELS.filter((m) =>
      (PASSTHROUGH_MODELS as readonly string[]).includes(m),
    );
    expect(overlap).toEqual([]);
  });
});

describe('assertUuid', () => {
  it('accepts canonical uuids and rejects anything else', () => {
    expect(() => assertUuid(ORG)).not.toThrow();
    expect(() => assertUuid(ORG.toUpperCase())).not.toThrow();
    for (const bad of [
      '',
      'abc',
      `${ORG}'; DROP TABLE quotes; --`,
      42,
      null,
      undefined,
      `${ORG} `,
    ]) {
      expect(() => assertUuid(bad)).toThrow(TenantScopeError);
    }
    expect(() => scopeArgs('Product', 'findMany', {}, 'not-a-uuid')).toThrow(/must be a UUID/);
  });
});
