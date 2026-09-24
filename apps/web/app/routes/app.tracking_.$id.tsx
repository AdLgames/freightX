import { MILESTONES, MILESTONE_LABELS } from '@harbour/adapters/tracking/core';
import { can } from '@harbour/db';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?url';
import { Form, Link, data } from 'react-router';
import type { Route } from './+types/app.tracking_.$id';
import { CsrfInput } from '../components/csrf';
import { StatusBadge } from '../components/tracking/status-badge';
import { Timeline, formatWhen } from '../components/tracking/timeline';
import { TrackingMap } from '../components/tracking/tracking-map';
import { getApp } from '../services/app.server';
import { requireOrgContext, withOrg } from '../services/auth.server';
import { requireCsrf } from '../services/csrf.server';
import { requestLogger } from '../services/logger.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { CSP_ADDITIONS_HEADER, serializeCspAdditions } from '../services/security-headers.server';
import { advanceDemoFleet } from '../services/tracking/demo-fleet.server';
import {
  addManualEvent,
  getShipmentDetail,
  loadMapState,
  untrackShipment,
} from '../services/tracking/queries.server';
import { fieldErrors } from '../validators/common';
import { CONTAINER_SIZE_LABELS, manualEventSchema } from '../validators/tracking';
import { z } from 'zod';

/**
 * M9 (ADR-0017) — /app/tracking/:id: timeline (no JavaScript needed), containers, vessel card and
 * the map (JavaScript, lazy-loaded on this route only). The route's `headers()` adds the tile
 * host and blob workers to the CSP for this response only; the global policy is unchanged.
 * The shipment id comes from the URL but the organisation from the session: a foreign id is a 404.
 */

export const meta: Route.MetaFunction = ({ data: d }) => [
  { title: `${d?.detail.shipment.reference ?? 'Shipment'} — Tracking — Harbour` },
];

export const links: Route.LinksFunction = () => [{ rel: 'stylesheet', href: maplibreCss }];

export const headers: Route.HeadersFunction = ({ loaderHeaders, parentHeaders }) => ({
  'Cache-Control': 'no-store',
  [CSP_ADDITIONS_HEADER]:
    loaderHeaders.get(CSP_ADDITIONS_HEADER) ?? parentHeaders.get(CSP_ADDITIONS_HEADER) ?? '',
});

const idSchema = z.uuid();

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireOrgContext(request);
  const app = await getApp();
  const id = idSchema.safeParse(params.id);
  const notFound = () =>
    pageError(
      404,
      'Shipment not found',
      'It may belong to another organisation or have been removed.',
    );
  if (!id.success) throw notFound();
  const now = new Date();
  const result = await withOrg(ctx, async (tx) => {
    if (app.tracking.demoFleetEnabled) await advanceDemoFleet(tx, { now, log: app.logger });
    const detail = await getShipmentDetail(tx, id.data);
    if (!detail) return null;
    return { detail, mapState: await loadMapState(tx, { shipmentId: id.data, now }) };
  });
  if (!result) throw notFound();
  const headers = new Headers(ctx.headers);
  headers.set(CSP_ADDITIONS_HEADER, serializeCspAdditions(app.tracking.mapCsp));
  const tracked = new URL(request.url).searchParams.get('tracked');
  return data(
    {
      ...result,
      canTrack: can(ctx.role, 'shipment.track'),
      providerConfigured: app.tracking.milestoneProvider.id !== 'none',
      mapStyleUrl: app.tracking.mapStyleUrl,
      tracked: tracked && /^[a-z_]{1,32}$/.test(tracked) ? tracked : null,
    },
    { headers },
  );
};

