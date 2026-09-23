import { randomUUID } from 'node:crypto';
import type { IdentityCheckResult } from '@harbour/adapters';
import {
  EnvKeyProvider,
  encryptField,
  generateDataKey,
  generateMasterKey,
  parseMasterKey,
} from '@harbour/db';
import { describe, expect, it } from 'vitest';
import { runEoriVerify } from '../src/jobs/eori-verify.js';
import {
  IdentityVerifyError,
  RepeatedErrorTracker,
  type IdentityField,
  type IdentityRecord,
  type IdentityVerificationStore,
} from '../src/jobs/identity-verify.js';
import { runVatVerify } from '../src/jobs/vat-verify.js';
import { CollectingAlertSink } from '../src/ports.js';
import { QUEUE_NAMES, SCHEDULES } from '../src/queues.js';
import { buildWiring, readEnv } from '../src/wiring.server.js';

const NOW = new Date('2026-09-23T12:00:00Z');
const provider = new EnvKeyProvider(parseMasterKey(generateMasterKey()));

/** In-memory store with an org that has encrypted values; records every write. */
class FakeStore implements IdentityVerificationStore {
  readonly writes: Array<{
    organizationId: string;
    field: IdentityField;
    status: string;
    checkedAt: Date;
  }> = [];
  constructor(readonly rows: Map<string, Array<IdentityRecord & { field: IdentityField }>>) {}
  static async withOrg(organizationId: string, values: Partial<Record<IdentityField, string>>) {
    const dataKey = generateDataKey();
    const wrapped = await provider.wrapDataKey(dataKey);
    const rows = new Map<string, Array<IdentityRecord & { field: IdentityField }>>();
    const list: Array<IdentityRecord & { field: IdentityField }> = [];
    for (const field of ['eori', 'vat'] as const) {
      const v = values[field];
      list.push({
        field,
        ciphertext:
          v === undefined
            ? null
            : encryptField(
                dataKey,
                organizationId,
                field === 'eori' ? 'eoriNumber' : 'vatNumber',
                v,
              ),
        dataKeyCiphertext: wrapped,
      });
    }
    rows.set(organizationId, list);
    return new FakeStore(rows);
  }
  async load(organizationId: string, field: IdentityField): Promise<IdentityRecord | null> {
    const row = this.rows.get(organizationId)?.find((r) => r.field === field);
    return row ? { ciphertext: row.ciphertext, dataKeyCiphertext: row.dataKeyCiphertext } : null;
  }
  async record(
    organizationId: string,
    field: IdentityField,
    result: { status: 'VALID' | 'INVALID' | 'ERROR'; checkedAt: Date; expectedCiphertext: string },
  ): Promise<boolean> {
    const row = this.rows.get(organizationId)?.find((r) => r.field === field);
    if (!row || row.ciphertext !== result.expectedCiphertext) return false;
    this.writes.push({ organizationId, field, status: result.status, checkedAt: result.checkedAt });
    return true;
  }
}

const checkerReturning = (result: IdentityCheckResult, seen: string[] = []) => ({
  check: async (value: string) => {
    seen.push(value);
    return result;
  },
});

const deps = (
  store: IdentityVerificationStore,
  checker: { check(v: string): Promise<IdentityCheckResult> },
) => {
  const alerts = new CollectingAlertSink();
  const errors = new RepeatedErrorTracker(3);
  return {
    store,
    keyProvider: provider,
    checker,
    now: () => NOW,
    alerts,
    errors,
    alertsSink: alerts,
  };
};

