// Spec: specs/secret-store.spec.ts (SECRET_NAMES, SECRET_FILE_SUFFIX, SECRET_TEMP_SUFFIX, SECRET_FILE_MODE,
// SECRETS_DIR_MODE, MAX_SECRET_CHARS, INSECURE_LINUX_BACKENDS)
// Acceptance: specs/entitlements-client.feature.md (Secret store) · plan decision "Secrets need a real keychain"
import * as realFs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KEYCHAIN_CHECK_TIMEOUT_MS, MAX_SECRET_CHARS, SECRET_FILE_MODE, SECRET_NAMES, SECRETS_DIR_MODE } from '@app/specs/secret-store.spec';
import { createSecretStore, type CreateSecretStoreOptions, type SafeStorageLike, type SecretStoreFs } from '../secret-store';

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'frost-secrets-'));
  dir = path.join(root, 'secrets');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MAGIC = Buffer.from('FAKE-KEYCHAIN:');
const SECRET = 'desktop-token-secret-0123456789';

/** Sync stand-ins for the fake's cipher (also used to plant blobs on disk). */
const encrypt = (plain: string) => Buffer.concat([MAGIC, Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)]);
const decrypt = (encrypted: Buffer) => {
  if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
  return Buffer.from(encrypted.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8');
};

/** A stand-in for Electron's asynchronous `safeStorage`: reversible, recognisable, and never the plain text. */
function fakeSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageLike & { encryptStringAsync: ReturnType<typeof vi.fn> } {
  return {
    isAsyncEncryptionAvailable: async () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'gnome_libsecret',
    encryptStringAsync: vi.fn(async (plain: string) => encrypt(plain)),
    decryptStringAsync: async (encrypted: Buffer) => ({ shouldReEncrypt: false, result: decrypt(encrypted) }),
  };
}

const create = (options: Partial<CreateSecretStoreOptions> = {}) =>
  createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux', ...options });

const ready = () => true;
const files = () => (existsSync(dir) ? readdirSync(dir).sort() : []);
const mode = (file: string) => statSync(file).mode & 0o777;

describe('secret store', () => {
  test('secret-round-trip', async () => {
    const log = vi.fn();
    const store = await create({ log });
    expect(store.persistent).toBe(true);
    expect(await store.read('account')).toBeNull();
    // Resolves true: on disk.
    expect(await store.write('account', SECRET)).toBe(true);
    expect(await store.read('account')).toBe(SECRET);
    expect(files()).toEqual(['account.bin']);
    const onDisk = readFileSync(path.join(dir, 'account.bin'));
    expect(onDisk.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(onDisk.toString('utf8')).not.toContain(SECRET);
    // A new instance (the next run) reads it back.
    const next = await create({ log });
    expect(await next.read('account')).toBe(SECRET);
    await next.write('account', 'second');
    expect(await (await create({ log })).read('account')).toBe('second');
    // Other platforms have no storage backend to ask about.
    const mac = await create({ safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('linux only'); } }, log, platform: 'darwin' });
    expect(mac.persistent).toBe(true);
    expect(await mac.read('account')).toBe('second');
    expect(log).not.toHaveBeenCalled();
  });

  test('secret-file-modes', async () => {
    const store = await create();
    await store.write('gsc', SECRET);
    await store.write('entitlements', '{}');
    expect(files()).toEqual(['entitlements.bin', 'gsc.bin']);
    // POSIX permission bits: Windows has none (its ACLs are not modelled by `mode`).
    if (process.platform !== 'win32') {
      expect(mode(dir)).toBe(SECRETS_DIR_MODE);
      expect(mode(path.join(dir, 'gsc.bin'))).toBe(SECRET_FILE_MODE);
      expect(mode(path.join(dir, 'entitlements.bin'))).toBe(SECRET_FILE_MODE);
    }
    // An existing directory with looser permissions is tightened.
    rmSync(dir, { recursive: true });
    realFs.mkdirSync(dir, { mode: 0o755 });
    realFs.chmodSync(dir, 0o755);
    await (await create()).write('account', SECRET);
    if (process.platform !== 'win32') expect(mode(dir)).toBe(SECRETS_DIR_MODE);
  });

  test('basic-text-is-memory-only', async () => {
    const safeStorage = fakeSafeStorage({ backend: 'basic_text' });
    const store = await create({ safeStorage });
    expect(store.persistent).toBe(false);
    await store.write('account', SECRET);
    expect(await store.read('account')).toBe(SECRET);
    expect(existsSync(dir)).toBe(false);
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    // The next run starts empty.
    expect(await (await create({ safeStorage })).read('account')).toBeNull();
    await store.delete('account');
    expect(await store.read('account')).toBeNull();
  });

  test('unknown-backend-is-memory-only', async () => {
    for (const safeStorage of [fakeSafeStorage({ backend: 'unknown' }), { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('not ready'); } }]) {
      const store = await create({ safeStorage });
      expect(store.persistent).toBe(false);
      await store.write('gsc', SECRET);
      expect(await store.read('gsc')).toBe(SECRET);
      expect(existsSync(dir)).toBe(false);
    }
  });

  test('encryption-unavailable-is-memory-only', async () => {
    const rejecting = { ...fakeSafeStorage(), isAsyncEncryptionAvailable: () => Promise.reject(new Error('no encryptor')) };
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const safeStorage of [fakeSafeStorage({ available: false }), rejecting]) {
        const store = await create({ safeStorage, platform });
        expect(store.persistent, platform).toBe(false);
        expect(await store.write('account', SECRET)).toBe(false);
        expect(await store.read('account')).toBe(SECRET);
        expect(existsSync(dir)).toBe(false);
      }
    }
    // A blob left by an earlier run with a keychain is not read (nor removed) without one.
    await (await create()).write('account', SECRET);
    const without = await create({ safeStorage: fakeSafeStorage({ available: false }) });
    expect(await without.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
  });

  test('keychain-check-is-bounded', async () => {
    vi.useFakeTimers();
    try {
      const creating = create({ safeStorage: { ...fakeSafeStorage(), isAsyncEncryptionAvailable: () => new Promise<boolean>(() => undefined) } });
      await vi.advanceTimersByTimeAsync(KEYCHAIN_CHECK_TIMEOUT_MS);
      const store = await creating;
      expect(store.persistent).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('undecryptable-secret-is-kept', async () => {
    const log = vi.fn();
    await (await create({ log })).write('account', SECRET);
    const original = readFileSync(path.join(dir, 'account.bin'));
    // The next run starts with the keyring locked: decryption fails, nothing has worked yet.
    let locked = true;
    const base = fakeSafeStorage();
    const safeStorage: SafeStorageLike = {
      ...base,
      decryptStringAsync: async (encrypted) => {
        if (locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
        return base.decryptStringAsync(encrypted);
      },
    };
    const store = await create({ safeStorage, log });
    expect(await store.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
    expect(readFileSync(path.join(dir, 'account.bin')).equals(original)).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain('account');
    expect(message).not.toContain(SECRET);
    // Unlocked later in the run: the value is there.
    locked = false;
    expect(await store.read('account')).toBe(SECRET);
  });

  test('corrupt-secret-is-deleted', async () => {
    const log = vi.fn();
    const store = await create({ log });
    realFs.mkdirSync(dir, { recursive: true });
    // An empty file is never a stored value: deleted at once.
    writeFileSync(path.join(dir, 'gsc.bin'), Buffer.alloc(0));
    expect(await store.read('gsc')).toBeNull();
    expect(files()).toEqual([]);
    // Garbage before the keychain proved itself: kept.
    writeFileSync(path.join(dir, 'account.bin'), `garbage ${SECRET}`);
    expect(await store.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
    // Once a decrypt (or encrypt) worked in this run, garbage is corrupt: deleted.
    await store.write('entitlements', '{}');
    expect(await store.read('account')).toBeNull();
    expect(files()).toEqual(['entitlements.bin']);
    for (const [message] of log.mock.calls) {
      expect(String(message)).not.toContain(SECRET);
      expect(String(message)).not.toContain('garbage');
    }
    // A blob that decrypts to more than a stored value can be is deleted too.
    const next = await create({ log });
    writeFileSync(path.join(dir, 'gsc.bin'), encrypt('x'.repeat(MAX_SECRET_CHARS + 1)));
    expect(await next.read('gsc')).toBeNull();
    expect(files()).toEqual(['entitlements.bin']);
  });

  test('secret-store-needs-app-ready', async () => {
    await expect(create({ isReady: () => false })).rejects.toThrow(/ready/);
    expect(existsSync(dir)).toBe(false);
  });

  test('secret-names-allowlisted', async () => {
    const store = await create();
    for (const name of ['../account', 'account.bin', 'tokens', '', 'ACCOUNT', 'constructor', '__proto__', '/etc/passwd']) {
      expect(() => store.write(name as never, SECRET), name).toThrow(/secret name/);
      expect(() => store.read(name as never), name).toThrow(/secret name/);
      expect(() => store.delete(name as never), name).toThrow(/secret name/);
    }
    for (const name of SECRET_NAMES) {
      await store.write(name, name);
      expect(await store.read(name)).toBe(name);
    }
    expect(() => store.write('account', 'x'.repeat(MAX_SECRET_CHARS + 1))).toThrow(/too long/);
    expect(() => store.write('account', 42 as never)).toThrow(/string/);
    expect(await store.read('account')).toBe('account');
  });

  test('secret-delete-and-clear', async () => {
    const store = await create();
    for (const name of SECRET_NAMES) await store.write(name, SECRET);
    await store.delete('gsc');
    expect(await store.read('gsc')).toBeNull();
    expect(files()).toEqual(['account.bin', 'entitlements.bin']);
    await store.delete('gsc');
    writeFileSync(path.join(dir, 'account.bin.abc123.tmp'), 'left over');
    writeFileSync(path.join(dir, 'unrelated.txt'), 'not ours');
    await store.clear();
    expect(files()).toEqual(['unrelated.txt']);
    for (const name of SECRET_NAMES) expect(await store.read(name)).toBeNull();
    expect(await (await create()).read('account')).toBeNull();
    // Memory-only too.
    const memory = await create({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }) });
    await memory.write('account', SECRET);
    await memory.clear();
    expect(await memory.read('account')).toBeNull();
  });

  test('failed-write-leaves-no-stale-value', async () => {
    const log = vi.fn();
    await (await create({ log })).write('account', 'old-value');
    const failingFs: SecretStoreFs = {
      ...realFs,
      renameSync: () => {
        throw Object.assign(new Error(`ENOSPC: no space left, rename '${path.join(dir, 'account.bin.tmp')}'`), { code: 'ENOSPC' });
      },
    };
    const store = await create({ fs: failingFs, log });
    await store.write('account', 'new-value');
    // This run keeps the new value; the old one is gone from disk, and no temporary file is left.
    expect(await store.read('account')).toBe('new-value');
    expect(files()).toEqual([]);
    expect(await (await create()).read('account')).toBeNull();
    expect(log).toHaveBeenCalled();
    for (const [message] of log.mock.calls) {
      expect(String(message)).not.toContain('new-value');
      expect(String(message)).not.toContain('old-value');
    }
    // A failing encryptor is the same: kept for the run, nothing stale left.
    await (await create()).write('gsc', 'old-gsc');
    const refusing = await create({ safeStorage: { ...fakeSafeStorage(), encryptStringAsync: vi.fn(() => Promise.reject(new Error('encryption failed'))) }, log });
    // The store is persistent, but this write is not on disk: it says so.
    expect(refusing.persistent).toBe(true);
    expect(await refusing.write('gsc', 'new-gsc')).toBe(false);
    expect(await refusing.read('gsc')).toBe('new-gsc');
    expect(files()).not.toContain('gsc.bin');
  });

  test('secret-reencrypts-when-asked', async () => {
    writeFileSync(path.join((realFs.mkdirSync(dir, { recursive: true }), dir), 'account.bin'), Buffer.concat([Buffer.from('OLD:'), encrypt(SECRET)]));
    const base = fakeSafeStorage();
    const safeStorage: SafeStorageLike = {
      ...base,
      // A blob under the old key decrypts, and asks to be written again with the current one.
      decryptStringAsync: async (encrypted) => {
        const old = encrypted.subarray(0, 4).toString('utf8') === 'OLD:';
        return { shouldReEncrypt: old, result: decrypt(old ? encrypted.subarray(4) : encrypted) };
      },
    };
    const store = await create({ safeStorage });
    expect(await store.read('account')).toBe(SECRET);
    await store.whenIdle();
    expect(base.encryptStringAsync).toHaveBeenCalledExactlyOnceWith(SECRET);
    expect(readFileSync(path.join(dir, 'account.bin')).equals(encrypt(SECRET))).toBe(true);
    // A current blob is left alone.
    expect(await (await create({ safeStorage })).read('account')).toBe(SECRET);
    expect(base.encryptStringAsync).toHaveBeenCalledOnce();
  });

  test('secret-writes-are-ordered', async () => {
    // The encryptor answers in reverse order of the calls: the disk still follows the calls.
    const base = fakeSafeStorage();
    let delay = 30;
    const safeStorage: SafeStorageLike = {
      ...base,
      encryptStringAsync: async (plain) => {
        await new Promise((resolve) => setTimeout(resolve, (delay = Math.max(0, delay - 10))));
        return encrypt(plain);
      },
    };
    const store = await create({ safeStorage });
    expect(store.pending()).toBe(false);
    const writes = [store.write('account', 'first'), store.delete('account'), store.write('account', 'last')];
    // The run reads the newest at once; the disk catches up.
    expect(store.pending()).toBe(true);
    expect(await store.read('account')).toBe('last');
    await store.whenIdle();
    expect(store.pending()).toBe(false);
    await Promise.all(writes);
    expect(decrypt(readFileSync(path.join(dir, 'account.bin')))).toBe('last');
    // A read whose decrypt finishes after a newer write answers the newer value, and keeps it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: SafeStorageLike = {
      ...base,
      decryptStringAsync: async (encrypted) => {
        await gate;
        return base.decryptStringAsync(encrypted);
      },
    };
    const next = await create({ safeStorage: slow });
    const reading = next.read('account');
    const written = next.write('account', 'newer');
    release();
    expect(await reading).toBe('newer');
    await written;
    expect(await next.read('account')).toBe('newer');
    expect(decrypt(readFileSync(path.join(dir, 'account.bin')))).toBe('newer');
  });
});
