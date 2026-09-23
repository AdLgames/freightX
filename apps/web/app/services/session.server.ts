import { createHash, randomBytes } from 'node:crypto';
import { ROLES } from '@harbour/db';
import { z } from 'zod';

/**
 * Server-side sessions (§7.1): "server-side session store in Redis, 30-day sliding expiry, rotated
 * on privilege change".
 *
 * - The session id is 32 random bytes (base64url) and lives only in the cookie. The store is keyed
 *   by sha256(id), so a leaked store dump cannot be replayed as cookies.
 * - Sliding expiry: every read that is more than an hour after `lastSeenAt` refreshes the TTL to
 *   30 days (at most one write per session per hour) and asks the caller to re-issue the cookie.
 * - Rotation (sign-in, organisation switch, role change): a new id and a new CSRF token are
 *   written and the old key is deleted, so the old cookie stops working immediately.
 * - `RedisSessionStore` is the production store. `InMemorySessionStore` is for development and
 *   tests on a single process and refuses to be built in production: on serverless hosts (Vercel)
 *   every instance would hold different sessions.
 *
 * No signing secret is involved: the id is unguessable and all state is server-side.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** 32 random bytes → 43 base64url characters. Also the CSRF token shape. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const randomToken = (): string => randomBytes(32).toString('base64url');
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const sessionDataSchema = z.object({
  userId: z.uuid(),
  currentOrgId: z.uuid().nullable(),
  /** Role in `currentOrgId` when it was last checked; a change triggers rotation (§7.1). */
  role: z.enum(ROLES).nullable(),
  csrfToken: z.string().regex(TOKEN_RE),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  rotatedAt: z.number().int().nonnegative(),
});
export type SessionData = z.infer<typeof sessionDataSchema>;

export interface Session {
  /** The raw id (cookie value). Never logged, never stored. */
  readonly id: string;
  readonly data: SessionData;
  /** True when this read refreshed the TTL; the caller should re-issue the cookie. */
  readonly touched: boolean;
}

// ---------- stores ----------

/** Key/value store of serialised sessions, keyed by sha256(id). */
export interface SessionStore {
  readonly backend: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    nodeEnv: 'development' | 'test' | 'production',
    private readonly now: () => number = () => Date.now(),
  ) {
    if (nodeEnv === 'production') {
      throw new Error('InMemorySessionStore is for development and test only; set REDIS_URL');
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Test helper: the stored keys (hashes). */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** The slice of ioredis the store uses (stubbable in tests). */
export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export class RedisSessionStore implements SessionStore {
  readonly backend = 'redis' as const;
  constructor(
    private readonly redis: RedisSessionClient,
    private readonly prefix = 'sess:',
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.prefix + key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(this.prefix + key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

// ---------- manager ----------

export interface SessionManagerOptions {
  now?: () => number;
  ttlMs?: number;
  touchIntervalMs?: number;
}

export class SessionManager {
  private readonly now: () => number;
  readonly ttlMs: number;
  private readonly touchIntervalMs: number;

  constructor(
    readonly store: SessionStore,
    opts: SessionManagerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
    this.touchIntervalMs = opts.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS;
  }

  get backend(): SessionStore['backend'] {
    return this.store.backend;
  }

  /** New session for a freshly signed-in user (always a new id: sign-in rotates). */
  async create(init: Pick<SessionData, 'userId' | 'currentOrgId' | 'role'>): Promise<Session> {
    const t = this.now();
    const data: SessionData = {
      ...init,
      csrfToken: randomToken(),
      createdAt: t,
      lastSeenAt: t,
      rotatedAt: t,
    };
    const id = randomToken();
    await this.write(id, data);
    return { id, data, touched: true };
  }

  /** Resolve a cookie value. Unknown, malformed, corrupt or idle-expired → null. */
  async read(id: string | null | undefined): Promise<Session | null> {
    if (!id || !TOKEN_RE.test(id)) return null;
    const key = sha256Hex(id);
    const raw = await this.store.get(key);
    if (raw === null) return null;
    let parsed: SessionData;
    try {
      const result = sessionDataSchema.safeParse(JSON.parse(raw));
      if (!result.success) throw new Error('corrupt session');
      parsed = result.data;
    } catch {
      await this.store.delete(key);
      return null;
    }
    const t = this.now();
    if (t - parsed.lastSeenAt >= this.ttlMs) {
      await this.store.delete(key);
      return null;
    }
    if (t - parsed.lastSeenAt >= this.touchIntervalMs) {
      const data = { ...parsed, lastSeenAt: t };
      await this.write(id, data);
      return { id, data, touched: true };
    }
    return { id, data: parsed, touched: false };
  }

  /**
   * New id + new CSRF token carrying the (patched) data; the old id is deleted. Called on
   * sign-in, organisation switch and role change.
   */
  async rotate(
    session: Session,
    patch: Partial<Pick<SessionData, 'currentOrgId' | 'role'>> = {},
  ): Promise<Session> {
    const t = this.now();
    const data: SessionData = {
      ...session.data,
      ...patch,
      csrfToken: randomToken(),
      lastSeenAt: t,
      rotatedAt: t,
    };
    const id = randomToken();
    await this.write(id, data);
    await this.store.delete(sha256Hex(session.id));
    return { id, data, touched: true };
  }

  async destroy(id: string): Promise<void> {
    if (!TOKEN_RE.test(id)) return;
    await this.store.delete(sha256Hex(id));
  }

  private async write(id: string, data: SessionData): Promise<void> {
    await this.store.set(sha256Hex(id), JSON.stringify(data), this.ttlMs);
  }
}

// ---------- cookie ----------

export const SECURE_COOKIE_NAME = '__Host-harbour_sid';
/** Only for NODE_ENV=development over plain http, where `__Host-` (which requires Secure) cannot work. */
export const INSECURE_COOKIE_NAME = 'harbour_sid';

export interface CookiePolicy {
  name: string;
  secure: boolean;
}

/** `__Host-harbour_sid; Secure` everywhere except development over http. */
export const cookiePolicyFor = (
  nodeEnv: 'development' | 'test' | 'production',
  request: Request,
): CookiePolicy => {
  const insecure = nodeEnv === 'development' && new URL(request.url).protocol === 'http:';
  return insecure
    ? { name: INSECURE_COOKIE_NAME, secure: false }
    : { name: SECURE_COOKIE_NAME, secure: true };
};

export const serializeSessionCookie = (
  policy: CookiePolicy,
  id: string,
  maxAgeMs: number = SESSION_TTL_MS,
): string =>
  [
    `${policy.name}=${id}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'HttpOnly',
    ...(policy.secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');

export const clearSessionCookie = (policy: CookiePolicy): string =>
  [
    `${policy.name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    ...(policy.secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');

/** The session cookie value from the request, or null. Only the policy's cookie name is read. */
export const readSessionCookie = (request: Request, policy: CookiePolicy): string | null => {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === policy.name) {
      const value = part.slice(eq + 1).trim();
      return TOKEN_RE.test(value) ? value : null;
    }
  }
  return null;
};
