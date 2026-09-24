import { MILESTONE_LABELS, isMilestone } from '@harbour/adapters/tracking/core';
import type { ShipmentDetail } from '../../services/tracking/queries.server';
import { SHIPMENT_STATUS_LABELS } from '../../validators/tracking';

/**
 * M9 — the shipment timeline: plain server-rendered markup, works without JavaScript.
 * Newest first (the loader orders by occurredAt desc).
 */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  MANUAL: 'entered manually',
  POLL: 'provider poll',
  terminal49: 'Terminal49 webhook',
};

export function Timeline({
  events,
  ports,
}: {
  events: ShipmentDetail['events'];
  ports: Record<string, string>;
}) {
  if (events.length === 0) {
    return <p className="muted">No milestones yet. Add one below, or wait for the provider.</p>;
  }
  return (
    <ol className="timeline">
      {events.map((e) => {
        const label = isMilestone(e.eventType) ? MILESTONE_LABELS[e.eventType] : e.eventType;
        const place = e.locationName ?? (e.locationLocode ? ports[e.locationLocode] : null);
        return (
          <li key={e.id} className="timeline-item">
            <time dateTime={e.occurredAt}>{formatWhen(e.occurredAt)}</time>
            <div>
              <strong>{label}</strong>
              {e.containerNumber ? (
                <>
                  {' '}
                  <code>{e.containerNumber}</code>
                </>
              ) : null}
              {place || e.locationLocode ? (
                <span className="muted">
                  {' '}
                  — {place ?? e.locationLocode}
                  {place && e.locationLocode ? ` (${e.locationLocode})` : ''}
                </span>
              ) : null}
              {e.vesselImo ? <span className="muted"> · IMO {e.vesselImo}</span> : null}
              {e.latitude !== null && e.longitude !== null ? (
                <span className="muted">
                  {' '}
                  · {e.latitude.toFixed(3)}, {e.longitude.toFixed(3)}
                </span>
              ) : null}
              <div className="hint">
                {SOURCE_LABELS[e.source] ?? e.source}
                {e.statusAfter
                  ? ` · status ${SHIPMENT_STATUS_LABELS[e.statusAfter] ?? e.statusAfter}`
                  : ''}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
