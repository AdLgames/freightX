import { Decimal } from 'decimal.js';
import type { LineInput, TariffInput } from '@harbour/engine';

/**
 * Catalogue → quote line (M3, used by the M4 quote builder). Quotes are immutable snapshots
 * (brief §1): a line COPIES the product's HS code, origin, value, currency, weight and volume at
 * the time it is added; editing the product later never changes an existing quote.
 *
 * Structural input so the function works on a Prisma `Product` row (Decimal fields) and on plain
 * test objects alike. Money and measures come out as canonical decimal strings (ADR-0003).
 */

export type DecimalLike = string | { toString(): string };

export interface SnapshotProduct {
  id: string;
  hsCode: string;
  /** null = user-entered, unverified → the engine emits HS_UNVERIFIED (blocking). */
  hsCodeVerifiedAt: Date | string | null;
  originCountry: string;
  unitValue: DecimalLike;
  currency: string;
  weightKg: DecimalLike;
  volumeCbm: DecimalLike;
}

export interface SnapshotOptions {
  /** Resolved tariff for the line; default marks it unresolved so the engine fails closed. */
  tariff?: TariffInput;
  preferenceClaimed?: boolean;
  /** Assists apportioned to this line, GBP (ADR-0011). */
  assistsGbp?: string;
}

const MAX_QUANTITY = 1_000_000;

const canonical = (value: DecimalLike, what: string): string => {
  const d = new Decimal(String(value));
  if (!d.isFinite() || d.isNegative())
    throw new RangeError(`${what} must be a non-negative decimal`);
  return d.toString();
};

export const TARIFF_NOT_RESOLVED: TariffInput = {
  kind: 'UNAVAILABLE',
  reason: 'Tariff not resolved for this line yet.',
};

export const productToQuoteLineSnapshot = (
  product: SnapshotProduct,
  quantity: number,
  opts: SnapshotOptions = {},
): LineInput => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new RangeError(`quantity must be an integer between 1 and ${MAX_QUANTITY}`);
  }
  const line: LineInput = {
    ref: product.id,
    hsCode: product.hsCode,
    hsCodeVerified: product.hsCodeVerifiedAt !== null && product.hsCodeVerifiedAt !== undefined,
    originCountry: product.originCountry,
    quantity,
    unitValue: canonical(product.unitValue, 'unitValue'),
    currency: product.currency,
    unitWeightKg: canonical(product.weightKg, 'weightKg'),
    unitVolumeCbm: canonical(product.volumeCbm, 'volumeCbm'),
    preferenceClaimed: opts.preferenceClaimed ?? false,
    tariff: opts.tariff ?? TARIFF_NOT_RESOLVED,
  };
  if (opts.assistsGbp !== undefined) line.assistsGbp = canonical(opts.assistsGbp, 'assistsGbp');
  return line;
};
