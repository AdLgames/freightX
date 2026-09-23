import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { getApp } from '../services/app.server';
import { endSession, requireUser } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';

/** POST only (CSRF-checked): destroys the server-side session and clears the cookie. */
export const loader = () => redirect('/');

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireUser(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const clearCookie = await endSession(ctx, request);
  requestLogger((await getApp()).logger, request).info('auth.signed_out', { userId: ctx.user.id });
  return redirect('/login?signed-out=1', { headers: { 'Set-Cookie': clearCookie } });
};
