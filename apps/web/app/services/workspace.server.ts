import type { PrismaClient } from '@harbour/db';
import { createEmailTransport, type EmailFetch, type EmailTransport } from './email.server';
import type { Env } from './env.server';
import type { Logger } from './logger.server';
import {
  InMemorySessionStore,
  RedisSessionStore,
  SessionManager,
  type RedisSessionClient,
} from './session.server';

/**
 * What the signed-in workspace needs, decided once at startup. The public calculator never looks
 * at this, so it keeps working with no DATABASE_URL, no REDIS_URL and no email transport.
 *
 *   no DATABASE_URL                → every workspace route: "Workspace needs a database" (503)
 *   production and no REDIS_URL    → every workspace route: "Workspace temporarily unavailable"
 *                                    (503). Never an in-memory fallback: on serverless hosts
 *                                    (Vercel) each instance would hold different sessions.
 *   no usable email transport, or
 *   production and no APP_URL      → /login: "Sign-in is not available yet" (503). Links are never
 *                                    built from the request's Host header in production.
 */
export type WorkspaceUnavailable = 'NO_DATABASE' | 'NO_SESSION_STORE' | 'NO_FIELD_ENCRYPTION_KEY'; // M2: production without FIELD_ENCRYPTION_KEY (§7.3), set in app.server.ts

export interface AuthServices {
  unavailable: WorkspaceUnavailable | null;
  prisma: PrismaClient | null;
  sessions: SessionManager | null;
  /** null → sign-in is not available (fail closed). */
  email: EmailTransport | null;
  /** Canonical origin (APP_URL) or null (development/test: the request's own origin is used). */
  appUrl: string | null;
}

export interface AuthServicesDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient | null;
  redis: RedisSessionClient | null;
  /** Test seams. */
  now?: () => number;
  email?: EmailTransport | null;
  emailFetch?: EmailFetch;
}

export const createAuthServices = (deps: AuthServicesDeps): AuthServices => {
  const { env, logger } = deps;
  const production = env.NODE_ENV === 'production';

  let sessions: SessionManager | null = null;
  if (deps.redis) {
    sessions = new SessionManager(
      new RedisSessionStore(deps.redis),
      deps.now ? { now: deps.now } : {},
    );
  } else if (!production) {
    sessions = new SessionManager(
      new InMemorySessionStore(env.NODE_ENV, deps.now),
      deps.now ? { now: deps.now } : {},
    );
  }

  let email: EmailTransport | null;
  let emailProblem: string | null = null;
  if (deps.email !== undefined) {
    email = deps.email;
  } else {
    const choice = createEmailTransport(env, logger, deps.emailFetch);
    email = choice.transport;
    emailProblem = choice.problem;
  }
  if (email && production && !env.APP_URL) {
    email = null;
    emailProblem = 'APP_URL is unset in production; magic links need a canonical origin.';
  }

  const unavailable: WorkspaceUnavailable | null = !deps.prisma
    ? 'NO_DATABASE'
    : !sessions
      ? 'NO_SESSION_STORE'
      : null;

  // Logged once, at startup (§7.1: fail closed, loudly).
  if (unavailable === 'NO_SESSION_STORE') {
    logger.error('auth.session_store_unavailable', {
      message: 'REDIS_URL is unset in production: workspace routes return 503.',
    });
  }
  if (emailProblem) {
    logger[production ? 'error' : 'warn']('auth.email_unavailable', {
      message: `${emailProblem} Sign-in is not available.`,
    });
  }
  logger.info('auth.configured', {
    workspace: unavailable ?? 'ready',
    sessionStore: sessions?.backend ?? null,
    emailTransport: email?.name ?? null,
    appUrl: env.APP_URL !== undefined,
  });

  return {
    unavailable,
    prisma: deps.prisma,
    sessions,
    email,
    appUrl: env.APP_URL ?? null,
  };
};
