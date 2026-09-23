import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CSRF_FIELD_NAME } from '../components/csrf';
import { CSRF_FIELD, assertSameOrigin, checkCsrf, tokensEqual } from './csrf.server';
import { pageErrorSchema } from './page-error';
import { randomToken, type Session } from './session.server';

const session: Session = {
  id: randomToken(),
  touched: false,
  data: {
    userId: randomUUID(),
    currentOrgId: null,
    role: null,
    csrfToken: randomToken(),
    epoch: 0, // M2
    createdAt: 0,
    lastSeenAt: 0,
    rotatedAt: 0,
  },
};

const post = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/app/thing', { method: 'POST', headers });

const form = (token?: string) => {
  const f = new FormData();
  if (token !== undefined) f.set(CSRF_FIELD, token);
  return f;
};

/** Runs `fn` and returns the HTTP status of the thrown page error, or null if nothing threw. */
const statusOf = (fn: () => void): number | null => {
  try {
    fn();
    return null;
  } catch (err) {
    const e = err as { init?: { status?: number }; data?: unknown };
    expect(pageErrorSchema.safeParse(e.data).success).toBe(true);
    return e.init?.status ?? null;
  }
};

describe('checkCsrf', () => {
  it('the component and the server agree on the field name', () => {
    expect(CSRF_FIELD_NAME).toBe(CSRF_FIELD);
  });

  it('rejects a missing token with 403', () => {
    expect(statusOf(() => checkCsrf(post(), form(), session, null))).toBe(403);
    expect(statusOf(() => checkCsrf(post(), form(''), session, null))).toBe(403);
    expect(statusOf(() => checkCsrf(post(), null, session, null))).toBe(403);
  });

  it('rejects a wrong token with 403', () => {
    expect(statusOf(() => checkCsrf(post(), form(randomToken()), session, null))).toBe(403);
    expect(
      statusOf(() => checkCsrf(post(), form(session.data.csrfToken.slice(1)), session, null)),
    ).toBe(403);
  });

  it('rejects a cross-site Origin even with the right token', () => {
    const token = form(session.data.csrfToken);
    expect(
      statusOf(() => checkCsrf(post({ origin: 'https://evil.example' }), token, session, null)),
    ).toBe(403);
    expect(statusOf(() => checkCsrf(post({ origin: 'null' }), token, session, null))).toBe(403);
    // With APP_URL set, the request's own host does not count.
    expect(
      statusOf(() =>
        checkCsrf(post({ origin: 'http://localhost' }), token, session, 'https://app.example'),
      ),
    ).toBe(403);
  });

  it('rejects Sec-Fetch-Site: cross-site / same-site when there is no Origin', () => {
    const token = form(session.data.csrfToken);
    for (const site of ['cross-site', 'same-site']) {
      expect(
        statusOf(() => checkCsrf(post({ 'sec-fetch-site': site }), token, session, null)),
      ).toBe(403);
    }
  });

  it('passes with the right token from the same origin', () => {
    const token = form(session.data.csrfToken);
    expect(statusOf(() => checkCsrf(post(), token, session, null))).toBeNull();
    expect(
      statusOf(() => checkCsrf(post({ origin: 'http://localhost' }), token, session, null)),
    ).toBeNull();
    expect(
      statusOf(() =>
        checkCsrf(
          post({ origin: 'https://app.example', 'sec-fetch-site': 'same-origin' }),
          token,
          session,
          'https://app.example',
        ),
      ),
    ).toBeNull();
  });

  it('assertSameOrigin alone guards pre-session forms (login)', () => {
    expect(statusOf(() => assertSameOrigin(post({ origin: 'https://evil.example' }), null))).toBe(
      403,
    );
    expect(statusOf(() => assertSameOrigin(post(), null))).toBeNull();
  });

  it('tokensEqual is exact', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });
});
