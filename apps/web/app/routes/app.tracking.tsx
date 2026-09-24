import { MILESTONE_LABELS, isMilestone } from '@harbour/adapters/tracking/core';
import { can } from '@harbour/db';
import { Form, Link, data, redirect } from 'react-router';
import type { Route } from './+types/app.tracking';
import { CsrfInput } from '../components/csrf';
import { StatusBadge } from '../components/tracking/status-badge';
import { formatWhen } from '../components/tracking/timeline';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { readForm } from '../services/request.server';
import {
  TrackShipmentError,
  listLinkableQuotes,
  listPorts,
  listShipments,
  trackShipment,
} from '../services/tracking/queries.server';
import { fieldErrors } from '../validators/common';
import {
  CONTAINER_SIZE_LABELS,
  CONTAINER_SIZE_TYPES,
  trackShipmentSchema,
} from '../validators/tracking';

/**
 * M9 (ADR-0017) — /app/tracking: the organisation's tracked shipments and the "Track a container"
 * form. Every role may view; tracking needs `shipment.track` (OWNER/ADMIN/MEMBER). Works without
 * JavaScript: plain table, plain form, server redirects.
 */

export const meta: Route.MetaFunction = () => [{ title: 'Tracking — Harbour' }];

export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const { shipments, ports, quotes } = await withOrg(ctx, async (tx) => ({
    shipments: await listShipments(tx),
    ports: await listPorts(tx),
    quotes: can(ctx.role, 'shipment.track') ? await listLinkableQuotes(tx) : [],
  }));
  return data(
    {
      shipments,
      ports: ports.map((p) => ({ locode: p.locode, name: p.name })),
      quotes,
      canTrack: can(ctx.role, 'shipment.track'),
      provider: {
        name: app.tracking.milestoneProvider.name,
        configured: app.tracking.milestoneProvider.id !== 'none',
        positions: app.tracking.positionProviderConfigured,
      },
    },
    { headers: ctx.headers },
  );
};

interface ActionData {
  errors: Record<string, string>;
  values: Record<string, string>;
}

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'shipment.track' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const app = await getApp();
  const log = requestLogger(app.logger, request);

  const raw = {
    reference: form?.get('reference') ?? '',
    containerNumbers: form?.get('containerNumbers') ?? '',
    masterBillNumber: form?.get('masterBillNumber') ?? '',
    originLocode: form?.get('originLocode') ?? '',
    destinationLocode: form?.get('destinationLocode') ?? '',
    quoteId: form?.get('quoteId') ?? '',
    sizeType: form?.get('sizeType') ?? '',
  };
  const values = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : '']),
  ) as Record<keyof typeof raw, string>;
  const parsed = trackShipmentSchema.safeParse(values);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('tracking.track_invalid', { fields: Object.keys(errors) });
    return data<ActionData>({ errors, values }, { status: 400 });
  }

  try {
    const result = await withOrg(ctx, (tx) =>
      trackShipment(
        tx,
        {
          organizationId: ctx.org.id,
          userId: ctx.user.id,
          provider: app.tracking.milestoneProvider,
          now: new Date(),
          log,
        },
        parsed.data,
      ),
    );
    const notice = result.subscription.ok ? 'subscribed' : result.subscription.reason.toLowerCase();
    return redirect(`/app/tracking/${result.shipmentId}?tracked=${encodeURIComponent(notice)}`);
  } catch (err) {
    if (err instanceof TrackShipmentError) {
      log.info('tracking.track_rejected_by_provider');
      return data<ActionData>(
        { errors: { containerNumbers: err.message }, values },
        { status: 400 },
      );
    }
    throw err;
  }
};

