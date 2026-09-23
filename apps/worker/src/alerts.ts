import { log } from './log.js';
import type { AlertCode, AlertLevel, AlertSink } from './ports.js';

/** Logs alerts as structured JSON (`event: "alert"`), for log-based alerting and local runs. */
export class ConsoleAlertSink implements AlertSink {
  constructor(private readonly stream: NodeJS.WritableStream = process.stdout) {}
  alert(level: AlertLevel, code: AlertCode, message: string, meta?: Record<string, unknown>): void {
    log('alert', { level, code, message, ...(meta ? { meta } : {}) }, this.stream);
  }
}

export interface WebhookAlertSinkOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Where to report a delivery failure; defaults to a structured log line. */
  onError?: (err: unknown) => void;
}

/**
 * POSTs alerts as JSON to a webhook (`ALERT_WEBHOOK_URL`) — a PagerDuty Events v2 / OpsGenie /
 * Slack incoming-webhook bridge can sit behind it later (§7.8). 5s timeout; never throws: an
 * unreachable alert channel is logged, not allowed to fail the job that raised the alert.
 */
export class WebhookAlertSink implements AlertSink {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly url: string,
    opts: WebhookAlertSinkOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.onError =
      opts.onError ??
      ((err) =>
        log('alert.webhook_failed', {
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
  }

  async alert(
    level: AlertLevel,
    code: AlertCode,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      source: 'harbour-worker',
      level,
      code,
      message,
      meta: meta ?? {},
      at: new Date().toISOString(),
    });
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.onError(new Error(`Alert webhook responded ${res.status}`));
    } catch (err) {
      this.onError(err);
    }
  }
}
