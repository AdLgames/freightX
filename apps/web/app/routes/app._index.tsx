import { can } from '@harbour/db';
import { AlertCircle, ArrowRight, Map as MapIcon, Plus } from 'lucide-react';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?url';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app._index';
import { CsrfInput } from '../components/csrf';
import { gbp } from '../components/format';
import { TreasuryCard } from '../components/home/treasury-card';
import { TrackingMap } from '../components/tracking/tracking-map';
import { modeName, portName } from '../data/ports';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { loadTreasury } from '../services/fx-treasury.server';
import { homeActions, homeStats, startOfMonthUtc, type RecentDraft } from '../services/home.server';
import { requestLogger } from '../services/logger.server';
import { pageError } from '../services/page-error';
import { CSP_ADDITIONS_HEADER, serializeCspAdditions } from '../services/security-headers.server';
import { SIMULATED_SOURCE } from '../services/tracking/demo-fleet';
import {
  advanceDemoFleet,
  clearDemoFleet,
  seedDemoFleet,
} from '../services/tracking/demo-fleet.server';
import { loadMapState } from '../services/tracking/queries.server';
// M4
import { QuickDutyCard } from '../components/quotes/quick-duty-card';
import { requireCsrf } from '../services/csrf.server';
import { runQuickDuty, type QuickDutyResult } from '../services/quotes/quick-duty.server';
import { readForm } from '../services/request.server';
import { QUICK_DUTY_FIELDS } from '../validators/quote';
// end M4
// M7
import { PaymentsDueCard } from '../components/orders/payments-due-card';
import { listPaymentsDue } from '../services/orders/orders.server';
// end M7

