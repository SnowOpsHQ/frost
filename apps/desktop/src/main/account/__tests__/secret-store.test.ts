// Spec: specs/secret-store.spec.ts (SECRET_NAMES, SECRET_FILE_SUFFIX, SECRET_TEMP_SUFFIX, SECRET_FILE_MODE,
// SECRETS_DIR_MODE, MAX_SECRET_CHARS, INSECURE_LINUX_BACKENDS)
// Acceptance: specs/entitlements-client.feature.md (Secret store) · plan decision "Secrets need a real keychain"
import * as realFs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_SECRET_CHARS, SECRET_FILE_MODE, SECRET_NAMES, SECRETS_DIR_MODE } from '@app/specs/secret-store.spec';
import { createSecretStore, type SafeStorageLike, type SecretStoreFs } from '../secret-store';

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

/** A stand-in for Electron's `safeStorage`: reversible, recognisable, and never the plain text. */
function fakeSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageLike & { encryptString: ReturnType<typeof vi.fn> } {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'gnome_libsecret',
    encryptString: vi.fn((plain: string) => Buffer.concat([MAGIC, Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)])),
    decryptString: (encrypted: Buffer) => {
      if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(encrypted.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8');
    },
  };
}

const ready = () => true;
const files = () => (existsSync(dir) ? readdirSync(dir).sort() : []);
const mode = (file: string) => statSync(file).mode & 0o777;

