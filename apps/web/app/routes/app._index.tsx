import { Link } from 'react-router';
import type { Route } from './+types/app._index';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { homeActions } from '../services/home.server';

/** Workspace Home. M1: the action-required banner. M4 adds recent drafts and quick duty check. */

export const meta: Route.MetaFunction = () => [{ title: 'Home — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const input = await withOrg(ctx, async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: ctx.org.id },
      select: { eoriNumber: true },
    });
    const customsProfile = await tx.customsProfile.findFirst({
      select: { paymentMethod: true, cdsAuthorityGranted: true },
    });
    return { eoriNumber: org?.eoriNumber ?? null, customsProfile };
  });
  // Only the derived action items leave the server; the EORI itself never does.
  return { orgName: ctx.org.name, actions: homeActions(input) };
};

export default function WorkspaceHome({ loaderData }: Route.ComponentProps) {
  const { orgName, actions } = loaderData;
  return (
    <>
      <h1>{orgName}</h1>
      {actions.length > 0 ? (
        <section className="banner indicative" aria-labelledby="action-required-title">
          <h2 id="action-required-title">Action required</h2>
          <ul>
            {actions.map((a) => (
              <li key={a.id}>
                <Link to={a.href}>{a.text}</Link>
              </li>
            ))}
          </ul>
          <p className="hint">You can still get quotes in the meantime.</p>
        </section>
      ) : null}

      {/* SLOT (M4): "Jump back in" — the three most recently edited draft quotes. */}
      {/* SLOT (M4): "Quick duty check" — HS code + invoice value → duty and VAT rates. */}
    </>
  );
}
