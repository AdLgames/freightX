import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/onboarding.organization';
import { CsrfInput, CsrfProvider } from '../components/csrf';
import { getApp } from '../services/app.server';
import { authPrisma, requireUser, rotateSession } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { createOrganization, listUserOrganizations } from '../services/organizations.server';
import { readForm } from '../services/request.server';
import { createOrganizationSchema } from '../validators/auth';
import { fieldErrors } from '../validators/common';

/**
 * First sign-in with no memberships lands here: name the organisation, and we create the
 * Organization, an OWNER Membership and an empty CustomsProfile in one transaction (audited), put
 * it in the session (rotated: a privilege change) and go to /app. The EORI / VAT / customs wizard
 * is milestone M2; Home shows an "action required" banner until then.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Set up your organisation — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireUser(request);
  const orgs = await listUserOrganizations(authPrisma(ctx), ctx.user.id);
  return data(
    { csrfToken: ctx.session.data.csrfToken, hasOrganizations: orgs.length > 0 },
    { headers: ctx.headers },
  );
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireUser(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const log = requestLogger((await getApp()).logger, request);

  const nameField = form?.get('name');
  const rawName = typeof nameField === 'string' ? nameField : '';
  const parsed = createOrganizationSchema.safeParse({ name: rawName });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('onboarding.invalid', { fields: Object.keys(errors) });
    return data({ errors, name: rawName.slice(0, 200) }, { status: 400 });
  }

  const created = await createOrganization(authPrisma(ctx), {
    userId: ctx.user.id,
    name: parsed.data.name,
  });
  const { setCookie } = await rotateSession(ctx, request, {
    currentOrgId: created.organizationId,
    role: 'OWNER',
  });
  log.info('onboarding.org_created', { userId: ctx.user.id, orgId: created.organizationId });
  return redirect('/app', { headers: { 'Set-Cookie': setCookie } });
};

export default function OnboardingOrganization({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.errors.name;
  return (
    <CsrfProvider token={loaderData.csrfToken}>
      <section className="narrow-page">
        <h1>Set up your organisation</h1>
        <p>
          This is the business you import for. You can add your EORI number and customs details
          next, in Settings.
        </p>
        <Form method="post">
          <CsrfInput />
          <div className={`field${error ? ' has-error' : ''}`}>
            <label htmlFor="name">Organisation name</label>
            <span className="hint" id="name-hint">
              For example, your company or trading name. 2 to 120 characters.
            </span>
            {error ? (
              <span className="field-error" id="name-error">
                {error}
              </span>
            ) : null}
            <input
              id="name"
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={120}
              autoComplete="organization"
              defaultValue={actionData?.name ?? ''}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'name-hint name-error' : 'name-hint'}
            />
          </div>
          <button type="submit" className="button">
            Create organisation
          </button>
        </Form>
        {loaderData.hasOrganizations ? (
          <p>
            <Link to="/app">Back to your workspace</Link>
          </p>
        ) : null}
      </section>
    </CsrfProvider>
  );
}
