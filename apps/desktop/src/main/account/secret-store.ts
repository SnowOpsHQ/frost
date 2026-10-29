import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  INSECURE_LINUX_BACKENDS,
  KEYCHAIN_CHECK_TIMEOUT_MS,
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
// `safeStorage`. Values are strings; on disk each is `await safeStorage.encryptStringAsync(value)` in
// `<dir>/<name>.bin`, written to a temporary file (owner-only) and renamed over the old one.
// `safeStorage`'s asynchronous API only: the synchronous calls are deprecated in Electron 45, and on
// Linux `isEncryptionAvailable()` can answer false where the asynchronous encryptor works.
//
// A write or delete changes what this run reads at once (a map of the run's values); the disk follows
// through one queue, in call order, so a write, a delete and a write in a row leave the last on disk.
// A read that has to decrypt a file runs in that queue too, and answers (and keeps) a newer value
// written meanwhile instead of the one it decrypted. `whenIdle()` waits for the disk to catch up (the
// quit waits for it). Logs name the blob and an error code, never a value, a ciphertext or a path.

/** What the store uses of Electron's `safeStorage` (its asynchronous API). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  /** `shouldReEncrypt`: the key rotated (or a better one is available); write the value again. */
  decryptStringAsync(encrypted: Buffer): Promise<{ readonly shouldReEncrypt: boolean; readonly result: string }>;
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
   * the store earlier rejects. Create it after `app.whenReady()`.
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
   * memory-only, because asynchronous encryption is unavailable or Linux selected `basic_text` /
   * `unknown`.
   */
  readonly persistent: boolean;
  /**
   * The value, or `null` when absent. A blob that does not decrypt is absent: its file is kept while
   * the keychain has not worked yet in this run (it may only be locked; a later read retries), and
   * deleted as corrupt once a decrypt or encrypt has succeeded. An empty file, or one that decrypts
   * to something the store never wrote, is deleted at once. A blob whose decrypt answers
   * `shouldReEncrypt` is written again. Throws (synchronously) for an unknown name.
   */
  read(name: SecretName): Promise<string | null>;
  /**
   * Stores `value`: this run reads it at once. Resolves `true` once it is on disk, `false` when it is
   * kept for this run only: a memory-only store, or a failed encrypt or disk write, which also removes
   * the stale file (never rejects). Callers that must not outlive the run with a value only in memory
   * (a grant to revoke at quit) decide from this, not from `persistent`. Throws (synchronously) for an
   * unknown name, a value that is not a string, or one longer than `MAX_SECRET_CHARS`.
   */
  write(name: SecretName, value: string): Promise<boolean>;
  /** Deletes `name`: this run reads `null` at once; resolves once the file is gone (never rejects). */
  delete(name: SecretName): Promise<void>;
  /** Deletes every blob (and stray temporary files). */
  clear(): Promise<void>;
  /** Whether a disk write, delete or read is still queued or running. */
  pending(): boolean;
  /** Resolves once every disk operation queued so far is done. */
  whenIdle(): Promise<void>;
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

/** `isAsyncEncryptionAvailable()`, or `false` when it does not answer within `KEYCHAIN_CHECK_TIMEOUT_MS`. */
function asyncEncryptionAvailable(safeStorage: SafeStorageLike): Promise<boolean> {
  let check: Promise<boolean>;
  try {
    check = Promise.resolve(safeStorage.isAsyncEncryptionAvailable()).then((available) => available === true);
  } catch {
    return Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), KEYCHAIN_CHECK_TIMEOUT_MS)));
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether `safeStorage` really encrypts here (see `INSECURE_LINUX_BACKENDS`): its asynchronous
 * encryptor is available (answering within `KEYCHAIN_CHECK_TIMEOUT_MS`) and, on Linux, the selected
 * backend is a real keyring.
 */
export async function keychainAvailable(safeStorage: SafeStorageLike, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await asyncEncryptionAvailable(safeStorage))) return false;
    if (platform !== 'linux') return true;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return typeof backend === 'string' && !INSECURE_LINUX_BACKENDS.includes(backend);
  } catch {
    return false;
  }
}

