import type { Action } from '@harbour/db';

/**
 * Workspace navigation (docs/phase-1-workspace-ux.md: "Home · Quotes · Products · Documents ·
 * Settings & billing"). EXTENSION POINT: a milestone adds or changes an entry here, in this one
 * array, and owns the route file it points at. `permission` hides the entry from roles that
 * cannot use it; the route itself must still call `requireOrgContext(request, { permission })`.
 */
export interface WorkspaceNavItem {
  to: string;
  label: string;
  /** Match only the exact path (for the index route). */
  end?: boolean;
  permission?: Action;
}

export const WORKSPACE_NAV: readonly WorkspaceNavItem[] = [
  { to: '/app', label: 'Home', end: true },
  { to: '/app/quotes', label: 'Quotes', permission: 'quote.view' },
  { to: '/app/products', label: 'Products' },
  { to: '/app/documents', label: 'Documents', permission: 'doc.download' },
  { to: '/app/tracking', label: 'Tracking' }, // M9 (ADR-0017): view for every role; tracking needs shipment.track
  { to: '/app/settings', label: 'Settings & billing' },
];
