import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CIPHERTEXT_RE,
  EnvKeyProvider,
  FieldCryptoError,
  InMemoryDataKeyStore,
  createKeyProvider,
  decryptField,
  encryptField,
  generateDataKey,
  generateMasterKey,
  isCiphertext,
  last4,
  orgFieldCipher,
  parseMasterKey,
  prismaDataKeyStore,
  resolveOrgDataKey,
  rewrapDataKey,
  type DataKeyStoreClient,
} from '../src/crypto.js';

const ORG = '7a1f5c8e-0d2b-4f6a-9c3e-1b2d3e4f5a6b';
const OTHER_ORG = '0b2e6d9f-1e3c-4a7b-8d4f-2c3e4f5a6b7c';

/** Replace one base64 segment of a ciphertext (tag/iv/data) with a flipped byte. */
const tamper = (ciphertext: string, segment: 1 | 2 | 3): string => {
  const parts = ciphertext.split(':');
  const buf = Buffer.from(parts[segment]!, 'base64');
  if (buf.length === 0) return ciphertext;
  buf[0] = (buf[0]! ^ 0xff) & 0xff;
  parts[segment] = buf.toString('base64');
  return parts.join(':');
};

describe('encryptField / decryptField', () => {
  const key = generateDataKey();

  it('round-trips and produces a v1 ciphertext with a fresh IV every time', () => {
    const a = encryptField(key, ORG, 'eoriNumber', 'GB123456789000');
    const b = encryptField(key, ORG, 'eoriNumber', 'GB123456789000');
    expect(a).toMatch(CIPHERTEXT_RE);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toBe(b); // random IV
    expect(a).not.toContain('GB123456789000');
    expect(Buffer.from(a.split(':')[1]!, 'base64')).toHaveLength(12);
    expect(Buffer.from(a.split(':')[2]!, 'base64')).toHaveLength(16);
    expect(decryptField(key, ORG, 'eoriNumber', a)).toBe('GB123456789000');
    expect(decryptField(key, ORG, 'eoriNumber', b)).toBe('GB123456789000');
    expect(isCiphertext(a)).toBe(true);
    expect(isCiphertext('GB123456789000')).toBe(false);
    expect(isCiphertext(null)).toBe(false);
  });

  it('handles empty and unicode plaintext', () => {
    const empty = encryptField(key, ORG, 'f', '');
    expect(decryptField(key, ORG, 'f', empty)).toBe('');
    const uni = encryptField(key, ORG, 'f', 'Ünïcödé ✓ 東京');
    expect(decryptField(key, ORG, 'f', uni)).toBe('Ünïcödé ✓ 東京');
  });

  it('detects tampering with the tag, the IV and the data', () => {
    const ct = encryptField(key, ORG, 'vatNumber', 'GB123456789');
    for (const segment of [1, 2, 3] as const) {
      const bad = tamper(ct, segment);
      expect(bad).not.toBe(ct);
      expect(() => decryptField(key, ORG, 'vatNumber', bad)).toThrow(FieldCryptoError);
      try {
        decryptField(key, ORG, 'vatNumber', bad);
      } catch (err) {
        expect((err as FieldCryptoError).code).toBe('DECRYPT_FAILED');
        expect((err as Error).message).not.toContain('GB123456789');
      }
    }
  });

  it('binds the ciphertext to the organisation and the field (AAD)', () => {
    const ct = encryptField(key, ORG, 'eoriNumber', 'GB123456789000');
    expect(() => decryptField(key, OTHER_ORG, 'eoriNumber', ct)).toThrow(/authentication failed/);
    expect(() => decryptField(key, ORG, 'vatNumber', ct)).toThrow(/authentication failed/);
  });

  it('fails with the wrong key and with malformed input', () => {
    const ct = encryptField(key, ORG, 'eoriNumber', 'GB123456789000');
    expect(() => decryptField(generateDataKey(), ORG, 'eoriNumber', ct)).toThrow(
      /authentication failed/,
    );
    for (const bad of ['', 'GB123456789000', 'v2:a:b:c', 'v1:notbase64!:x:y', 'v1:AA==:AA==:']) {
      expect(() => decryptField(key, ORG, 'eoriNumber', bad)).toThrow(FieldCryptoError);
    }
    expect(() => encryptField(Buffer.alloc(16), ORG, 'eoriNumber', 'x')).toThrow(/32 bytes/);
    expect(() => encryptField(key, '', 'eoriNumber', 'x')).toThrow(FieldCryptoError);
  });

  it('last4 keeps only the display suffix', () => {
    expect(last4('GB123456789000')).toBe('9000');
    expect(last4('GB1')).toBe('GB1');
  });
});

