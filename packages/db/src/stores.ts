import type {
  FxRateRecord,
  FxRateStore,
  NormalisedCommodity,
  TariffCacheStore,
} from '@harbour/adapters';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/client/index.js';

/**
 * Prisma-backed implementations of the persistence seams the web app and the adapters define:
 * `TariffCacheStore` and `FxRateStore` (from @harbour/adapters) and the web app's
 * `EmailSignupRepository` (structurally identical interface below).
 *
 * All three tables are global, not tenant data: `TariffCache`, `FxRate` and `EmailSignup` are in
 * PASSTHROUGH_MODELS (src/tenancy.ts) and have no RLS (migration 0002), so these stores take the
 * plain `PrismaClient` and need no `withOrgTransaction`.
 */

// ---------- Tariff cache ----------

/**
 * `tariff_cache` is keyed by (hs_code, origin_country) but the adapters' `TariffCacheStore` is keyed
 * by commodity code only: the cached `NormalisedCommodity` holds the measures for ALL origins and
 * the engine filters them by the line's origin. Rows written through this store therefore use
 * this origin wildcard. The column stays available for a future per-origin cache.
 */
export const TARIFF_CACHE_ANY_ORIGIN = '*';

const stringList = z.array(z.string()).readonly();

/** Mirrors `NormalisedCommodity` / engine `RawTariffMeasure`; what we read back is validated. */
export const normalisedCommoditySchema = z.object({
  code: z.string().min(1),
  description: z.string(),
  declarable: z.boolean(),
  measures: z.array(
    z.object({
      sid: z.string(),
      measureTypeId: z.string(),
      dutyExpression: z.string(),
      geographicalAreaId: z.string(),
      geographicalAreaMembers: stringList.exactOptional(),
      excludedCountries: stringList.exactOptional(),
      additionalCode: z.string().nullable().exactOptional(),
      effectiveStartDate: z.string().nullable().exactOptional(),
      effectiveEndDate: z.string().nullable().exactOptional(),
    }),
  ),
});

// Compile-time guard: the schema and the adapters' type must describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesNormalisedCommodity: Same<
  z.infer<typeof normalisedCommoditySchema>,
  NormalisedCommodity
> = true;
void schemaMatchesNormalisedCommodity;

export interface PrismaTariffCacheStoreOptions {
  /** Called when a row fails validation (treated as a miss). Receives the code and zod issue paths only. */
  onCorruptRow?: (info: { hsCode: string; issues: string[] }) => void;
}

/**
 * `TariffCache` over Prisma. TTL is the caller's decision (`UkTradeTariffClient` uses 24h, §5.2):
 * `get` returns the row whatever its `expiresAt`, exactly like the in-memory cache, and the client
 * compares `expiresAt` itself.
 */
export class PrismaTariffCacheStore implements TariffCacheStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PrismaTariffCacheStoreOptions = {},
  ) {}

  async get(
    code: string,
  ): Promise<{ value: NormalisedCommodity; fetchedAt: Date; expiresAt: Date } | null> {
    const row = await this.prisma.tariffCache.findUnique({
      where: { hsCode_originCountry: { hsCode: code, originCountry: TARIFF_CACHE_ANY_ORIGIN } },
    });
    if (!row) return null;
    const parsed = normalisedCommoditySchema.safeParse(row.payload);
    if (!parsed.success) {
      this.options.onCorruptRow?.({
        hsCode: code,
        issues: parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
      });
      return null; // a corrupt row is a miss: the client refetches and overwrites it
    }
    return { value: parsed.data, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt };
  }

  async set(
    code: string,
    value: NormalisedCommodity,
    fetchedAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    // Validate on the way in too, so nothing the reader would reject is ever stored.
    const payload = normalisedCommoditySchema.parse(value) as Prisma.InputJsonValue;
    await this.prisma.tariffCache.upsert({
      where: { hsCode_originCountry: { hsCode: code, originCountry: TARIFF_CACHE_ANY_ORIGIN } },
      create: {
        hsCode: code,
        originCountry: TARIFF_CACHE_ANY_ORIGIN,
        fetchedAt,
        expiresAt,
        payload,
      },
      update: { fetchedAt, expiresAt, payload },
    });
  }
}

// ---------- FX rates ----------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Positive decimal with at most 6 dp — the precision of `fx_rates.rate_to_gbp` (Decimal(14,6)). */
const RATE_RE = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;

