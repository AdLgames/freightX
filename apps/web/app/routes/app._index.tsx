import { AlertCircle, ArrowRight, Map as MapIcon, Plus } from 'lucide-react';
import { Link, data } from 'react-router';
import type { Route } from './+types/app._index';
import { gbp } from '../components/format';
import { modeName, portName } from '../data/ports';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { homeActions, homeStats, startOfMonthUtc, type RecentDraft } from '../services/home.server';
// M4
import { QuickDutyCard } from '../components/quotes/quick-duty-card';
import { requireCsrf } from '../services/csrf.server';
import { runQuickDuty, type QuickDutyResult } from '../services/quotes/quick-duty.server';
import { readForm } from '../services/request.server';
import { QUICK_DUTY_FIELDS } from '../validators/quote';
// end M4

/**
 * Workspace Home, the "Command Center" (docs/design-system.md). M1: the action-required banner.
 * Stat cards and recent drafts read real rows; the map panel hosts the tracking component once
 * the tracking milestone lands (until then it states plainly that nothing is tracked).
 */

export const meta: Route.MetaFunction = () => [{ title: 'Home — Harbour' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const now = new Date();
  const data = await withOrg(ctx, async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: ctx.org.id },
      select: { eoriNumber: true },
    });
    const customsProfile = await tx.customsProfile.findFirst({
      select: { paymentMethod: true, cdsAuthorityGranted: true },
    });
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
    return {
      actionsInput: { eoriNumber: org?.eoriNumber ?? null, customsProfile },
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
  // Only derived action items leave the server; the EORI itself never does.
  return {
    orgName: ctx.org.name,
    actions: homeActions(data.actionsInput),
    ...data,
    actionsInput: undefined,
  };
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
  const values: Record<string, string> = {};
  for (const f of QUICK_DUTY_FIELDS) {
    const v = form?.get(f);
    if (typeof v === 'string') values[f] = v.slice(0, 200);
  }
  if (form?.get('intent') !== 'quick-duty') {
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
  const { orgName, actions, stats, drafts } = loaderData;
  const quickDuty = actionData?.quickDuty ?? null; // M4
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
          <p className="pill pill-dark">
            <span className="dot dot-muted" />
            <span>Tracking</span>
          </p>
          <div className="map-empty">
            <MapIcon className="icon large" aria-hidden="true" />
            <h2 id="map-title">No shipments tracked yet</h2>
            <p>Shipments you track appear here with carrier milestones and vessel positions.</p>
          </div>
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
      </div>
    </>
  );
}
