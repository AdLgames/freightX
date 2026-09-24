import type { PaymentMethod } from '@harbour/db';

/**
 * Home "Action required" banner (docs/phase-1-workspace-ux.md, Home). Per the corrected spec these
 * block BOOKING (Phase 2), not quoting, so the banner informs and links to Settings; it does not
 * gate anything in the workspace. Returns copy and links only — never the EORI or any value.
 */
export interface ActionItem {
  id: 'eori_missing' | 'cds_authority_missing';
  text: string;
  href: string;
}

export interface HomeActionInput {
  eoriNumber: string | null;
  customsProfile: { paymentMethod: PaymentMethod; cdsAuthorityGranted: boolean } | null;
}

export const homeActions = (input: HomeActionInput): ActionItem[] => {
  const items: ActionItem[] = [];
  if (input.eoriNumber === null || input.eoriNumber.trim() === '') {
    items.push({
      id: 'eori_missing',
      text: 'Add your EORI number — you need it before booking',
      href: '/app/settings',
    });
  }
  if (
    input.customsProfile?.paymentMethod === 'OWN_DEFERMENT' &&
    !input.customsProfile.cdsAuthorityGranted
  ) {
    items.push({
      id: 'cds_authority_missing',
      text: 'Authorise our forwarding partner to use your duty deferment account in CDS — you need it before booking',
      href: '/app/settings',
    });
  }
  return items;
};

// ---------- Home stat cards and recent drafts (docs/design-system.md, "Home") ----------

import { D, sum } from '@harbour/engine';

export interface HomeStatsInput {
  activeShipments: number;
  /** `totalLandedCostExVat` of READY/ACCEPTED quotes created this month, decimal strings. */
  monthQuoteTotals: readonly string[];
  draftQuotes: number;
}

export interface HomeStats {
  activeShipments: number;
  estimatedLandedCostGbp: string;
  draftQuotes: number;
}

export const homeStats = (input: HomeStatsInput): HomeStats => ({
  activeShipments: input.activeShipments,
  estimatedLandedCostGbp: sum(input.monthQuoteTotals.map((t) => D(t))).toFixed(2),
  draftQuotes: input.draftQuotes,
});

export interface RecentDraft {
  id: string;
  route: string;
  mode: string;
  updatedAt: string;
  totalExVatGbp: string;
}

/** Start of the current month in UTC — quotes created from here count towards "this month". */
export const startOfMonthUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

// ---------- Exception alerts (Home "Action required", extended) ----------

/**
 * The Home banner as an exception list. Two sources today:
 *   - customs profile gaps (`homeActions`, warning);
 *   - a release document missing on a shipment that is about to arrive (critical): without the
 *     bill of lading (or its telex release) / air waybill the container cannot be collected and
 *     demurrage starts. Arrivals are shipments with an ETA inside `RELEASE_DOCUMENT_WINDOW_DAYS`
 *     (or already past) that are not delivered or cancelled.
 * Pure: the loader gathers rows, this decides. Copy only — no amounts, no PII.
 */
export const RELEASE_DOCUMENT_WINDOW_DAYS = 7;
export const RELEASE_DOCUMENT_TYPES = ['BILL_OF_LADING', 'AIRWAY_BILL'] as const;

export interface ArrivalInput {
  shipmentId: string;
  reference: string | null;
  /** Destination port name (or LOCODE) for copy. */
  destinationName: string | null;
  etaIso: string;
  quoteId: string | null;
  /** Document types on file for this shipment (its own and its quote's), excluding rejected/deleted. */
  documentTypes: readonly string[];
}

export interface HomeAlert {
  id: string;
  level: 'critical' | 'warning';
  title: string;
  message: string;
  actionText: string;
  actionHref: string;
  /** Secondary link, e.g. the shipment itself. */
  secondary: { text: string; href: string } | null;
}

const DAY_MS = 86_400_000;

const daysUntil = (iso: string, now: Date): number =>
  Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS);

const arrivalPhrase = (days: number): string => {
  if (days < 0) return `arrived ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'arrives today';
  if (days === 1) return 'arrives tomorrow';
  return `arrives in ${days} days`;
};

export const homeAlerts = (
  input: HomeActionInput & { arrivals: readonly ArrivalInput[] },
  now: Date,
): HomeAlert[] => {
  const alerts: HomeAlert[] = [];
  const arrivals = [...input.arrivals].sort((a, b) => a.etaIso.localeCompare(b.etaIso));
  for (const a of arrivals) {
    const days = daysUntil(a.etaIso, now);
    if (days > RELEASE_DOCUMENT_WINDOW_DAYS) continue;
    const hasRelease = a.documentTypes.some((t) =>
      (RELEASE_DOCUMENT_TYPES as readonly string[]).includes(t),
    );
    if (hasRelease) continue;
    const name = a.reference ?? 'A shipment';
    const where = a.destinationName ? ` at ${a.destinationName}` : '';
    alerts.push({
      id: `release_missing:${a.shipmentId}`,
      level: 'critical',
      title: 'Release document missing',
      message: `${name} ${arrivalPhrase(days)}${where}. Without the bill of lading (telex release) or air waybill the container cannot be collected and demurrage starts.`,
      actionText: 'Upload the bill of lading',
      actionHref: a.quoteId
        ? `/app/documents/new?quoteId=${a.quoteId}&type=BILL_OF_LADING`
        : '/app/documents/new?type=BILL_OF_LADING',
      secondary: { text: 'View shipment', href: `/app/tracking/${a.shipmentId}` },
    });
  }
  for (const item of homeActions(input)) {
    alerts.push({
      id: item.id,
      level: 'warning',
      title: 'Action required: complete your customs profile',
      message: item.text,
      actionText: 'Complete setup',
      actionHref: item.href,
      secondary: null,
    });
  }
  return alerts;
};
