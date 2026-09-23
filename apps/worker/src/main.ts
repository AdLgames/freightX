#!/usr/bin/env node
/**
 * Worker process entry point.
 *
 *   node dist/main.js                 # long-running: BullMQ workers + schedulers + /healthz
 *   node dist/main.js --once <queue>  # run one job inline, no Redis (local dev, runbooks)
 *
 * Env: REDIS_URL (required unless --once), ALERT_WEBHOOK_URL, WORKER_PORT (default 9090),
 * TARIFF_REFRESH_CODES. See README.md.
 */
import { createServer, type Server } from 'node:http';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { errorFields, log } from './log.js';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  isQueueName,
  scheduleRepeatables,
  type QueueName,
} from './queues.js';
import { buildWiring, readEnv, type JobSummary } from './wiring.server.js';

interface LastRun {
  at: string;
  status: 'completed' | 'failed';
  jobId: string | undefined;
  summary?: JobSummary;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  startedAt: string;
  queues: Array<{ name: QueueName; lastRun: LastRun | null }>;
}

const parseArgs = (argv: readonly string[]): { once?: string; onceData?: string } => {
  const i = argv.indexOf('--once');
  if (i < 0) return {};
  const value = argv[i + 1];
  // M5: an optional JSON payload after the queue name (on-demand jobs such as document-scan)
  const onceData = argv[i + 2];
  return { once: value ?? '', ...(onceData !== undefined ? { onceData } : {}) };
};

const runOnce = async (queueName: string, onceData?: string): Promise<number> => {
  if (!isQueueName(queueName)) {
    process.stderr.write(
      `Unknown queue "${queueName}". Expected one of: ${QUEUE_NAMES.join(', ')}\n`,
    );
    return 2;
  }
  const env = readEnv();
  const wiring = buildWiring(env);
  log('job.started', { queue: queueName, mode: 'once' });
  try {
    // M5: on-demand jobs take their payload from the command line
    const data: unknown = onceData === undefined ? undefined : JSON.parse(onceData);
    const summary = await wiring.runJob(queueName, data);
    log('job.completed', { queue: queueName, mode: 'once', summary });
    return 0;
  } catch (err) {
    log('job.failed', { queue: queueName, mode: 'once', ...errorFields(err) });
    return 1;
  }
};

const startHealthServer = (port: number, report: () => HealthReport): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
        const body = JSON.stringify(report());
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });

const startWorker = async (): Promise<void> => {
  const env = readEnv();
  if (!env.REDIS_URL) {
    process.stderr.write(
      'REDIS_URL is not set. The worker needs Redis for BullMQ (e.g. redis://localhost:6379).\n' +
        'To run a single job without Redis use: node dist/main.js --once <fx-refresh|tariff-refresh|quote-expiry>\n' +
        // M5
        '  (document-scan takes the payload as JSON: --once document-scan \'{"documentId":"…","organizationId":"…"}\')\n',
    );
    process.exit(1);
  }
  const startedAt = new Date().toISOString();
  const wiring = buildWiring(env);
  const lastRuns = new Map<QueueName, LastRun>();

  // BullMQ requires maxRetriesPerRequest: null so blocking commands are not cut short.
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connection.on('error', (err) => log('redis.error', errorFields(err)));

  const queues = new Map<QueueName, Queue>();
  const workers: Worker[] = [];
  for (const name of QUEUE_NAMES) {
    const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, queue);
    const ids = await scheduleRepeatables(name, queue);
    log('scheduler.registered', { queue: name, schedulers: ids });

    const worker = new Worker(
      name,
      async (job: Job) => {
        log('job.started', {
          queue: name,
          jobId: job.id,
          jobName: job.name,
          attempt: job.attemptsMade + 1,
        });
        return wiring.runJob(name, job.data); // M5: on-demand queues (document-scan) need the job data
      },
      { connection, concurrency: 1 },
    );
    worker.on('completed', (job, result: JobSummary) => {
      lastRuns.set(name, {
        at: new Date().toISOString(),
        status: 'completed',
        jobId: job.id,
        summary: result,
      });
      log('job.completed', { queue: name, jobId: job.id, summary: result });
    });
    worker.on('failed', (job, err) => {
      const attempt = job?.attemptsMade ?? 0;
      const attempts = job?.opts.attempts ?? 1;
      lastRuns.set(name, {
        at: new Date().toISOString(),
        status: 'failed',
        jobId: job?.id,
        error: err.message,
      });
      log('job.failed', { queue: name, jobId: job?.id, attempt, attempts, ...errorFields(err) });
      if (attempt >= attempts) {
        void wiring.ports.alerts.alert(
          'critical',
          'JOB_FAILED',
          `${name} job exhausted its ${attempts} attempts`,
          {
            queue: name,
            jobId: job?.id,
            error: err.message,
          },
        );
      }
    });
    worker.on('error', (err) => log('worker.error', { queue: name, ...errorFields(err) }));
    workers.push(worker);
  }

  const report = (): HealthReport => ({
    ok: true,
    startedAt,
    queues: QUEUE_NAMES.map((name) => ({ name, lastRun: lastRuns.get(name) ?? null })),
  });
  const server = await startHealthServer(env.WORKER_PORT, report);
  log('worker.started', { queues: [...QUEUE_NAMES], port: env.WORKER_PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('worker.stopping', { signal });
    const forceExit = setTimeout(() => {
      log('worker.force_exit', { signal });
      process.exit(1);
    }, 30_000);
    forceExit.unref();
    try {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await connection.quit();
      log('worker.stopped', { signal });
      process.exit(0);
    } catch (err) {
      log('worker.stop_failed', { signal, ...errorFields(err) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.once !== undefined) {
    process.exitCode = await runOnce(args.once, args.onceData); // M5: optional payload
    return;
  }
  await startWorker();
};

main().catch((err: unknown) => {
  log('worker.crashed', errorFields(err));
  process.exit(1);
});
