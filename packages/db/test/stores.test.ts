/**
 * Pure unit tests for src/stores.ts — no database. The Prisma client is replaced by a minimal
 * stub that records the arguments it receives. Round trips against Postgres live in
 * stores.db.test.ts.
 */
import type { FxRateRecord, NormalisedCommodity } from '@harbour/adapters';
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaEmailSignupRepository,
  PrismaFxRateStore,
  PrismaTariffCacheStore,
  SIGNUP_SOURCE_UNKNOWN,
  TARIFF_CACHE_ANY_ORIGIN,
  fxRecordToRow,
  isoDateToUtcMidnight,
  normalisedCommoditySchema,
  startOfUtcDay,
  utcIsoDate,
} from '../src/stores.js';
import { Prisma, type PrismaClient } from '../generated/client/index.js';
import { PASSTHROUGH_MODELS, scopeArgs } from '../src/tenancy.js';

const asClient = (stub: unknown) => stub as PrismaClient;

const commodity: NormalisedCommodity = {
  code: '6404199000',
  description: 'Footwear with outer soles of rubber',
  declarable: true,
  measures: [
    {
      sid: '20000001',
      measureTypeId: '103',
      dutyExpression: '8.00 %',
      geographicalAreaId: '1011',
      additionalCode: null,
      effectiveStartDate: '2021-01-01',
      effectiveEndDate: null,
    },
    {
      sid: '20000002',
      measureTypeId: '142',
      dutyExpression: '0.00 %',
      geographicalAreaId: '1013',
      geographicalAreaMembers: ['DE', 'FR'],
      excludedCountries: ['FR'],
    },
  ],
};

describe('normalisedCommoditySchema', () => {
  it('accepts a NormalisedCommodity unchanged (optional keys stay absent)', () => {
    const parsed = normalisedCommoditySchema.parse(commodity);
    expect(parsed).toEqual(commodity);
    expect('geographicalAreaMembers' in parsed.measures[0]!).toBe(false);
  });

  it('rejects corrupt payloads', () => {
    expect(normalisedCommoditySchema.safeParse(null).success).toBe(false);
    expect(normalisedCommoditySchema.safeParse({ ...commodity, measures: 'x' }).success).toBe(
      false,
    );
    expect(
      normalisedCommoditySchema.safeParse({
        ...commodity,
        measures: [{ ...commodity.measures[0], sid: 5 }],
      }).success,
    ).toBe(false);
  });
});

describe('PrismaTariffCacheStore', () => {
  it('reads the origin-wildcard row and returns the validated payload', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      hsCode: commodity.code,
      originCountry: TARIFF_CACHE_ANY_ORIGIN,
      fetchedAt: new Date('2026-09-23T10:00:00Z'),
      expiresAt: new Date('2026-09-24T10:00:00Z'),
      payload: commodity,
    });
    const store = new PrismaTariffCacheStore(asClient({ tariffCache: { findUnique } }));
    const got = await store.get(commodity.code);
    expect(findUnique).toHaveBeenCalledWith({
      where: { hsCode_originCountry: { hsCode: commodity.code, originCountry: '*' } },
    });
    expect(got?.value).toEqual(commodity);
    expect(got?.expiresAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it('treats a corrupt row as a miss and reports only issue paths', async () => {
    const onCorruptRow = vi.fn();
    const findUnique = vi.fn().mockResolvedValue({
      fetchedAt: new Date(),
      expiresAt: new Date(),
      payload: { code: '6404199000', measures: 'nope' },
    });
    const store = new PrismaTariffCacheStore(asClient({ tariffCache: { findUnique } }), {
      onCorruptRow,
    });
    expect(await store.get('6404199000')).toBeNull();
    expect(onCorruptRow).toHaveBeenCalledTimes(1);
    const info = onCorruptRow.mock.calls[0]![0] as { hsCode: string; issues: string[] };
    expect(info.hsCode).toBe('6404199000');
    expect(info.issues).toEqual(expect.arrayContaining(['description', 'measures']));
  });

  it('a missing row is a miss', async () => {
    const store = new PrismaTariffCacheStore(
      asClient({ tariffCache: { findUnique: vi.fn().mockResolvedValue(null) } }),
    );
    expect(await store.get('0101210000')).toBeNull();
  });

  it('set upserts on (code, "*") with the caller-decided expiry', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const store = new PrismaTariffCacheStore(asClient({ tariffCache: { upsert } }));
    const fetchedAt = new Date('2026-09-23T10:00:00Z');
    const expiresAt = new Date('2026-09-24T10:00:00Z'); // 24h, decided by UkTradeTariffClient
    await store.set(commodity.code, commodity, fetchedAt, expiresAt);
    const args = upsert.mock.calls[0]![0];
    expect(args.where).toEqual({
      hsCode_originCountry: { hsCode: commodity.code, originCountry: '*' },
    });
    expect(args.create).toEqual({
      hsCode: commodity.code,
      originCountry: '*',
      fetchedAt,
      expiresAt,
      payload: commodity,
    });
    expect(args.update).toEqual({ fetchedAt, expiresAt, payload: commodity });
  });
});

