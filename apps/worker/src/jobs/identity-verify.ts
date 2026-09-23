import type { IdentityCheckResult } from '@harbour/adapters';
import {
  ORGANIZATION_ENCRYPTED_FIELDS,
  decryptField,
  isCiphertext,
  type KeyProvider,
} from '@harbour/db';
import { z } from 'zod';
import type { AlertSink } from '../ports.js';

/**
 * M2 — shared core of the `eori-verify` and `vat-verify` jobs (brief §5.6: "verify via HMRC …
 * API on save (async job, result stored)").
 *
 * Payload `{ organizationId }`. The job reads the ENCRYPTED number and the organisation's wrapped
 * data key through the store, decrypts in memory (§7.3), calls the HMRC checker and writes
 * VALID / INVALID / ERROR (+ verifiedAt) back — conditionally on the ciphertext being unchanged,
 * so a number edited while the job was queued is never stamped with a stale result.
 *
 * The number never appears in a log, summary, alert or error message. Summaries carry the
 * organisation id, the field and the outcome only.
 *
 * Failure semantics: a definite HMRC answer (valid / not found) completes the job. An
 * UNAVAILABLE / MALFORMED / BAD_REQUEST answer records ERROR and THROWS so BullMQ retries with
 * backoff; three consecutive ERRORs for the same organisation and field raise a warning alert
 * (`IDENTITY_VERIFY_REPEATED_ERROR`) on top of the usual `JOB_FAILED` after the last attempt.
 */
export type IdentityField = 'eori' | 'vat';

/** Column → AAD field name (must match what apps/web encrypted with). */
export const IDENTITY_ENCRYPTED_FIELD: Record<IdentityField, string> = {
  eori: ORGANIZATION_ENCRYPTED_FIELDS.eoriNumber,
  vat: ORGANIZATION_ENCRYPTED_FIELDS.vatNumber,
};

export const identityJobPayloadSchema = z.object({ organizationId: z.uuid() });
export type IdentityJobPayload = z.infer<typeof identityJobPayloadSchema>;

export interface IdentityRecord {
  /** The stored (encrypted) value, or null when the organisation has none. */
  ciphertext: string | null;
  dataKeyCiphertext: string | null;
}

export type IdentityOutcome = 'VALID' | 'INVALID' | 'ERROR';

export interface IdentityVerificationStore {
  /** null when the organisation is not visible (deleted / wrong context). */
  load(organizationId: string, field: IdentityField): Promise<IdentityRecord | null>;
  /**
   * Writes the result only if the stored ciphertext still equals `expectedCiphertext`; returns
   * whether a row was updated. `verifiedAt` is set for VALID/INVALID only.
   */
  record(
    organizationId: string,
    field: IdentityField,
    result: { status: IdentityOutcome; checkedAt: Date; expectedCiphertext: string },
  ): Promise<boolean>;
}

export interface IdentityChecker {
  check(value: string): Promise<IdentityCheckResult>;
}

/** Counts consecutive ERRORs per (organisation, field) inside one worker process. */
export class RepeatedErrorTracker {
  private readonly counts = new Map<string, number>();
  constructor(readonly threshold = 3) {}
  /** Returns the new consecutive count. */
  failed(organizationId: string, field: IdentityField): number {
    const key = `${field}:${organizationId}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
  reset(organizationId: string, field: IdentityField): void {
    this.counts.delete(`${field}:${organizationId}`);
  }
}

export interface IdentityVerifyDeps {
  field: IdentityField;
  store: IdentityVerificationStore;
  /** null → the worker has no FIELD_ENCRYPTION_KEY; the job fails with a clear message. */
  keyProvider: KeyProvider | null;
  checker: IdentityChecker;
  now: () => Date;
  alerts: AlertSink;
  errors: RepeatedErrorTracker;
}

export interface IdentityVerifySummary {
  field: IdentityField;
  organizationId: string;
  outcome: IdentityOutcome | 'SKIPPED';
  /** Why the job was skipped or errored — a code, never a value. */
  reason?: string;
  asOf: string;
}

export class IdentityVerifyError extends Error {
  override readonly name = 'IdentityVerifyError';
  constructor(
    readonly field: IdentityField,
    readonly reason: string,
  ) {
    super(`${field} verification ${reason}`);
  }
}

export const runIdentityVerify = async (
  payload: unknown,
  deps: IdentityVerifyDeps,
): Promise<IdentityVerifySummary> => {
  const parsed = identityJobPayloadSchema.safeParse(payload);
  if (!parsed.success)
    throw new IdentityVerifyError(deps.field, 'payload must be { organizationId }');
  const { organizationId } = parsed.data;
  const { field } = deps;
  const asOf = deps.now().toISOString();
  const skipped = (reason: string): IdentityVerifySummary => ({
    field,
    organizationId,
    outcome: 'SKIPPED',
    reason,
    asOf,
  });

  const record = await deps.store.load(organizationId, field);
  if (!record) return skipped('ORG_NOT_FOUND');
  if (record.ciphertext === null) return skipped('NOT_SET');
  if (!isCiphertext(record.ciphertext) || record.dataKeyCiphertext === null) {
    // A plaintext leftover (pre-0008 test data) or a missing data key: nothing to verify safely.
    return skipped('NOT_ENCRYPTED');
  }
  if (!deps.keyProvider) {
    throw new IdentityVerifyError(field, 'needs FIELD_ENCRYPTION_KEY (same key as apps/web)');
  }

  const dataKey = await deps.keyProvider.unwrapDataKey(record.dataKeyCiphertext);
  const value = decryptField(
    dataKey,
    organizationId,
    IDENTITY_ENCRYPTED_FIELD[field],
    record.ciphertext,
  );
  dataKey.fill(0);

  const result = await deps.checker.check(value);
  const checkedAt = result.ok ? result.checkedAt : deps.now();
  const status: IdentityOutcome = result.ok ? (result.valid ? 'VALID' : 'INVALID') : 'ERROR';
  const written = await deps.store.record(organizationId, field, {
    status,
    checkedAt,
    expectedCiphertext: record.ciphertext,
  });
  if (!written) return skipped('CHANGED_MEANWHILE');

  if (result.ok) {
    deps.errors.reset(organizationId, field);
    return { field, organizationId, outcome: status, asOf };
  }

  const consecutive = deps.errors.failed(organizationId, field);
  if (consecutive >= deps.errors.threshold) {
    await deps.alerts.alert(
      'warning',
      'IDENTITY_VERIFY_REPEATED_ERROR',
      `${field} verification has failed ${consecutive} times in a row for one organisation`,
      { organizationId, field, consecutiveErrors: consecutive, reason: result.reason },
    );
  }
  throw new IdentityVerifyError(field, result.reason);
};
