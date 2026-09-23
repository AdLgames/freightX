import type { FreightInput, Mode } from '@harbour/engine';

export interface FreightRequest {
  /** UN/LOCODE, e.g. CNSHA. For air, the airport LOCODE, e.g. CNPVG. */
  origin: string;
  /** UN/LOCODE, e.g. GBFXT. */
  destination: string;
  mode: Mode;
  /** Total actual weight in kg (decimal string). */
  weightKg: string;
  /** Total volume in CBM (decimal string). */
  volumeCbm: string;
  /** FCL only. If omitted, the provider infers from volume and records an assumption. */
  containers?: ReadonlyArray<{ size: '20' | '40'; count: number }>;
}

export interface FreightQuote {
  /** Ready to feed the engine. */
  freight: FreightInput;
  transitDays: number | null;
  /** Human-readable assumptions the provider made (container inference, minimums applied…). */
  assumptions: string[];
}

export type FreightResult =
  | { ok: true; quote: FreightQuote }
  | { ok: false; reason: 'NO_LANE' | 'UNAVAILABLE' | 'INVALID'; message: string };

export interface FreightRateProvider {
  readonly name: string;
  quote(req: FreightRequest): Promise<FreightResult>;
}
