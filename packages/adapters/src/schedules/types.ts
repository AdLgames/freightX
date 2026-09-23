import type { Mode } from '@harbour/engine';

/**
 * Normalised sailing schedule types (ADR-0010). Shaped after the DCSA Commercial Schedules
 * standard so aggregator adapters (Portcast, Linescape, SeaRates…) and direct carrier adapters
 * map into the same structure. Nothing here is a booking: schedule visibility is not equipment
 * availability.
 */

export interface ScheduleSearch {
  /** UN/LOCODE, e.g. CNSZX. */
  origin: string;
  /** UN/LOCODE, e.g. GBFXT. */
  destination: string;
  mode: Extract<Mode, 'SEA_LCL' | 'SEA_FCL'>;
  /** ISO date; sailings departing on or after this date. */
  earliestDeparture: string;
  /** Days of departures to return (default 30, max 90 — aggregator horizons stop there). */
  windowDays?: number;
}

export interface SailingLeg {
  /** UN/LOCODE. */
  from: string;
  to: string;
  vesselName: string | null;
  /** IMO number when known. */
  vesselImo: string | null;
  voyageNumber: string | null;
  /** ISO datetimes. */
  etd: string;
  eta: string;
}

export interface SailingCutoffs {
  /** Cargo must be physically at the origin terminal. */
  cargo: string | null;
  /** Verified Gross Mass declaration deadline. */
  vgm: string | null;
  /** Customs documentation / shipping-instruction deadline. */
  documentation: string | null;
}

export interface Sailing {
  /** Provider-scoped stable id for caching and snapshotting. */
  id: string;
  provider: string;
  /** SCAC or carrier name as the provider reports it. */
  carrier: string;
  service: string | null;
  origin: string;
  destination: string;
  /** Origin-port departure and destination-port arrival, ISO datetimes. */
  etd: string;
  eta: string;
  transitDays: number;
  /** One leg = direct; more = transshipment via the intermediate ports. */
  legs: SailingLeg[];
  cutoffs: SailingCutoffs;
  /**
   * Provider signals. `null` means the provider does not report the signal — never treat null as
   * "no risk".
   */
  blankSailing: boolean | null;
  /** 0–100 congestion index at the origin port, or null when unreported. */
  originCongestionIndex: number | null;
  /** When the provider last refreshed this sailing (ISO). */
  fetchedAt: string;
}

export type ScheduleResult =
  | { ok: true; provider: string; sailings: Sailing[]; fetchedAt: string; fromCache: boolean }
  | {
      ok: false;
      provider: string;
      reason: 'NOT_CONFIGURED' | 'NO_ROUTE' | 'UNAVAILABLE' | 'INVALID' | 'MALFORMED';
      message: string;
    };

export interface ScheduleProvider {
  readonly name: string;
  search(query: ScheduleSearch): Promise<ScheduleResult>;
}
