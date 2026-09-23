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
