import type { RouteConfig } from '@react-router/dev/routes';
import { flatRoutes } from '@react-router/fs-routes';

// Co-located tests live next to their route modules; they must never become routes.
export default flatRoutes({ ignoredRouteFiles: ['**/*.test.{ts,tsx}'] }) satisfies RouteConfig;
