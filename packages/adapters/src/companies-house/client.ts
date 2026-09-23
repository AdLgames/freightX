import {
  HttpError,
  isRetryableHttpError,
  withRetry,
  withTimeout,
  type FetchLike,
} from '../resilience.js';
import {
  COMPANY_NUMBER_RE,
  companyProfileSchema,
  companySearchResponseSchema,
  profileToCompanyMatch,
  toCompanyMatch,
  type CompanyMatch,
} from './schema.js';

/**
 * Companies House Public Data API client (M2, ADR-0015).
 *
 *   GET https://api.company-information.service.gov.uk/search/companies?q=<name>&items_per_page=5
 *   GET https://api.company-information.service.gov.uk/company/<number>
 *
 * Authentication is HTTP Basic with the API key as the username and an empty password
 * (`COMPANIES_HOUSE_API_KEY`). 5 s timeout, 2 retries with jitter on 429/5xx/network, none on
 * other 4xx. Responses are zod-validated; a shape change is `MALFORMED`, never a crash. The
 * client never logs; the query (an organisation name) and the key stay out of errors.
 */
export interface CompaniesHouseClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type CompanyLookupFailure = 'UNAVAILABLE' | 'MALFORMED' | 'UNAUTHORISED' | 'NOT_FOUND';

export type CompanySearchResult =
  | { ok: true; matches: CompanyMatch[] }
  | { ok: false; reason: Exclude<CompanyLookupFailure, 'NOT_FOUND'> };

export type CompanyProfileResult =
  { ok: true; company: CompanyMatch } | { ok: false; reason: CompanyLookupFailure };

export const COMPANIES_HOUSE_BASE_URL = 'https://api.company-information.service.gov.uk';
export const COMPANY_SEARCH_MAX_ITEMS = 5;

/** `Basic base64(key + ':')` — the documented scheme (key as username, empty password). */
export const basicAuthHeader = (apiKey: string): string =>
  `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;

export class CompaniesHouseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly authorization: string;

  constructor(opts: CompaniesHouseClientOptions) {
    if (!opts.apiKey) throw new Error('CompaniesHouseClient needs an API key');
    this.baseUrl = (opts.baseUrl ?? COMPANIES_HOUSE_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep;
    this.authorization = basicAuthHeader(opts.apiKey);
  }

  /** GET with auth/retry/timeout. Throws HttpError on non-2xx (with a redacted URL). */
  private async getJson(path: string, redactedPath: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const redacted = `${this.baseUrl}${redactedPath}`;
    return withRetry(
      () =>
        withTimeout(async (signal) => {
          const res = await this.fetchImpl(url, {
            signal,
            headers: { authorization: this.authorization, accept: 'application/json' },
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
  }

  private static failure(err: unknown): Exclude<CompanyLookupFailure, 'MALFORMED'> {
    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) return 'UNAUTHORISED';
      if (err.status === 404) return 'NOT_FOUND';
    }
    return 'UNAVAILABLE';
  }

  /** Best matches for an organisation name (at most `COMPANY_SEARCH_MAX_ITEMS`). */
  async searchCompanies(query: string): Promise<CompanySearchResult> {
    const q = query.trim();
    if (q === '') return { ok: true, matches: [] };
    const params = new URLSearchParams({
      q,
      items_per_page: String(COMPANY_SEARCH_MAX_ITEMS),
    });
    let raw: unknown;
    try {
      raw = await this.getJson(
        `/search/companies?${params.toString()}`,
        '/search/companies?q=[REDACTED]',
      );
    } catch (err) {
      const reason = CompaniesHouseClient.failure(err);
      // A 404 on the search endpoint is a routing problem on our side, not "no results".
      return { ok: false, reason: reason === 'NOT_FOUND' ? 'UNAVAILABLE' : reason };
    }
    const parsed = companySearchResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED' };
    return {
      ok: true,
      matches: parsed.data.items.slice(0, COMPANY_SEARCH_MAX_ITEMS).map(toCompanyMatch),
    };
  }

  /** The company profile by number — what the app stores after the user confirms a match. */
  async getCompany(companyNumber: string): Promise<CompanyProfileResult> {
    const number = companyNumber.trim().toUpperCase();
    if (!COMPANY_NUMBER_RE.test(number)) return { ok: false, reason: 'NOT_FOUND' };
    let raw: unknown;
    try {
      raw = await this.getJson(`/company/${encodeURIComponent(number)}`, '/company/[NUMBER]');
    } catch (err) {
      return { ok: false, reason: CompaniesHouseClient.failure(err) };
    }
    const parsed = companyProfileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'MALFORMED' };
    return { ok: true, company: profileToCompanyMatch(parsed.data) };
  }
}
