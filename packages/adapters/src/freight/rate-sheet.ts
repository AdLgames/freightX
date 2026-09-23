import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { FreightRateProvider, FreightRequest, FreightResult } from './provider.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'money must be a decimal string with ≤2 dp');

const laneSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('SEA_LCL'),
    origin: z.string().length(5),
    destination: z.string().length(5),
    transitDays: z.number().int().positive(),
    rate: z.object({ perCbm: money, minimum: money }),
    originFees: z.object({ flat: money }),
    destinationFees: z.object({ flat: money, perCbm: money }),
    clearanceFee: money,
    ukHaulage: z.object({ flat: money }),
  }),
  z.object({
    mode: z.literal('SEA_FCL'),
    origin: z.string().length(5),
    destination: z.string().length(5),
    transitDays: z.number().int().positive(),
    rate: z.object({ per20ft: money, per40ft: money }),
    originFees: z.object({ per20ft: money, per40ft: money }),
    destinationFees: z.object({ per20ft: money, per40ft: money }),
    clearanceFee: money,
    ukHaulage: z.object({ per20ft: money, per40ft: money }),
  }),
  z.object({
    mode: z.literal('AIR'),
    origin: z.string().length(5),
    destination: z.string().length(5),
    transitDays: z.number().int().positive(),
    rate: z.object({ perKg: money, minimum: money }),
    originFees: z.object({ flat: money }),
    destinationFees: z.object({ perKg: money, minimum: money }),
    clearanceFee: money,
    ukHaulage: z.object({ flat: money }),
  }),
]);

export const rateSheetSchema = z.object({
  version: z.string().regex(/^RATE_SHEET_V\d+$/),
  currency: z.literal('GBP'),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  placeholder: z.boolean(),
  sources: z.array(z.string()),
  notes: z.array(z.string()).default([]),
  lanes: z.array(laneSchema).min(1),
});

export type RateSheet = z.infer<typeof rateSheetSchema>;
export type RateSheetLane = RateSheet['lanes'][number];

export const loadRateSheet = (path: string): RateSheet =>
  rateSheetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

const D = (s: string) => new Decimal(s);
const fix = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** Usable capacity used to infer containers when the request gives none. */
const CBM_20FT = new Decimal(28);
const CBM_40FT = new Decimal(58);

const inferContainers = (volumeCbm: Decimal): Array<{ size: '20' | '40'; count: number }> => {
  if (volumeCbm.lte(CBM_20FT)) return [{ size: '20', count: 1 }];
  if (volumeCbm.lte(CBM_40FT)) return [{ size: '40', count: 1 }];
  return [{ size: '40', count: volumeCbm.div(CBM_40FT).ceil().toNumber() }];
};

/**
 * Phase 0 freight source (§5.8): our own versioned rate sheet. Deterministic, no I/O after load.
 * `fetchedAt` is the request time; `providerValidUntil` is the sheet's validity so the engine's
 * `validUntil = min(sheet validity, fetchedAt + 7d)` rule applies.
 */
export class RateSheetFreightProvider implements FreightRateProvider {
  readonly name: string;

  constructor(
    private readonly sheet: RateSheet,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.name = sheet.version;
  }

  get version(): string {
    return this.sheet.version;
  }

  get isPlaceholder(): boolean {
    return this.sheet.placeholder;
  }

  lanes(): ReadonlyArray<Pick<RateSheetLane, 'origin' | 'destination' | 'mode' | 'transitDays'>> {
    return this.sheet.lanes.map(({ origin, destination, mode, transitDays }) => ({
      origin,
      destination,
      mode,
      transitDays,
    }));
  }

  findLane(
    origin: string,
    destination: string,
    mode: FreightRequest['mode'],
  ): RateSheetLane | undefined {
    return this.sheet.lanes.find(
      (l) => l.origin === origin && l.destination === destination && l.mode === mode,
    );
  }

