import {
  can,
  withOrgTransaction,
  withUserTransaction,
  type Action,
  type Prisma,
  type PrismaClient,
  type Role,
  type TenantTransactionClient,
} from '@harbour/db';
import { redirect } from 'react-router';
import { DEFAULT_NEXT, safeNext } from '../validators/auth';
import { getApp, type AppServices } from './app.server';
import { requestLogger } from './logger.server';
import { findMembership, listUserOrganizations } from './organizations.server';
import { pageError } from './page-error';
import {
  clearSessionCookie,
  cookiePolicyFor,
  readSessionCookie,
  serializeSessionCookie,
  type CookiePolicy,
  type Session,
  type SessionData,
  type SessionManager,
} from './session.server';

/**
 * Authentication and tenancy guards for workspace loaders and actions (§7.1, §7.2).
 *
 *   const ctx = await requireOrgContext(request, { permission: 'quote.edit' });
 *   const rows = await withOrg(ctx, (tx) => tx.quote.findMany());
 *
 * - The organisation comes from the SESSION (`currentOrgId`) and the membership is re-read from the
 *   database on every request. URL params and form fields never choose the organisation.
 * - All tenant data access goes through `withOrg` (→ `withOrgTransaction`: Prisma scope + RLS). With
 *   FORCE RLS a query outside that transaction sees no rows at all.
 * - Guards throw: a redirect (to /login, onboarding, or the same URL after a session rotation) or a
 *   page error (403/503) rendered by the root ErrorBoundary.
 */

const INTERNAL = Symbol('harbour.auth.internal');

interface Internal {
  app: AppServices;
  prisma: PrismaClient;
  sessions: SessionManager;
  cookie: CookiePolicy;
}

const workspaceOf = (ctx: UserContext): Workspace => ({
  app: ctx[INTERNAL].app,
  prisma: ctx[INTERNAL].prisma,
  sessions: ctx[INTERNAL].sessions,
});

export interface UserContext {
  user: { id: string; email: string };
  session: Session;
  /**
   * Response headers the loader should return (`data(value, { headers: ctx.headers })`): a
   * re-issued session cookie when the sliding expiry was refreshed. The /app layout does this.
   */
  headers: Headers;
  readonly [INTERNAL]: Internal;
}

export interface OrgContext extends UserContext {
  org: { id: string; name: string };
  membership: { id: string; role: Role };
  role: Role;
}

// ---------- availability ----------

export interface Workspace {
  app: AppServices;
  prisma: PrismaClient;
  sessions: SessionManager;
}

/** Throws the "needs a database" / "temporarily unavailable" page when the workspace cannot run. */
export const requireWorkspace = async (): Promise<Workspace> => {
  const app = await getApp();
  const { auth } = app;
  const production = app.env.NODE_ENV === 'production';
  if (auth.unavailable === 'NO_DATABASE' || !auth.prisma) {
    throw pageError(
      503,
      'Workspace needs a database',
      'The workspace is not set up on this server yet. The landed-cost calculator still works.',
      production
        ? null
        : 'Set DATABASE_URL and run `pnpm db:migrate` (see packages/db/README.md), then restart.',
    );
  }
  if (auth.unavailable === 'NO_SESSION_STORE' || !auth.sessions) {
    throw sessionStoreUnavailable();
  }
  return { app, prisma: auth.prisma, sessions: auth.sessions };
};

const sessionStoreUnavailable = () =>
  pageError(
    503,
    'Workspace temporarily unavailable',
    'Please try again in a few minutes. The landed-cost calculator is still available.',
  );

// ---------- session plumbing ----------

export const sessionCookiePolicy = (app: AppServices, request: Request): CookiePolicy =>
  cookiePolicyFor(app.env.NODE_ENV, request);

