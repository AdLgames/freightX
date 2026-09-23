import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Env } from './env.server';
import type { Logger } from './logger.server';

/**
 * Transactional email (magic links now, invitations in M2). One interface, two transports:
 *
 * - `ConsoleEmailTransport` — development and test only. Logs the link PATH from the message at
 *   info level (so a developer can sign in without a mail server); never the recipient, subject
 *   line aside, and never the body. Refuses to exist in production.
 * - `ResendEmailTransport` — POST https://api.resend.com/emails with a bearer key. 5 s timeout, one
 *   retry on 5xx/network errors with the same Idempotency-Key, none on 4xx.
 *
 * The provider is an open decision (docs/decisions-needed.md, "Transactional email provider").
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTransport {
  readonly name: 'console' | 'resend' | 'memory';
  send(message: EmailMessage): Promise<void>;
}

export class EmailSendError extends Error {
  override readonly name = 'EmailSendError';
  constructor(
    message: string,
    /** HTTP status from the provider, when there was one. */
    readonly status: number | null,
  ) {
    super(message);
  }
}

// ---------- console ----------

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/;

/** Path + query of the first URL in `text` (the magic link), or null. Origin is dropped. */
export const linkPathFrom = (text: string): string | null => {
  const match = URL_IN_TEXT.exec(text);
  if (!match) return null;
  try {
    const u = new URL(match[0]);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
};

export class ConsoleEmailTransport implements EmailTransport {
  readonly name = 'console' as const;

  constructor(
    private readonly logger: Logger,
    nodeEnv: Env['NODE_ENV'],
  ) {
    if (nodeEnv === 'production') {
      throw new Error('ConsoleEmailTransport is for development and test only');
    }
  }

  async send(message: EmailMessage): Promise<void> {
    // `to` is logged as a constant marker, not the address (§7.3).
    this.logger.info('email.console', {
      to: '[REDACTED]',
      subject: message.subject,
      linkPath: linkPathFrom(message.text),
    });
  }
}

// ---------- Resend ----------

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type EmailFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetchImpl?: EmailFetch;
  timeoutMs?: number;
  /** Total attempts for retryable failures (5xx, network, timeout). Default 2. */
  maxAttempts?: number;
}

const resendResponseSchema = z.object({ id: z.string().min(1).max(200) });

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend' as const;
  private readonly fetchImpl: EmailFetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: ResendOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  }

  async send(message: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      from: this.opts.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
    // Same key on every attempt: a retry after a lost response cannot send twice.
    const idempotencyKey = randomUUID();
    let lastError: EmailSendError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.name : 'unknown';
        lastError = new EmailSendError(`email provider unreachable (${reason})`, null);
        continue;
      }
      if (res.ok) {
        const parsed = resendResponseSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) {
          throw new EmailSendError('email provider returned an unexpected response', res.status);
        }
        return;
      }
      // The response body can echo the recipient; it is never read into an error or a log.
      lastError = new EmailSendError(`email provider rejected the request`, res.status);
      if (res.status < 500) break; // 4xx: our request is wrong; retrying cannot help.
    }
    throw lastError ?? new EmailSendError('email not sent', null);
  }
}

// ---------- selection ----------

export type EmailTransportChoice =
  { transport: EmailTransport; problem: null } | { transport: null; problem: string };

/**
 * Picks the transport from env. Never throws: a misconfiguration yields `transport: null` and a
 * `problem` the caller logs once at startup; sign-in then fails closed ("not available yet").
 */
export const createEmailTransport = (
  env: Env,
  logger: Logger,
  fetchImpl?: EmailFetch,
): EmailTransportChoice => {
  const production = env.NODE_ENV === 'production';
  const choice = env.EMAIL_TRANSPORT ?? (production ? null : 'console');
  if (choice === null) {
    return { transport: null, problem: 'EMAIL_TRANSPORT is unset in production.' };
  }
  if (choice === 'console') {
    if (production) {
      return {
        transport: null,
        problem: 'EMAIL_TRANSPORT=console is refused in production.',
      };
    }
    return { transport: new ConsoleEmailTransport(logger, env.NODE_ENV), problem: null };
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return {
      transport: null,
      problem: 'EMAIL_TRANSPORT=resend needs RESEND_API_KEY and EMAIL_FROM.',
    };
  }
  return {
    transport: new ResendEmailTransport({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    problem: null,
  };
};

/** Test transport: keeps messages in memory. Never selected by `createEmailTransport`. */
export class MemoryEmailTransport implements EmailTransport {
  readonly name = 'memory' as const;
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
