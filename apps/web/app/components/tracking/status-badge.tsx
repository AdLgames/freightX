import { SHIPMENT_STATUS_LABELS } from '../../validators/tracking';

/** M9 — `ShipmentStatus` as a pill. Plain CSS (`.status-pill.track-*` in styles.css). */
export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'DELIVERED' || status === 'CLEARED'
      ? 'ready'
      : status === 'EXCEPTION' || status === 'CANCELLED'
        ? 'error'
        : status === 'IN_TRANSIT' || status === 'AT_DESTINATION' || status === 'OUT_FOR_DELIVERY'
          ? 'active'
          : 'indicative';
  return (
    <span className={`status-pill ${tone}`} data-status={status}>
      {SHIPMENT_STATUS_LABELS[status] ?? status}
    </span>
  );
}
