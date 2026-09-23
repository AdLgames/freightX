/**
 * Prisma stores round-trip against a real Postgres. Skipped unless DATABASE_URL is set. The
 * tables are global (no RLS), so this runs the same as a superuser or as a harbour_app member.
 * Keys are randomised per run and removed afterwards.
 */
import type { FxRateRecord, NormalisedCommodity } from '@harbour/adapters';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disposePrismaClient } from '../src/client.js';
import {
  PrismaEmailSignupRepository,
  PrismaFxRateStore,
  PrismaTariffCacheStore,
  SIGNUP_SOURCE_UNKNOWN,
} from '../src/stores.js';
import type { PrismaClient } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** Random 'X??' code (ISO 4217 reserves X-codes for non-national units, so no real rate clashes). */
const testCurrency = () =>
  'X' +
  Array.from(randomBytes(2), (b) => String.fromCharCode(65 + (b % 26)))
    .join('')
    .toUpperCase();

describe.skipIf(!DATABASE_URL)('Prisma stores (database)', () => {
  let prisma: PrismaClient;
  const hsCode = `99${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const currencies = [testCurrency(), testCurrency()];
  const emails: string[] = [];

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL!, log: ['error'] });
  });

  afterAll(async () => {
    await prisma.tariffCache.deleteMany({ where: { hsCode } });
    await prisma.fxRate.deleteMany({ where: { currency: { in: currencies } } });
    await prisma.emailSignup.deleteMany({ where: { email: { in: emails } } });
    await disposePrismaClient();
  });

  describe('PrismaTariffCacheStore', () => {
    const commodity: NormalisedCommodity = {
      code: hsCode,
      description: 'Test commodity',
      declarable: true,
      measures: [
        {
          sid: '1',
          measureTypeId: '103',
          dutyExpression: '12.00 % + £ 25.00 / 100 kg',
          geographicalAreaId: '1011',
          additionalCode: null,
          effectiveStartDate: '2021-01-01',
          effectiveEndDate: null,
        },
        {
          sid: '2',
          measureTypeId: '142',
          dutyExpression: '0.00 %',
          geographicalAreaId: '1013',
          geographicalAreaMembers: ['DE', 'FR', 'IT'],
          excludedCountries: ['IT'],
        },
      ],
    };

    it('set/get round-trips under the origin wildcard and upserts', async () => {
      const store = new PrismaTariffCacheStore(prisma);
      expect(await store.get(hsCode)).toBeNull();

      const fetchedAt = new Date('2026-09-23T10:00:00.123Z');
      const expiresAt = new Date(fetchedAt.getTime() + 24 * 60 * 60 * 1000);
      await store.set(hsCode, commodity, fetchedAt, expiresAt);
      const got = await store.get(hsCode);
      expect(got).toEqual({ value: commodity, fetchedAt, expiresAt });

      const later = new Date(fetchedAt.getTime() + 60_000);
      const updated = { ...commodity, description: 'Updated' };
      await store.set(hsCode, updated, later, new Date(later.getTime() + 86_400_000));
      expect((await store.get(hsCode))?.value.description).toBe('Updated');

      const rows = await prisma.tariffCache.findMany({ where: { hsCode } });
      expect(rows.map((r) => r.originCountry)).toEqual(['*']);
    });

    it('a corrupt payload is a miss (and reported)', async () => {
      const issues: string[][] = [];
      const store = new PrismaTariffCacheStore(prisma, {
        onCorruptRow: (info) => issues.push(info.issues),
      });
      await prisma.tariffCache.update({
        where: { hsCode_originCountry: { hsCode, originCountry: '*' } },
        data: { payload: { code: hsCode, measures: [{ sid: 1 }] } },
      });
      expect(await store.get(hsCode)).toBeNull();
      expect(issues).toHaveLength(1);
    });
  });

  describe('PrismaFxRateStore', () => {
    const [ccy, other] = currencies as [string, string];
    const sept: FxRateRecord = {
      source: 'HMRC_MONTHLY',
      currency: ccy,
      rateToGbp: '0.791234',
      validFrom: '2026-09-01',
      validTo: '2026-09-30',
    };
    const oct: FxRateRecord = {
      ...sept,
      rateToGbp: '0.8',
      validFrom: '2026-10-01',
      validTo: '2026-10-31',
    };

    it('upsert then find round-trips decimals as strings and dates as YYYY-MM-DD', async () => {
      const store = new PrismaFxRateStore(prisma);
      await store.upsert([sept, oct, { ...sept, currency: other, source: 'ECB' }]);
      expect(await store.find('HMRC_MONTHLY', ccy, new Date('2026-09-15T12:00:00Z'))).toEqual(sept);
      expect(await store.find('HMRC_MONTHLY', ccy, new Date('2026-10-02T00:00:00Z'))).toEqual(oct);
      // source is part of the key
      expect(await store.find('ECB', ccy, new Date('2026-09-15T12:00:00Z'))).toBeNull();
      expect((await store.find('ECB', other, new Date('2026-09-15T12:00:00Z')))?.source).toBe(
        'ECB',
      );
      // stored as Decimal(14,6), read back without padding
      const [raw] = await prisma.$queryRaw<{ r: string }[]>`
        SELECT rate_to_gbp::text AS r FROM fx_rates
        WHERE currency = ${ccy} AND valid_from = '2026-10-01'`;
      expect(raw?.r).toBe('0.800000');
    });

    it('validTo is inclusive of its whole UTC day; validFrom starts at 00:00 UTC', async () => {
      const store = new PrismaFxRateStore(prisma);
      const at = (iso: string) => store.find('HMRC_MONTHLY', ccy, new Date(iso));
      expect((await at('2026-09-01T00:00:00.000Z'))?.validFrom).toBe('2026-09-01');
      expect(await at('2026-08-31T23:59:59.999Z')).toBeNull();
      expect((await at('2026-09-30T23:59:59.999Z'))?.validFrom).toBe('2026-09-01');
      expect(await at('2026-11-01T00:00:00.000Z')).toBeNull();
    });

    it('latest validFrom wins when periods overlap', async () => {
      const store = new PrismaFxRateStore(prisma);
      await store.upsert([
        { ...sept, rateToGbp: '0.9', validFrom: '2026-09-20', validTo: '2026-09-30' },
      ]);
      expect(
        (await store.find('HMRC_MONTHLY', ccy, new Date('2026-09-25T00:00:00Z')))?.rateToGbp,
      ).toBe('0.9');
      expect(
        (await store.find('HMRC_MONTHLY', ccy, new Date('2026-09-10T00:00:00Z')))?.rateToGbp,
      ).toBe('0.791234');
    });

    it('upsert is idempotent on (source, currency, validFrom) and updates rate/validTo', async () => {
      const store = new PrismaFxRateStore(prisma);
      const before = await prisma.fxRate.count({ where: { currency: ccy } });
      await store.upsert([sept, sept]);
      await store.upsert([{ ...sept, rateToGbp: '0.791235' }]);
      expect(await prisma.fxRate.count({ where: { currency: ccy } })).toBe(before);
      expect(
        (await store.find('HMRC_MONTHLY', ccy, new Date('2026-09-10T00:00:00Z')))?.rateToGbp,
      ).toBe('0.791235');
    });

    it('a batch with an invalid record writes nothing', async () => {
      const store = new PrismaFxRateStore(prisma);
      await expect(
        store.upsert([
          { ...sept, validFrom: '2026-12-01', validTo: '2026-12-31' },
          { ...sept, validFrom: '2027-01-01', validTo: '2027-01-31', rateToGbp: '0.12345678' },
        ]),
      ).rejects.toThrow(RangeError);
      expect(await store.find('HMRC_MONTHLY', ccy, new Date('2026-12-15T00:00:00Z'))).toBeNull();
    });
  });

  describe('PrismaEmailSignupRepository', () => {
    it('adds once, duplicate is a no-op returning created:false, count reflects rows', async () => {
      const repo = new PrismaEmailSignupRepository(prisma);
      const email = `signup-${randomUUID()}@example.test`;
      const bare = `signup-${randomUUID()}@example.test`;
      emails.push(email, bare);
      const before = await repo.count();
      const createdAt = new Date('2026-09-23T12:00:00.000Z');

      expect(await repo.add({ email, source: 'landing', createdAt })).toEqual({ created: true });
      expect(await repo.add({ email, source: 'calculator', createdAt: new Date() })).toEqual({
        created: false,
      });
      expect(await repo.add({ email: bare, source: null, createdAt })).toEqual({ created: true });
      expect(await repo.count()).toBe(before + 2);

      const rows = await prisma.emailSignup.findMany({
        where: { email: { in: [email, bare] } },
        orderBy: { email: 'asc' },
      });
      const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
      expect(byEmail[email]?.source).toBe('landing'); // the duplicate did not overwrite
      expect(byEmail[email]?.createdAt.toISOString()).toBe(createdAt.toISOString());
      expect(byEmail[bare]?.source).toBe(SIGNUP_SOURCE_UNKNOWN);
    });
  });
});
