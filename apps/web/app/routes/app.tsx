import { can } from '@harbour/db';
import { Box, Menu, Search } from 'lucide-react';
import { Form, NavLink, Outlet, data } from 'react-router';
import type { Route } from './+types/app';
import { CsrfInput, CsrfProvider } from '../components/csrf';
import { NavIcon } from '../components/workspace-icons';
import { WORKSPACE_NAV } from '../components/workspace-nav';
import { DISCLAIMER } from '../root';
import { requireOrgContext, withUser } from '../services/auth.server';
import { userOrganizationsQuery } from '../services/organizations.server';

/**
 * Workspace shell for every /app/* route (M1 owns this file). The loader authenticates, resolves
 * the organisation from the session and re-checks the membership (requireOrgContext); child
 * routes still call requireOrgContext themselves (memoised per request, so it costs nothing extra)
 * because a layout guard does not protect a child loader's data.
 *
 * Layout: docs/design-system.md — navy sidebar on wide screens, top bar with a CSS-only menu on
 * narrow ones (a <details> element, so it works without JavaScript).
 * Extension points: navigation lives in components/workspace-nav.ts; forms use <CsrfInput/>.
 */

export const handle = { layout: 'workspace' as const };

export const meta: Route.MetaFunction = () => [{ title: 'Workspace — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

const initialsOf = (email: string): string => {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : local.slice(0, 2);
  return letters.toUpperCase();
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const orgs = await withUser(ctx, (tx) => userOrganizationsQuery(tx, ctx.user.id));
  return data(
    {
      user: { email: ctx.user.email, initials: initialsOf(ctx.user.email) },
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
  const navList = (
    <ul>
      {nav.map((item) => (
        <li key={item.to}>
          <NavLink to={item.to} end={item.end ?? false}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
  const orgControls = (
    <div className="ws-org">
      <p className="ws-org-name">
        <span className="ws-label">Organisation</span>
        <strong>{org.name}</strong>
      </p>
      {orgs.length > 1 ? (
        <Form method="post" action="/app/switch-org" className="org-switch">
          <CsrfInput />
          <label htmlFor="org-switch" className="ws-label">
            Switch organisation
          </label>
          <select id="org-switch" name="organizationId" defaultValue={org.id}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button type="submit" className="button ghost small">
            Switch
          </button>
        </Form>
      ) : null}
      <Form method="post" action="/logout" className="sign-out">
        <CsrfInput />
        <button type="submit" className="button ghost small">
          Sign out
        </button>
      </Form>
    </div>
  );

  return (
    <CsrfProvider token={csrfToken}>
      <div className="ws">
        <aside className="ws-sidebar">
          <div className="ws-brand">
            <span className="brand-mark" aria-hidden="true">
              <Box className="icon" />
            </span>
            <span>Harbour</span>
          </div>
          <nav aria-label="Workspace" className="ws-nav">
            {navList}
          </nav>
          {orgControls}
        </aside>

        <div className="ws-main">
          <header className="ws-header">
            <details className="ws-menu">
              <summary aria-label="Open menu">
                <Menu className="icon" aria-hidden="true" />
                <span className="ws-menu-brand">
                  <span className="brand-mark" aria-hidden="true">
                    <Box className="icon" />
                  </span>
                  Harbour
                </span>
              </summary>
              <nav aria-label="Workspace (mobile)" className="ws-nav ws-nav-mobile">
                {navList}
                {orgControls}
              </nav>
            </details>
            <Form method="get" action="/app/products" className="ws-search" role="search">
              <Search className="icon" aria-hidden="true" />
              <label htmlFor="ws-search" className="visually-hidden">
                Search products
              </label>
              <input
                id="ws-search"
                name="q"
                type="search"
                placeholder="Search products by SKU or name"
                maxLength={120}
              />
            </Form>
            <p className="ws-user" title={user.email}>
              <span className="avatar" aria-hidden="true">
                {user.initials}
              </span>
              <span className="visually-hidden">{user.email}</span>
            </p>
          </header>
          <main id="main" className="ws-content">
            <Outlet />
          </main>
          <footer className="ws-footer">
            <p className="muted">{DISCLAIMER}</p>
          </footer>
        </div>
      </div>
    </CsrfProvider>
  );
}