/** `YYYY-MM-DD` → that day's UTC midnight. Rejects impossible dates (e.g. 2026-02-30). */
export function isoDateToUtcMidnight(isoDate: string): Date {
  const m = ISO_DATE_RE.exec(isoDate);
  if (!m) throw new RangeError(`expected YYYY-MM-DD, got ${JSON.stringify(isoDate)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== isoDate) {
    throw new RangeError(`not a calendar date: ${isoDate}`);
  }
  return d;
}

/** Date → `YYYY-MM-DD` of its UTC calendar day. */
export const utcIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Start (00:00:00.000 UTC) of the UTC calendar day containing `at`. */
export const startOfUtcDay = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** Validates one record and converts it to row values. Throws on anything malformed. */
export function fxRecordToRow(rec: FxRateRecord): {
  source: string;
  currency: string;
  rateToGbp: Prisma.Decimal;
  validFrom: Date;
  validTo: Date;
} {
  if (!/^[A-Z]{3}$/.test(rec.currency)) {
    throw new RangeError(
      `currency must be ISO 4217 upper-case, got ${JSON.stringify(rec.currency)}`,
    );
  }
  if (!RATE_RE.test(rec.rateToGbp) || new Prisma.Decimal(rec.rateToGbp).lte(0)) {
    throw new RangeError(
      `rateToGbp must be a positive decimal string with at most 6 dp (${rec.currency})`,
    );
  }
  const validFrom = isoDateToUtcMidnight(rec.validFrom);
  const validTo = isoDateToUtcMidnight(rec.validTo);
  if (validTo < validFrom) {
    throw new RangeError(`validTo before validFrom (${rec.source} ${rec.currency})`);
  }
  return {
    source: rec.source,
    currency: rec.currency,
    rateToGbp: new Prisma.Decimal(rec.rateToGbp),
    validFrom,
    validTo,
  };
}

const FX_SOURCES = new Set<string>(['HMRC_MONTHLY', 'ECB', 'MANUAL']);

/**
 * `FxRate` over Prisma (§5.7).
 *
 * Dates: `validFrom`/`validTo` are calendar days (`YYYY-MM-DD`). Both are stored as that day's UTC
 * midnight, and `validTo` is INCLUSIVE of its whole day: `find` matches when
 * `validFrom <= at` and `validTo >= startOfUtcDay(at)`, so an HMRC rate "valid to 2026-09-30" still
 * applies at 2026-09-30T23:59Z. Stored values round-trip to the same strings.
 *
 * Rates are decimal strings end to end (`Prisma.Decimal` in between, never `number`). `find`
 * returns `Decimal.toString()`, i.e. the numeric value without padding ("0.7912", not "0.791200").
 */
export class PrismaFxRateStore implements FxRateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async find(
    source: FxRateRecord['source'],
    currency: string,
    at: Date,
  ): Promise<FxRateRecord | null> {
    const row = await this.prisma.fxRate.findFirst({
      where: {
        source,
        currency,
        validFrom: { lte: at },
        validTo: { gte: startOfUtcDay(at) },
      },
      orderBy: { validFrom: 'desc' },
    });
    if (!row) return null;
    if (!FX_SOURCES.has(row.source)) return null; // not a source the engine knows; never guess
    return {
      source: row.source as FxRateRecord['source'],
      currency: row.currency,
      rateToGbp: row.rateToGbp.toString(),
      validFrom: utcIsoDate(row.validFrom),
      validTo: utcIsoDate(row.validTo),
    };
  }

  /** Idempotent on (source, currency, validFrom); all-or-nothing in one transaction. */
  async upsert(records: readonly FxRateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map(fxRecordToRow); // validate everything before touching the DB
    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.fxRate.upsert({
          where: {
            source_currency_validFrom: {
              source: row.source,
              currency: row.currency,
              validFrom: row.validFrom,
            },
          },
          create: row,
          update: { rateToGbp: row.rateToGbp, validTo: row.validTo },
        }),
      ),
    );
  }
}

// ---------- Email signups ----------

/** Same shape as the web app's `EmailSignupRecord` (apps/web/app/services/signup-repository.server.ts). */
export interface EmailSignupInput {
  email: string;
  source: string | null;
  createdAt: Date;
}

/** `email_signups.source` is NOT NULL; a signup without a known surface is stored with this value. */
export const SIGNUP_SOURCE_UNKNOWN = 'unknown';

/**
 * `EmailSignup` over Prisma, matching the web app's `EmailSignupRepository`: `add` is idempotent on
 * email — a duplicate is a no-op returning `created: false` (single `INSERT ... ON CONFLICT DO
 * NOTHING`, so concurrent duplicates cannot race into an error). The email is stored as given;
 * the web validator already trims and lower-cases it.
 */
export class PrismaEmailSignupRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async add(record: EmailSignupInput): Promise<{ created: boolean }> {
    const { count } = await this.prisma.emailSignup.createMany({
      data: [
        {
          email: record.email,
          source: record.source ?? SIGNUP_SOURCE_UNKNOWN,
          createdAt: record.createdAt,
        },
      ],
      skipDuplicates: true,
    });
    return { created: count === 1 };
  }

  async count(): Promise<number> {
    return this.prisma.emailSignup.count();
  }
}