export async function createSecretStore(options: CreateSecretStoreOptions): Promise<SecretStore> {
  const { dir, safeStorage, log } = options;
  if (!options.isReady()) throw new Error('secret store: create it after the app is ready (app.whenReady())');
  const fs = options.fs ?? nodeFs;
  const persistent = await keychainAvailable(safeStorage, options.platform ?? process.platform);
  /** Values of this run: every value in memory-only mode, a read-through cache otherwise. */
  const values = new Map<SecretName, string>();
  /** Bumped by every write and delete of a name, so a decrypt that finishes late does not undo one. */
  const generations = new Map<SecretName, number>();
  const generationOf = (name: SecretName): number => generations.get(name) ?? 0;
  const changed = (name: SecretName): void => void generations.set(name, generationOf(name) + 1);
  /** Whether `safeStorage` encrypted or decrypted successfully in this run (the keychain is unlocked). */
  let keychainWorked = false;
  const fileOf = (name: SecretName) => path.join(dir, `${name}${SECRET_FILE_SUFFIX}`);

  // ---- The disk queue: one operation at a time, in call order; none ever rejects ---------------
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  const enqueue = <T>(operation: () => Promise<T> | T, fallback: T): Promise<T> => {
    queued++;
    const run = queue.then(operation).then(
      (value) => value,
      () => fallback,
    );
    queue = run.then(
      () => void queued--,
      () => void queued--,
    );
    return run;
  };

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

  /** Whether `value` reached the disk. */
  const persist = async (name: SecretName, value: string): Promise<boolean> => {
    const file = fileOf(name);
    const temp = `${file}.${randomBytes(6).toString('hex')}${SECRET_TEMP_SUFFIX}`;
    try {
      const encrypted = await safeStorage.encryptStringAsync(value);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('secret store: the keychain answered no ciphertext');
      keychainWorked = true;
      ensureDir();
      fs.writeFileSync(temp, encrypted, { mode: SECRET_FILE_MODE, flag: 'wx' });
      fs.chmodSync(temp, SECRET_FILE_MODE);
      fs.renameSync(temp, file);
      return true;
    } catch (error) {
      // Never leave an older value on disk to come back at the next start.
      removeFile(temp);
      removeFile(file);
      log(`secret store: could not write ${name} (${errorCode(error)}); kept for this run only`);
      return false;
    }
  };

  /** The file's value (`null` when absent or unusable), and whether the keychain asked to re-encrypt it. */
  const load = async (name: SecretName): Promise<{ readonly value: string; readonly reEncrypt: boolean } | null> => {
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
    let answer: { readonly shouldReEncrypt?: unknown; readonly result?: unknown } | null;
    try {
      answer = await safeStorage.decryptStringAsync(encrypted);
    } catch {
      // Before the keychain worked in this run, it may only be locked (as at login): keep the file.
      if (keychainWorked) return discard();
      log(`secret store: ${name} could not be decrypted (keychain locked?); left in place`);
      return null;
    }
    keychainWorked = true;
    const value = answer?.result;
    if (typeof value !== 'string' || value.length > MAX_SECRET_CHARS) return discard();
    return { value, reEncrypt: answer?.shouldReEncrypt === true };
  };

  return {
    persistent,
    read(name) {
      checkName(name);
      const known = values.get(name);
      if (known !== undefined) return Promise.resolve(known);
      if (!persistent) return Promise.resolve(null);
      const started = generationOf(name);
      return enqueue(async () => {
        // Written or deleted since the read was asked for (or read by an earlier call): that answers it.
        if (generationOf(name) !== started || values.has(name)) return values.get(name) ?? null;
        const loaded = await load(name);
        if (generationOf(name) !== started) return values.get(name) ?? null;
        if (loaded === null) return null;
        values.set(name, loaded.value);
        if (loaded.reEncrypt) {
          log(`secret store: ${name} is written again with the current key`);
          await persist(name, loaded.value);
        }
        return loaded.value;
      }, null);
    },
    write(name, value) {
      checkName(name);
      if (typeof value !== 'string') throw new Error('secret store: a value must be a string');
      if (value.length > MAX_SECRET_CHARS) throw new Error('secret store: value too long');
      values.set(name, value);
      changed(name);
      if (!persistent) return Promise.resolve(false);
      return enqueue(() => persist(name, value), false);
    },
    delete(name) {
      checkName(name);
      values.delete(name);
      changed(name);
      if (!persistent) return Promise.resolve();
      return enqueue(() => removeFile(fileOf(name)), undefined);
    },
    clear() {
      values.clear();
      for (const name of SECRET_NAMES) changed(name);
      if (!persistent) return Promise.resolve();
      return enqueue(() => {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(dir);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') log(`secret store: could not list the directory (${errorCode(error)})`);
        }
        const ours = (entry: string) => SECRET_NAMES.some((name) => entry === `${name}${SECRET_FILE_SUFFIX}` || (entry.startsWith(`${name}${SECRET_FILE_SUFFIX}.`) && entry.endsWith(SECRET_TEMP_SUFFIX)));
        for (const entry of entries.filter(ours)) removeFile(path.join(dir, entry));
        for (const name of SECRET_NAMES) removeFile(fileOf(name));
      }, undefined);
    },
    pending: () => queued > 0,
    async whenIdle() {
      while (queued > 0) await queue;
    },
  };
}

/** A store that keeps nothing beyond this run (main's fallback when the real one cannot be created). */
export function memorySecretStore(): SecretStore {
  const values = new Map<SecretName, string>();
  return {
    persistent: false,
    read: (name) => (checkName(name), Promise.resolve(values.get(name) ?? null)),
    write: (name, value) => (checkName(name), values.set(name, value), Promise.resolve(false)),
    delete: (name) => (checkName(name), values.delete(name), Promise.resolve()),
    clear: () => (values.clear(), Promise.resolve()),
    pending: () => false,
    whenIdle: () => Promise.resolve(),
  };
}
