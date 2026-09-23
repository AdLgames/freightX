import { can, type Action } from '@harbour/db';
import { NavLink, Outlet } from 'react-router';
import type { Route } from './+types/app.settings';
import { requireOrgContext } from '../services/auth.server';

/**
 * Settings & billing layout (M2 owns this file; M6 adds `app.settings.billing.tsx`, which renders
 * in the Outlet below). Sections are hidden from roles that cannot use them; every child route
 * still calls `requireOrgContext(request, { permission })` itself.
 */
export const meta: Route.MetaFunction = () => [{ title: 'Settings & billing — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export interface SettingsSection {
  to: string;
  label: string;
  description: string;
  permission?: Action;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    to: '/app/settings/organisation',
    label: 'Organisation',
    description: 'Name, base currency, EORI and VAT registration, Companies House record.',
  },
  {
    to: '/app/settings/customs',
    label: 'Customs profile',
    description: 'Import VAT handling, how duty is paid, deferment account and CDS authority.',
  },
  {
    to: '/app/settings/members',
    label: 'Members',
    description: 'Who can sign in to this organisation and what they can do.',
  },
  {
    to: '/app/settings/audit',
    label: 'Audit log',
    description: 'Every change to settings, members and quotes, with who made it and when.',
    permission: 'audit.view',
  },
  {
    // Owned by milestone M6 (created in parallel; 404 until it lands).
    to: '/app/settings/billing',
    label: 'Billing',
    description: 'Subscription and invoices.',
    permission: 'billing.manage',
  },
];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  return {
    sections: SETTINGS_SECTIONS.filter((s) => !s.permission || can(ctx.role, s.permission)),
  };
};

export default function SettingsLayout({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <h1>Settings & billing</h1>
      <nav aria-label="Settings" className="settings-nav">
        <ul>
          <li>
            <NavLink to="/app/settings" end>
              Overview
            </NavLink>
          </li>
          {loaderData.sections.map((s) => (
            <li key={s.to}>
              <NavLink to={s.to}>{s.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </>
  );
}
