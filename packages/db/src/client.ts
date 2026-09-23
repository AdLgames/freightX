import { PrismaClient, type Prisma } from '../generated/client/index.js';

/**
 * Prisma client factory. One instance per process: Prisma opens a connection pool per client, and
 * dev-mode hot reloading would otherwise leak pools, so the instance is cached on globalThis
 * outside production.
 *
 * The connection MUST be a non-superuser member of `harbour_app` (see migration 0002) or row-level
 * security does not apply. Nothing here can verify that; infra owns it.
 */

export interface CreatePrismaClientOptions {
  /** Defaults to process.env.DATABASE_URL. */
  databaseUrl?: string;
  /** Overrides the NODE_ENV-derived log config. */
  log?: Prisma.LogLevel[];
}

const GLOBAL_KEY = '__harbourPrismaClient' as const;
type GlobalWithPrisma = typeof globalThis & { [GLOBAL_KEY]?: PrismaClient };

export function logLevelsFor(nodeEnv: string | undefined): Prisma.LogLevel[] {
  if (nodeEnv === 'production') return ['warn', 'error'];
  if (nodeEnv === 'test') return ['error'];
  return ['query', 'info', 'warn', 'error'];
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const g = globalThis as GlobalWithPrisma;
  const cached = g[GLOBAL_KEY];
  if (cached) return cached;

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (and no databaseUrl option was given)');
  }

  const client = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: options.log ?? logLevelsFor(process.env.NODE_ENV),
  });

  if (process.env.NODE_ENV !== 'production') g[GLOBAL_KEY] = client;
  return client;
}

/** Test/teardown helper: disconnects and drops the cached instance. */
export async function disposePrismaClient(): Promise<void> {
  const g = globalThis as GlobalWithPrisma;
  const cached = g[GLOBAL_KEY];
  if (!cached) return;
  delete g[GLOBAL_KEY];
  await cached.$disconnect();
}