describe('secret store', () => {
  test('secret-round-trip', () => {
    const log = vi.fn();
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' });
    expect(store.persistent).toBe(true);
    expect(store.read('account')).toBeNull();
    store.write('account', SECRET);
    expect(store.read('account')).toBe(SECRET);
    expect(files()).toEqual(['account.bin']);
    const onDisk = readFileSync(path.join(dir, 'account.bin'));
    expect(onDisk.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(onDisk.toString('utf8')).not.toContain(SECRET);
    // A new instance (the next run) reads it back.
    const next = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' });
    expect(next.read('account')).toBe(SECRET);
    next.write('account', 'second');
    expect(createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' }).read('account')).toBe('second');
    // Other platforms have no storage backend to ask about.
    const mac = createSecretStore({ dir, isReady: ready, safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('linux only'); } }, log, platform: 'darwin' });
    expect(mac.persistent).toBe(true);
    expect(mac.read('account')).toBe('second');
    expect(log).not.toHaveBeenCalled();
  });

  test('secret-file-modes', () => {
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' });
    store.write('gsc', SECRET);
    store.write('entitlements', '{}');
    expect(mode(dir)).toBe(SECRETS_DIR_MODE);
    expect(mode(path.join(dir, 'gsc.bin'))).toBe(SECRET_FILE_MODE);
    expect(mode(path.join(dir, 'entitlements.bin'))).toBe(SECRET_FILE_MODE);
    expect(files()).toEqual(['entitlements.bin', 'gsc.bin']);
    // An existing directory with looser permissions is tightened.
    rmSync(dir, { recursive: true });
    realFs.mkdirSync(dir, { mode: 0o755 });
    realFs.chmodSync(dir, 0o755);
    createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' }).write('account', SECRET);
    expect(mode(dir)).toBe(SECRETS_DIR_MODE);
  });

  test('basic-text-is-memory-only', () => {
    const safeStorage = fakeSafeStorage({ backend: 'basic_text' });
    const store = createSecretStore({ dir, isReady: ready, safeStorage, log: vi.fn(), platform: 'linux' });
    expect(store.persistent).toBe(false);
    store.write('account', SECRET);
    expect(store.read('account')).toBe(SECRET);
    expect(existsSync(dir)).toBe(false);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    // The next run starts empty.
    expect(createSecretStore({ dir, isReady: ready, safeStorage, log: vi.fn(), platform: 'linux' }).read('account')).toBeNull();
    store.delete('account');
    expect(store.read('account')).toBeNull();
  });

  test('unknown-backend-is-memory-only', () => {
    for (const safeStorage of [fakeSafeStorage({ backend: 'unknown' }), { ...fakeSafeStorage(), getSelectedStorageBackend: () => { throw new Error('not ready'); } }]) {
      const store = createSecretStore({ dir, isReady: ready, safeStorage, log: vi.fn(), platform: 'linux' });
      expect(store.persistent).toBe(false);
      store.write('gsc', SECRET);
      expect(store.read('gsc')).toBe(SECRET);
      expect(existsSync(dir)).toBe(false);
    }
  });

  test('encryption-unavailable-is-memory-only', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const safeStorage = fakeSafeStorage({ available: false });
      const store = createSecretStore({ dir, isReady: ready, safeStorage, log: vi.fn(), platform });
      expect(store.persistent, platform).toBe(false);
      store.write('account', SECRET);
      expect(store.read('account')).toBe(SECRET);
      expect(existsSync(dir)).toBe(false);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    }
    // A blob left by an earlier run with a keychain is not read (nor removed) without one.
    createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' }).write('account', SECRET);
    const without = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage({ available: false }), log: vi.fn(), platform: 'linux' });
    expect(without.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
  });

  test('undecryptable-secret-is-kept', () => {
    const log = vi.fn();
    createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' }).write('account', SECRET);
    const original = readFileSync(path.join(dir, 'account.bin'));
    // The next run starts with the keyring locked: decryption fails, nothing has worked yet.
    let locked = true;
    const base = fakeSafeStorage();
    const safeStorage: SafeStorageLike = {
      ...base,
      decryptString: (encrypted) => {
        if (locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
        return base.decryptString(encrypted);
      },
    };
    const store = createSecretStore({ dir, isReady: ready, safeStorage, log, platform: 'linux' });
    expect(store.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
    expect(readFileSync(path.join(dir, 'account.bin')).equals(original)).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain('account');
    expect(message).not.toContain(SECRET);
    // Unlocked later in the run: the value is there.
    locked = false;
    expect(store.read('account')).toBe(SECRET);
  });

  test('corrupt-secret-is-deleted', () => {
    const log = vi.fn();
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' });
    realFs.mkdirSync(dir, { recursive: true });
    // An empty file is never a stored value: deleted at once.
    writeFileSync(path.join(dir, 'gsc.bin'), Buffer.alloc(0));
    expect(store.read('gsc')).toBeNull();
    expect(files()).toEqual([]);
    // Garbage before the keychain proved itself: kept.
    writeFileSync(path.join(dir, 'account.bin'), `garbage ${SECRET}`);
    expect(store.read('account')).toBeNull();
    expect(files()).toEqual(['account.bin']);
    // Once a decrypt (or encrypt) worked in this run, garbage is corrupt: deleted.
    store.write('entitlements', '{}');
    expect(store.read('account')).toBeNull();
    expect(files()).toEqual(['entitlements.bin']);
    for (const [message] of log.mock.calls) {
      expect(String(message)).not.toContain(SECRET);
      expect(String(message)).not.toContain('garbage');
    }
    // A blob that decrypts to more than a stored value can be is deleted too.
    const next = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' });
    writeFileSync(path.join(dir, 'gsc.bin'), fakeSafeStorage().encryptString('x'.repeat(MAX_SECRET_CHARS + 1)) as Buffer);
    expect(next.read('gsc')).toBeNull();
    expect(files()).toEqual(['entitlements.bin']);
  });

  test('secret-store-needs-app-ready', () => {
    expect(() => createSecretStore({ dir, isReady: () => false, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' })).toThrow(/ready/);
    expect(existsSync(dir)).toBe(false);
  });

  test('secret-names-allowlisted', () => {
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' });
    for (const name of ['../account', 'account.bin', 'tokens', '', 'ACCOUNT', 'constructor', '__proto__', '/etc/passwd']) {
      expect(() => store.write(name as never, SECRET), name).toThrow(/secret name/);
      expect(() => store.read(name as never), name).toThrow(/secret name/);
      expect(() => store.delete(name as never), name).toThrow(/secret name/);
    }
    for (const name of SECRET_NAMES) {
      store.write(name, name);
      expect(store.read(name)).toBe(name);
    }
    expect(() => store.write('account', 'x'.repeat(MAX_SECRET_CHARS + 1))).toThrow(/too long/);
    expect(() => store.write('account', 42 as never)).toThrow(/string/);
    expect(store.read('account')).toBe('account');
  });

  test('secret-delete-and-clear', () => {
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' });
    for (const name of SECRET_NAMES) store.write(name, SECRET);
    store.delete('gsc');
    expect(store.read('gsc')).toBeNull();
    expect(files()).toEqual(['account.bin', 'entitlements.bin']);
    store.delete('gsc');
    writeFileSync(path.join(dir, 'account.bin.abc123.tmp'), 'left over');
    writeFileSync(path.join(dir, 'unrelated.txt'), 'not ours');
    store.clear();
    expect(files()).toEqual(['unrelated.txt']);
    for (const name of SECRET_NAMES) expect(store.read(name)).toBeNull();
    expect(createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' }).read('account')).toBeNull();
    // Memory-only too.
    const memory = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage({ backend: 'basic_text' }), log: vi.fn(), platform: 'linux' });
    memory.write('account', SECRET);
    memory.clear();
    expect(memory.read('account')).toBeNull();
  });

  test('failed-write-leaves-no-stale-value', () => {
    const log = vi.fn();
    createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log, platform: 'linux' }).write('account', 'old-value');
    const failingFs: SecretStoreFs = {
      ...realFs,
      renameSync: () => {
        throw Object.assign(new Error(`ENOSPC: no space left, rename '${path.join(dir, 'account.bin.tmp')}'`), { code: 'ENOSPC' });
      },
    };
    const store = createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), fs: failingFs, log, platform: 'linux' });
    store.write('account', 'new-value');
    // This run keeps the new value; the old one is gone from disk, and no temporary file is left.
    expect(store.read('account')).toBe('new-value');
    expect(files()).toEqual([]);
    expect(createSecretStore({ dir, isReady: ready, safeStorage: fakeSafeStorage(), log: vi.fn(), platform: 'linux' }).read('account')).toBeNull();
    expect(log).toHaveBeenCalled();
    for (const [message] of log.mock.calls) {
      expect(String(message)).not.toContain('new-value');
      expect(String(message)).not.toContain('old-value');
    }
  });
});