export default function TrackingList({ loaderData, actionData }: Route.ComponentProps) {
  const { shipments, ports, quotes, canTrack, provider } = loaderData;
  const errors: Record<string, string> = actionData?.errors ?? {};
  const values: Record<string, string> = actionData?.values ?? { destinationLocode: 'GBFXT' };
  const err = (name: string) =>
    errors[name] ? (
      <span className="field-error" id={`${name}-error`}>
        {errors[name]}
      </span>
    ) : null;

  return (
    <>
      <h1>Tracking</h1>
      <p className="lede">
        Container milestones and vessel positions for your shipments. Read-only: booking stays gated
        until the forwarder agreement is signed.
      </p>
      {!provider.configured ? (
        <p className="banner notice">
          Tracking provider not configured — events can be added manually on each shipment.
          {provider.positions ? '' : ' Vessel positions are not configured either.'}
        </p>
      ) : null}

      <section aria-labelledby="shipments-title">
        <h2 id="shipments-title">Shipments</h2>
        {shipments.length === 0 ? (
          <p className="muted">Nothing tracked yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Route</th>
                  <th>Containers</th>
                  <th>Last milestone</th>
                  <th>Carrier ETA</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => {
                  const latest = [...s.containers]
                    .filter((c) => c.lastMilestoneAt)
                    .sort((a, b) => (a.lastMilestoneAt! < b.lastMilestoneAt! ? 1 : -1))[0];
                  return (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/app/tracking/${s.id}`}>{s.reference ?? s.id.slice(0, 8)}</Link>
                        {s.masterBillNumber ? (
                          <div className="hint">MBL {s.masterBillNumber}</div>
                        ) : null}
                      </td>
                      <td>
                        {s.originLocode ?? '?'} → {s.destinationLocode ?? '?'}
                      </td>
                      <td>
                        {s.containers.map((c) => (
                          <div key={c.id}>
                            <code>{c.containerNumber}</code>
                            {c.vesselName ? <span className="muted"> · {c.vesselName}</span> : null}
                          </div>
                        ))}
                      </td>
                      <td>
                        {latest?.lastMilestone ? (
                          <>
                            {isMilestone(latest.lastMilestone)
                              ? MILESTONE_LABELS[latest.lastMilestone]
                              : latest.lastMilestone}
                            <div className="hint">{formatWhen(latest.lastMilestoneAt!)}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{s.eta ? formatWhen(s.eta) : <span className="muted">—</span>}</td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canTrack ? (
        <section aria-labelledby="track-title" className="narrow-page">
          <h2 id="track-title">Track a container</h2>
          <Form method="post">
            <CsrfInput />
            {errors._form ? <p className="field-error">{errors._form}</p> : null}
            <div className={`field${errors.reference ? ' has-error' : ''}`}>
              <label htmlFor="reference">Reference</label>
              <span className="hint" id="reference-hint">
                Your own label for this shipment, e.g. the PO number.
              </span>
              {err('reference')}
              <input
                id="reference"
                name="reference"
                type="text"
                required
                maxLength={120}
                defaultValue={values.reference}
                aria-describedby="reference-hint"
              />
            </div>
            <div className={`field${errors.containerNumbers ? ' has-error' : ''}`}>
              <label htmlFor="containerNumbers">Container number(s)</label>
              <span className="hint" id="containerNumbers-hint">
                One per line. 4 letters + 7 digits (ISO 6346); the check digit is verified.
              </span>
              {err('containerNumbers')}
              <textarea
                id="containerNumbers"
                name="containerNumbers"
                rows={3}
                maxLength={2000}
                defaultValue={values.containerNumbers}
                aria-describedby="containerNumbers-hint"
              />
            </div>
            <div className="inline-fields">
              <div className={`field${errors.masterBillNumber ? ' has-error' : ''}`}>
                <label htmlFor="masterBillNumber">Master bill of lading (optional)</label>
                {err('masterBillNumber')}
                <input
                  id="masterBillNumber"
                  name="masterBillNumber"
                  type="text"
                  maxLength={40}
                  defaultValue={values.masterBillNumber}
                />
              </div>
              <div className="field">
                <label htmlFor="sizeType">Container size (optional)</label>
                <select id="sizeType" name="sizeType" defaultValue={values.sizeType}>
                  <option value="">Unknown</option>
                  {CONTAINER_SIZE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CONTAINER_SIZE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="inline-fields">
              <div className={`field${errors.originLocode ? ' has-error' : ''}`}>
                <label htmlFor="originLocode">Origin port</label>
                {err('originLocode')}
                <select id="originLocode" name="originLocode" defaultValue={values.originLocode}>
                  <option value="">Unknown</option>
                  {ports.map((p) => (
                    <option key={p.locode} value={p.locode}>
                      {p.name} ({p.locode})
                    </option>
                  ))}
                </select>
              </div>
              <div className={`field${errors.destinationLocode ? ' has-error' : ''}`}>
                <label htmlFor="destinationLocode">Destination port</label>
                {err('destinationLocode')}
                <select
                  id="destinationLocode"
                  name="destinationLocode"
                  defaultValue={values.destinationLocode}
                >
                  <option value="">Unknown</option>
                  {ports.map((p) => (
                    <option key={p.locode} value={p.locode}>
                      {p.name} ({p.locode})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {quotes.length > 0 ? (
              <div className={`field${errors.quoteId ? ' has-error' : ''}`}>
                <label htmlFor="quoteId">Link to a quote (optional)</label>
                {err('quoteId')}
                <select id="quoteId" name="quoteId" defaultValue={values.quoteId}>
                  <option value="">None</option>
                  {quotes.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <button type="submit" className="button">
              Track
            </button>
          </Form>
        </section>
      ) : (
        <p className="muted">Your role can view tracking but not add shipments.</p>
      )}
    </>
  );
}
