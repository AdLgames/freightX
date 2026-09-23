/**
 * Structured JSON logs to stdout (§3 observability). One object per line, `event` first. Never
 * put PII here: jobs only log counts, months, queue names and error classes/messages.
 */
export interface LogFields {
  [key: string]: unknown;
}

export const log = (
  event: string,
  fields: LogFields = {},
  stream: NodeJS.WritableStream = process.stdout,
): void => {
  const line = JSON.stringify({ event, ts: new Date().toISOString(), ...fields });
  stream.write(`${line}\n`);
};

export const errorFields = (err: unknown): LogFields => {
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message };
  }
  return { errorMessage: String(err) };
};