  async quote(req: FreightRequest): Promise<FreightResult> {
    if (!/^\d+(\.\d+)?$/.test(req.weightKg) || !/^\d+(\.\d+)?$/.test(req.volumeCbm)) {
      return {
        ok: false,
        reason: 'INVALID',
        message: 'weightKg and volumeCbm must be decimal strings',
      };
    }
    const lane = this.findLane(req.origin, req.destination, req.mode);
    if (!lane) {
      return {
        ok: false,
        reason: 'NO_LANE',
        message: `No ${req.mode} rate for ${req.origin} → ${req.destination} in ${this.sheet.version}`,
      };
    }
    const weightKg = D(req.weightKg);
    const volumeCbm = D(req.volumeCbm);
    const assumptions: string[] = [];
    if (this.sheet.placeholder) {
      assumptions.push(
        `${this.sheet.version} contains placeholder figures pending refresh from FBX and forwarder quotes.`,
      );
    }

    let toBorder: Decimal;
    let origin: Decimal;
    let destination: Decimal;
    let haulage: Decimal;

    switch (lane.mode) {
      case 'SEA_LCL': {
        // Weight-or-measure: 1 tonne = 1 CBM revenue ton.
        const revenueTons = Decimal.max(volumeCbm, weightKg.div(1000));
        const raw = revenueTons.times(D(lane.rate.perCbm));
        toBorder = Decimal.max(raw, D(lane.rate.minimum));
        if (toBorder.gt(raw)) assumptions.push(`LCL minimum charge £${lane.rate.minimum} applied.`);
        origin = D(lane.originFees.flat);
        destination = D(lane.destinationFees.flat).plus(
          revenueTons.times(D(lane.destinationFees.perCbm)),
        );
        haulage = D(lane.ukHaulage.flat);
        break;
      }
      case 'SEA_FCL': {
        const containers =
          req.containers && req.containers.length > 0
            ? [...req.containers]
            : inferContainers(volumeCbm);
        if (!req.containers || req.containers.length === 0) {
          assumptions.push(
            `Containers inferred from ${req.volumeCbm} CBM: ${containers.map((c) => `${c.count}×${c.size}ft`).join(', ')}.`,
          );
        }
        const sumBy = (per20: string, per40: string) =>
          containers.reduce(
            (acc, c) => acc.plus(D(c.size === '20' ? per20 : per40).times(c.count)),
            new Decimal(0),
          );
        toBorder = sumBy(lane.rate.per20ft, lane.rate.per40ft);
        origin = sumBy(lane.originFees.per20ft, lane.originFees.per40ft);
        destination = sumBy(lane.destinationFees.per20ft, lane.destinationFees.per40ft);
        haulage = sumBy(lane.ukHaulage.per20ft, lane.ukHaulage.per40ft);
        break;
      }
      case 'AIR': {
        const volumetricKg = volumeCbm.times(1_000_000).div(6000);
        const chargeableKg = Decimal.max(weightKg, volumetricKg);
        const raw = chargeableKg.times(D(lane.rate.perKg));
        toBorder = Decimal.max(raw, D(lane.rate.minimum));
        if (toBorder.gt(raw)) assumptions.push(`Air minimum charge £${lane.rate.minimum} applied.`);
        origin = D(lane.originFees.flat);
        destination = Decimal.max(
          chargeableKg.times(D(lane.destinationFees.perKg)),
          D(lane.destinationFees.minimum),
        );
        haulage = D(lane.ukHaulage.flat);
        break;
      }
    }

    const fetchedAt = this.now();
    return {
      ok: true,
      quote: {
        transitDays: lane.transitDays,
        assumptions,
        freight: {
          source: this.sheet.version,
          fetchedAt: fetchedAt.toISOString(),
          providerValidUntil: `${this.sheet.validUntil}T23:59:59.000Z`,
          toBorderGbp: fix(toBorder),
          postBorderGbp: fix(haulage),
          originFeesGbp: fix(origin),
          destinationFeesGbp: fix(destination),
          clearanceFeeGbp: lane.clearanceFee,
          benchmarkToBorderGbp: fix(toBorder),
        },
      },
    };
  }
}
