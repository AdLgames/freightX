import { HttpError, isRetryableHttpError, withRetry, withTimeout } from '../resilience.js';
import { EORI_RE, eoriLookupResponseSchema, type IdentityCheckResult } from './schema.js';

/**
 * HMRC "Check an EORI number" API (M2, §5.6 "verify via HMRC EORI checker API on save (async
 * job, result stored)"). Public, no credentials.
 *
 *   POST https://api.service.hmrc.gov.uk/customs/eori/lookup
 *   { "eoris": ["GB123456789000"] }
 *   → [ { "eori": "GB123456789000", "valid": true, "companyDetails": { … } } ]
 *
 * 5 s timeout, 2 retries with jitter on 429/5xx/network. The EORI is never placed in an error
 * message or URL; callers log the outcome only.
 */

/** `fetch` with a body (the resilience `FetchLike` only covers GET). `globalThis.fetch` satisfies it. */
export type PostFetchLike = (
  input: string,
  init?: {
    method?: string;
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface HmrcEoriCheckerOptions {
  baseUrl?: string;
  fetch?: PostFetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const HMRC_API_BASE_URL = 'https://api.service.hmrc.gov.uk';
export const HMRC_EORI_LOOKUP_PATH = '/customs/eori/lookup';

export class HmrcEoriChecker {
  private readonly baseUrl: string;
  private readonly fetchImpl: PostFetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly now: () => Date;

  constructor(opts: HmrcEoriCheckerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? HMRC_API_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep;
    this.now = opts.now ?? (() => new Date());
  }

  async check(eori: string): Promise<IdentityCheckResult> {
    const value = eori.replace(/\s+/g, '').toUpperCase();
    if (!EORI_RE.test(value)) return { ok: false, reason: 'BAD_REQUEST' };
    const url = `${this.baseUrl}${HMRC_EORI_LOOKUP_PATH}`;
    let raw: unknown;
    try {
      raw = await withRetry(
        () =>
          withTimeout(async (signal) => {
            const res = await this.fetchImpl(url, {
              method: 'POST',
              signal,
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ eoris: [value] }),
            });
            if (!res.ok) throw new HttpError(res.status, url);
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
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return { ok: false, reason: 'BAD_REQUEST' };
      }
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    const parsed = eoriLookupResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED' };
    const item = parsed.data.find((i) => i.eori === value);
    if (!item) return { ok: false, reason: 'MALFORMED' };
    return { ok: true, valid: item.valid, checkedAt: this.now() };
  }
}
