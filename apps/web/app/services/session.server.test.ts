import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisClient, type RedisClient } from './redis.server';
import {
  INSECURE_COOKIE_NAME,
  InMemorySessionStore,
  RedisSessionStore,
  SECURE_COOKIE_NAME,
  SESSION_TTL_MS,
  SessionManager,
  clearSessionCookie,
  cookiePolicyFor,
  readSessionCookie,
  serializeSessionCookie,
  sha256Hex,
  type RedisSessionClient,
} from './session.server';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const USER = randomUUID();
const ORG = randomUUID();

const setup = () => {
  const clock = { ms: Date.UTC(2026, 8, 23, 10) };
  const now = () => clock.ms;
  const store = new InMemorySessionStore('test', now);
  let writes = 0;
  const countingStore = {
    backend: store.backend,
    get: (k: string) => store.get(k),
    set: async (k: string, v: string, ttl: number) => {
      writes += 1;
      await store.set(k, v, ttl);
    },
    delete: (k: string) => store.delete(k),
  };
  const sessions = new SessionManager(countingStore, { now });
  return { clock, store, sessions, writes: () => writes };
};

describe('SessionManager', () => {
  it('stores sessions under sha256(id) only; the raw id is never a key or a value', async () => {
    const { store, sessions } = setup();
    const s = await sessions.create({ userId: USER, currentOrgId: ORG, role: 'OWNER' });
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.keys()).toEqual([sha256Hex(s.id)]);
    const raw = await store.get(sha256Hex(s.id));
    expect(raw).not.toContain(s.id);
    expect(s.data).toMatchObject({ userId: USER, currentOrgId: ORG, role: 'OWNER' });
    expect(s.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await sessions.read(s.id))?.data).toEqual(s.data);
  });

  it('rejects unknown, malformed and corrupt ids', async () => {
    const { store, sessions } = setup();
    expect(await sessions.read(null)).toBeNull();
    expect(await sessions.read('short')).toBeNull();
    expect(await sessions.read('A'.repeat(43))).toBeNull();
    const s = await sessions.create({ userId: USER, currentOrgId: null, role: null });
    await store.set(sha256Hex(s.id), '{"userId":"not-a-uuid"}', HOUR);
    expect(await sessions.read(s.id)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it('rotation issues a new id and CSRF token and invalidates the old id', async () => {
    const { sessions } = setup();
    const s = await sessions.create({ userId: USER, currentOrgId: null, role: null });
    const r = await sessions.rotate(s, { currentOrgId: ORG, role: 'ADMIN' });
    expect(r.id).not.toBe(s.id);
    expect(r.data.csrfToken).not.toBe(s.data.csrfToken);
    expect(r.data).toMatchObject({ userId: USER, currentOrgId: ORG, role: 'ADMIN' });
    expect(r.data.createdAt).toBe(s.data.createdAt);
    expect(await sessions.read(s.id)).toBeNull();
    expect((await sessions.read(r.id))?.data.currentOrgId).toBe(ORG);
  });

  it('slides the 30-day expiry, writing at most once an hour', async () => {
    const { clock, sessions, writes } = setup();
    const s = await sessions.create({ userId: USER, currentOrgId: null, role: null });
    const afterCreate = writes();

    clock.ms += 30 * 60 * 1000;
    const quiet = await sessions.read(s.id);
    expect(quiet?.touched).toBe(false);
    expect(writes()).toBe(afterCreate);

    clock.ms += 31 * 60 * 1000;
    const touched = await sessions.read(s.id);
    expect(touched?.touched).toBe(true);
    expect(touched?.data.lastSeenAt).toBe(clock.ms);
    expect(writes()).toBe(afterCreate + 1);

    // Active use keeps it alive well past 30 days from creation...
    for (let i = 0; i < 40; i += 1) {
      clock.ms += DAY;
      expect(await sessions.read(s.id), `day ${i}`).not.toBeNull();
    }
    // ...and 30 idle days end it.
    clock.ms += SESSION_TTL_MS;
    expect(await sessions.read(s.id)).toBeNull();
  });

  it('destroy (logout) removes the session', async () => {
    const { sessions } = setup();
    const s = await sessions.create({ userId: USER, currentOrgId: null, role: null });
    await sessions.destroy(s.id);
    expect(await sessions.read(s.id)).toBeNull();
  });

  it('the in-memory store refuses production', () => {
    expect(() => new InMemorySessionStore('production')).toThrow(/development and test only/);
  });
});

describe('session cookie', () => {
  const https = new Request('https://app.example.test/app');
  const http = new Request('http://localhost:3000/app');

  it('is __Host-harbour_sid; HttpOnly; Secure; SameSite=Lax; Path=/ with a 30-day Max-Age', () => {
    for (const [env, req] of [
      ['production', https],
      ['test', http],
      ['development', https],
    ] as const) {
      const policy = cookiePolicyFor(env, req);
      expect(policy).toEqual({ name: SECURE_COOKIE_NAME, secure: true });
      const header = serializeSessionCookie(policy, 'x'.repeat(43));
      expect(header).toBe(
        `__Host-harbour_sid=${'x'.repeat(43)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      );
      expect(header).not.toMatch(/Domain=/i);
    }
  });

  it('uses harbour_sid without Secure only in development over http', () => {
    const policy = cookiePolicyFor('development', http);
    expect(policy).toEqual({ name: INSECURE_COOKIE_NAME, secure: false });
    expect(serializeSessionCookie(policy, 'y'.repeat(43))).toBe(
      `harbour_sid=${'y'.repeat(43)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
    );
    expect(clearSessionCookie(policy)).toBe(
      'harbour_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
  });

  it('reads only its own, well-formed cookie', () => {
    const policy = cookiePolicyFor('test', http);
    const id = 'a'.repeat(43);
    const req = (cookie: string) => new Request('http://localhost/', { headers: { cookie } });
    expect(readSessionCookie(req(`other=1; __Host-harbour_sid=${id}`), policy)).toBe(id);
    expect(readSessionCookie(req(`harbour_sid=${id}`), policy)).toBeNull();
    expect(readSessionCookie(req('__Host-harbour_sid=../../etc'), policy)).toBeNull();
    expect(readSessionCookie(new Request('http://localhost/'), policy)).toBeNull();
  });
});

describe('RedisSessionStore', () => {
  it('prefixes keys and sets a PX TTL', async () => {
    const calls: unknown[][] = [];
    const client: RedisSessionClient = {
      get: async (k) => {
        calls.push(['get', k]);
        return null;
      },
      set: async (...args) => {
        calls.push(['set', ...args]);
        return 'OK';
      },
      del: async (k) => {
        calls.push(['del', k]);
        return 1;
      },
    };
    const store = new RedisSessionStore(client);
    await store.set('abc', '{}', SESSION_TTL_MS);
    await store.get('abc');
    await store.delete('abc');
    expect(calls).toEqual([
      ['set', 'sess:abc', '{}', 'PX', SESSION_TTL_MS],
      ['get', 'sess:abc'],
      ['del', 'sess:abc'],
    ]);
  });
});

describe.skipIf(!process.env.REDIS_URL)('RedisSessionStore against Redis', () => {
  let client: RedisClient;
  afterAll(async () => {
    await client?.quit();
  });

  it('creates, slides, rotates and destroys sessions with a 30-day TTL', async () => {
    client = await createRedisClient(process.env.REDIS_URL!, () => {});
    const sessions = new SessionManager(new RedisSessionStore(client));
    const s = await sessions.create({ userId: USER, currentOrgId: ORG, role: 'MEMBER' });
    const ttl = await client.pttl(`sess:${sha256Hex(s.id)}`);
    expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS);
    expect(await client.exists(`sess:${s.id}`)).toBe(0);
    expect((await sessions.read(s.id))?.data.role).toBe('MEMBER');

    const r = await sessions.rotate(s, { role: 'ADMIN' });
    expect(await sessions.read(s.id)).toBeNull();
    expect((await sessions.read(r.id))?.data.role).toBe('ADMIN');

    await sessions.destroy(r.id);
    expect(await sessions.read(r.id)).toBeNull();
  });
});
