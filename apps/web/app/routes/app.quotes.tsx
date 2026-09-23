import type { Route } from './+types/app.quotes';
import { requireOrgContext } from '../services/auth.server';

/** Placeholder owned by milestone M4, which replaces this file. */

export const meta: Route.MetaFunction = () => [{ title: 'Quotes — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireOrgContext(request, { permission: 'quote.view' });
  return null;
};

export default function Placeholder() {
  return (
    <>
      <h1>Quotes</h1>
      <p>Coming in milestone M4.</p>
    </>
  );
}
