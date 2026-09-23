import type { Route } from './+types/app.settings';
import { requireOrgContext } from '../services/auth.server';

/** Placeholder owned by milestone M2 (billing in M6), which replaces this file. */

export const meta: Route.MetaFunction = () => [{ title: 'Settings & billing — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireOrgContext(request);
  return null;
};

export default function Placeholder() {
  return (
    <>
      <h1>Settings & billing</h1>
      <p>Coming in milestone M2 (billing in M6).</p>
    </>
  );
}