interface ActionData {
  errors: Record<string, string>;
  values: Record<string, string>;
  added?: boolean;
}

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireOrgContext(request, { permission: 'shipment.track' });
  const form = await readForm(request);
  await requireCsrf(request, form, ctx.session);
  const app = await getApp();
  const log = requestLogger(app.logger, request);
  const id = idSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Shipment not found', '');
  const intent = form?.get('intent');

  if (intent === 'untrack') {
    const r = await withOrg(ctx, (tx) =>
      untrackShipment(
        tx,
        {
          organizationId: ctx.org.id,
          userId: ctx.user.id,
          provider: app.tracking.milestoneProvider,
          now: new Date(),
          log,
        },
        id.data,
      ),
    );
    return data<ActionData>(
      { errors: r.ok ? {} : { _form: r.message ?? 'Could not stop tracking.' }, values: {} },
      { status: r.ok ? 200 : 400 },
    );
  }

  const names = [
    'containerId',
    'milestone',
    'occurredAt',
    'locationLocode',
    'locationName',
    'vesselImo',
    'vesselName',
    'voyageNumber',
    'latitude',
    'longitude',
    'note',
  ] as const;
  const values = Object.fromEntries(
    names.map((n) => {
      const v = form?.get(n);
      return [n, typeof v === 'string' ? v.slice(0, 500) : ''];
    }),
  ) as Record<(typeof names)[number], string>;
  const parsed = manualEventSchema.safeParse(values);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error.issues);
    log.info('tracking.manual_event_invalid', { fields: Object.keys(errors) });
    return data<ActionData>({ errors, values }, { status: 400 });
  }
  const outcome = await withOrg(ctx, (tx) =>
    addManualEvent(
      tx,
      { organizationId: ctx.org.id, userId: ctx.user.id, now: new Date(), log },
      id.data,
      parsed.data,
    ),
  );
  if (outcome.outcome === 'NOT_FOUND') {
    return data<ActionData>(
      { errors: { containerId: 'Pick a container of this shipment.' }, values },
      { status: 400 },
    );
  }
  log.info('tracking.manual_event_added', {
    shipmentId: id.data,
    milestone: parsed.data.milestone,
    illegal: outcome.outcome === 'INSERTED' && outcome.illegal,
  });
  return data<ActionData>({ errors: {}, values: {}, added: true }, { status: 200 });
};

