import { redirect } from 'react-router';
import type { Route } from './+types/app.switch-org';
import { getApp } from '../services/app.server';
import { authPrisma, requireUser, rotateSession } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { findMembership, recordOrgSwitch } from '../services/organizations.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { switchOrganizationSchema } from '../validators/auth';

/**
 * Organisation switcher (POST only, CSRF-checked). The requested organisation is only a request:
 * the membership is verified in the database before the session changes, the session is rotated
 * (privilege change) and the switch is audited in the target organisation.
 */
export const loader = () => redirect('/app');

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireUser(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const log = requestLogger((await getApp()).logger, request);

  const parsed = switchOrganizationSchema.safeParse({
    organizationId: form?.get('organizationId'),
  });
  const denied = () =>
    pageError(
      403,
      'You cannot switch to that organisation',
      'You are not a member of it, or it no longer exists.',
    );
  if (!parsed.success) {
    log.warn('session.org_switch_denied', { userId: ctx.user.id, reason: 'invalid' });
    throw denied();
  }
  const orgId = parsed.data.organizationId;
  const membership = await findMembership(authPrisma(ctx), orgId, ctx.user.id);
  if (!membership) {
    log.warn('session.org_switch_denied', { userId: ctx.user.id, orgId, reason: 'not_member' });
    throw denied();
  }

  await recordOrgSwitch(authPrisma(ctx), { userId: ctx.user.id, organizationId: orgId });
  const { setCookie } = await rotateSession(ctx, request, {
    currentOrgId: orgId,
    role: membership.role,
  });
  log.info('session.org_switch', { userId: ctx.user.id, orgId });
  return redirect('/app', { headers: { 'Set-Cookie': setCookie } });
};