describe('eori-verify / vat-verify', () => {
  it('decrypts the stored EORI, calls the checker with the plaintext and records VALID', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const seen: string[] = [];
    const d = deps(store, checkerReturning({ ok: true, valid: true, checkedAt: NOW }, seen));
    const summary = await runEoriVerify({ organizationId: org }, d);
    expect(summary).toEqual({
      field: 'eori',
      organizationId: org,
      outcome: 'VALID',
      asOf: NOW.toISOString(),
    });
    expect(seen).toEqual(['GB123456789000']);
    expect(store.writes).toEqual([
      { organizationId: org, field: 'eori', status: 'VALID', checkedAt: NOW },
    ]);
    // The summary (what gets logged) never carries the number.
    expect(JSON.stringify(summary)).not.toContain('GB123456789000');
    expect(d.alertsSink.alerts).toEqual([]);
  });

  it('records INVALID when HMRC does not know the VAT number', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { vat: 'GB123456782' });
    const seen: string[] = [];
    const d = deps(store, checkerReturning({ ok: true, valid: false, checkedAt: NOW }, seen));
    const summary = await runVatVerify({ organizationId: org }, d);
    expect(summary.outcome).toBe('INVALID');
    expect(seen).toEqual(['GB123456782']);
    expect(store.writes[0]).toMatchObject({ field: 'vat', status: 'INVALID' });
  });

  it('records ERROR, throws so BullMQ retries, and alerts after three consecutive errors', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const d = deps(store, checkerReturning({ ok: false, reason: 'UNAVAILABLE' }));
    for (let i = 1; i <= 3; i += 1) {
      await expect(runEoriVerify({ organizationId: org }, d)).rejects.toThrow(IdentityVerifyError);
      expect(store.writes[i - 1]).toMatchObject({ status: 'ERROR', checkedAt: NOW });
      expect(d.alertsSink.alerts).toHaveLength(i === 3 ? 1 : 0);
    }
    expect(d.alertsSink.alerts[0]).toMatchObject({
      level: 'warning',
      code: 'IDENTITY_VERIFY_REPEATED_ERROR',
      meta: { organizationId: org, field: 'eori', consecutiveErrors: 3, reason: 'UNAVAILABLE' },
    });
    expect(JSON.stringify(d.alertsSink.alerts)).not.toContain('GB123456789000');
    // A success resets the counter.
    const ok = deps(store, checkerReturning({ ok: true, valid: true, checkedAt: NOW }));
    ok.errors = d.errors;
    await runEoriVerify({ organizationId: org }, ok);
    await expect(runEoriVerify({ organizationId: org }, d)).rejects.toThrow();
    expect(d.alertsSink.alerts).toHaveLength(1);
  });

  it('skips when the organisation is unknown, the number is not set, or it is not ciphertext', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const checker = checkerReturning({ ok: true, valid: true, checkedAt: NOW });
    expect((await runVatVerify({ organizationId: org }, deps(store, checker))).outcome).toBe(
      'SKIPPED',
    );
    expect((await runVatVerify({ organizationId: org }, deps(store, checker))).reason).toBe(
      'NOT_SET',
    );
    expect(
      (await runEoriVerify({ organizationId: randomUUID() }, deps(store, checker))).reason,
    ).toBe('ORG_NOT_FOUND');
    const plain = new FakeStore(
      new Map([[org, [{ field: 'eori', ciphertext: 'GB123456789000', dataKeyCiphertext: null }]]]),
    );
    expect((await runEoriVerify({ organizationId: org }, deps(plain, checker))).reason).toBe(
      'NOT_ENCRYPTED',
    );
    expect(store.writes).toEqual([]);
  });

  it('does not stamp a result on a number that changed while the job was queued', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const changing: IdentityVerificationStore = {
      load: (o, f) => store.load(o, f),
      record: async (o, f, r) => store.record(o, f, { ...r, expectedCiphertext: 'v1:changed:x:y' }),
    };
    const summary = await runEoriVerify(
      { organizationId: org },
      deps(changing, checkerReturning({ ok: true, valid: true, checkedAt: NOW })),
    );
    expect(summary).toMatchObject({ outcome: 'SKIPPED', reason: 'CHANGED_MEANWHILE' });
  });

  it('rejects a bad payload and a missing encryption key with clear errors', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const d = deps(store, checkerReturning({ ok: true, valid: true, checkedAt: NOW }));
    await expect(runEoriVerify({ organizationId: 'nope' }, d)).rejects.toThrow(/payload/);
    await expect(runEoriVerify(undefined, d)).rejects.toThrow(/payload/);
    await expect(
      runEoriVerify({ organizationId: org }, { ...d, keyProvider: null }),
    ).rejects.toThrow(/FIELD_ENCRYPTION_KEY/);
    expect(store.writes).toEqual([]);
  });

  it('a wrong master key cannot decrypt (tampered / rotated key)', async () => {
    const org = randomUUID();
    const store = await FakeStore.withOrg(org, { eori: 'GB123456789000' });
    const other = new EnvKeyProvider(parseMasterKey(generateMasterKey()));
    const d = {
      ...deps(store, checkerReturning({ ok: true, valid: true, checkedAt: NOW })),
      keyProvider: other,
    };
    await expect(runEoriVerify({ organizationId: org }, d)).rejects.toThrow(
      /authentication failed/,
    );
  });
});

describe('wiring', () => {
  it('registers the two on-demand queues with no schedule', () => {
    expect(QUEUE_NAMES).toContain('eori-verify');
    expect(QUEUE_NAMES).toContain('vat-verify');
    expect(SCHEDULES['eori-verify']).toEqual([]);
    expect(SCHEDULES['vat-verify']).toEqual([]);
  });

  it('without DATABASE_URL / FIELD_ENCRYPTION_KEY the identity jobs fail clearly instead of pretending', async () => {
    const wiring = buildWiring(readEnv({}), { now: () => NOW });
    expect(wiring.keyProvider).toBeNull();
    await expect(wiring.runJob('eori-verify', { organizationId: randomUUID() })).rejects.toThrow(
      /DATABASE_URL/,
    );
    const withKey = buildWiring(readEnv({ FIELD_ENCRYPTION_KEY: generateMasterKey() }));
    expect(withKey.keyProvider?.keyId).toBe('env');
    const badKey = buildWiring(readEnv({ FIELD_ENCRYPTION_KEY: 'not-a-key' }));
    expect(badKey.keyProvider).toBeNull();
  });
});
