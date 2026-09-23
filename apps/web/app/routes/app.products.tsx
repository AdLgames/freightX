import type { Route } from './+types/app.products';
import { requireOrgContext } from '../services/auth.server';

/** Placeholder owned by milestone M3, which replaces this file. */

export const meta: Route.MetaFunction = () => [{ title: 'Products — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireOrgContext(request);
  return null;
};

export default function Placeholder() {
  return (
    <>
      <h1>Products</h1>
      <p>Coming in milestone M3.</p>
    </>
  );
}
