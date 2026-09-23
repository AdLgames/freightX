import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level envelope encryption (§7.3; ADR-0016 made it a prerequisite). M2.
 *
 *   master key  ──wraps──▶  per-organisation data key  ──encrypts──▶  field values
 *   (KeyProvider)           (organizations.data_key_ciphertext)      (eori_number, vat_number, …)
 *
 * - AES-256-GCM everywhere, random 12-byte IV per encryption, 16-byte tag.
 * - Ciphertext format `v1:<base64 iv>:<base64 tag>:<base64 data>`. `v1` is the format version, so a
 *   later algorithm change can coexist with old rows.
 * - AAD (additional authenticated data) binds a value to its place: `<organizationId>:<field>` for
 *   fields, a fixed label for wrapped data keys. A ciphertext copied to another organisation or
 *   another column fails to decrypt (tests: "tamper detection").
 * - `KeyProvider` is the seam for a KMS. `EnvKeyProvider` holds the master key from
 *   `FIELD_ENCRYPTION_KEY` (32 bytes, base64) in process memory. TODO(kms): a `KmsKeyProvider`
 *   would call KMS `Encrypt`/`Decrypt` (or `GenerateDataKey`) for wrap/unwrap only — the data key
 *   never leaves the process in clear and field encryption stays local. Decision (v) in
 *   docs/decisions-needed.md. When it lands, `rewrapDataKey` re-wraps every organisation's data
 *   key without touching field ciphertexts.
 * - Nothing here logs. Callers must never log plaintext or ciphertext; keep `*Last4` for display.
 *
 * Pure module: node:crypto only. The Prisma glue is a structural adapter (`prismaDataKeyStore`).
 */

export const CIPHERTEXT_VERSION = 'v1';
export const MASTER_KEY_BYTES = 32;
export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';
const DATA_KEY_AAD = 'harbour:data-key:v1';

const B64 = '[A-Za-z0-9+/]+={0,2}';
/** `v1:<iv>:<tag>:<data>` (data may be empty for an empty plaintext). */
export const CIPHERTEXT_RE = new RegExp(`^${CIPHERTEXT_VERSION}:${B64}:${B64}:(?:${B64})?$`);

export type FieldCryptoErrorCode =
  'INVALID_KEY' | 'INVALID_CIPHERTEXT' | 'DECRYPT_FAILED' | 'MISSING_MASTER_KEY';