/** Reads the session; a store failure is a 503, never "signed out". */
export const readSession = async (
  ws: Workspace,
  request: Request,
): Promise<{ session: Session | null; cookie: CookiePolicy; presented: boolean }> => {
  const cookie = sessionCookiePolicy(ws.app, request);
  const id = readSessionCookie(request, cookie);
  try {
    return { session: await ws.sessions.read(id), cookie, presented: id !== null };
  } catch (err) {
    requestLogger(ws.app.logger, request).error('session.store_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw sessionStoreUnavailable();
  }
};

const withSessionStore = async <T>(ws: Workspace, request: Request, fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    requestLogger(ws.app.logger, request).error('session.store_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw sessionStoreUnavailable();
  }
};

/** Sign-in: a brand-new session (id AND CSRF token), replacing any session the browser had. */
export const startSession = async (
  ws: Workspace,
  request: Request,
  init: Pick<SessionData, 'userId' | 'currentOrgId' | 'role'>,
): Promise<{ session: Session; setCookie: string }> => {
  const { session: previous, cookie } = await readSession(ws, request);
  const session = await withSessionStore(ws, request, async () => {
    if (previous) await ws.sessions.destroy(previous.id);
    return ws.sessions.create(init);
  });
  return { session, setCookie: serializeSessionCookie(cookie, session.id) };
};

/** Rotate after a privilege change (org switch, role change, onboarding). Returns Set-Cookie. */
export const rotateSession = async (
  ctx: UserContext,
  request: Request,
  patch: Partial<Pick<SessionData, 'currentOrgId' | 'role'>>,
): Promise<{ session: Session; setCookie: string }> => {
  const { sessions, cookie } = ctx[INTERNAL];
  const session = await withSessionStore(workspaceOf(ctx), request, () =>
    sessions.rotate(ctx.session, patch),
  );
  return { session, setCookie: serializeSessionCookie(cookie, session.id) };
};

/** Sign-out: destroys the server-side session and clears the cookie. */
export const endSession = async (ctx: UserContext, request: Request): Promise<string> => {
  const { sessions, cookie } = ctx[INTERNAL];
  await withSessionStore(workspaceOf(ctx), request, () => sessions.destroy(ctx.session.id));
  return clearSessionCookie(cookie);
};

// ---------- redirects ----------

const currentPath = (request: Request): string => {
  const url = new URL(request.url);
  return request.method === 'GET' || request.method === 'HEAD'
    ? `${url.pathname}${url.search}`
    : url.pathname;
};

/** `/login?next=<current path>` (only same-origin relative paths survive `safeNext`). */
export const loginUrl = (request: Request): string => {
  const next = safeNext(currentPath(request));
  return next === DEFAULT_NEXT ? '/login' : `/login?next=${encodeURIComponent(next)}`;
};

// ---------- guards ----------

const userMemo = new WeakMap<Request, Promise<UserContext>>();
const orgMemo = new WeakMap<Request, Promise<OrgContext>>();

/**
 * The signed-in user, or a redirect to `/login?next=`. Memoised per Request, so a layout and its
 * child loaders share one session read (and at most one rotation).
 */
export const requireUser = (request: Request): Promise<UserContext> => {
  let pending = userMemo.get(request);
  if (!pending) {
    pending = resolveUser(request);
    userMemo.set(request, pending);
  }
  return pending;
};

const resolveUser = async (request: Request): Promise<UserContext> => {
  const ws = await requireWorkspace();
  const { session, cookie, presented } = await readSession(ws, request);
  const clear = presented ? { headers: { 'Set-Cookie': clearSessionCookie(cookie) } } : undefined;
  if (!session) throw redirect(loginUrl(request), clear);

  // `users` is a global identity table (no RLS, PASSTHROUGH_MODELS): read with the plain client.
  const user = await ws.prisma.user.findUnique({
    where: { id: session.data.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    await withSessionStore(ws, request, () => ws.sessions.destroy(session.id));
    throw redirect(loginUrl(request), { headers: { 'Set-Cookie': clearSessionCookie(cookie) } });
  }

  const headers = new Headers();
  if (session.touched) headers.append('Set-Cookie', serializeSessionCookie(cookie, session.id));
  return {
    user,
    session,
    headers,
    [INTERNAL]: { app: ws.app, prisma: ws.prisma, sessions: ws.sessions, cookie },
  };
};

export interface OrgContextOptions {
  /** RBAC action from `@harbour/db` (§7.2 matrix); missing → any member may pass. */
  permission?: Action;
}

/**
 * The signed-in user in their current organisation. Resolves `currentOrgId` from the session and
 * re-checks the membership in the database on every request:
 *
 *   no session                        → redirect /login?next=
 *   no membership anywhere            → redirect /onboarding/organization
 *   current membership gone/tampered  → session rotated onto another membership (or none), redirect
 *   role changed since last request   → session rotated (privilege change), redirect to same URL
 *   permission not granted            → 403 page
 */
export const requireOrgContext = async (
  request: Request,
  opts: OrgContextOptions = {},
): Promise<OrgContext> => {
  let pending = orgMemo.get(request);
  if (!pending) {
    pending = resolveOrg(request);
    orgMemo.set(request, pending);
  }
  const ctx = await pending;
  if (opts.permission !== undefined) assertPermission(ctx, opts.permission, request);
  return ctx;
};

/** 403 unless the context's role may perform `action` (`can()` from @harbour/db). */
export const assertPermission = (ctx: OrgContext, action: Action, request?: Request): void => {
  if (can(ctx.role, action)) return;
  const { logger } = ctx[INTERNAL].app;
  const log = request ? requestLogger(logger, request) : logger;
  log.warn('auth.forbidden', { userId: ctx.user.id, orgId: ctx.org.id, action, role: ctx.role });
  throw pageError(
    403,
    'You do not have access to this',
    'Your role in this organisation does not allow it. Ask an owner or admin if you need access.',
  );
};

const resolveOrg = async (request: Request): Promise<OrgContext> => {
  const base = await requireUser(request);
  const { prisma, sessions, cookie } = base[INTERNAL];
  const ws = workspaceOf(base);
  const log = requestLogger(ws.app.logger, request);
  const { session } = base;
  const userId = base.user.id;

  const rotateAndRedirect = async (
    patch: Pick<SessionData, 'currentOrgId' | 'role'>,
    to: string,
  ): Promise<never> => {
    const rotated = await withSessionStore(ws, request, () => sessions.rotate(session, patch));
    throw redirect(to, { headers: { 'Set-Cookie': serializeSessionCookie(cookie, rotated.id) } });
  };

  const currentOrgId = session.data.currentOrgId;
  if (currentOrgId !== null) {
    const membership = await findMembership(prisma, currentOrgId, userId);
    if (membership) {
      if (session.data.role !== membership.role) {
        // Role changed since this session last saw it (or was never recorded): privilege change.
        log.info('session.rotated', { reason: 'role_change', userId, orgId: currentOrgId });
        return rotateAndRedirect(
          { currentOrgId, role: membership.role },
          safeNext(currentPath(request)),
        );
      }
      return {
        ...base,
        org: membership.organization,
        membership: { id: membership.membershipId, role: membership.role },
        role: membership.role,
      };
    }
    // Removed from the organisation, organisation deleted, or a tampered session value.
    log.warn('auth.membership_missing', { userId, orgId: currentOrgId });
  }

  const memberships = await listUserOrganizations(prisma, userId);
  const next = memberships[0];
  if (!next) {
    if (currentOrgId === null) throw redirect('/onboarding/organization');
    return rotateAndRedirect({ currentOrgId: null, role: null }, '/onboarding/organization');
  }
  log.info('session.rotated', { reason: 'org_selected', userId, orgId: next.organization.id });
  return rotateAndRedirect(
    { currentOrgId: next.organization.id, role: next.role },
    currentOrgId === null ? safeNext(currentPath(request)) : DEFAULT_NEXT,
  );
};

// ---------- data access ----------

/**
 * Runs `fn(tx)` in the context's organisation: Prisma tenant scope + `app.current_org` (RLS) +
 * `app.current_user`. The only way workspace code should touch tenant tables.
 */
export const withOrg = <T>(
  ctx: OrgContext,
  fn: (tx: TenantTransactionClient) => Promise<T>,
): Promise<T> => withOrgTransaction(ctx[INTERNAL].prisma, ctx.org.id, fn, { userId: ctx.user.id });

/**
 * User-scoped work without an organisation (e.g. listing the user's organisations). Under RLS it
 * sees the user's own memberships and their organisations, nothing else.
 */
export const withUser = <T>(
  ctx: UserContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => withUserTransaction(ctx[INTERNAL].prisma, ctx.user.id, fn);

/** The plain client, for auth internals only (users, magic links, onboarding). */
export const authPrisma = (ctx: UserContext): PrismaClient => ctx[INTERNAL].prisma;
