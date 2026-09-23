/**
 * Persistence and alerting ports the worker needs (§3, §5.7, §5.8, §7.8).
 *
 * `@harbour/db` (Prisma) is built separately; the worker does not depend on it at typecheck
 * time. These are the *only* shapes the jobs know about, so `wiring.server.ts` can swap the
 * in-memory implementations for Prisma-backed ones without touching job logic.
 */
import type { FxRateStore } from '@harbour/adapters';

export type { FxRateRecord, FxRateStore, TariffCacheStore } from '@harbour/adapters';

/**
 * Hourly quote expiry (§5.8 "Cron expires quotes hourly", §5.9 status rules).
 *
 * Contract: `expireQuotesPastValidUntil(now)` moves quotes whose `validUntil < now` AND whose
 * status is one of `READY`, `INDICATIVE` or `DRAFT` to `EXPIRED`, and returns how many rows it
 * changed. It must NEVER touch `ACCEPTED` quotes (they are immutable; the Postgres trigger
 * only allows `ACCEPTED → CANCELLED | EXPIRED` by an explicit user/ops action, not by this
 * sweep), nor `CANCELLED` or already-`EXPIRED` rows. A Prisma implementation is one
 * `updateMany` with `where: { validUntil: { lt: now }, status: { in: [...] } }`.
 */
export interface QuoteExpiryPort {
  expireQuotesPastValidUntil(now: Date): Promise<number>;
}

export const EXPIRABLE_QUOTE_STATUSES = ['READY', 'INDICATIVE', 'DRAFT'] as const;
export type ExpirableQuoteStatus = (typeof EXPIRABLE_QUOTE_STATUSES)[number];
export type QuoteStatus = ExpirableQuoteStatus | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED';

export interface InMemoryQuote {
  id: string;
  status: QuoteStatus;
  validUntil: Date;
}

/** Reference implementation of the expiry rule, used by tests and `--once` runs. */
export class InMemoryQuoteExpiryPort implements QuoteExpiryPort {
  constructor(public readonly quotes: InMemoryQuote[] = []) {}

  async expireQuotesPastValidUntil(now: Date): Promise<number> {
    let changed = 0;
    for (const q of this.quotes) {
      const expirable = (EXPIRABLE_QUOTE_STATUSES as readonly string[]).includes(q.status);
      if (expirable && q.validUntil.getTime() < now.getTime()) {
        q.status = 'EXPIRED';
        changed += 1;
      }
    }
    return changed;
  }
}

/**
 * Which commodity codes the nightly tariff refresh warms (§11 item 4). Phase 1: every distinct
 * `Product.hsCode`; Phase 0: the `TARIFF_REFRESH_CODES` env list.
 */
export interface HsCodeSource {
  listActiveHsCodes(): Promise<string[]>;
}

export class StaticHsCodeSource implements HsCodeSource {
  private readonly codes: string[];
  constructor(codes: readonly string[]) {
    this.codes = Array.from(new Set(codes.map((c) => c.trim()).filter((c) => c !== '')));
  }
  async listActiveHsCodes(): Promise<string[]> {
    return [...this.codes];
  }
}

export type AlertLevel = 'info' | 'warning' | 'critical';

/**
 * Alert codes raised by the worker (§7.8 "tariff or FX job failed"). Keep this list in sync with
 * `docs/runbooks/tariff-or-fx-job-failed.md`.
 */
export type AlertCode =
  | 'FX_HMRC_MISSING'
  | 'FX_HMRC_FETCH_FAILED'
  | 'FX_HMRC_PARSE_FAILED'
  | 'FX_ECB_FETCH_FAILED'
  | 'FX_ECB_PARSE_FAILED'
  | 'TARIFF_REFRESH_DEGRADED'
  | 'JOB_FAILED'
  // M5: document-scan job — a scanner rejected an upload (warning; the object is already deleted)
  | 'DOCUMENT_MALWARE_FOUND';

export interface AlertSink {
  alert(
    level: AlertLevel,
    code: AlertCode,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> | void;
}

export interface AlertRecord {
  level: AlertLevel;
  code: AlertCode;
  message: string;
  meta?: Record<string, unknown>;
}

/** Records alerts in memory; used by tests and to count alerts per job run. */
export class CollectingAlertSink implements AlertSink {
  readonly alerts: AlertRecord[] = [];
  alert(level: AlertLevel, code: AlertCode, message: string, meta?: Record<string, unknown>): void {
    this.alerts.push(
      meta === undefined ? { level, code, message } : { level, code, message, meta },
    );
  }
}

/** Fans one alert out to several sinks; a failing sink never blocks the others. */
export class CompositeAlertSink implements AlertSink {
  constructor(private readonly sinks: readonly AlertSink[]) {}
  async alert(
    level: AlertLevel,
    code: AlertCode,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all(
      this.sinks.map(async (s) => {
        try {
          await s.alert(level, code, message, meta);
        } catch {
          // A broken alert channel must not fail the job; ConsoleAlertSink is always wired too.
        }
      }),
    );
  }
}

/** Everything a job run needs from the outside world. */
export interface WorkerPorts {
  fxStore: FxRateStore;
  quoteExpiry: QuoteExpiryPort;
  hsCodes: HsCodeSource;
  alerts: AlertSink;
}
