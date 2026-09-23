import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/invite.accept';
import { CsrfInput, CsrfProvider } from '../components/csrf';
import { getApp } from '../services/app.server';
import { authPrisma, requireUser, rotateSession } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import { acceptInvitation, lookupInvitation } from '../services/settings/invitations.server';
import { inviteTokenSchema } from '../validators/settings';

/**
 * Invitation landing page (M2). `/invite/accept?token=<org id>.<secret>`.
 *
 * - Not signed in → `/login?next=/invite/accept?token=…` (requireUser); after the magic link the
 *   visitor lands back here (login_.verify.tsx keeps `next` for this path even with no
 *   organisation yet).
 * - GET only shows who invited them and a "Join" button (mail scanners prefetch links; nothing
 *   changes on GET). POST accepts: the address must match the signed-in user's, case-insensitive.
 * - Expired / revoked / used / wrong-address links get one clear message each.
 */
export const meta: Route.MetaFunction = () => [
  { title: 'Join an organisation — Harbour' },
  { name: 'robots', content: 'noindex' },
];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const MESSAGES = {
  INVALID: 'This invitation link is not valid. Ask the person who invited you to send a new one.',
  EXPIRED: 'This invitation has expired. Ask the person who invited you to send a new one.',
  REVOKED: 'This invitation has been withdrawn.',
  ACCEPTED: 'This invitation has already been used.',
  WRONG_EMAIL:
    'This invitation was sent to a different email address. Sign out and sign in with the address it was sent to.',
} as const;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireUser(request);
  const token = inviteTokenSchema.safeParse(new URL(request.url).searchParams.get('token') ?? '');
  const base = { csrfToken: ctx.session.data.csrfToken, email: ctx.user.email };
  if (!token.success) {
    return data(
      { ...base, ok: false as const, message: MESSAGES.INVALID, invitation: null, token: '' },
      { headers: ctx.headers },
    );
  }
  const found = await lookupInvitation(authPrisma(ctx), token.data, ctx.user, new Date());
  if (!found.ok) {
    return data(
      { ...base, ok: false as const, message: MESSAGES[found.reason], invitation: null, token: '' },
      { headers: ctx.headers },
    );
  }
  return data(
    {
      ...base,
      ok: true as const,
      message: found.invitation.forThisUser ? null : MESSAGES.WRONG_EMAIL,
      invitation: {
        organizationName: found.invitation.organizationName,
        role: found.invitation.role,
        forThisUser: found.invitation.forThisUser,
      },
      token: `${token.data.organizationId}.${token.data.secret}`,
    },
    { headers: ctx.headers },
  );
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireUser(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const log = requestLogger((await getApp()).logger, request);

  const token = inviteTokenSchema.safeParse(form?.get('token') ?? '');
  if (!token.success) {
    log.info('invite.rejected', { userId: ctx.user.id, reason: 'INVALID' });
    return data({ error: MESSAGES.INVALID }, { status: 400 });
  }
  const result = await acceptInvitation(authPrisma(ctx), token.data, ctx.user, new Date());
  if (!result.ok) {
    log.info('invite.rejected', {
      userId: ctx.user.id,
      orgId: token.data.organizationId,
      reason: result.reason,
    });
    return data(
      { error: MESSAGES[result.reason] },
      { status: result.reason === 'WRONG_EMAIL' ? 403 : 400 },
    );
  }
  // Joining is a privilege change: rotate onto the new organisation.
  const { setCookie } = await rotateSession(ctx, request, {
    currentOrgId: result.organizationId,
    role: result.role,
  });
  log.info('invite.accepted', {
    userId: ctx.user.id,
    orgId: result.organizationId,
    membershipId: result.membershipId,
    role: result.role,
  });
  return redirect('/app', { headers: { 'Set-Cookie': setCookie } });
};

export default function InviteAccept({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.error ?? loaderData.message;
  const invitation = loaderData.invitation;
  return (
    <CsrfProvider token={loaderData.csrfToken}>
      <section className="narrow-page">
        <h1>Join an organisation</h1>
        {error ? (
          <div className="banner error" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
        {invitation ? (
          <p>
            You have been invited to join <strong>{invitation.organizationName}</strong> as{' '}
            <strong>{invitation.role.toLowerCase()}</strong>. You are signed in as{' '}
            <span className="code">{loaderData.email}</span>.
          </p>
        ) : null}
        {invitation && invitation.forThisUser && !actionData?.error ? (
          <Form method="post">
            <CsrfInput />
            <input type="hidden" name="token" value={loaderData.token} />
            <button type="submit" className="button">
              Join {invitation.organizationName}
            </button>
          </Form>
        ) : null}
        <p>
          <Link to="/app">Go to your workspace</Link>
          {' · '}
          <Form method="post" action="/logout" style={{ display: 'inline' }}>
            <CsrfInput />
            <button type="submit" className="button secondary">
              Sign out
            </button>
          </Form>
        </p>
      </section>
    </CsrfProvider>
  );
}