describe('FX date/decimal helpers', () => {
  it('isoDateToUtcMidnight parses calendar days and rejects anything else', () => {
    expect(isoDateToUtcMidnight('2026-09-30').toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(isoDateToUtcMidnight('2028-02-29').toISOString()).toBe('2028-02-29T00:00:00.000Z');
    for (const bad of ['2026-02-30', '2026-9-30', '2026-09-30T00:00:00Z', '', '30/09/2026']) {
      expect(() => isoDateToUtcMidnight(bad), bad).toThrow(RangeError);
    }
  });

  it('startOfUtcDay / utcIsoDate work in UTC regardless of the local zone', () => {
    const at = new Date('2026-09-30T23:59:59.999Z');
    expect(startOfUtcDay(at).toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(utcIsoDate(at)).toBe('2026-09-30');
  });

  const rec: FxRateRecord = {
    source: 'HMRC_MONTHLY',
    currency: 'USD',
    rateToGbp: '0.791234',
    validFrom: '2026-09-01',
    validTo: '2026-09-30',
  };

  it('fxRecordToRow keeps the rate as a Decimal (never a number) and dates as UTC midnight', () => {
    const row = fxRecordToRow(rec);
    expect(row.rateToGbp).toBeInstanceOf(Prisma.Decimal);
    expect(row.rateToGbp.toString()).toBe('0.791234');
    expect(row.validFrom.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(row.validTo.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('fxRecordToRow rejects malformed records instead of letting Postgres round them', () => {
    const bad: Array<Partial<FxRateRecord>> = [
      { rateToGbp: '0.7912345' }, // 7 dp: Decimal(14,6) would silently round
      { rateToGbp: '0' },
      { rateToGbp: '-1' },
      { rateToGbp: '1e-3' },
      { rateToGbp: 'abc' },
      { currency: 'usd' },
      { validFrom: '2026-09-31' },
      { validTo: '2026-08-31' }, // before validFrom
    ];
    for (const patch of bad) {
      expect(() => fxRecordToRow({ ...rec, ...patch }), JSON.stringify(patch)).toThrow(RangeError);
    }
  });
});

describe('PrismaFxRateStore', () => {
  it('find: latest validFrom <= at, validTo inclusive of its whole UTC day', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      source: 'HMRC_MONTHLY',
      currency: 'USD',
      rateToGbp: new Prisma.Decimal('0.791234'),
      validFrom: new Date('2026-09-01T00:00:00Z'),
      validTo: new Date('2026-09-30T00:00:00Z'),
    });
    const store = new PrismaFxRateStore(asClient({ fxRate: { findFirst } }));
    const at = new Date('2026-09-30T18:30:00Z');
    const got = await store.find('HMRC_MONTHLY', 'USD', at);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        source: 'HMRC_MONTHLY',
        currency: 'USD',
        validFrom: { lte: at },
        validTo: { gte: new Date('2026-09-30T00:00:00Z') },
      },
      orderBy: { validFrom: 'desc' },
    });
    expect(got).toEqual({
      source: 'HMRC_MONTHLY',
      currency: 'USD',
      rateToGbp: '0.791234',
      validFrom: '2026-09-01',
      validTo: '2026-09-30',
    });
  });

  it('find ignores rows with a source the engine does not know', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      source: 'SOMETHING_ELSE',
      currency: 'USD',
      rateToGbp: new Prisma.Decimal('1'),
      validFrom: new Date(),
      validTo: new Date(),
    });
    const store = new PrismaFxRateStore(asClient({ fxRate: { findFirst } }));
    expect(await store.find('HMRC_MONTHLY', 'USD', new Date())).toBeNull();
  });

  it('upsert validates every record before touching the database', async () => {
    const $transaction = vi.fn();
    const store = new PrismaFxRateStore(asClient({ $transaction, fxRate: { upsert: vi.fn() } }));
    await expect(
      store.upsert([
        {
          source: 'ECB',
          currency: 'EUR',
          rateToGbp: '0.85',
          validFrom: '2026-09-01',
          validTo: '2026-09-08',
        },
        {
          source: 'ECB',
          currency: 'USD',
          rateToGbp: 'NaN',
          validFrom: '2026-09-01',
          validTo: '2026-09-08',
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect($transaction).not.toHaveBeenCalled();
    await store.upsert([]);
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('PrismaEmailSignupRepository', () => {
  it('maps a duplicate (skipDuplicates → count 0) to created:false', async () => {
    const createMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      count: 0,
    });
    const repo = new PrismaEmailSignupRepository(asClient({ emailSignup: { createMany } }));
    const createdAt = new Date('2026-09-23T12:00:00Z');
    expect(await repo.add({ email: 'a@example.test', source: 'landing', createdAt })).toEqual({
      created: true,
    });
    expect(await repo.add({ email: 'a@example.test', source: null, createdAt })).toEqual({
      created: false,
    });
    expect(createMany.mock.calls[0]![0]).toEqual({
      data: [{ email: 'a@example.test', source: 'landing', createdAt }],
      skipDuplicates: true,
    });
    expect(createMany.mock.calls[1]![0].data[0].source).toBe(SIGNUP_SOURCE_UNKNOWN);
  });
});

describe('the store models are global (pass-through), not tenant data', () => {
  it('TariffCache, FxRate and EmailSignup pass through the tenant scope unchanged', () => {
    for (const model of ['TariffCache', 'FxRate', 'EmailSignup'] as const) {
      expect(PASSTHROUGH_MODELS).toContain(model);
      const args = { where: { id: 'x' } };
      expect(scopeArgs(model, 'findMany', args, '00000000-0000-4000-8000-000000000000')).toEqual(
        args,
      );
    }
  });
});