export default function ShipmentDetailPage({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, mapState, canTrack, providerConfigured, mapStyleUrl, tracked } = loaderData;
  const { shipment, containers, events, vessels, ports } = detail;
  const errors: Record<string, string> = actionData?.errors ?? {};
  const values: Record<string, string> = actionData?.values ?? {};
  const err = (name: string) =>
    errors[name] ? <span className="field-error">{errors[name]}</span> : null;
  const portName = (locode: string | null) =>
    locode ? `${ports[locode] ?? locode} (${locode})` : '—';

  return (
    <>
      <p>
        <Link to="/app/tracking">← All shipments</Link>
      </p>
      <h1>{shipment.reference ?? 'Shipment'}</h1>
      <p>
        <StatusBadge status={shipment.status} />{' '}
        <span className="muted">
          {portName(shipment.originLocode)} → {portName(shipment.destinationLocode)}
        </span>
      </p>
      {tracked === 'subscribed' ? (
        <p className="banner ready">Tracking subscribed with the provider.</p>
      ) : null}
      {tracked === 'not_configured' ? (
        <p className="banner notice">
          Tracking not configured — events can be added manually below.
        </p>
      ) : null}
      {tracked === 'unavailable' ? (
        <p className="banner indicative">
          The tracking provider was unavailable; the shipment was saved. Try subscribing again
          later.
        </p>
      ) : null}
      {actionData?.added ? <p className="banner ready">Milestone added.</p> : null}
      {errors._form ? <p className="banner error">{errors._form}</p> : null}

      <dl className="meta">
        <dt>Master bill</dt>
        <dd>{shipment.masterBillNumber ?? '—'}</dd>
        <dt>Carrier ETA</dt>
        <dd>{shipment.eta ? formatWhen(shipment.eta) : 'not provided'}</dd>
        <dt>Provider</dt>
        <dd>
          {shipment.trackingRequestRef
            ? `${shipment.trackingProvider} · subscribed ${shipment.trackingSubscribedAt ? formatWhen(shipment.trackingSubscribedAt) : ''}`
            : providerConfigured
              ? 'not subscribed'
              : 'none (manual events)'}
        </dd>
        {shipment.quoteId ? (
          <>
            <dt>Quote</dt>
            <dd>
              <code>{shipment.quoteId}</code>
            </dd>
          </>
        ) : null}
      </dl>

      <section aria-labelledby="containers-title">
        <h2 id="containers-title">Containers</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Size</th>
                <th>Vessel</th>
                <th>Voyage</th>
                <th>Last milestone</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <code>{c.containerNumber}</code>
                  </td>
                  <td>
                    {c.sizeType
                      ? (CONTAINER_SIZE_LABELS[c.sizeType as keyof typeof CONTAINER_SIZE_LABELS] ??
                        c.sizeType)
                      : '—'}
                  </td>
                  <td>
                    {c.vesselName ?? (c.vesselImo ? `IMO ${c.vesselImo}` : '—')}
                    {c.vesselName && c.vesselImo ? (
                      <div className="hint">IMO {c.vesselImo}</div>
                    ) : null}
                  </td>
                  <td>{c.voyageNumber ?? '—'}</td>
                  <td>
                    {c.lastMilestone
                      ? (MILESTONE_LABELS[c.lastMilestone as keyof typeof MILESTONE_LABELS] ??
                        c.lastMilestone)
                      : '—'}
                    {c.lastMilestoneAt ? (
                      <div className="hint">{formatWhen(c.lastMilestoneAt)}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {vessels.length > 0 ? (
        <section aria-labelledby="vessel-title" className="vessel-cards">
          <h2 id="vessel-title">Vessel</h2>
          {vessels.map((v) => (
            <dl className="meta vessel-card" key={v.imo}>
              <dt>Name</dt>
              <dd>
                {v.name ?? '—'} <span className="muted">IMO {v.imo}</span>
              </dd>
              <dt>Speed</dt>
              <dd>{v.speedKnots !== null ? `${v.speedKnots.toFixed(1)} kn` : '—'}</dd>
              <dt>Heading</dt>
              <dd>{v.headingDeg !== null ? `${v.headingDeg.toFixed(0)}°` : '—'}</dd>
              <dt>Last position</dt>
              <dd>
                {v.positionAt ? formatWhen(v.positionAt) : 'no position yet'}
                {v.positionSource ? <span className="muted"> · {v.positionSource}</span> : null}
                {v.pollState === 'STALE' ? (
                  <span className="field-error"> · position feed stale (last seen)</span>
                ) : null}
              </dd>
              <dt>Carrier ETA</dt>
              <dd>{v.providerEtaAt ? formatWhen(v.providerEtaAt) : 'not provided'}</dd>
              <dt>Polling</dt>
              <dd>{v.pollState.toLowerCase().replace('_', ' ')}</dd>
            </dl>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="map-title">
        <h2 id="map-title">Map</h2>
        <TrackingMap
          styleUrl={mapStyleUrl}
          stateUrl={`/app/api/map-state?shipmentId=${encodeURIComponent(shipment.id)}`}
          initialState={mapState}
        />
      </section>

      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title">Timeline</h2>
        <Timeline events={events} ports={ports} />
      </section>

      {canTrack ? (
        <section aria-labelledby="manual-title" className="narrow-page">
          <h2 id="manual-title">Add a milestone manually</h2>
          <p className="hint">
            For updates the carrier sent you by email or portal. Stored with source{' '}
            <code>MANUAL</code>.
          </p>
          <Form method="post">
            <CsrfInput />
            <div className={`field${errors.containerId ? ' has-error' : ''}`}>
              <label htmlFor="containerId">Container</label>
              {err('containerId')}
              <select
                id="containerId"
                name="containerId"
                required
                defaultValue={values.containerId ?? containers[0]?.id ?? ''}
              >
                {containers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.containerNumber}
                  </option>
                ))}
              </select>
            </div>
            <div className="inline-fields">
              <div className={`field${errors.milestone ? ' has-error' : ''}`}>
                <label htmlFor="milestone">Milestone</label>
                {err('milestone')}
                <select
                  id="milestone"
                  name="milestone"
                  required
                  defaultValue={values.milestone ?? 'GATE_IN_ORIGIN'}
                >
                  {MILESTONES.map((m) => (
                    <option key={m} value={m}>
                      {MILESTONE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`field${errors.occurredAt ? ' has-error' : ''}`}>
                <label htmlFor="occurredAt">When (UTC)</label>
                {err('occurredAt')}
                <input
                  id="occurredAt"
                  name="occurredAt"
                  type="datetime-local"
                  required
                  defaultValue={values.occurredAt ?? ''}
                />
              </div>
            </div>
            <div className="inline-fields">
              <div className={`field${errors.locationLocode ? ' has-error' : ''}`}>
                <label htmlFor="locationLocode">Location (UN/LOCODE)</label>
                {err('locationLocode')}
                <input
                  id="locationLocode"
                  name="locationLocode"
                  type="text"
                  maxLength={5}
                  className="narrow"
                  defaultValue={values.locationLocode ?? ''}
                />
              </div>
              <div className={`field${errors.locationName ? ' has-error' : ''}`}>
                <label htmlFor="locationName">Location name</label>
                {err('locationName')}
                <input
                  id="locationName"
                  name="locationName"
                  type="text"
                  maxLength={120}
                  defaultValue={values.locationName ?? ''}
                />
              </div>
            </div>
            <div className="inline-fields">
              <div className={`field${errors.vesselImo ? ' has-error' : ''}`}>
                <label htmlFor="vesselImo">Vessel IMO</label>
                {err('vesselImo')}
                <input
                  id="vesselImo"
                  name="vesselImo"
                  type="text"
                  maxLength={12}
                  className="narrow"
                  defaultValue={values.vesselImo ?? ''}
                />
              </div>
              <div className={`field${errors.vesselName ? ' has-error' : ''}`}>
                <label htmlFor="vesselName">Vessel name</label>
                {err('vesselName')}
                <input
                  id="vesselName"
                  name="vesselName"
                  type="text"
                  maxLength={120}
                  defaultValue={values.vesselName ?? ''}
                />
              </div>
              <div className={`field${errors.voyageNumber ? ' has-error' : ''}`}>
                <label htmlFor="voyageNumber">Voyage</label>
                {err('voyageNumber')}
                <input
                  id="voyageNumber"
                  name="voyageNumber"
                  type="text"
                  maxLength={40}
                  className="narrow"
                  defaultValue={values.voyageNumber ?? ''}
                />
              </div>
            </div>
            <div className="inline-fields">
              <div className={`field${errors.latitude ? ' has-error' : ''}`}>
                <label htmlFor="latitude">Latitude</label>
                {err('latitude')}
                <input
                  id="latitude"
                  name="latitude"
                  type="text"
                  inputMode="decimal"
                  maxLength={12}
                  className="narrow"
                  defaultValue={values.latitude ?? ''}
                />
              </div>
              <div className={`field${errors.longitude ? ' has-error' : ''}`}>
                <label htmlFor="longitude">Longitude</label>
                {err('longitude')}
                <input
                  id="longitude"
                  name="longitude"
                  type="text"
                  inputMode="decimal"
                  maxLength={12}
                  className="narrow"
                  defaultValue={values.longitude ?? ''}
                />
              </div>
            </div>
            <div className={`field${errors.note ? ' has-error' : ''}`}>
              <label htmlFor="note">Note (optional)</label>
              {err('note')}
              <input
                id="note"
                name="note"
                type="text"
                maxLength={500}
                defaultValue={values.note ?? ''}
              />
            </div>
            <button type="submit" className="button">
              Add milestone
            </button>
          </Form>
          {shipment.trackingRequestRef ? (
            <Form method="post" className="notes">
              <CsrfInput />
              <input type="hidden" name="intent" value="untrack" />
              <button type="submit" className="button secondary">
                Stop provider tracking
              </button>
            </Form>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
