import type { Route } from './+types/app.documents';
import { requireOrgContext } from '../services/auth.server';

/** Placeholder owned by milestone M5, which replaces this file. */

export const meta: Route.MetaFunction = () => [{ title: 'Documents — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireOrgContext(request, { permission: 'doc.download' });
  return null;
};

export default function Placeholder() {
  return (
    <>
      <h1>Documents</h1>
      <p>Coming in milestone M5.</p>
    </>
  );
}
