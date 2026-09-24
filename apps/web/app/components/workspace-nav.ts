import type { Action } from '@harbour/db';

/**
 * Workspace navigation (docs/phase-1-workspace-ux.md: "Home · Quotes · Products · Documents ·
 * Settings & billing"). EXTENSION POINT: a milestone adds or changes an entry here, in this one
 * array, and owns the route file it points at. `permission` hides the entry from roles that
 * cannot use it; the route itself must still call `requireOrgContext(request, { permission })`.
 * `icon` names a lucide icon rendered by the shell (see components/workspace-icons.tsx).
 */
export interface WorkspaceNavItem {
  to: string;
  label: string;
  /** Match only the exact path (for the index route). */
  end?: boolean;
  permission?: Action;
  icon: 'home' | 'quotes' | 'tracking' | 'products' | 'suppliers' | 'documents' | 'settings';
}

export const WORKSPACE_NAV: readonly WorkspaceNavItem[] = [
  { to: '/app', label: 'Home', end: true, icon: 'home' },
  { to: '/app/quotes', label: 'Quotes', permission: 'quote.view', icon: 'quotes' },
  { to: '/app/tracking', label: 'Tracking', icon: 'tracking' }, // M9 (ADR-0017): view for every role; tracking needs shipment.track
  { to: '/app/products', label: 'Products', icon: 'products' },
  { to: '/app/suppliers', label: 'Suppliers', icon: 'suppliers' }, // M3
  { to: '/app/documents', label: 'Documents', permission: 'doc.download', icon: 'documents' },
  { to: '/app/settings', label: 'Settings & billing', icon: 'settings' },
];
