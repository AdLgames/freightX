import type { JobsOptions } from 'bullmq';

/** Queue names. One queue per job type so each can be paused/drained independently. */
// M6: the event-driven `stripe-events` queue is NOT in QUEUE_NAMES (no cron schedule; the web app
// enqueues, and consumes it too unless STRIPE_EVENTS_CONSUMER=worker). See jobs/stripe-events.ts.
export { STRIPE_EVENTS_QUEUE, STRIPE_EVENT_JOB_OPTIONS } from './jobs/stripe-events.js';
// end M6
export const QUEUE_NAMES = [
  'fx-refresh',
  'tariff-refresh',
  'quote-expiry',
  'document-scan', // M5: on demand (one job per completed upload, enqueued by the web app); no schedule
  // M2: on-demand identity checks enqueued by apps/web (payload { organizationId }); no cron.
  'eori-verify',
  'vat-verify',
  'vessel-poll', // M9
  'tracking-poll', // M9
  'tracking-events', // M9 (event-driven: fed by the web app's webhook route, no schedule)
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** M2: queues with no cron schedule; jobs arrive from apps/web (`JobEnqueuer`). */
export const ON_DEMAND_QUEUE_NAMES = [
  'eori-verify',
  'vat-verify',
] as const satisfies readonly QueueName[];

/** M9: queues with no repeatable schedule; jobs are added by producers (the web app). */
export const EVENT_DRIVEN_QUEUES: readonly QueueName[] = ['tracking-events'];

export const isQueueName = (s: string): s is QueueName =>
  (QUEUE_NAMES as readonly string[]).includes(s);

/** §7.8: a failed job retries 5× with exponential backoff from 30s before it is left in failed. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
} satisfies JobsOptions;

export interface RepeatableSchedule {
  /** Stable scheduler id; changing the pattern under the same id updates it in place. */
  id: string;
  /** 5-field cron, evaluated in UTC. */
  pattern: string;
  /** Job name (shows up in dashboards); defaults to the queue name. */
  jobName?: string;
}

/**
 * Schedules (all UTC):
 *   fx-refresh      06:00 daily, plus 07:00 on the 1st and 25th (§5.7). The job logic decides
 *                   what is due each run, so the schedule stays simple and idempotent.
 *   tariff-refresh  02:00 nightly (§11 item 4).
 *   quote-expiry    every hour on the hour (§5.8).
 */
export const SCHEDULES: Record<QueueName, readonly RepeatableSchedule[]> = {
  'fx-refresh': [
    { id: 'fx-refresh:daily', pattern: '0 6 * * *' },
    { id: 'fx-refresh:hmrc-publication', pattern: '0 7 1,25 * *', jobName: 'fx-refresh-hmrc' },
  ],
  'tariff-refresh': [{ id: 'tariff-refresh:nightly', pattern: '0 2 * * *' }],
  'quote-expiry': [{ id: 'quote-expiry:hourly', pattern: '0 * * * *' }],
  'document-scan': [], // M5: never repeatable; jobs carry { documentId, organizationId }
  // M2: no schedule — jobs are added by the web app (settings) when an EORI / VAT number is saved.
  'eori-verify': [],
  'vat-verify': [],
  // M9 (ADR-0017): the hourly sweep picks vessels whose nextPollAt has passed; the per-vessel
  // interval (18 h / 5 h / 1 h) lives in the job, not the schedule. tracking-poll is the 6-hourly
  // milestone fallback (brief §6.4). tracking-events has no schedule (see EVENT_DRIVEN_QUEUES).
  'vessel-poll': [{ id: 'vessel-poll:hourly', pattern: '30 * * * *' }],
  'tracking-poll': [{ id: 'tracking-poll:six-hourly', pattern: '15 */6 * * *' }],
  'tracking-events': [],
};

/** The slice of `bullmq.Queue` the scheduler needs, so tests can pass a fake. */
export interface SchedulableQueue {
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: { pattern?: string; tz?: string },
    jobTemplate?: { name?: string; data?: unknown; opts?: JobsOptions },
  ): Promise<unknown>;
}

/**
 * Registers the repeatable jobs for `name` on `queue` with `upsertJobScheduler` (BullMQ ≥ 5.16).
 * Idempotent: the same scheduler ids are upserted on every worker boot. Returns the ids.
 */
export const scheduleRepeatables = async (
  name: QueueName,
  queue: SchedulableQueue,
  opts: { jobOptions?: JobsOptions } = {},
): Promise<string[]> => {
  const ids: string[] = [];
  for (const s of SCHEDULES[name]) {
    await queue.upsertJobScheduler(
      s.id,
      { pattern: s.pattern, tz: 'UTC' },
      {
        name: s.jobName ?? name,
        data: { schedule: s.id },
        opts: opts.jobOptions ?? DEFAULT_JOB_OPTIONS,
      },
    );
    ids.push(s.id);
  }
  return ids;
};
