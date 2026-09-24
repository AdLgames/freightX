import type { QuoteResult } from '@harbour/engine';
import type { QuoteDutyPaymentMethod, QuoteStatusValue } from '../../validators/quote';

/**
 * JSON-safe shapes shared by the builder preview, the saved-quote detail page and the client
 * (M4). No Prisma types here: this file is imported by components, so it must stay client-safe.
 */

/** A quote line as shown on screen: the engine's line plus the catalogue labels at that moment. */
export interface QuoteLineLabel {
  /** `LineResult.ref` — the product id. */
  ref: string;
  productId: string;
  sku: string;
  name: string;
  /** Official tariff description when the code resolved (or the product's stored one). */
  hsDescription: string | null;
  hsVerified: boolean;
  /** The product has been archived since the line was added (still quotable on a snapshot). */
  archived: boolean;
}

export interface BrokerFeeTermsView {
  feePct: string;
  minimumGbp: string;
  /** Terms came from configured defaults rather than the customs profile or the form. */
  usedDefaults: boolean;
}

export interface DutyPaymentView {
  method: QuoteDutyPaymentMethod;
  /** BROKER_DEFERMENT only; null when no terms are known (no fee included). */
  brokerFeeTerms: BrokerFeeTermsView | null;
}

export interface StageView {
  stage: string;
  ok: boolean;
  note: string;
}

/** Everything the breakdown column needs, whether freshly computed or read back from a row. */
export interface QuoteView {
  quote: QuoteResult;
  lines: QuoteLineLabel[];
  dutyPayment: DutyPaymentView;
  freight: { transitDays: number | null; assumptions: string[] };
  shipment: { totalWeightKg: string; totalVolumeCbm: string };
  stages: StageView[];
}

/** One row of the quotes list. */
export interface QuoteListRow {
  id: string;
  reference: string;
  status: QuoteStatusValue;
  incoterm: string;
  mode: string;
  originPort: string | null;
  destinationPort: string | null;
  originCountry: string;
  lineCount: number;
  /** Per-unit ex VAT of the first line (single-line quotes) or null for mixed quotes. */
  landedCostPerUnit: string | null;
  totalLandedCostExVat: string;
  totalLandedCost: string;
  validUntil: string;
  updatedAt: string;
}

/** Short human reference for a quote: the first 8 hex characters of its id, upper-cased. */
export const quoteReference = (id: string): string => `Q-${id.slice(0, 8).toUpperCase()}`;

/** Status → `.status-pill` modifier (styles.css). */
export const QUOTE_STATUS_CLASS: Record<QuoteStatusValue, string> = {
  DRAFT: 'quote-draft',
  INDICATIVE: 'indicative',
  READY: 'ready',
  ACCEPTED: 'quote-accepted',
  EXPIRED: 'quote-muted',
  CANCELLED: 'quote-muted',
};

/** Statuses the builder may open for editing (§5.9: DRAFT = being edited). */
export const EDITABLE_STATUSES: readonly QuoteStatusValue[] = ['DRAFT'];

/** Statuses that count towards the FREE plan's saved-quote limit (PLAN_LIMITS.savedQuotes). */
export const COUNTED_STATUSES: readonly QuoteStatusValue[] = [
  'DRAFT',
  'INDICATIVE',
  'READY',
  'ACCEPTED',
];
