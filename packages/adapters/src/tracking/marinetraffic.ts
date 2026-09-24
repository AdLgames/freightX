import { z } from 'zod';
import { withTimeout } from '../resilience.js';
import { checkImo } from './check-digits.js';
import { locodeFromDestination } from './spire.js';
import {
  vesselPositionSchema,
  type HttpFetch,
  type PositionProvider,
  type VesselPosition,
} from './types.js';

/**
 * MarineTraffic vessel positions (decision (ac), ADR-0017) — shaped on the documented REST
 * "Vessel Positions" export (PS07 / `exportvessel`) with `protocol=jsono`. EVERY path, parameter
 * and field is "TO CONFIRM" against the live docs (https://servicedocs.marinetraffic.com) before
 * `TRACKING_POSITION_PROVIDER=marinetraffic` is enabled (docs/decisions-needed.md (ae)).
 *
 * MarineTraffic bills per call and the documented single-vessel endpoint takes ONE IMO, so
 * `maxImosPerCall = 1`; the worker still calls once per vessel, never per container. The API key
 * is part of the URL path in their scheme; it must therefore never be logged (errors carry the
 * status only).
 */
export interface MarineTrafficOptions {
  /** `MARINETRAFFIC_API_KEY`. */
  apiKey?: string | undefined;
  /** TO CONFIRM. Default https://services.marinetraffic.com. */
  baseUrl?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/** TO CONFIRM: `jsono` keys of the single-vessel positions export. */
const rowSchema = z.object({
  IMO: z.union([z.string(), z.number()]).optional(),
  SHIPNAME: z.string().optional(),
  LAT: z.union([z.string(), z.number()]),
  LON: z.union([z.string(), z.number()]),
  /** Speed in knots × 10 in MarineTraffic exports (TO CONFIRM). */
  SPEED: z.union([z.string(), z.number()]).optional(),
  HEADING: z.union([z.string(), z.number()]).optional(),
  COURSE: z.union([z.string(), z.number()]).optional(),
  TIMESTAMP: z.string(),
  DESTINATION: z.string().optional(),
  ETA: z.string().optional(),
});

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** MarineTraffic timestamps are `YYYY-MM-DDTHH:MM:SS` in UTC without a zone designator (TO CONFIRM). */
const toIsoUtc = (ts: string): string => (/[zZ]|[+-]\d{2}:\d{2}$/.test(ts) ? ts : `${ts}Z`);

export const normaliseMarineTrafficRow = (
  row: z.infer<typeof rowSchema>,
  requestedImo: string,
): VesselPosition | null => {
  const imoCheck = checkImo(row.IMO === undefined ? requestedImo : String(row.IMO));
  if (!imoCheck.ok) return null;
  const lat = num(row.LAT);
  const lon = num(row.LON);
  if (lat === undefined || lon === undefined) return null;
  const speedTenths = num(row.SPEED) ?? 0;
  const heading = num(row.HEADING) ?? num(row.COURSE) ?? 0;
  const candidate = {
    imo: imoCheck.imo,
    ...(row.SHIPNAME ? { name: row.SHIPNAME } : {}),
    lat,
    lon,
    speedKnots: Math.max(0, speedTenths / 10),
    // 511 = "not available" in AIS heading.
    headingDeg: heading === 511 ? 0 : ((heading % 360) + 360) % 360,
    positionAt: toIsoUtc(row.TIMESTAMP),
    ...(locodeFromDestination(row.DESTINATION)
      ? { destinationLocode: locodeFromDestination(row.DESTINATION) }
      : {}),
    ...(row.ETA ? { etaAt: toIsoUtc(row.ETA) } : {}),
  };
  const parsed = vesselPositionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

export class MarineTrafficPositionProvider implements PositionProvider {
  readonly name = 'MARINETRAFFIC';
  readonly maxImosPerCall = 1;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;

  constructor(opts: MarineTrafficOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://services.marinetraffic.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  async positions(imos: readonly string[]): Promise<VesselPosition[]> {
    if (!this.configured) throw new Error('MARINETRAFFIC_API_KEY is not set.');
    const out: VesselPosition[] = [];
    for (const imo of imos) {
      // TO CONFIRM: /api/exportvessel/v:5/<key>/imo:<imo>/protocol:jsono
      const url = `${this.baseUrl}/api/exportvessel/v:5/${encodeURIComponent(this.apiKey ?? '')}/imo:${encodeURIComponent(imo)}/protocol:jsono`;
      const res = await withTimeout(
        (signal) =>
          this.fetchImpl(url, { method: 'GET', signal, headers: { accept: 'application/json' } }),
        this.timeoutMs,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`MarineTraffic responded ${res.status}`);
      }
      const parsed = z.array(rowSchema).safeParse(await res.json());
      if (!parsed.success)
        throw new Error('MarineTraffic response did not match the expected shape');
      for (const row of parsed.data) {
        const v = normaliseMarineTrafficRow(row, imo);
        if (v) out.push(v);
      }
    }
    return out;
  }
}
