import { createHash, timingSafeEqual } from 'node:crypto';
import type { Session } from './session.server';
import { getApp } from './app.server';
import { pageError } from './page-error';

/**
 * CSRF (§7.1 "CSRF token on every mutating form"). Two layers:
 *
 * 1. Same-origin check: a POST whose `Origin` is present must equal the app origin (APP_URL, or
 *    the request's own origin in development/test when APP_URL is unset). Without `Origin`, a
 *    `Sec-Fetch-Site` header other than `same-origin`/`none` is rejected. Neither header (old
 *    clients, curl) → the token decides.
 * 2. Synchroniser token: `session.data.csrfToken`, rendered by `<CsrfInput/>` as the `_csrf` field
 *    and compared in constant time.
 *
 * Both failures are a 403 page. SameSite=Lax on the session cookie is a third, implicit layer.
 */
export const CSRF_FIELD = '_csrf';

const FORBIDDEN_FORM = () =>
  pageError(
    403,
    'This form has expired',
    'Go back, reload the page and try again. If you opened the page a while ago, you may need to sign in again.',
  );

export const expectedOrigin = (request: Request, appUrl: string | null): string =>
  appUrl ?? new URL(request.url).origin;

/** Throws a 403 page when the request is visibly cross-site. */
export const assertSameOrigin = (request: Request, appUrl: string | null): void => {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin !== expectedOrigin(request, appUrl)) throw FORBIDDEN_FORM();
    return;
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') throw FORBIDDEN_FORM();
};

/** Constant-time string equality (hash both sides so lengths never leak through timing). */
export const tokensEqual = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
};

/** Pure form of `requireCsrf` with the app origin passed in (unit-tested). */
export const checkCsrf = (
  request: Request,
  form: FormData | null,
  session: Session,
  appUrl: string | null,
): void => {
  assertSameOrigin(request, appUrl);
  const submitted = form?.get(CSRF_FIELD);
  if (typeof submitted !== 'string' || submitted === '') throw FORBIDDEN_FORM();
  if (!tokensEqual(submitted, session.data.csrfToken)) throw FORBIDDEN_FORM();
};

/**
 * Call at the top of every mutating workspace action, after reading the form:
 *
 *   const form = await readForm(request);
 *   await requireCsrf(request, form, ctx.session);
 */
export const requireCsrf = async (
  request: Request,
  form: FormData | null,
  session: Session,
): Promise<void> => {
  const app = await getApp();
  checkCsrf(request, form, session, app.auth.appUrl);
};
