import { randomUUID } from 'node:crypto';
import { PrismaFxRateStore, createPrismaClient, disposePrismaClient } from '@harbour/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createStores } from './db.server';
import { loadEnv } from './env.server';
import { createLogger } from './logger.server';

const DATABASE_URL = process.env.DATABASE_URL;

const capture = () => {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) };
};

describe('createStores', () => {
  it('uses in-memory stores when DATABASE_URL is unset', async () => {
    const { lines, logger } = capture();
    const stores = createStores(loadEnv({ NODE_ENV: 'test' }), logger);
    expect(stores.backend).toBe('memory');
    expect(
      await stores.signups.add({ email: 'a@example.test', source: null, createdAt: new Date() }),
    ).toEqual({ created: true });
    expect(lines.join('\n')).toContain('"event":"db.memory"');
  });
});

describe.skipIf(!DATABASE_URL)('createStores with DATABASE_URL (database)', () => {
  const email = `web-${randomUUID()}@example.test`;
  const currency = `X${randomUUID()
    .replace(/[^A-Z]/gi, '')
    .slice(0, 2)
    .toUpperCase()
    .padEnd(2, 'Q')}`;

  afterAll(async () => {
    const prisma = createPrismaClient({ databaseUrl: DATABASE_URL! });
    await prisma.emailSignup.deleteMany({ where: { email } });
    await prisma.fxRate.deleteMany({ where: { currency } });
    await disposePrismaClient();
  });

  it('returns the Postgres stores and never logs the connection string', async () => {
    const { lines, logger } = capture();
    const stores = createStores(loadEnv({ NODE_ENV: 'test', DATABASE_URL }), logger);
    expect(stores.backend).toBe('postgres');
    expect(await stores.signups.add({ email, source: 'landing', createdAt: new Date() })).toEqual({
      created: true,
    });
    expect(await stores.signups.add({ email, source: 'landing', createdAt: new Date() })).toEqual({
      created: false,
    });
    const log = lines.join('\n');
    expect(log).toContain('"event":"db.postgres"');
    expect(log).not.toContain(DATABASE_URL!);
  });

  it('without FX_SEED_CSV, seeded (sample) rates stay in-process; Postgres rates win on read', async () => {
    const stores = createStores(loadEnv({ NODE_ENV: 'test', DATABASE_URL }), capture().logger);
    const sample = {
      source: 'HMRC_MONTHLY' as const,
      currency,
      rateToGbp: '0.5',
      validFrom: '2026-09-01',
      validTo: '2026-09-30',
    };
    await stores.fxStore.upsert([sample]);
    const prisma = createPrismaClient({ databaseUrl: DATABASE_URL! });
    expect(await prisma.fxRate.count({ where: { currency } })).toBe(0);
    const at = new Date('2026-09-15T00:00:00Z');
    expect(await stores.fxStore.find('HMRC_MONTHLY', currency, at)).toEqual(sample);

    await new PrismaFxRateStore(prisma).upsert([{ ...sample, rateToGbp: '0.75' }]);
    expect((await stores.fxStore.find('HMRC_MONTHLY', currency, at))?.rateToGbp).toBe('0.75');
  });
});