/**
 * Workspace Home, the "Command Center" (docs/design-system.md). M1: the action-required banner.
 * Stat cards and recent drafts read real rows. The map panel hosts the M9 tracking map for every
 * active container of the organisation (same component and JSON feed as the tracking detail
 * route); with `DEMO_FLEET=on` a member can load a simulated fleet into it (services/tracking/
 * demo-fleet.ts) and the panel says so. The route's `headers()` adds the map's CSP sources for
 * this response only, exactly as the detail route does.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Home — Harbour' }];

export const links: Route.LinksFunction = () => [{ rel: 'stylesheet', href: maplibreCss }];

export const headers: Route.HeadersFunction = ({ loaderHeaders }) => ({
  'Cache-Control': 'no-store',
  [CSP_ADDITIONS_HEADER]: loaderHeaders.get(CSP_ADDITIONS_HEADER) ?? '',
});

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const now = new Date();
  const demoFleetEnabled = app.tracking.demoFleetEnabled;
  const result = await withOrg(ctx, async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: ctx.org.id },
      select: { eoriNumber: true },
    });
    const customsProfile = await tx.customsProfile.findFirst({
      select: { paymentMethod: true, cdsAuthorityGranted: true },
    });
    const paymentsDue = await listPaymentsDue(tx, 3); // M7
    const [activeShipments, monthQuotes, draftQuotes, drafts] = await Promise.all([
      tx.shipment.count({ where: { status: { notIn: ['DELIVERED', 'CANCELLED'] } } }),
      tx.quote.findMany({
        where: { status: { in: ['READY', 'ACCEPTED'] }, createdAt: { gte: startOfMonthUtc(now) } },
        select: { totalLandedCostExVat: true },
      }),
      tx.quote.count({ where: { status: 'DRAFT' } }),
      tx.quote.findMany({
        where: { status: 'DRAFT' },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: {
          id: true,
          originPort: true,
          destinationPort: true,
          originCountry: true,
          mode: true,
          updatedAt: true,
          totalLandedCostExVat: true,
        },
      }),
    ]);
    // Demo fleet: simulated vessels move on read (no worker needed); a no-op when the flag is off.
    if (demoFleetEnabled) await advanceDemoFleet(tx, { now, log: app.logger });
    const mapState = await loadMapState(tx, { now });
    return {
      actionsInput: { eoriNumber: org?.eoriNumber ?? null, customsProfile },
      paymentsDue, // M7
      mapState,
      stats: homeStats({
        activeShipments,
        monthQuoteTotals: monthQuotes.map((q) => q.totalLandedCostExVat.toString()),
        draftQuotes,
      }),
      drafts: drafts.map((q): RecentDraft => ({
        id: q.id,
        route: `${q.originPort ? portName(q.originPort) : q.originCountry} → ${
          q.destinationPort ? portName(q.destinationPort) : 'UK'
        }`,
        mode: modeName(q.mode),
        updatedAt: q.updatedAt.toISOString(),
        totalExVatGbp: q.totalLandedCostExVat.toString(),
      })),
    };
  });
  // Treasury: ECB rows from the shared store (no API call; §5.7).
  const treasury = await loadTreasury(app.stores.fxStore, now);
  const headers = new Headers(ctx.headers);
  headers.set(CSP_ADDITIONS_HEADER, serializeCspAdditions(app.tracking.mapCsp));
  // Only derived action items leave the server; the EORI itself never does.
  return data(
    {
      orgName: ctx.org.name,
      actions: homeActions(result.actionsInput),
      ...result,
      actionsInput: undefined,
      mapStyleUrl: app.tracking.mapStyleUrl,
      treasury,
      tracking: {
        canTrack: can(ctx.role, 'shipment.track'),
        positionsConfigured: app.tracking.positionProviderConfigured,
        demoFleetEnabled,
      },
    },
    { headers },
  );
};

// M4: the quick duty check posts to Home itself (`intent=quick-duty`) so it works without
// JavaScript; the same check is served as JSON by /app/api/quick-duty. Nothing is saved.
export interface HomeActionData {
  quickDuty: {
    values: Record<string, string>;
    errors: Record<string, string>;
    result: QuickDutyResult | null;
  };
}

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request);
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const intent = form?.get('intent');

  // Demo fleet (DEMO_FLEET=on): seed or clear the organisation's simulated ships, then PRG back.
  if (intent === 'demo-fleet-seed' || intent === 'demo-fleet-clear') {
    const app = await getApp();
    if (!app.tracking.demoFleetEnabled) {
      throw pageError(404, 'Not available', 'The simulated fleet is not enabled on this server.');
    }
    if (!can(ctx.role, 'shipment.track')) {
      throw pageError(403, 'Not allowed', 'Your role cannot track shipments.');
    }
    const actor = {
      organizationId: ctx.org.id,
      userId: ctx.user.id,
      now: new Date(),
      log: requestLogger(app.logger, request),
    };
    await withOrg(ctx, async (tx) => {
      if (intent === 'demo-fleet-seed') await seedDemoFleet(tx, actor);
      else await clearDemoFleet(tx, actor);
    });
    return redirect('/app', { headers: ctx.headers });
  }

  const values: Record<string, string> = {};
  for (const f of QUICK_DUTY_FIELDS) {
    const v = form?.get(f);
    if (typeof v === 'string') values[f] = v.slice(0, 200);
  }
  if (intent !== 'quick-duty') {
    return data<HomeActionData>(
      { quickDuty: { values, errors: {}, result: null } },
      { status: 400 },
    );
  }
  const result = await runQuickDuty(ctx, request, values);
  const status = result.kind === 'invalid' ? 400 : result.kind === 'rate-limited' ? 429 : 200;
  return data<HomeActionData>(
    {
      quickDuty: {
        values,
        errors: result.kind === 'invalid' ? result.errors : {},
        result: result.kind === 'invalid' ? null : result,
      },
    },
    { status },
  );
};
// end M4

const relativeTime = (iso: string, now = Date.now()): string => {
  const ms = now - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

export default function WorkspaceHome({ loaderData, actionData }: Route.ComponentProps) {
  const { orgName, actions, stats, drafts, paymentsDue, mapState, mapStyleUrl, tracking } =
    loaderData; // M7: paymentsDue
  const { treasury } = loaderData;
  const quickDuty = actionData?.quickDuty ?? null; // M4
  const positioned = mapState.containers.filter((c) => c.ping);
  const simulated = positioned.some((c) => c.ping?.positionSource === SIMULATED_SOURCE);
  const pill = simulated
    ? { dot: 'dot-simulated', text: 'Simulated data' }
    : positioned.length > 0 && tracking.positionsConfigured
      ? { dot: 'dot-live', text: 'Live tracking' }
      : positioned.length > 0
        ? { dot: 'dot-muted', text: 'Manual milestones' }
        : { dot: 'dot-muted', text: 'Tracking' };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Command Center</h1>
          <p className="muted">{orgName}</p>
        </div>
        <Link to="/app/quotes/new" className="button lime">
          <Plus className="icon" aria-hidden="true" /> New quote
        </Link>
      </div>

      {actions.length > 0 ? (
        <section className="action-banner" aria-labelledby="action-required-title">
          <AlertCircle className="icon" aria-hidden="true" />
          <div>
            <h2 id="action-required-title">Action required: complete your customs profile</h2>
            <ul>
              {actions.map((a) => (
                <li key={a.id}>{a.text}</li>
              ))}
            </ul>
            <Link to="/app/settings" className="action-link">
              Complete setup <ArrowRight className="icon" aria-hidden="true" />
            </Link>
            <p className="hint on-dark">You can still get quotes in the meantime.</p>
          </div>
        </section>
      ) : null}

      <section className="stat-grid" aria-label="At a glance">
        <div className="card stat">
          <p className="stat-label">Active shipments</p>
          <p className="stat-value">{stats.activeShipments}</p>
        </div>
        <div className="card stat">
          <p className="stat-label">Estimated landed cost this month</p>
          <p className="stat-value">{gbp(stats.estimatedLandedCostGbp)}</p>
          <p className="stat-sub">ready and accepted quotes, ex VAT</p>
        </div>
        <div className="card stat">
          <p className="stat-label">Draft quotes</p>
          <p className="stat-value">{stats.draftQuotes}</p>
        </div>
      </section>

      <div className="home-grid">
        <section className="map-panel" aria-labelledby="map-title">
          <div className="map-panel-head">
            <p className="pill pill-dark">
              <span className={`dot ${pill.dot}`} />
              <span>{pill.text}</span>
            </p>
            <h2 id="map-title" className="visually-hidden">
              Tracked shipments map
            </h2>
            {positioned.length > 0 ? (
              <Link to="/app/tracking" className="map-panel-link">
                {positioned.length} container{positioned.length === 1 ? '' : 's'} at sea{' '}
                <ArrowRight className="icon" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
          {positioned.length > 0 ? (
            <div className="map-panel-body">
              <TrackingMap
                styleUrl={mapStyleUrl}
                stateUrl="/app/api/map-state"
                initialState={mapState}
              />
              {simulated && tracking.canTrack && tracking.demoFleetEnabled ? (
                <Form method="post" action="/app?index" className="map-panel-actions">
                  <CsrfInput />
                  <input type="hidden" name="intent" value="demo-fleet-clear" />
                  <span className="muted small">
                    These three ships are fictional and move on their own. Real shipments you track
                    appear alongside them.
                  </span>
                  <button type="submit" className="button ghost-dark small">
                    Clear simulated fleet
                  </button>
                </Form>
              ) : null}
            </div>
          ) : (
            <div className="map-empty">
              <MapIcon className="icon large" aria-hidden="true" />
              <h3>No shipments tracked yet</h3>
              <p>Shipments you track appear here with carrier milestones and vessel positions.</p>
              {tracking.canTrack ? (
                <div className="map-empty-actions">
                  <Link to="/app/tracking" className="button ghost-dark small">
                    Track a container
                  </Link>
                  {tracking.demoFleetEnabled ? (
                    /* `?index`: Home is the /app index route, so a plain POST to /app would hit the layout. */
                    <Form method="post" action="/app?index">
                      <CsrfInput />
                      <input type="hidden" name="intent" value="demo-fleet-seed" />
                      <button type="submit" className="button lime small">
                        Load a simulated fleet
                      </button>
                    </Form>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </section>

        <section className="card drafts" aria-labelledby="drafts-title">
          <h2 id="drafts-title">Recent drafts</h2>
          {drafts.length === 0 ? (
            <p className="muted">
              No draft quotes yet. <Link to="/app/quotes/new">Start one</Link>.
            </p>
          ) : (
            <ul className="draft-list">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link to={`/app/quotes/${d.id}/edit`} className="draft-row">
                    <span>
                      <span className="draft-route">{d.route}</span>
                      <span className="muted small">
                        Updated {relativeTime(d.updatedAt)} · {d.mode}
                      </span>
                    </span>
                    <span className="draft-total">
                      {gbp(d.totalExVatGbp)}
                      <span className="draft-cta">Continue →</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* M4 */}
        <QuickDutyCard
          values={quickDuty?.values ?? {}}
          errors={quickDuty?.errors ?? {}}
          result={quickDuty?.result ?? null}
        />
        {/* end M4 */}
        <div className="home-stack">
          <TreasuryCard treasury={treasury} />
          {/* M7 */}
          <PaymentsDueCard payments={paymentsDue} />
          {/* end M7 */}
        </div>
      </div>
    </>
  );
}
