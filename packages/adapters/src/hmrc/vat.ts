import {
  HttpError,
  isRetryableHttpError,
  withRetry,
  withTimeout,
  type FetchLike,
} from '../resilience.js';
import { VRN_RE, vatCheckResponseSchema, type IdentityCheckResult } from './schema.js';

/**
 * HMRC "Check a UK VAT number" API (M2, §5.6 "verify via HMRC VAT API; mismatch produces
 * warning, not block"). Public, no credentials.
 *
 *   GET https://api.service.hmrc.gov.uk/organisations/vat/check-vat-number/lookup/{vrn}
 *   Accept: application/vnd.hmrc.1.0+json   (documented versioned media type)
 *   → 200 { "target": { "name", "vatNumber", "address" } }   |   404 { "code": "NOT_FOUND" }
 *
 * `vrn` is the 9 (or 12) digits without the `GB` prefix; the caller passes either form. The
 * number is part of the URL, so the URL is redacted before it reaches any error message.
 */
export interface HmrcVatCheckerOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const HMRC_VAT_CHECK_PATH = '/organisations/vat/check-vat-number/lookup';
export const HMRC_ACCEPT_V1 = 'application/vnd.hmrc.1.0+json';

/** "GB123456789" / "GB 123 4567 89" / "123456789" → "123456789"; null when not a VRN. */
export const toVrn = (vatNumber: string): string | null => {
  const compact = vatNumber.replace(/\s+/g, '').toUpperCase().replace(/^GB/, '');
  return VRN_RE.test(compact) ? compact : null;
};

export class HmrcVatChecker {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly now: () => Date;

  constructor(opts: HmrcVatCheckerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.service.hmrc.gov.uk').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep;
    this.now = opts.now ?? (() => new Date());
  }

  async check(vatNumber: string): Promise<IdentityCheckResult> {
    const vrn = toVrn(vatNumber);
    if (vrn === null) return { ok: false, reason: 'BAD_REQUEST' };
    const url = `${this.baseUrl}${HMRC_VAT_CHECK_PATH}/${vrn}`;
    const redacted = `${this.baseUrl}${HMRC_VAT_CHECK_PATH}/[VRN]`;
    let raw: unknown;
    try {
      raw = await withRetry(
        () =>
          withTimeout(async (signal) => {
            const res = await this.fetchImpl(url, {
              signal,
              headers: { accept: HMRC_ACCEPT_V1 },
            });
            if (!res.ok) throw new HttpError(res.status, redacted);
            return res.json();
          }, this.timeoutMs),
        {
          retries: this.retries,
          baseDelayMs: 300,
          shouldRetry: isRetryableHttpError,
          ...(this.sleep ? { sleep: this.sleep } : {}),
        },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        // 404 NOT_FOUND is the documented "no such registration" answer: a definite result.
        if (err.status === 404) return { ok: true, valid: false, checkedAt: this.now() };
        if (err.status >= 400 && err.status < 500 && err.status !== 429) {
          return { ok: false, reason: 'BAD_REQUEST' };
        }
      }
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    const parsed = vatCheckResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED' };
    // Belt and braces: the target must be the number we asked about.
    if (parsed.data.target.vatNumber !== vrn) return { ok: false, reason: 'MALFORMED' };
    return { ok: true, valid: true, checkedAt: this.now() };
  }
}
