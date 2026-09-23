import { describe, expect, it } from 'vitest';
import { runQuoteExpiry } from '../src/jobs/quote-expiry.js';
import { InMemoryQuoteExpiryPort, type QuoteExpiryPort } from '../src/ports.js';

describe('runQuoteExpiry', () => {
  it('delegates to the port with the injected clock and returns the count', async () => {
    const seen: Date[] = [];
    const port: QuoteExpiryPort = {
      expireQuotesPastValidUntil: async (now) => {
        seen.push(now);
        return 7;
      },
    };
    const now = new Date('2026-09-23T13:00:00Z');
    const summary = await runQuoteExpiry({ port, now: () => now });
    expect(summary).toEqual({ expired: 7, asOf: '2026-09-23T13:00:00.000Z' });
    expect(seen).toEqual([now]);
  });

  it('reference port: expires READY/INDICATIVE/DRAFT past validUntil, never ACCEPTED', async () => {
    const past = new Date('2026-09-01T00:00:00Z');
    const future = new Date('2026-12-01T00:00:00Z');
    const port = new InMemoryQuoteExpiryPort([
      { id: 'a', status: 'READY', validUntil: past },
      { id: 'b', status: 'INDICATIVE', validUntil: past },
      { id: 'c', status: 'DRAFT', validUntil: past },
      { id: 'd', status: 'ACCEPTED', validUntil: past },
      { id: 'e', status: 'READY', validUntil: future },
      { id: 'f', status: 'CANCELLED', validUntil: past },
      { id: 'g', status: 'EXPIRED', validUntil: past },
    ]);
    const summary = await runQuoteExpiry({ port, now: () => new Date('2026-09-23T13:00:00Z') });
    expect(summary.expired).toBe(3);
    expect(port.quotes.map((q) => q.status)).toEqual([
      'EXPIRED',
      'EXPIRED',
      'EXPIRED',
      'ACCEPTED',
      'READY',
      'CANCELLED',
      'EXPIRED',
    ]);
    // Second run is a no-op.
    expect((await runQuoteExpiry({ port, now: () => new Date() })).expired).toBe(0);
  });
});
