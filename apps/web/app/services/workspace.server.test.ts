/**
 * Production guards (§7.1 fail closed) without a database: the workspace refuses to run on an
 * in-memory session store in production, sign-in refuses to run without an email transport, and
 * the public calculator is unaffected by either.
 */
import type { PrismaClient } from '@harbour/db';
import { afterEach, describe, expect, it } from 'vitest';
import { loader as calculatorLoader } from '../routes/calculator';
import { loader as appLoader } from '../routes/app';
import { loader as loginLoader } from '../routes/login';
import { createTestApp, makeRequest, run } from '../test-support/harness';
import { setAppForTests } from './app.server';
import { MemoryEmailTransport } from './email.server';
import { pageErrorSchema } from './page-error';
import type { RedisSessionClient } from './session.server';

// Never queried: every guard below fails before the database is touched.
const unusedPrisma = {} as PrismaClient;
const unusedRedis: RedisSessionClient = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 0,
};

const pageTitle = (data: unknown) => pageErrorSchema.parse(data).title;

afterEach(() => setAppForTests(null));

describe('workspace production guards', () => {
  it('production without REDIS_URL: workspace 503, calculator 200, error logged once', async () => {
    const { logs } = await createTestApp({
      env: { NODE_ENV: 'production', APP_URL: 'https://app.example.test' },
      prismaOverride: unusedPrisma,
      email: new MemoryEmailTransport(),
    });
    const storeErrors = () => logs.filter((l) => l.event === 'auth.session_store_unavailable');
    expect(storeErrors()).toHaveLength(1);

    const app = await run(appLoader, makeRequest('/app'));
    expect(app.status).toBe(503);
    expect(pageTitle(app.data)).toBe('Workspace temporarily unavailable');

    const login = await run(loginLoader, makeRequest('/login'));
    expect(login.status).toBe(503);

    const calc = await run(calculatorLoader, makeRequest('/calculator'));
    expect(calc.status).toBe(200);
    expect(calc.thrown).toBe(false);
    // Logged at startup only, not per request.
    expect(storeErrors()).toHaveLength(1);
  });

  it('production without an email transport: /login says sign-in is not available yet', async () => {
    const { logs } = await createTestApp({
      env: { NODE_ENV: 'production', APP_URL: 'https://app.example.test' },
      prismaOverride: unusedPrisma,
      redis: unusedRedis,
      email: 'console',
    });
    // (createAppServices and the harness each build auth services once; neither logs per request.)
    const emailErrors = () => logs.filter((l) => l.event === 'auth.email_unavailable');
    const atStartup = emailErrors().length;
    expect(atStartup).toBeGreaterThan(0);
    expect(emailErrors().every((l) => l.level === 'error')).toBe(true);
    const login = await run(loginLoader, makeRequest('/login'));
    expect(login.status).toBe(503);
    expect(pageTitle(login.data)).toBe('Sign-in is not available yet');
    expect(emailErrors()).toHaveLength(atStartup);
  });

  it('production without APP_URL: links are never built from the Host header', async () => {
    await createTestApp({
      env: { NODE_ENV: 'production' },
      prismaOverride: unusedPrisma,
      redis: unusedRedis,
      email: new MemoryEmailTransport(),
    });
    const login = await run(loginLoader, makeRequest('/login'));
    expect(pageTitle(login.data)).toBe('Sign-in is not available yet');
  });

  it('no DATABASE_URL: "Workspace needs a database" (dev hint outside production)', async () => {
    await createTestApp({});
    const res = await run(appLoader, makeRequest('/app'));
    expect(res.status).toBe(503);
    const body = pageErrorSchema.parse(res.data);
    expect(body.title).toBe('Workspace needs a database');
    expect(body.hint).toMatch(/DATABASE_URL/);
    expect((await run(calculatorLoader, makeRequest('/calculator'))).status).toBe(200);

    await createTestApp({ env: { NODE_ENV: 'production' } });
    const prod = pageErrorSchema.parse((await run(appLoader, makeRequest('/app'))).data);
    expect(prod.hint).toBeNull();
  });
});
