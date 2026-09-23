import { randomUUID } from 'node:crypto';

/**
 * Structured JSON logs (§3 observability, §7.3 "redact emails, EORI, VAT, document names").
 * One JSON object per line on stdout; every line carries `event`, `level`, `ts` and whatever
 * fields the caller adds — after `redact()`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** New logger whose lines always include `fields` (e.g. `{ requestId }`). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where lines go; defaults to `process.stdout`. Injected in tests. */
  sink?: (line: string) => void;
  now?: () => Date;
  base?: LogFields;
}

export const parseLogLevel = (raw: string | undefined, fallback: LogLevel = 'info'): LogLevel =>
  raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : fallback;

// ---------- redaction ----------

const SENSITIVE_KEY = /^(email|eori|vat|vatNumber|eoriNumber|originalName)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// EORI before VAT: an EORI "GB123456789000" contains a VAT-shaped prefix.
const EORI = /\b(GB|XI)\d{12}\b/g;
const VAT = /\bGB\d{9}(?:\d{3})?\b/g;
const MAX_DEPTH = 8;

export const REDACTED = '[REDACTED]';

export const redactString = (s: string): string =>
  s.replace(EMAIL, '[EMAIL]').replace(EORI, '$1[EORI]').replace(VAT, 'GB[VAT]');

/**
 * Deep-copy `value` masking PII: any key named email/eori/vat/vatNumber/eoriNumber/originalName
 * (case-insensitive) is replaced wholesale; every string is scrubbed of email addresses and
 * EORI/VAT numbers. Safe on cycles, Errors, Dates, arrays and Maps.
 */
export const redact = (
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const out: LogFields = { name: value.name, message: redactString(value.message) };
    if (value.stack) out.stack = redactString(value.stack);
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  if (value instanceof Map) {
    return redact(Object.fromEntries(value.entries()), depth, seen);
  }
  const out: LogFields = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
};

// ---------- logger ----------

const defaultSink = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const safeStringify = (obj: unknown): string => {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ event: 'log.unserialisable', level: 'error' });
  }
};

export const createLogger = (opts: LoggerOptions = {}): Logger => {
  const level = opts.level ?? 'info';
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  const build = (base: LogFields): Logger => {
    const emit = (lvl: LogLevel, event: string, fields?: LogFields): void => {
      if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
      const line = {
        ts: now().toISOString(),
        level: lvl,
        event,
        ...(redact({ ...base, ...(fields ?? {}) }) as LogFields),
      };
      sink(safeStringify(line));
    };
    return {
      debug: (e, f) => emit('debug', e, f),
      info: (e, f) => emit('info', e, f),
      warn: (e, f) => emit('warn', e, f),
      error: (e, f) => emit('error', e, f),
      child: (fields) => build({ ...base, ...fields }),
    };
  };
  return build(opts.base ?? {});
};

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Honour an upstream `x-request-id` when it looks sane, else mint one. */
export const requestIdFor = (request: Request): string => {
  const incoming = request.headers.get('x-request-id');
  return incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
};

/** Child logger for one request: request id, method and path only — never the IP or query string. */
export const requestLogger = (logger: Logger, request: Request): Logger => {
  const url = new URL(request.url);
  return logger.child({
    requestId: requestIdFor(request),
    method: request.method,
    path: url.pathname,
  });
};
