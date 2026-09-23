/**
 * Settings services at startup (M2): the field-encryption key decides whether the workspace runs
 * (§7.3 fail closed in production; ephemeral key + loud warning in development), Companies House
 * is optional, and the calculator never cares.
 */
import { generateMasterKey, type PrismaClient } from '@harbour/db';
import { afterEach, describe, expect, it } from 'vitest';
import { loader as appLoader } from '../../routes/app';
import { loader as calculatorLoader } from '../../routes/calculator';
import { createTestApp, makeRequest, run } from '../../test-support/harness';
import { setAppForTests } from '../app.server';
import { MemoryEmailTransport } from '../email.server';
import { loadEnv } from '../env.server';
import { createLogger } from '../logger.server';
import { pageErrorSchema } from '../page-error';
import type { RedisSessionClient } from '../session.server';
import { createSettingsServices } from './index.server';

const unusedPrisma = {} as PrismaClient;
const unusedRedis: RedisSessionClient = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 0,
};

const captureLogger = () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (l) => logs.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { logger, logs };
};

afterEach(() => setAppForTests(null));

describe('createSettingsServices', () => {
  it('production without FIELD_ENCRYPTION_KEY: unavailable, one error logged, never the key', () => {
    const { logger, logs } = captureLogger();
    const s = createSettingsServices({ env: loadEnv({ NODE_ENV: 'production' }), logger });
    expect(s.unavailable).toBe('NO_FIELD_ENCRYPTION_KEY');
    expect(s.keyProvider).toBeNull();
    expect(s.fieldEncryption).toBe('missing');
    expect(logs.filter((l) => l.event === 'settings.field_encryption_unavailable')).toHaveLength(1);
  });

  it('a malformed key is refused in every environment', () => {
    const { logger, logs } = captureLogger();
    const s = createSettingsServices({
      env: loadEnv({ NODE_ENV: 'development', FIELD_ENCRYPTION_KEY: 'not-32-bytes' }),
      logger,
    });
    expect(s.unavailable).toBe('NO_FIELD_ENCRYPTION_KEY');
    expect(JSON.stringify(logs)).not.toContain('not-32-bytes');
  });

  it('development without a key: ephemeral key and a loud warning', () => {
    const { logger, logs } = captureLogger();
    const s = createSettingsServices({ env: loadEnv({ NODE_ENV: 'development' }), logger });
    expect(s.unavailable).toBeNull();
    expect(s.keyProvider?.keyId).toBe('ephemeral');
    expect(s.fieldEncryption).toBe('ephemeral');
    expect(logs.filter((l) => l.event === 'settings.field_encryption_ephemeral')).toHaveLength(1);
    expect(logs[0]?.level).toBe('warn');
  });

  it('a configured key is used; Companies House and the forwarder come from env; jobs pick a backend', () => {
    const { logger, logs } = captureLogger();
    const key = generateMasterKey();
    const s = createSettingsServices({
      env: loadEnv({
        NODE_ENV: 'production',
        FIELD_ENCRYPTION_KEY: key,
        COMPANIES_HOUSE_API_KEY: 'ch-key',
        FORWARDER_EORI: 'gb 9876 5432 1000',
        FORWARDER_NAME: 'Example Freight Ltd',
      }),
      logger,
    });
    expect(s.unavailable).toBeNull();
    expect(s.fieldEncryption).toBe('configured');
    expect(s.companiesHouse).not.toBeNull();
    expect(s.forwarder).toEqual({ eori: 'GB987654321000', name: 'Example Freight Ltd' });
    expect(s.jobs.backend).toBe('memory');
    const text = JSON.stringify(logs);
    expect(text).not.toContain(key);
    expect(text).not.toContain('ch-key');

    const off = createSettingsServices({ env: loadEnv({ NODE_ENV: 'test' }), logger });
    expect(off.companiesHouse).toBeNull();
    expect(off.forwarder).toEqual({ eori: null, name: null });
  });

  it('rejects a malformed FORWARDER_EORI at startup', () => {
    expect(() => loadEnv({ FORWARDER_EORI: 'nope' })).toThrow();
  });
});

describe('workspace guard', () => {
  it('production without FIELD_ENCRYPTION_KEY: workspace 503 "not configured", calculator 200', async () => {
    const { logs } = await createTestApp({
      env: {
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.test',
        FIELD_ENCRYPTION_KEY: '',
      },
      prismaOverride: unusedPrisma,
      redis: unusedRedis,
      email: new MemoryEmailTransport(),
    });
    expect(logs.filter((l) => l.event === 'settings.field_encryption_unavailable')).toHaveLength(1);
    const app = await run(appLoader, makeRequest('/app'));
    expect(app.status).toBe(503);
    expect(pageErrorSchema.parse(app.data).title).toBe('Workspace not configured');
    expect(pageErrorSchema.parse(app.data).hint).toBeNull();
    const calc = await run(calculatorLoader, makeRequest('/calculator'));
    expect(calc.status).toBe(200);
  });

  it('the startup log records presence only', async () => {
    const { logs } = await createTestApp({
      env: { FIELD_ENCRYPTION_KEY: generateMasterKey() },
      prismaOverride: unusedPrisma,
    });
    const started = logs.find((l) => l.event === 'app.started');
    expect(started).toMatchObject({
      fieldEncryption: 'configured',
      companiesHouse: false,
      jobEnqueuer: 'memory',
    });
  });
});
