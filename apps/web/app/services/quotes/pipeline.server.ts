import { resolveFx } from '@harbour/adapters';
import {
  computeQuote,
  type LineInput,
  type QuoteInput,
  type SupplierFreightInput,
  type TariffInput,
} from '@harbour/engine';
import { Decimal } from 'decimal.js';
import { DOOR_INCOTERMS, parseLaneKey } from '../../validators/calculator';
import type { QuoteFormInput } from '../../validators/quote';
import {
  productToQuoteLineSnapshot,
  type SnapshotProduct, // M7
} from '../catalogue/snapshot.server';
import type { ProductRecord } from '../catalogue/products.server';
import {
  resolveBrokerFeeTerms,
  resolveTariffStage,
  type PipelineDeps,
  type StageName,
  type StageReport,
} from '../quote-pipeline.server';
import type { BrokerFeeTermsView, QuoteLineLabel, QuoteView } from './view';

/**
 * §5.1 pipeline for the quote builder (M4): the Phase 0 calculator pipeline extended to several
 * catalogue lines. Stages: resolveProducts (catalogue rows → line snapshots) → resolveFx (every
 * currency on the quote, one optional manual override) → resolveFreight (rate sheet for the whole
 * shipment) → resolveTariff (once per distinct HS code, through the calculator's stage) → compute.
 *
 * Every stage degrades to a warning / INDICATIVE result; the only non-quote outcomes are inputs
 * we cannot price at all (no FX rate) and a product that is not in this organisation.
 */

export type CatalogueOutcome =
  | { kind: 'QUOTE'; view: QuoteView; input: QuoteInput }
  | {
      kind: 'FAILED';
      stage: StageName;
      message: string;
      /** Form field the message belongs to, when there is one. */
      field: string | null;
    };

const D = (s: string): Decimal => new Decimal(s);

/** The tariff decision for one HS code, memoised per pipeline run. */
interface LineTariff {
  tariff: TariffInput;
  description: string | null;
  verified: boolean;
  note: string;
}

const resolveLineTariff = async (
  hsCode: string,
  deps: PipelineDeps,
  memo: Map<string, Promise<LineTariff>>,
): Promise<LineTariff> => {
  const cached = memo.get(hsCode);
  if (cached) return cached;
  const pending = (async (): Promise<LineTariff> => {
    const stage = await resolveTariffStage({ hsCode, manualDuty: false }, deps);
    if (stage.kind === 'CHOICE') {
      // The builder never picks a 10-digit code (§5.2): that decision belongs on the product.
      return {
        tariff: {
          kind: 'UNAVAILABLE',
          reason: `${hsCode} maps to ${stage.candidates.length} commodity codes; choose the 10-digit code on the product.`,
        },
        description: null,
        verified: false,
        note: `${hsCode} is ambiguous (${stage.candidates.length} codes); pick one on the product.`,
      };
    }
    return {
      tariff: stage.tariff,
      description: stage.summary.description,
      verified: stage.summary.verified,
      note: stage.note,
    };
  })();
  memo.set(hsCode, pending);
  return pending;
};

