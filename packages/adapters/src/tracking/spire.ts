import { z } from 'zod';
import { withTimeout } from '../resilience.js';
import { checkImo } from './check-digits.js';
import {
  LOCODE_RE,
  vesselPositionSchema,
  type HttpFetch,
  type PositionProvider,
  type VesselPosition,
} from './types.js';

/**
 * Spire Maritime vessel positions (decision (ac), ADR-0017) — shaped on Spire's documented
 * GraphQL API (https://documentation.spire.com/maritime-2-0/). EVERY field below is "TO CONFIRM"
 * against the live schema and a sandbox before `TRACKING_POSITION_PROVIDER=spire` is enabled
 * (docs/decisions-needed.md (ae)). The token goes in one header and is never logged; the query
 * carries only IMO numbers.
 */
export interface SpireOptions {
  /** `SPIRE_API_TOKEN`. */
  token?: string | undefined;
  /** TO CONFIRM. Default https://api.spire.com/graphql. */
  endpoint?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/** TO CONFIRM: the `vessels(imo: [...])` connection and the field names. */
export const SPIRE_VESSELS_QUERY = `
query HarbourVesselPositions($imo: [IMO!]) {
  vessels(imo: $imo) {
    nodes {
      staticData { name imo }
      lastPositionUpdate { latitude longitude speed heading course timestamp }
      currentVoyage { destination eta }
    }
  }
}`;

const node = z.object({
  staticData: z
    .object({
      name: z.string().nullable().optional(),
      imo: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .nullable()
    .optional(),
  lastPositionUpdate: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      speed: z.number().nullable().optional(),
      heading: z.number().nullable().optional(),
      course: z.number().nullable().optional(),
      timestamp: z.string(),
    })
    .nullable()
    .optional(),
  currentVoyage: z
    .object({
      destination: z.string().nullable().optional(),
      eta: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const responseSchema = z.object({
  data: z
    .object({ vessels: z.object({ nodes: z.array(node) }) })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Spire reports AIS `destination` free text; only a clean UN/LOCODE is trusted. */
export const locodeFromDestination = (raw: string | null | undefined): string | undefined => {
  if (!raw) return undefined;
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  return LOCODE_RE.test(cleaned) ? cleaned : undefined;
};

export const normaliseSpireNode = (n: z.infer<typeof node>): VesselPosition | null => {
  const imoRaw = n.staticData?.imo;
  const imo = imoRaw === null || imoRaw === undefined ? null : checkImo(String(imoRaw));
  const pos = n.lastPositionUpdate;
  if (!imo?.ok || !pos) return null;
  const heading = pos.heading ?? pos.course ?? 0;
  const candidate = {
    imo: imo.imo,
    ...(n.staticData?.name ? { name: n.staticData.name } : {}),
    lat: pos.latitude,
    lon: pos.longitude,
    speedKnots: Math.max(0, pos.speed ?? 0),
    headingDeg: ((heading % 360) + 360) % 360,
    positionAt: pos.timestamp,
    ...(locodeFromDestination(n.currentVoyage?.destination)
      ? { destinationLocode: locodeFromDestination(n.currentVoyage?.destination) }
      : {}),
    ...(n.currentVoyage?.eta ? { etaAt: n.currentVoyage.eta } : {}),
  };
  const parsed = vesselPositionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

export class SpirePositionProvider implements PositionProvider {
  readonly name = 'SPIRE';
  /** TO CONFIRM: Spire's per-query vessel limit. */
  readonly maxImosPerCall = 100;
  private readonly token: string | undefined;
  private readonly endpoint: string;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;

  constructor(opts: SpireOptions = {}) {
    this.token = opts.token;
    this.endpoint = opts.endpoint ?? 'https://api.spire.com/graphql';
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return this.token !== undefined && this.token !== '';
  }

  async positions(imos: readonly string[]): Promise<VesselPosition[]> {
    if (!this.configured) throw new Error('SPIRE_API_TOKEN is not set.');
    if (imos.length === 0) return [];
    const res = await withTimeout(
      (signal) =>
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${this.token ?? ''}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ query: SPIRE_VESSELS_QUERY, variables: { imo: [...imos] } }),
        }),
      this.timeoutMs,
    );
    if (res.status < 200 || res.status >= 300) throw new Error(`Spire responded ${res.status}`);
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('Spire response did not match the expected shape');
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      throw new Error(`Spire GraphQL error: ${parsed.data.errors[0]?.message ?? 'unknown'}`);
    }
    const out: VesselPosition[] = [];
    for (const n of parsed.data.data?.vessels.nodes ?? []) {
      const v = normaliseSpireNode(n);
      if (v) out.push(v);
    }
    return out;
  }
}