describe('EnvKeyProvider and master key parsing', () => {
  it('parses a 32-byte base64 key and rejects anything else', () => {
    const b64 = generateMasterKey();
    expect(parseMasterKey(b64)).toHaveLength(32);
    expect(parseMasterKey(`  ${b64}\n`)).toHaveLength(32);
    for (const bad of ['', 'short', Buffer.alloc(16).toString('base64'), 'not base64 at all!!']) {
      expect(() => parseMasterKey(bad)).toThrow(FieldCryptoError);
    }
    expect(() => new EnvKeyProvider(Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it('wraps and unwraps a data key; a wrapped key is not a field ciphertext for any org', async () => {
    const provider = new EnvKeyProvider(parseMasterKey(generateMasterKey()));
    const dataKey = generateDataKey();
    const wrapped = await provider.wrapDataKey(dataKey);
    expect(wrapped).toMatch(CIPHERTEXT_RE);
    expect((await provider.unwrapDataKey(wrapped)).equals(dataKey)).toBe(true);
    // Different AAD: the wrapped key cannot be "decrypted" as if it were an org field.
    const master = parseMasterKey(generateMasterKey());
    const p2 = new EnvKeyProvider(master);
    const w2 = await p2.wrapDataKey(dataKey);
    expect(() => decryptField(master, ORG, 'eoriNumber', w2)).toThrow(/authentication failed/);
    await expect(p2.unwrapDataKey(tamper(w2, 2))).rejects.toThrow(/authentication failed/);
    await expect(provider.unwrapDataKey(w2)).rejects.toThrow(/authentication failed/);
    await expect(provider.wrapDataKey(Buffer.alloc(8))).rejects.toThrow(/32 bytes/);
  });

  it('rewrapDataKey moves a data key to a new master key without touching field ciphertexts', async () => {
    const oldProvider = new EnvKeyProvider(parseMasterKey(generateMasterKey()), 'k1');
    const newProvider = new EnvKeyProvider(parseMasterKey(generateMasterKey()), 'k2');
    const dataKey = generateDataKey();
    const field = encryptField(dataKey, ORG, 'eoriNumber', 'GB123456789000');
    const wrappedOld = await oldProvider.wrapDataKey(dataKey);

    const wrappedNew = await rewrapDataKey(wrappedOld, oldProvider, newProvider);
    expect(wrappedNew).not.toBe(wrappedOld);
    const unwrapped = await newProvider.unwrapDataKey(wrappedNew);
    expect(decryptField(unwrapped, ORG, 'eoriNumber', field)).toBe('GB123456789000');
    await expect(oldProvider.unwrapDataKey(wrappedNew)).rejects.toThrow(/authentication failed/);
  });
});

describe('createKeyProvider', () => {
  it('uses the configured key when present', () => {
    const choice = createKeyProvider({ masterKey: generateMasterKey(), nodeEnv: 'production' });
    expect(choice.provider?.keyId).toBe('env');
    expect(choice.ephemeral).toBe(false);
    expect(choice.problem).toBeNull();
  });

  it('fails closed in production without a key, and on a malformed key anywhere', () => {
    const prod = createKeyProvider({ masterKey: undefined, nodeEnv: 'production' });
    expect(prod.provider).toBeNull();
    expect(prod.problem).toMatch(/FIELD_ENCRYPTION_KEY is unset in production/);
    const bad = createKeyProvider({ masterKey: 'nope', nodeEnv: 'development' });
    expect(bad.provider).toBeNull();
    expect(bad.problem).toMatch(/32 random bytes/);
    expect(bad.problem).not.toContain('nope');
  });

  it('generates an ephemeral key in development and test', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      const choice = createKeyProvider({ masterKey: undefined, nodeEnv });
      expect(choice.provider?.keyId).toBe('ephemeral');
      expect(choice.ephemeral).toBe(true);
    }
  });
});

describe('resolveOrgDataKey / orgFieldCipher', () => {
  const provider = new EnvKeyProvider(parseMasterKey(generateMasterKey()));

  it('generates, wraps and stores a data key on first use, then reuses it', async () => {
    const store = new InMemoryDataKeyStore();
    const k1 = await resolveOrgDataKey(provider, store, ORG);
    expect(store.wrapped.get(ORG)).toMatch(CIPHERTEXT_RE);
    const k2 = await resolveOrgDataKey(provider, store, ORG);
    expect(k1.equals(k2)).toBe(true);
    const other = await resolveOrgDataKey(provider, store, OTHER_ORG);
    expect(other.equals(k1)).toBe(false);
    expect(store.wrapped.size).toBe(2);
  });

  it('two concurrent first uses converge on one stored key', async () => {
    const store = new InMemoryDataKeyStore();
    const [a, b, c] = await Promise.all([
      resolveOrgDataKey(provider, store, ORG),
      resolveOrgDataKey(provider, store, ORG),
      resolveOrgDataKey(provider, store, ORG),
    ]);
    expect(a.equals(b) && b.equals(c)).toBe(true);
    expect(store.wrapped.size).toBe(1);
  });

  it('orgFieldCipher encrypts/decrypts with the org key and rejects another org’s value', async () => {
    const store = new InMemoryDataKeyStore();
    const cipher = orgFieldCipher(provider, store, ORG);
    const ct = await cipher.encrypt('eoriNumber', 'GB123456789000');
    expect(ct).toMatch(CIPHERTEXT_RE);
    expect(await cipher.decrypt('eoriNumber', ct)).toBe('GB123456789000');
    const otherCipher = orgFieldCipher(provider, store, OTHER_ORG);
    await expect(otherCipher.decrypt('eoriNumber', ct)).rejects.toThrow(/authentication failed/);
  });

  it('prismaDataKeyStore initialises only when absent (conditional updateMany) and reads back', async () => {
    let stored: string | null = null;
    const calls: string[] = [];
    const tx: DataKeyStoreClient = {
      organization: {
        findUnique: async () => {
          calls.push('findUnique');
          return { dataKeyCiphertext: stored };
        },
        updateMany: async (args) => {
          calls.push('updateMany');
          expect(args.where).toEqual({ id: ORG, dataKeyCiphertext: null });
          if (stored === null) {
            stored = args.data.dataKeyCiphertext;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    };
    const store = prismaDataKeyStore(tx);
    expect(await store.read(ORG)).toBeNull();
    const first = await store.initialise(ORG, 'v1:a:b:c');
    expect(first).toBe('v1:a:b:c');
    const second = await store.initialise(ORG, 'v1:x:y:z');
    expect(second).toBe('v1:a:b:c'); // existing wins
    expect(await store.read(ORG)).toBe('v1:a:b:c');
    expect(calls).toEqual([
      'findUnique',
      'updateMany',
      'findUnique',
      'updateMany',
      'findUnique',
      'findUnique',
    ]);
  });

  it('prismaDataKeyStore fails closed when the organisation is not in scope', async () => {
    const tx: DataKeyStoreClient = {
      organization: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
    };
    await expect(prismaDataKeyStore(tx).initialise(randomUUID(), 'v1:a:b:c')).rejects.toThrow(
      /not found in scope/,
    );
  });
});