/** Never carries plaintext or key material in its message. */
export class FieldCryptoError extends Error {
  override readonly name = 'FieldCryptoError';
  constructor(
    readonly code: FieldCryptoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------- primitives ----------

const seal = (key: Buffer, aad: string, plaintext: Buffer): string => {
  if (key.length !== DATA_KEY_BYTES) {
    throw new FieldCryptoError('INVALID_KEY', `key must be ${DATA_KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHERTEXT_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    data.toString('base64'),
  ].join(':');
};

const open = (key: Buffer, aad: string, ciphertext: string): Buffer => {
  if (key.length !== DATA_KEY_BYTES) {
    throw new FieldCryptoError('INVALID_KEY', `key must be ${DATA_KEY_BYTES} bytes`);
  }
  if (typeof ciphertext !== 'string' || !CIPHERTEXT_RE.test(ciphertext)) {
    throw new FieldCryptoError('INVALID_CIPHERTEXT', 'value is not a v1 ciphertext');
  }
  const [, ivB64 = '', tagB64 = '', dataB64 = ''] = ciphertext.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new FieldCryptoError('INVALID_CIPHERTEXT', 'ciphertext has a malformed iv or tag');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  } catch {
    // GCM reports every tamper (tag, iv, data, AAD, wrong key) the same way; so do we.
    throw new FieldCryptoError('DECRYPT_FAILED', 'authentication failed');
  }
};

export const isCiphertext = (value: unknown): value is string =>
  typeof value === 'string' && CIPHERTEXT_RE.test(value);

/**
 * Encrypted columns and the AAD field name used for each (web writes, worker reads). Adding a
 * column = add it here; the name is part of the AAD, so it must never change afterwards.
 */
export const ORGANIZATION_ENCRYPTED_FIELDS = {
  eoriNumber: 'eoriNumber',
  vatNumber: 'vatNumber',
} as const;
export type OrganizationEncryptedField =
  (typeof ORGANIZATION_ENCRYPTED_FIELDS)[keyof typeof ORGANIZATION_ENCRYPTED_FIELDS];

/** Display suffix kept in clear next to an encrypted field (`eoriLast4`, `vatLast4`). */
export const last4 = (value: string): string => value.slice(-4);

// ---------- field encryption ----------

const fieldAad = (organizationId: string, field: string): string => {
  if (!organizationId || !field) {
    throw new FieldCryptoError('INVALID_KEY', 'organizationId and field are required');
  }
  return `${organizationId}:${field}`;
};

/** Encrypts `plaintext` for (`organizationId`, `field`) under that organisation's data key. */
export const encryptField = (
  orgKey: Buffer,
  organizationId: string,
  field: string,
  plaintext: string,
): string => seal(orgKey, fieldAad(organizationId, field), Buffer.from(plaintext, 'utf8'));

/** Inverse of `encryptField`; throws `FieldCryptoError('DECRYPT_FAILED')` on any tampering. */
export const decryptField = (
  orgKey: Buffer,
  organizationId: string,
  field: string,
  ciphertext: string,
): string => open(orgKey, fieldAad(organizationId, field), ciphertext).toString('utf8');

// ---------- key provider ----------

export interface KeyProvider {
  /** For logs and the rotation runbook only (never the key). */
  readonly keyId: string;
  wrapDataKey(dataKey: Buffer): Promise<string>;
  unwrapDataKey(wrapped: string): Promise<Buffer>;
}

/** Base64 → 32-byte master key. Never include the value in an error. */
export const parseMasterKey = (base64: string): Buffer => {
  const trimmed = base64.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (
    trimmed === '' ||
    key.length !== MASTER_KEY_BYTES ||
    key.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')
  ) {
    throw new FieldCryptoError(
      'INVALID_KEY',
      `FIELD_ENCRYPTION_KEY must be ${MASTER_KEY_BYTES} random bytes, base64-encoded`,
    );
  }
  return key;
};

/** For docs, tests and local setup: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. */
export const generateMasterKey = (): string => randomBytes(MASTER_KEY_BYTES).toString('base64');

export const generateDataKey = (): Buffer => randomBytes(DATA_KEY_BYTES);

/** Master key held in process memory (from env). The KMS provider replaces this later (see header). */
export class EnvKeyProvider implements KeyProvider {
  private readonly masterKey: Buffer;
  constructor(
    masterKey: Buffer,
    readonly keyId: string = 'env',
  ) {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new FieldCryptoError('INVALID_KEY', `master key must be ${MASTER_KEY_BYTES} bytes`);
    }
    this.masterKey = Buffer.from(masterKey);
  }

  async wrapDataKey(dataKey: Buffer): Promise<string> {
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new FieldCryptoError('INVALID_KEY', `data key must be ${DATA_KEY_BYTES} bytes`);
    }
    return seal(this.masterKey, DATA_KEY_AAD, dataKey);
  }

  async unwrapDataKey(wrapped: string): Promise<Buffer> {
    const key = open(this.masterKey, DATA_KEY_AAD, wrapped);
    if (key.length !== DATA_KEY_BYTES) {
      throw new FieldCryptoError('DECRYPT_FAILED', 'unwrapped data key has the wrong length');
    }
    return key;
  }
}

export type KeyProviderChoice =
  | { provider: KeyProvider; ephemeral: boolean; problem: null }
  | { provider: null; ephemeral: false; problem: string };

/**
 * Picks the provider from configuration. Production without a key fails closed (the caller
 * withholds the workspace; the calculator is unaffected). Development/test without a key get an
 * ephemeral key — every restart makes existing ciphertexts unreadable — and `ephemeral: true` so
 * the caller can warn loudly. A malformed key is a problem in every environment.
 */
export const createKeyProvider = (input: {
  masterKey: string | undefined;
  nodeEnv: 'development' | 'test' | 'production';
}): KeyProviderChoice => {
  if (input.masterKey !== undefined) {
    try {
      return {
        provider: new EnvKeyProvider(parseMasterKey(input.masterKey)),
        ephemeral: false,
        problem: null,
      };
    } catch (err) {
      return {
        provider: null,
        ephemeral: false,
        problem: err instanceof FieldCryptoError ? err.message : 'FIELD_ENCRYPTION_KEY is invalid',
      };
    }
  }
  if (input.nodeEnv === 'production') {
    return {
      provider: null,
      ephemeral: false,
      problem:
        'FIELD_ENCRYPTION_KEY is unset in production (§7.3: EORI/VAT are encrypted at rest).',
    };
  }
  return {
    provider: new EnvKeyProvider(generateDataKey(), 'ephemeral'),
    ephemeral: true,
    problem: null,
  };
};

/**
 * Key rotation helper: re-wraps one organisation's data key under a new master key. Field
 * ciphertexts are untouched (they use the data key). A rotation job iterates organisations with a
 * maintenance role, calls this and writes the result back to `data_key_ciphertext`.
 */
export const rewrapDataKey = async (
  wrapped: string,
  from: KeyProvider,
  to: KeyProvider,
): Promise<string> => to.wrapDataKey(await from.unwrapDataKey(wrapped));

// ---------- per-organisation data key ----------

/** Where the wrapped data key lives (`organizations.data_key_ciphertext`). */
export interface DataKeyStore {
  read(organizationId: string): Promise<string | null>;
  /**
   * Stores `wrapped` only when the organisation has no data key yet, and returns the value now
   * stored (an existing one wins over `wrapped`), so two concurrent first uses converge.
   */
  initialise(organizationId: string, wrapped: string): Promise<string>;
}

/** The slice of a (tenant-scoped, in-transaction) Prisma client `prismaDataKeyStore` needs. */
export interface DataKeyStoreClient {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: { dataKeyCiphertext: true };
    }): PromiseLike<{ dataKeyCiphertext: string | null } | null>;
    updateMany(args: {
      where: { id: string; dataKeyCiphertext: null };
      data: { dataKeyCiphertext: string };
    }): PromiseLike<{ count: number }>;
  };
}

/**
 * `DataKeyStore` over a Prisma client that is already inside `withOrgTransaction(orgId)` (RLS
 * context set; the tenant scope also confines it to `orgId`). The conditional `updateMany`
 * (`dataKeyCiphertext: null`) is the "only if absent" guard.
 */
export const prismaDataKeyStore = (tx: DataKeyStoreClient): DataKeyStore => ({
  read: async (organizationId) => {
    const row = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { dataKeyCiphertext: true },
    });
    return row?.dataKeyCiphertext ?? null;
  },
  initialise: async (organizationId, wrapped) => {
    await tx.organization.updateMany({
      where: { id: organizationId, dataKeyCiphertext: null },
      data: { dataKeyCiphertext: wrapped },
    });
    const row = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { dataKeyCiphertext: true },
    });
    if (!row?.dataKeyCiphertext) {
      throw new FieldCryptoError('MISSING_MASTER_KEY', 'organisation not found in scope');
    }
    return row.dataKeyCiphertext;
  },
});

/** Test/in-memory `DataKeyStore`. */
export class InMemoryDataKeyStore implements DataKeyStore {
  readonly wrapped = new Map<string, string>();
  async read(organizationId: string): Promise<string | null> {
    return this.wrapped.get(organizationId) ?? null;
  }
  async initialise(organizationId: string, wrapped: string): Promise<string> {
    const existing = this.wrapped.get(organizationId);
    if (existing !== undefined) return existing;
    this.wrapped.set(organizationId, wrapped);
    return wrapped;
  }
}

/** The organisation's data key (generated, wrapped and stored on first use). */
export const resolveOrgDataKey = async (
  provider: KeyProvider,
  store: DataKeyStore,
  organizationId: string,
): Promise<Buffer> => {
  const existing = await store.read(organizationId);
  if (existing !== null) return provider.unwrapDataKey(existing);
  const fresh = generateDataKey();
  const stored = await store.initialise(organizationId, await provider.wrapDataKey(fresh));
  return provider.unwrapDataKey(stored);
};

export interface OrgFieldCipher {
  readonly organizationId: string;
  encrypt(field: string, plaintext: string): Promise<string>;
  decrypt(field: string, ciphertext: string): Promise<string>;
}

/**
 * Encrypt/decrypt fields of one organisation. The data key is resolved lazily, once per cipher
 * instance — create one per transaction, not per process (the unwrapped key must not outlive the
 * work that needs it).
 */
export const orgFieldCipher = (
  provider: KeyProvider,
  store: DataKeyStore,
  organizationId: string,
): OrgFieldCipher => {
  let key: Promise<Buffer> | undefined;
  const orgKey = () => (key ??= resolveOrgDataKey(provider, store, organizationId));
  return {
    organizationId,
    encrypt: async (field, plaintext) =>
      encryptField(await orgKey(), organizationId, field, plaintext),
    decrypt: async (field, ciphertext) =>
      decryptField(await orgKey(), organizationId, field, ciphertext),
  };
};
