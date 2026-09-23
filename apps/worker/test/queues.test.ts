import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  SCHEDULES,
  isQueueName,
  scheduleRepeatables,
  type SchedulableQueue,
} from '../src/queues.js';

interface Call {
  id: string;
  repeat: { pattern?: string; tz?: string };
  template: { name?: string; data?: unknown; opts?: unknown } | undefined;
}

const fakeQueue = () => {
  const calls: Call[] = [];
  const queue: SchedulableQueue = {
    upsertJobScheduler: async (id, repeat, template) => {
      calls.push({ id, repeat, template });
      return { id };
    },
  };
  return { queue, calls };
};

describe('scheduleRepeatables', () => {
  it('registers fx-refresh daily at 06:00 UTC plus 07:00 on the 1st and 25th', async () => {
    const { queue, calls } = fakeQueue();
    const ids = await scheduleRepeatables('fx-refresh', queue);
    expect(ids).toEqual(['fx-refresh:daily', 'fx-refresh:hmrc-publication']);
    expect(calls.map((c) => c.repeat)).toEqual([
      { pattern: '0 6 * * *', tz: 'UTC' },
      { pattern: '0 7 1,25 * *', tz: 'UTC' },
    ]);
    for (const c of calls) {
      expect(c.template?.opts).toEqual({
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    }
  });

  it('registers tariff-refresh nightly at 02:00 and quote-expiry hourly', async () => {
    const t = fakeQueue();
    await scheduleRepeatables('tariff-refresh', t.queue);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      id: 'tariff-refresh:nightly',
      repeat: { pattern: '0 2 * * *', tz: 'UTC' },
      template: { name: 'tariff-refresh', opts: DEFAULT_JOB_OPTIONS },
    });

    const q = fakeQueue();
    await scheduleRepeatables('quote-expiry', q.queue);
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]).toMatchObject({
      id: 'quote-expiry:hourly',
      repeat: { pattern: '0 * * * *', tz: 'UTC' },
    });
  });

  it('every queue has at least one schedule with a stable, queue-prefixed id', () => {
    for (const name of QUEUE_NAMES) {
      // M5: document-scan is on demand (enqueued per upload by the web app), never repeatable.
      if (name === 'document-scan') {
        expect(SCHEDULES[name]).toEqual([]);
        continue;
      }
      expect(SCHEDULES[name].length).toBeGreaterThan(0);
      for (const s of SCHEDULES[name]) expect(s.id.startsWith(`${name}:`)).toBe(true);
    }
    expect(isQueueName('fx-refresh')).toBe(true);
    expect(isQueueName('nope')).toBe(false);
  });
});
