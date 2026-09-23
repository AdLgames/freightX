import { redirect } from 'react-router';
import type { Route } from './+types/signup';
import { getApp } from '../services/app.server';
import { requestLogger } from '../services/logger.server';
import { SIGNUP_LIMIT } from '../services/rate-limit.server';
import { clientIp, readForm } from '../services/request.server';
import { signupSchema } from '../validators/signup';

/** POST only: GET requests bounce to the landing page. */
export const loader = () => redirect('/');

const field = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

export const action = async ({ request }: Route.ActionArgs) => {
  const app = await getApp();
  const log = requestLogger(app.logger, request);

  const form = await readForm(request);
  if (!form) return redirect('/?signup=invalid');

  // Honeypot filled → a bot. Pretend it worked so it learns nothing.
  const honeypot = field(form, 'website');
  if (honeypot !== undefined && honeypot !== '') {
    log.info('signup.honeypot');
    return redirect('/?signup=ok');
  }

  const limit = await app.rateLimiter.consume(clientIp(request), SIGNUP_LIMIT);
  if (!limit.allowed) {
    log.warn('signup.rate_limited', { retryAfterSeconds: limit.retryAfterSeconds });
    return redirect('/?signup=rate-limited');
  }

  const parsed = signupSchema.safeParse({
    email: field(form, 'email') ?? '',
    website: honeypot,
    source: field(form, 'source'),
  });
  if (!parsed.success) {
    log.info('signup.invalid', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
    return redirect('/?signup=invalid');
  }

  const { created } = await app.stores.signups.add({
    email: parsed.data.email,
    source: parsed.data.source ?? null,
    createdAt: new Date(),
  });
  // Gate metric (§2: 50 signups). No email in the log line (§7.3).
  log.info('signup.completed', { created, source: parsed.data.source ?? null });
  return redirect('/?signup=ok');
};
