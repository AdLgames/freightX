/**
 * Test harness for the auth and workspace routes (imported only by *.test.ts files).
 *
 * `createTestApp` builds the real composition root and swaps in controllable pieces: a capturing
 * logger, an in-memory rate limiter, the session store of choice and an email transport. Route
 * modules read it through `getApp()` after `setAppForTests(app)`.
 */
import { randomUUID } from 'node:crypto';
import { generateMasterKey, type PrismaClient } from '@harbour/db'; // M2: generateMasterKey
import { createAppServices, setAppForTests, type AppServices } from '../services/app.server';
import type { EmailTransport } from '../services/email.server';
import { loadEnv } from '../services/env.server';
import { createLogger } from '../services/logger.server';
import { InMemoryRateLimiter } from '../services/rate-limit.server';
import { SECURE_COOKIE_NAME, type RedisSessionClient } from '../services/session.server';
import { createAuthServices } from '../services/workspace.server';

export const ORIGIN = 'http://localhost';
/** M2: the field-encryption master key every test app shares (see createTestApp). */
export const TEST_MASTER_KEY = generateMasterKey();

export interface TestApp {
  app: AppServices;
  logs: Array<Record<string, unknown>>;
  /** Raw log lines, for "no PII" assertions. */
  lines: string[];
  prisma: PrismaClient | null;
}

export interface TestAppOptions {
  databaseUrl?: string | undefined;
  env?: Record<string, string>;
  email?: EmailTransport | null | 'console';
  redis?: RedisSessionClient | null;
  prismaOverride?: PrismaClient | null;
}

export const createTestApp = async (opts: TestAppOptions = {}): Promise<TestApp> => {
  const lines: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (l) => {
      lines.push(l);
      logs.push(JSON.parse(l) as Record<string, unknown>);
    },
  });
  const env = loadEnv({
    NODE_ENV: 'test',
    // M2: one key per test run so encrypted fields round-trip. Pass FIELD_ENCRYPTION_KEY yourself
    // (even as '') to exercise the missing-key guard.
    ...(opts.env && 'FIELD_ENCRYPTION_KEY' in opts.env
      ? {}
      : { FIELD_ENCRYPTION_KEY: TEST_MASTER_KEY }),
    ...(opts.databaseUrl ? { DATABASE_URL: opts.databaseUrl } : {}),
    ...opts.env,
  });
  const base = await createAppServices({ env, logger });
  const prisma = opts.prismaOverride !== undefined ? opts.prismaOverride : base.auth.prisma;
  // 'console' / undefined: let createAuthServices pick from env, exactly as production code does.
  const email = opts.email === 'console' || opts.email === undefined ? {} : { email: opts.email };
  const auth = createAuthServices({ env, logger, prisma, redis: opts.redis ?? null, ...email });
  // M2: production without FIELD_ENCRYPTION_KEY closes the workspace (see app.server.ts).
  if (base.settings.unavailable && auth.unavailable === null) {
    auth.unavailable = base.settings.unavailable;
  }
  const app: AppServices = { ...base, auth, rateLimiter: new InMemoryRateLimiter() };
  setAppForTests(app);
  return { app, logs, lines, prisma };
};

// ---------- requests ----------

export interface RequestOptions {
  method?: string;
  form?: Record<string, string>;
  cookie?: string | null;
  headers?: Record<string, string>;
}

export const makeRequest = (path: string, opts: RequestOptions = {}): Request => {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const method = opts.method ?? (opts.form ? 'POST' : 'GET');
  if (opts.form) headers.set('content-type', 'application/x-www-form-urlencoded');
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(opts.form ? { body: new URLSearchParams(opts.form).toString() } : {}),
  });
};

// ---------- calling loaders/actions ----------

export interface RouteResult {
  status: number;
  location: string | null;
  setCookie: string[];
  data: unknown;
  thrown: boolean;
}

interface DataWithInit {
  type: 'DataWithResponseInit';
  data: unknown;
  init: ResponseInit | null;
}

const isDataWithInit = (v: unknown): v is DataWithInit =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'DataWithResponseInit';

type RouteFn = (args: { request: Request; params: object; context: object }) => unknown;

/** Calls a loader/action and normalises returned or thrown redirects, data() and plain values. */
export const run = async (fn: unknown, request: Request): Promise<RouteResult> => {
  let value: unknown;
  let thrown = false;
  try {
    value = await (fn as RouteFn)({ request, params: {}, context: {} });
  } catch (err) {
    value = err;
    thrown = true;
  }
  if (value instanceof Response) {
    return {
      status: value.status,
      location: value.headers.get('location'),
      setCookie: value.headers.getSetCookie(),
      data: null,
      thrown,
    };
  }
  if (isDataWithInit(value)) {
    const headers = new Headers(value.init?.headers);
    return {
      status: value.init?.status ?? 200,
      location: null,
      setCookie: headers.getSetCookie(),
      data: value.data,
      thrown,
    };
  }
  if (thrown) throw value;
  return { status: 200, location: null, setCookie: [], data: value, thrown };
};

/** `name=value` of the session cookie from Set-Cookie headers (test env: `__Host-harbour_sid`). */
export const sessionCookieFrom = (setCookie: string[]): string | null => {
  for (const c of setCookie) {
    const pair = c.split(';')[0] ?? '';
    if (pair.startsWith(`${SECURE_COOKIE_NAME}=`) && pair.length > SECURE_COOKIE_NAME.length + 1) {
      return pair;
    }
  }
  return null;
};

export const sessionIdFrom = (cookie: string): string => cookie.split('=')[1] ?? '';

export const cookieFor = (sessionId: string): string => `${SECURE_COOKIE_NAME}=${sessionId}`;

export const uniqueEmail = (label = 'user'): string =>
  `${label}-${randomUUID().slice(0, 8)}@example.test`;

/** The `linkPath` the ConsoleEmailTransport logged last. */
export const lastLinkPath = (logs: Array<Record<string, unknown>>): string | null => {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = logs[i];
    if (line?.event === 'email.console' && typeof line.linkPath === 'string') return line.linkPath;
  }
  return null;
};