export const runCatalogueQuote = async (
  input: QuoteFormInput,
  products: readonly ProductRecord[],
  deps: PipelineDeps,
): Promise<CatalogueOutcome> => {
  const now = deps.now ?? (() => new Date());
  const stages: StageReport[] = [];
  const lane = parseLaneKey(input.lane);
  if (!lane) {
    return {
      kind: 'FAILED',
      stage: 'resolveProducts',
      message: 'Unknown route.',
      field: 'lane',
    };
  }

  // ---------- resolveProducts ----------
  const byId = new Map(products.map((p) => [p.id, p]));
  const resolved: Array<{
    product: ProductRecord;
    line: (typeof input.lines)[number];
    /** M7: the product as priced on this line — the PO unit cost/currency when given. */
    snapshot: SnapshotProduct;
  }> = [];
  for (const [i, l] of input.lines.entries()) {
    const product = byId.get(l.productId);
    if (!product) {
      return {
        kind: 'FAILED',
        stage: 'resolveProducts',
        message:
          'One of the products is no longer in your catalogue. Remove the line and add it again.',
        field: `line_${i}_productId`,
      };
    }
    // M7 (ADR-0013): a quote built from a purchase order prices the line at the PO unit cost in
    // the PO currency; weight, volume, HS code and origin still come from the catalogue.
    const snapshot: SnapshotProduct =
      l.unitCost !== undefined && l.currency !== undefined
        ? { ...product, unitValue: l.unitCost, currency: l.currency }
        : product;
    resolved.push({ product, line: l, snapshot });
  }
  let totalWeight = new Decimal(0);
  let totalVolume = new Decimal(0);
  for (const { product, line } of resolved) {
    totalWeight = totalWeight.plus(D(product.weightKg.toString()).times(line.quantity));
    totalVolume = totalVolume.plus(D(product.volumeCbm.toString()).times(line.quantity));
  }
  const totalWeightKg = totalWeight.toFixed(3);
  const totalVolumeCbm = totalVolume.toFixed(4);
  const poPriced = resolved.filter((r) => r.line.unitCost !== undefined).length; // M7
  stages.push({
    stage: 'resolveProducts',
    ok: true,
    note:
      `${resolved.length} line(s) from the catalogue. Shipment: ${totalWeightKg} kg, ${totalVolumeCbm} CBM.` +
      (poPriced > 0 ? ` ${poPriced} line(s) priced at the purchase-order unit cost.` : ''),
  });

  // ---------- resolveFx ----------
  const currencies = [...new Set(resolved.map((r) => r.snapshot.currency))]; // M7: PO currency when given
  const manual =
    input.manualFxCurrency !== undefined && input.manualFxRate !== undefined
      ? { [input.manualFxCurrency]: input.manualFxRate }
      : undefined;
  const fx = await resolveFx(deps.fxStore, currencies, {
    at: now(),
    ...(manual ? { manual } : {}),
  });
  if (!fx.ok) {
    stages.push({
      stage: 'resolveFx',
      ok: false,
      note: `No exchange rate for ${fx.missing.join(', ')}.`,
    });
    return {
      kind: 'FAILED',
      stage: 'resolveFx',
      message: `We have no ${fx.missing.join(', ')} → GBP exchange rate loaded. Enter a manual rate for that currency to continue.`,
      field: 'manualFxRate',
    };
  }
  const nonGbp = currencies.filter((c) => c !== 'GBP');
  stages.push({
    stage: 'resolveFx',
    ok: true,
    note:
      nonGbp.length === 0
        ? 'Prices are in GBP; no conversion needed.'
        : nonGbp
            .map(
              (c) =>
                `${c}: ${String(fx.fx.rates[c]?.rateToGbp ?? '?')} GBP (${fx.fx.rates[c]?.source ?? '?'})`,
            )
            .join('; ') + '.',
  });

  // ---------- resolveFreight ----------
  let freight: QuoteInput['freight'] = null;
  let transitDays: number | null = null;
  let assumptions: string[] = [];
  try {
    const res = await deps.freight.quote({
      origin: lane.origin,
      destination: lane.destination,
      mode: lane.mode,
      weightKg: totalWeightKg,
      volumeCbm: totalVolumeCbm,
    });
    if (res.ok) {
      freight = res.quote.freight;
      transitDays = res.quote.transitDays;
      assumptions = res.quote.assumptions;
      stages.push({
        stage: 'resolveFreight',
        ok: true,
        note: `${res.quote.freight.source}: £${String(res.quote.freight.toBorderGbp)} to the UK border.`,
      });
    } else {
      stages.push({ stage: 'resolveFreight', ok: false, note: res.message });
    }
  } catch (err) {
    stages.push({
      stage: 'resolveFreight',
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    });
  }

  // ---------- resolveTariff ----------
  const memo = new Map<string, Promise<LineTariff>>();
  const tariffs = await Promise.all(
    resolved.map((r) => resolveLineTariff(r.product.hsCode, deps, memo)),
  );
  const distinct = [...new Set(resolved.map((r) => r.product.hsCode))];
  const notes = await Promise.all(distinct.map((c) => resolveLineTariff(c, deps, memo)));
  stages.push({
    stage: 'resolveTariff',
    ok: notes.every((t) => t.verified),
    note: notes.map((t) => t.note).join(' '),
  });

  // ---------- compute ----------
  const lines: LineInput[] = resolved.map(({ snapshot, line }, i) =>
    productToQuoteLineSnapshot(snapshot, line.quantity, {
      tariff: tariffs[i]!.tariff,
      preferenceClaimed: line.preferenceClaimed,
      ...(line.assistsGbp !== undefined ? { assistsGbp: line.assistsGbp } : {}),
    }),
  );
  const brokerFeeTerms: BrokerFeeTermsView | null =
    input.dutyPayment === 'BROKER_DEFERMENT'
      ? resolveBrokerFeeTerms(
          { brokerFeePct: input.brokerFeePct, brokerMinimumGbp: input.brokerMinimumGbp },
          deps.pricing,
        )
      : null;
  let supplierFreight: SupplierFreightInput | null = null;
  if (DOOR_INCOTERMS.includes(input.incoterm) && input.supplierFreightTotalGbp !== undefined) {
    supplierFreight = {
      totalGbp: input.supplierFreightTotalGbp,
      postBorderGbp: input.supplierFreightUkGbp ?? null,
    };
  }
  const quoteInput: QuoteInput = {
    incoterm: input.incoterm,
    mode: lane.mode,
    // Duty origin is per line; the quote-level country is the first line's (shown on lists).
    originCountry: resolved[0]?.product.originCountry ?? 'XX',
    originPort: lane.origin,
    destinationPort: lane.destination,
    lines,
    fx: fx.fx,
    freight,
    supplierFreight,
    includeOriginFees: input.includeOriginFees,
    insurance:
      input.insurancePremiumGbp !== undefined ? { premiumGbp: input.insurancePremiumGbp } : null,
    vatRegistered: input.vatRegistered,
    vatPostponed: input.vatPostponed,
    brokerDeferment: brokerFeeTerms
      ? { feePct: brokerFeeTerms.feePct, minimumGbp: brokerFeeTerms.minimumGbp }
      : null,
    inlandVatAdjustmentGbp: deps.pricing?.inlandVatAdjustmentGbp[lane.mode] ?? null,
    asOf: now().toISOString(),
  };
  const result = computeQuote(quoteInput);
  if (!result.ok) {
    stages.push({ stage: 'compute', ok: false, note: `${result.code}: ${result.message}` });
    return { kind: 'FAILED', stage: 'compute', message: result.message, field: null };
  }
  const quote = result.quote;
  stages.push({
    stage: 'compute',
    ok: true,
    note: `${quote.status} · calc ${quote.calcVersion} · ${quote.warnings.length} warning(s).`,
  });
  const labels: QuoteLineLabel[] = resolved.map(({ product }, i) => ({
    ref: product.id,
    productId: product.id,
    sku: product.sku,
    name: product.name,
    hsDescription: tariffs[i]!.description ?? product.hsDescription,
    hsVerified: product.hsCodeVerifiedAt !== null,
    archived: product.archivedAt !== null,
  }));
  return {
    kind: 'QUOTE',
    input: quoteInput,
    view: {
      quote,
      lines: labels,
      dutyPayment: { method: input.dutyPayment, brokerFeeTerms },
      freight: { transitDays, assumptions },
      shipment: { totalWeightKg, totalVolumeCbm },
      stages,
    },
  };
};
