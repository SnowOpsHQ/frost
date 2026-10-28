import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  INSECURE_LINUX_BACKENDS,
  MAX_SECRET_CHARS,
  SECRET_FILE_MODE,
  SECRET_FILE_SUFFIX,
  SECRET_NAMES,
  SECRET_TEMP_SUFFIX,
  SECRETS_DIR_MODE,
  type SecretName,
} from '@app/specs/secret-store.spec';

// Main's secret store (spec `secret-store.spec.ts`; acceptance `entitlements-client.feature.md`,
// Secret store; plan decision "Secrets need a real keychain"). No Electron import: main passes
// `safeStorage`. Values are strings; on disk each is `safeStorage.encryptString(value)` in
// `<dir>/<name>.bin`, written to a temporary file (owner-only) and renamed over the old one.
// Logs name the blob and an error code, never a value, a ciphertext or a path.

/** What the store uses of Electron's `safeStorage`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only (Electron throws or is absent elsewhere). */
  getSelectedStorageBackend?(): string;
}

/** The synchronous `node:fs` calls the store makes (injectable to simulate failures). */
export type SecretStoreFs = Pick<typeof nodeFs, 'mkdirSync' | 'chmodSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'readdirSync'>;

export interface CreateSecretStoreOptions {
  /** The blobs' directory: main passes `path.join(app.getPath('userData'), SECRETS_DIR_NAME)`. */
  readonly dir: string;
  /**
   * Whether the app is ready (main passes `() => app.isReady()`). Whether the keychain is usable is
   * decided once, at creation, and on Linux `safeStorage` answers wrongly before `ready`; so creating
   * the store earlier throws. Create it after `app.whenReady()`.
   */
  readonly isReady: () => boolean;
  readonly safeStorage: SafeStorageLike;
  readonly fs?: SecretStoreFs;
  readonly log: (message: string) => void;
  /** Defaults to `process.platform`; only Linux has a storage backend to check. */
  readonly platform?: NodeJS.Platform;
}

export interface SecretStore {
  /**
   * Whether values outlive this run (written to disk, encrypted by the OS keychain). `false`:
   * memory-only, because encryption is unavailable or Linux selected `basic_text` / `unknown`.
   */
  readonly persistent: boolean;
  /**
   * The value, or `null` when absent. A blob that does not decrypt is absent: its file is kept while
   * the keychain has not worked yet in this run (it may only be locked; a later read retries), and
   * deleted as corrupt once a decrypt or encrypt has succeeded. An empty file, or one that decrypts
   * to something the store never wrote, is deleted at once.
   */
  read(name: SecretName): string | null;
  /** Stores `value`. A failed disk write keeps it for this run and removes the stale file. */
  write(name: SecretName, value: string): void;
  delete(name: SecretName): void;
  /** Deletes every blob (and stray temporary files). */
  clear(): void;
}

const NAMES: ReadonlySet<string> = new Set(SECRET_NAMES);

function checkName(name: unknown): asserts name is SecretName {
  if (typeof name !== 'string' || !NAMES.has(name)) throw new Error('secret store: unknown secret name');
}

/** A code for the log (`ENOSPC` …): an error's message can carry a path, so it is never logged. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error';
}

/** Whether `safeStorage` really encrypts here (see `INSECURE_LINUX_BACKENDS`). */
export function keychainAvailable(safeStorage: SafeStorageLike, platform: NodeJS.Platform): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return typeof backend === 'string' && !INSECURE_LINUX_BACKENDS.includes(backend);
  } catch {
    return false;
  }
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  const { dir, safeStorage, log } = options;
  if (!options.isReady()) throw new Error('secret store: create it after the app is ready (app.whenReady())');
  const fs = options.fs ?? nodeFs;
  const persistent = keychainAvailable(safeStorage, options.platform ?? process.platform);
  /** Values of this run: every value in memory-only mode, a read-through cache otherwise. */
  const values = new Map<SecretName, string>();
  /** Whether `safeStorage` encrypted or decrypted successfully in this run (the keychain is unlocked). */
  let keychainWorked = false;
  const fileOf = (name: SecretName) => path.join(dir, `${name}${SECRET_FILE_SUFFIX}`);

  const removeFile = (file: string): void => {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      log(`secret store: could not remove a file (${errorCode(error)})`);
    }
  };

  const ensureDir = (): void => {
    fs.mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
    // `mkdir`'s mode is masked by the umask and does not apply to a directory that already exists.
    fs.chmodSync(dir, SECRETS_DIR_MODE);
  };

  const persist = (name: SecretName, value: string): void => {
    const file = fileOf(name);
    const temp = `${file}.${randomBytes(6).toString('hex')}${SECRET_TEMP_SUFFIX}`;
    try {
      const encrypted = safeStorage.encryptString(value);
      keychainWorked = true;
      ensureDir();
      fs.writeFileSync(temp, encrypted, { mode: SECRET_FILE_MODE, flag: 'wx' });
      fs.chmodSync(temp, SECRET_FILE_MODE);
      fs.renameSync(temp, file);
    } catch (error) {
      // Never leave an older value on disk to come back at the next start.
      removeFile(temp);
      removeFile(file);
      log(`secret store: could not write ${name} (${errorCode(error)}); kept for this run only`);
    }
  };

  const load = (name: SecretName): string | null => {
    const file = fileOf(name);
    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') log(`secret store: could not read ${name} (${errorCode(error)})`);
      return null;
    }
    const discard = (): null => {
      log(`secret store: ${name} is corrupt; discarded`);
      removeFile(file);
      return null;
    };
    if (encrypted.length === 0) return discard();
    let value: unknown;
    try {
      value = safeStorage.decryptString(encrypted);
    } catch {
      // Before the keychain worked in this run, it may only be locked (as at login): keep the file.
      if (keychainWorked) return discard();
      log(`secret store: ${name} could not be decrypted (keychain locked?); left in place`);
      return null;
    }
    keychainWorked = true;
    if (typeof value !== 'string' || value.length > MAX_SECRET_CHARS) return discard();
    return value;
  };

  return {
    persistent,
    read(name) {
      checkName(name);
      const known = values.get(name);
      if (known !== undefined) return known;
      if (!persistent) return null;
      const value = load(name);
      if (value !== null) values.set(name, value);
      return value;
    },
    write(name, value) {
      checkName(name);
      if (typeof value !== 'string') throw new Error('secret store: a value must be a string');
      if (value.length > MAX_SECRET_CHARS) throw new Error('secret store: value too long');
      values.set(name, value);
      if (persistent) persist(name, value);
    },
    delete(name) {
      checkName(name);
      values.delete(name);
      if (persistent) removeFile(fileOf(name));
    },
    clear() {
      values.clear();
      if (!persistent) return;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') log(`secret store: could not list the directory (${errorCode(error)})`);
      }
      const ours = (entry: string) => SECRET_NAMES.some((name) => entry === `${name}${SECRET_FILE_SUFFIX}` || (entry.startsWith(`${name}${SECRET_FILE_SUFFIX}.`) && entry.endsWith(SECRET_TEMP_SUFFIX)));
      for (const entry of entries.filter(ours)) removeFile(path.join(dir, entry));
      for (const name of SECRET_NAMES) removeFile(fileOf(name));
    },
  };
}
