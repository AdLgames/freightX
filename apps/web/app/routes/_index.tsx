import { ArrowRight, Box, FileCheck, Globe, Ship } from 'lucide-react';
import { Form, Link } from 'react-router';
import type { Route } from './+types/_index';
import { CALC_VERSION } from '@harbour/engine';
import { modeName, portName } from '../data/ports';
import { getApp } from '../services/app.server';

const SIGNUP_MESSAGES: Record<string, { tone: 'ready' | 'error'; text: string }> = {
  ok: {
    tone: 'ready',
    text: 'Thanks — you are on the list. We will email you when the workspace opens.',
  },
  invalid: {
    tone: 'error',
    text: 'That email address does not look right. Please check it and try again.',
  },
  'rate-limited': {
    tone: 'error',
    text: 'Too many signups from your connection. Please try again in an hour.',
  },
};

export const handle = { layout: 'landing' as const };

export const meta: Route.MetaFunction = () => [
  { title: 'Harbour — know what it really costs, before you commit' },
  {
    name: 'description',
    content:
      'Harbour gives growing importers the fully landed cost per unit — freight, duty, VAT and fees — before they pay a supplier, and keeps products, HS codes, documents and shipments in one workspace.',
  },
];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const flag = new URL(request.url).searchParams.get('signup');
  const app = await getApp();
  // Only figures the platform produces (docs/design-system.md): the rate sheet's real lanes.
  const seaLanes = app.lanes.filter((l) => l.mode !== 'AIR');
  const featured = [
    ...seaLanes.filter((l) => l.origin === 'CNSZX' && l.destination === 'GBFXT'),
    ...seaLanes.filter((l) => l.origin === 'CNNGB' && l.destination === 'GBSOU'),
    ...seaLanes.filter((l) => l.origin === 'INNSA' && l.destination === 'GBLGP'),
    ...app.lanes.filter((l) => l.mode === 'AIR' && l.origin === 'CNPVG'),
  ]
    .filter((l, i, arr) => arr.findIndex((x) => x.key === l.key) === i)
    .slice(0, 4);
  return {
    signup: flag && flag in SIGNUP_MESSAGES ? flag : null,
    stats: {
      lanes: app.lanes.length,
      originCountries: new Set(app.lanes.map((l) => l.origin.slice(0, 2))).size,
      ukGateways: new Set(app.lanes.map((l) => l.destination)).size,
    },
    featured: featured.map((l) => ({
      key: l.key,
      from: portName(l.origin),
      to: portName(l.destination),
      mode: modeName(l.mode),
      transitDays: l.transitDays,
    })),
    ratesArePlaceholder: app.rateSheet.placeholder,
    calcVersion: CALC_VERSION,
  };
};

export default function Index({ loaderData }: Route.ComponentProps) {
  const { signup, stats, featured, ratesArePlaceholder } = loaderData;
  const flash = signup ? SIGNUP_MESSAGES[signup] : undefined;
  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <p className="pill pill-dark">
            <Globe className="icon" aria-hidden="true" />
            <span>Landed cost, opened up</span>
          </p>
          <h1 className="hero-title">
            Know what it really costs.
            <br />
            <span className="accent">Before you commit.</span>
          </h1>
          <p className="hero-lede">
            Harbour gives growing importers the fully landed cost per unit — freight, duty, VAT and
            fees — before they pay a supplier. Keep products, HS codes and documents in one
            workspace, and follow every shipment to the door.
          </p>
          <div className="hero-actions">
            <Link to="/calculator" className="button lime large">
              Try the calculator <ArrowRight className="icon" aria-hidden="true" />
            </Link>
            <Link to="/login" className="button ghost large">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <section className="section-light">
        <div className="container">
          <p className="eyebrow">What you get</p>
          <h2 className="section-title">Every number, with its source.</h2>
          <div className="feature-grid">
            <article className="card feature">
              <span className="feature-icon" aria-hidden="true">
                <Box className="icon" />
              </span>
              <h3>Landed cost per unit</h3>
              <p>
                Duty and VAT from the UK Trade Tariff by commodity code, HMRC monthly exchange
                rates, and the customs value built the way HMRC builds it, incoterm by incoterm.
              </p>
            </article>
            <article className="card feature">
              <span className="feature-icon" aria-hidden="true">
                <FileCheck className="icon" />
              </span>
              <h3>Your catalogue, reused</h3>
              <p>
                Save products with verified HS codes, weights and supplier prices once. Every future
                quote starts from them in seconds.
              </p>
            </article>
            <article className="card feature">
              <span className="feature-icon" aria-hidden="true">
                <Ship className="icon" />
              </span>
              <h3>Tracking you can trust</h3>
              <p>
                Carrier milestones and vessel positions, each labelled with where it came from.
                Nothing on the map is invented.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="section-panel">
        <div className="container">
          <div className="lanes-panel">
            <div className="lanes-head">
              <p className="pill pill-dark">
                <span className={`dot ${ratesArePlaceholder ? 'dot-muted' : 'dot-live'}`} />
                <span>{ratesArePlaceholder ? 'Preview rates' : 'Current rate sheet'}</span>
              </p>
              <h2 className="section-title on-dark">Lanes we quote today.</h2>
            </div>
            <dl className="stats-grid">
              <div>
                <dt>lanes on the rate sheet</dt>
                <dd>{stats.lanes}</dd>
              </div>
              <div>
                <dt>origin countries</dt>
                <dd>{stats.originCountries}</dd>
              </div>
              <div>
                <dt>UK gateways</dt>
                <dd>{stats.ukGateways}</dd>
              </div>
            </dl>
          </div>
          <ul className="lane-list">
            {featured.map((l) => (
              <li key={l.key} className="card lane-card">
                <div>
                  <p className="lane-route">
                    {l.from} → {l.to}
                  </p>
                  <p className="muted">
                    {l.mode} · about {l.transitDays} days
                  </p>
                </div>
                <Link to="/calculator" className="lane-link">
                  Quote <ArrowRight className="icon" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section-light">
        <div className="container narrow">
          <p className="eyebrow">The workspace</p>
          <h2 className="section-title">Products, quotes, documents and shipments in one place.</h2>
          <p>
            The workspace is opening to early customers. Leave your email and we will let you know
            when your organisation can join.
          </p>
          {flash ? (
            <div className={`banner ${flash.tone}`} role="status">
              <p>{flash.text}</p>
            </div>
          ) : null}
          <Form method="post" action="/signup" className="signup-form">
            <div className="field">
              <label htmlFor="email">Email address</label>
              <span className="hint" id="email-hint">
                We will only use it to tell you when the workspace opens.
              </span>
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                maxLength={254}
                aria-describedby="email-hint"
              />
            </div>
            <div className="honeypot" aria-hidden="true">
              <label htmlFor="website">Leave this field empty</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <input type="hidden" name="source" value="landing" />
            <button type="submit" className="button lime">
              Keep me posted
            </button>
          </Form>
        </div>
      </section>
    </>
  );
}
