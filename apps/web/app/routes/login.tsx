import { Form, data, redirect } from 'react-router';
import type { Route } from './+types/login';
import { readSession, requireWorkspace } from '../services/auth.server';
import { assertSameOrigin } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { hashEmail, hashIp, issueMagicLink, magicLinkUrl } from '../services/magic-link.server';
import { pageError } from '../services/page-error';
import { LOGIN_EMAIL_LIMIT, LOGIN_IP_LIMIT } from '../services/rate-limit.server';
import { clientIp, readForm } from '../services/request.server';
import { TURNSTILE_FIELD } from '../services/turnstile.server';
import { loginSchema, safeNext } from '../validators/auth';

/**
 * Magic-link sign-in (§7.1). GET renders the form; POST issues a 15-minute single-use link.
 *
 * The POST answers "If that address can sign in, we've sent a link" for every valid address:
 * links are sent to unknown addresses too (the User is created only when a link is confirmed), so
 * the response never reveals whether an account exists. Rate limits: 20/hour per IP, 5/hour per
 * address, both keyed by hashes. Neither the address nor the IP is logged.
 */

const SENT_MESSAGE = "If that address can sign in, we've sent a link.";

export const meta: Route.MetaFunction = () => [
  { title: 'Sign in — Harbour' },
  { name: 'robots', content: 'noindex' },
];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const signInUnavailable = () =>
  pageError(
    503,
    'Sign-in is not available yet',
    'We are still setting up sign-in. The landed-cost calculator is available in the meantime.',
  );

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ws = await requireWorkspace();
  if (!ws.app.auth.email) throw signInUnavailable();
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));
  const { session } = await readSession(ws, request);
  if (session) throw redirect(next);
  return {
    next,
    signedOut: url.searchParams.get('signed-out') === '1',
    turnstileSiteKey: ws.app.turnstile.enabled ? ws.app.turnstile.siteKey : null,
  };
};

export type LoginActionData =
  | { status: 'sent'; next: string }
  | { status: 'error'; next: string; message: string; field: 'email' | null; email: string };

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ws = await requireWorkspace();
  const { app, prisma } = ws;
  const email = app.auth.email;
  if (!email) throw signInUnavailable();
  const log = requestLogger(app.logger, request);
  assertSameOrigin(request, app.auth.appUrl);

  const form = await readForm(request);
  if (!form) {
    return data<LoginActionData>(
      {
        status: 'error',
        next: '/app',
        message: 'We could not read that. Please try again.',
        field: null,
        email: '',
      },
      { status: 400 },
    );
  }
  const next = safeNext(form.get('next'));
  const rawEmail = field(form, 'email').slice(0, 320);
  const fail = (status: number, message: string, f: 'email' | null = null) =>
    data<LoginActionData>(
      { status: 'error', next, message, field: f, email: rawEmail },
      { status },
    );

  const parsed = loginSchema.safeParse({ email: rawEmail });
  if (!parsed.success) {
    log.info('auth.login_invalid');
    return fail(400, 'Enter a valid email address, like name@example.co.uk.', 'email');
  }

  const turnstile = await app.turnstile.verify(field(form, TURNSTILE_FIELD));
  if (!turnstile.ok) {
    log.info('auth.turnstile_rejected', { reason: turnstile.reason });
    return fail(
      400,
      turnstile.reason === 'UNAVAILABLE'
        ? 'We could not confirm you are human right now. Please try again in a minute.'
        : 'Please complete the "I am human" check and try again.',
    );
  }

  // Both buckets are consumed on every attempt; either one running out stops the request. The
  // message is the same whether or not the address has an account.
  const ip = clientIp(request);
  const byIp = await app.rateLimiter.consume(hashIp(ip), LOGIN_IP_LIMIT);
  const byEmail = await app.rateLimiter.consume(hashEmail(parsed.data.email), LOGIN_EMAIL_LIMIT);
  if (!byIp.allowed || !byEmail.allowed) {
    const retryAfter = Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds);
    log.warn('auth.rate_limited', {
      scope: !byIp.allowed ? 'ip' : 'email',
      retryAfterSeconds: retryAfter,
    });
    return data<LoginActionData>(
      {
        status: 'error',
        next,
        message: 'Too many sign-in requests. Please wait a while and try again.',
        field: null,
        email: rawEmail,
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const { token } = await issueMagicLink(prisma, {
    email: parsed.data.email,
    ipHash: ip === 'unknown' ? null : hashIp(ip),
    now: new Date(),
  });
  const origin = app.auth.appUrl ?? new URL(request.url).origin;
  const link = magicLinkUrl(origin, token, next);
  try {
    await email.send({
      to: parsed.data.email,
      subject: 'Your Harbour sign-in link',
      text: [
        'Use this link to sign in to Harbour. It works once and expires in 15 minutes.',
        '',
        link,
        '',
        'If you did not ask to sign in, ignore this email. Nobody can sign in without the link.',
      ].join('\n'),
    });
  } catch (err) {
    log.error('auth.link_send_failed', {
      transport: email.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(503, 'We could not send the email just now. Please try again in a few minutes.');
  }
  log.info('auth.link_sent', { transport: email.name });
  return data<LoginActionData>({ status: 'sent', next });
};

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const sent = actionData?.status === 'sent';
  const error = actionData?.status === 'error' ? actionData : null;
  const next = actionData?.next ?? loaderData.next;

  return (
    <section className="narrow-page">
      <h1>Sign in to Harbour</h1>
      {loaderData.signedOut && !actionData ? (
        <div className="banner notice" role="status">
          <p>You have signed out.</p>
        </div>
      ) : null}

      {sent ? (
        <div className="banner ready" role="status">
          <h2>Check your email</h2>
          <p>{SENT_MESSAGE} It works once and expires in 15 minutes.</p>
          <p className="muted">No email after a few minutes? Check spam, or try again.</p>
        </div>
      ) : null}

      {error && error.field === null ? (
        <div className="banner error" role="alert">
          <p>{error.message}</p>
        </div>
      ) : null}

      <p>We will email you a sign-in link. There is no password.</p>
      <Form method="post" className="login-form">
        <input type="hidden" name="next" value={next} />
        <div className={`field${error?.field === 'email' ? ' has-error' : ''}`}>
          <label htmlFor="email">Email address</label>
          {error?.field === 'email' ? (
            <span className="field-error" id="email-error">
              {error.message}
            </span>
          ) : null}
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            defaultValue={error?.email ?? ''}
            aria-invalid={error?.field === 'email' ? true : undefined}
            aria-describedby={error?.field === 'email' ? 'email-error' : undefined}
          />
        </div>
        {loaderData.turnstileSiteKey ? (
          <>
            <div
              className="cf-turnstile"
              data-sitekey={loaderData.turnstileSiteKey}
              data-theme="light"
            />
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          </>
        ) : null}
        <button type="submit" className="button">
          Email me a sign-in link
        </button>
      </Form>
    </section>
  );
}
