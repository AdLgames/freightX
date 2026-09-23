import type { QuoteExpiryPort } from '../ports.js';

/**
 * Hourly quote expiry (§5.8, §8 "stale freight price used"). All the rules live in the port
 * (only READY/INDICATIVE/DRAFT past `validUntil` become EXPIRED; ACCEPTED is never touched) so
 * they are enforced in one SQL statement; this job just runs it and reports the count.
 */
export interface QuoteExpiryDeps {
  port: QuoteExpiryPort;
  now: () => Date;
}

export interface QuoteExpirySummary {
  expired: number;
  asOf: string;
}

export const runQuoteExpiry = async (deps: QuoteExpiryDeps): Promise<QuoteExpirySummary> => {
  const now = deps.now();
  const expired = await deps.port.expireQuotesPastValidUntil(now);
  return { expired, asOf: now.toISOString() };
};
