/**
 * Runs only when REDIS_URL is set (CI provides a redis:7 service). Enqueues one quote-expiry job
 * on an isolated key prefix, processes it with a real BullMQ Worker and checks the result.
 */
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runQuoteExpiry, type QuoteExpirySummary } from '../src/jobs/quote-expiry.js';
import { InMemoryQuoteExpiryPort } from '../src/ports.js';
import { DEFAULT_JOB_OPTIONS, scheduleRepeatables } from '../src/queues.js';

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('quote-expiry on a real BullMQ queue', () => {
  const prefix = `harbour-test-${randomUUID().slice(0, 8)}`;
  let connection: Redis;
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker;

  const port = new InMemoryQuoteExpiryPort([
    { id: 'a', status: 'READY', validUntil: new Date('2026-01-01T00:00:00Z') },
    { id: 'b', status: 'ACCEPTED', validUntil: new Date('2026-01-01T00:00:00Z') },
  ]);

  beforeAll(async () => {
    connection = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue('quote-expiry', {
      connection,
      prefix,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    events = new QueueEvents('quote-expiry', { connection: connection.duplicate(), prefix });
    await events.waitUntilReady();
    worker = new Worker(
      'quote-expiry',
      async () => runQuoteExpiry({ port, now: () => new Date('2026-09-23T13:00:00Z') }),
      { connection: connection.duplicate(), prefix },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  it('processes an enqueued job and returns the expiry summary', async () => {
    const job = await queue.add('quote-expiry', { schedule: 'manual' });
    const result = (await job.waitUntilFinished(events, 15_000)) as QuoteExpirySummary;
    expect(result).toEqual({ expired: 1, asOf: '2026-09-23T13:00:00.000Z' });
    expect(port.quotes.map((q) => q.status)).toEqual(['EXPIRED', 'ACCEPTED']);
    expect(job.opts.attempts).toBe(5);
  }, 20_000);

  it('registers the repeatable scheduler idempotently', async () => {
    const ids1 = await scheduleRepeatables('quote-expiry', queue);
    const ids2 = await scheduleRepeatables('quote-expiry', queue);
    expect(ids1).toEqual(ids2);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(['quote-expiry:hourly']);
    expect(schedulers[0]?.pattern).toBe('0 * * * *');
  });
});
