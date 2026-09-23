import { can } from '@harbour/db';
import { Link } from 'react-router';
import type { Route } from './+types/app.settings._index';
import { StatusBadge } from '../components/settings-ui';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { readCustomsProfile } from '../services/settings/customs-profile.server';
import { readIdentity } from '../services/settings/identity.server';
import { SETTINGS_SECTIONS } from './app.settings';

/** Settings overview (M2): one card per section with a one-line status. */
export const meta: Route.MetaFunction = () => [{ title: 'Settings — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const { identity, profile, members } = await withOrg(ctx, async (tx) => ({
    identity: await readIdentity(tx, ctx.org.id),
    profile: await readCustomsProfile(tx, ctx.org.id),
    members: await tx.membership.count(),
  }));
  return {
    orgName: ctx.org.name,
    role: ctx.role,
    sections: SETTINGS_SECTIONS.filter((s) => !s.permission || can(ctx.role, s.permission)),
    identity,
    paymentMethod: profile.paymentMethod,
    usePva: profile.usePva,
    cdsAuthorityGranted: profile.cdsAuthorityGranted,
    members,
  };
};

export default function SettingsOverview({ loaderData }: Route.ComponentProps) {
  const { sections, identity, members } = loaderData;
  return (
    <section aria-labelledby="settings-overview">
      <h2 id="settings-overview">{loaderData.orgName}</h2>
      <p className="muted">
        Your role: <strong>{loaderData.role}</strong>. Owners and admins can change organisation
        details, the customs profile and members.
      </p>
      <ul className="card-list">
        {sections.map((s) => (
          <li key={s.to} className="card">
            <h3>
              <Link to={s.to}>{s.label}</Link>
            </h3>
            <p>{s.description}</p>
            {s.to === '/app/settings/organisation' ? (
              <p className="muted">
                EORI: {identity.eori.set ? `…${identity.eori.last4}` : 'not added'}{' '}
                <StatusBadge status={identity.eori.status} />
                <br />
                VAT:{' '}
                {identity.vat.registered
                  ? `registered …${identity.vat.last4 ?? ''}`
                  : 'not registered'}{' '}
                {identity.vat.registered ? <StatusBadge status={identity.vat.status} /> : null}
              </p>
            ) : null}
            {s.to === '/app/settings/customs' ? (
              <p className="muted">
                Duty paid via {loaderData.paymentMethod.toLowerCase().replace(/_/g, ' ')}; postponed
                VAT accounting {loaderData.usePva ? 'on' : 'off'}
                {loaderData.paymentMethod === 'OWN_DEFERMENT'
                  ? `; CDS authority ${loaderData.cdsAuthorityGranted ? 'confirmed' : 'not yet confirmed'}`
                  : ''}
                .
              </p>
            ) : null}
            {s.to === '/app/settings/members' ? (
              <p className="muted">
                {members} {members === 1 ? 'member' : 'members'}.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
