import { can } from '@harbour/db';
import { Form, NavLink, Outlet, data } from 'react-router';
import type { Route } from './+types/app';
import { CsrfInput, CsrfProvider } from '../components/csrf';
import { WORKSPACE_NAV } from '../components/workspace-nav';
import { requireOrgContext, withUser } from '../services/auth.server';
import { userOrganizationsQuery } from '../services/organizations.server';

/**
 * Workspace shell for every /app/* route (M1 owns this file). The loader authenticates, resolves
 * the organisation from the session and re-checks the membership (requireOrgContext); child
 * routes still call requireOrgContext themselves (memoised per request, so it costs nothing extra)
 * because a layout guard does not protect a child loader's data.
 *
 * Extension points: navigation lives in components/workspace-nav.ts; forms use <CsrfInput/>.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Workspace — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const orgs = await withUser(ctx, (tx) => userOrganizationsQuery(tx, ctx.user.id));
  return data(
    {
      user: { email: ctx.user.email },
      org: ctx.org,
      role: ctx.role,
      orgs: orgs.map((m) => m.organization),
      csrfToken: ctx.session.data.csrfToken,
      nav: WORKSPACE_NAV.filter((item) => !item.permission || can(ctx.role, item.permission)),
    },
    { headers: ctx.headers },
  );
};

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { org, orgs, user, nav, csrfToken } = loaderData;
  return (
    <CsrfProvider token={csrfToken}>
      <div className="workspace">
        <div className="workspace-bar">
          <p className="workspace-org">
            <span className="muted">Organisation</span> <strong>{org.name}</strong>
          </p>
          {orgs.length > 1 ? (
            <Form method="post" action="/app/switch-org" className="org-switch">
              <CsrfInput />
              <label htmlFor="org-switch">Switch organisation</label>
              <select id="org-switch" name="organizationId" defaultValue={org.id}>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="button secondary">
                Switch
              </button>
            </Form>
          ) : null}
          <Form method="post" action="/logout" className="sign-out">
            <CsrfInput />
            <span className="muted">{user.email}</span>
            <button type="submit" className="button secondary">
              Sign out
            </button>
          </Form>
        </div>
        <nav aria-label="Workspace" className="workspace-nav">
          <ul>
            {nav.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end ?? false}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="workspace-content">
          <Outlet />
        </div>
      </div>
    </CsrfProvider>
  );
}
