import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/login_.verify';
import { requireWorkspace, startSession } from '../services/auth.server';
import { assertSameOrigin } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { consumeMagicLink } from '../services/magic-link.server';
import { listUserOrganizations } from '../services/organizations.server';
import { readForm } from '../services/request.server';
import { magicTokenSchema, safeNext } from '../validators/auth';

/**
 * Magic-link landing page. GET only renders a "Sign in" button — it never touches the token —
 * because mail scanners and link previews fetch URLs: if GET consumed the token, the scanner would
 * use up the link before the person clicks it. The POST consumes the token (single use, atomic),
 * creates the user on first sign-in and starts a brand-new session.
 */

export const meta: Route.MetaFunction = () => [
  { title: 'Confirm sign-in — Harbour' },
  { name: 'robots', content: 'noindex' },
];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const INVALID_LINK =
  'This sign-in link has expired or has already been used. Request a new one below.';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireWorkspace();
  const url = new URL(request.url);
  const token = magicTokenSchema.safeParse(url.searchParams.get('token') ?? '');
  return {
    token: token.success ? token.data : null,
    next: safeNext(url.searchParams.get('next')),
  };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ws = await requireWorkspace();
  const { app, prisma } = ws;
  const log = requestLogger(app.logger, request);
  assertSameOrigin(request, app.auth.appUrl);

  const form = await readForm(request);
  const token = magicTokenSchema.safeParse(form?.get('token') ?? '');
  if (!form || !token.success) {
    log.info('auth.link_invalid', { reason: 'malformed' });
    return data({ error: INVALID_LINK }, { status: 400 });
  }
  const next = safeNext(form.get('next'));

  const consumed = await consumeMagicLink(prisma, token.data, new Date());
  if (!consumed) {
    // Unknown, expired and used tokens are indistinguishable to the visitor.
    log.info('auth.link_invalid', { reason: 'unusable' });
    return data({ error: INVALID_LINK }, { status: 400 });
  }

  const [first] = await listUserOrganizations(prisma, consumed.userId);
  const { setCookie } = await startSession(ws, request, {
    userId: consumed.userId,
    currentOrgId: first?.organization.id ?? null,
    role: first?.role ?? null,
  });
  log.info('auth.signed_in', {
    userId: consumed.userId,
    newUser: consumed.newUser,
    orgId: first?.organization.id ?? null,
  });
  // M2: an invitee with no organisation yet continues to the invitation, not to onboarding.
  const acceptingInvite = next.startsWith('/invite/accept');
  return redirect(first || acceptingInvite ? next : '/onboarding/organization', {
    headers: { 'Set-Cookie': setCookie },
  });
};

export default function VerifyLogin({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.error ?? (loaderData.token ? null : INVALID_LINK);
  return (
    <section className="narrow-page">
      <h1>Sign in to Harbour</h1>
      {error ? (
        <>
          <div className="banner error" role="alert">
            <p>{error}</p>
          </div>
          <p>
            <Link to="/login" className="button">
              Request a new link
            </Link>
          </p>
        </>
      ) : (
        <Form method="post">
          <p>Press the button to finish signing in on this device.</p>
          <input type="hidden" name="token" value={loaderData.token ?? ''} />
          <input type="hidden" name="next" value={loaderData.next} />
          <button type="submit" className="button">
            Sign in
          </button>
        </Form>
      )}
    </section>
  );
}
