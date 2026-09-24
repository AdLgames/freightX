import { ClipboardList, FileText, Home, Package, Settings, Ship, Truck, Users } from 'lucide-react';
import type { WorkspaceNavItem } from './workspace-nav';

/** Inline SVG icons (lucide-react renders SVG in the document; no external assets, CSP-safe). */
export function NavIcon({ name }: { name: WorkspaceNavItem['icon'] }) {
  const props = { className: 'icon', 'aria-hidden': true as const };
  switch (name) {
    case 'home':
      return <Home {...props} />;
    case 'quotes':
      return <FileText {...props} />;
    case 'orders': // M7
      return <ClipboardList {...props} />;
    case 'tracking':
      return <Ship {...props} />;
    case 'products':
      return <Package {...props} />;
    case 'suppliers':
      return <Truck {...props} />;
    case 'documents':
      return <FileText {...props} />;
    case 'settings':
      return <Settings {...props} />;
    default:
      return <Users {...props} />;
  }
}
