import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.server';
import {
  BullmqJobEnqueuer,
  JOB_OPTIONS,
  MemoryJobEnqueuer,
  createJobEnqueuer,
  type AddableQueue,
} from './jobs.server';

const captureLogger = () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (l) => logs.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { logger, logs };
};

describe('MemoryJobEnqueuer', () => {
  it('records the job, warns that nothing will run it, and resolves false', async () => {
    const { logger, logs } = captureLogger();
    const jobs = new MemoryJobEnqueuer(logger);
    const organizationId = randomUUID();
    expect(await jobs.enqueue('eori-verify', { organizationId })).toBe(false);
    expect(jobs.enqueued).toEqual([{ queue: 'eori-verify', payload: { organizationId } }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      event: 'jobs.enqueue_skipped',
      queue: 'eori-verify',
      orgId: organizationId,
    });
  });
});

describe('BullmqJobEnqueuer', () => {
  it('opens each queue once, adds with the worker job options, and never throws', async () => {
    const { logger, logs } = captureLogger();
    const opened: string[] = [];
    const added: Array<{ queue: string; name: string; data: unknown; opts: unknown }> = [];
    const jobs = new BullmqJobEnqueuer(async (name) => {
      opened.push(name);
      const queue: AddableQueue = {
        add: async (jobName, data, opts) => {
          added.push({ queue: name, name: jobName, data, opts });
          return { id: '1' };
        },
      };
      return queue;
    }, logger);
    const organizationId = randomUUID();
    expect(await jobs.enqueue('eori-verify', { organizationId })).toBe(true);
    expect(await jobs.enqueue('eori-verify', { organizationId })).toBe(true);
    expect(await jobs.enqueue('vat-verify', { organizationId })).toBe(true);
    expect(opened).toEqual(['eori-verify', 'vat-verify']);
    expect(added).toHaveLength(3);
    expect(added[0]).toEqual({
      queue: 'eori-verify',
      name: 'eori-verify',
      data: { organizationId },
      opts: JOB_OPTIONS,
    });
    expect(JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    expect(logs.map((l) => l.event)).toEqual(['jobs.enqueued', 'jobs.enqueued', 'jobs.enqueued']);
  });

  it('a queue failure is logged (no URL, no secret) and reported as false; the queue is reopened next time', async () => {
    const { logger, logs } = captureLogger();
    let attempts = 0;
    const jobs = new BullmqJobEnqueuer(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect ECONNREFUSED redis://:hunter2@redis:6379');
      return { add: async () => ({}) };
    }, logger);
    const organizationId = randomUUID();
    expect(await jobs.enqueue('eori-verify', { organizationId })).toBe(false);
    expect(logs[0]).toMatchObject({
      level: 'error',
      event: 'jobs.enqueue_failed',
      queue: 'eori-verify',
    });
    expect(await jobs.enqueue('eori-verify', { organizationId })).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('createJobEnqueuer', () => {
  it('picks BullMQ only when REDIS_URL is set', () => {
    const { logger } = captureLogger();
    expect(createJobEnqueuer(undefined, logger).backend).toBe('memory');
    expect(createJobEnqueuer('redis://localhost:6379', logger).backend).toBe('bullmq');
  });
});
