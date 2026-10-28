import { CREDENTIAL_LIMITS, isCredentialSlot, normalizeKey, type CredentialSlot, type KeyProtection } from '@app/specs/agent-proxy.spec';

// The agent's key store (Phase 5 Task 3, plan decision 1; acceptance `specs/agent-host.feature.md`,
// Credentials): one key per slot (`anthropic`, `openai`, `gateway`), each encrypted with Electron's
// `safeStorage`, all in one file under `userData` (written atomically, mode 0600). A key goes in
// through `setKey` and never comes back out through this API, except to the closure `withKey` runs,
// which only main's model proxy calls: the plaintext lives for the duration of that call, is never
// cached, logged, put in an error, or returned to anyone else. The settings page learns only
// `hasKey` and how well keys are protected (`protection`).
//
// Electron 45 deprecates `safeStorage`'s synchronous API; on Linux its `isEncryptionAvailable()`
// answers `false` where the asynchronous encryptor works, so the store uses the asynchronous one.
// How well that encryptor protects a key shows in its output: on Linux, `v11` data is keyed by the
// desktop's secret service, `v10` by a fixed key built into Chromium (no secret service, or
// `--password-store=basic`; verified on Electron 45), which is `weak`.
//
// A key is stored and used only with `os` protection (Task 3 review). With `weak` protection the
// agent process (which runs unsandboxed, as the user) could decrypt the file offline with
// Chromium's fixed key, or write a blob of its own for main to send: `setKey` refuses
// (`no-keychain`), `withKey` and `hasKey` treat any stored key as absent, and on Linux a stored blob
// must carry the secret service's `v11` tag (a `v10` blob, which anyone can make, is never used).

/** The part of Electron's `safeStorage` the store uses (the asynchronous API). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Uint8Array>;
  decryptStringAsync(encrypted: Buffer): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
}

/** The file operations the store uses (`node:fs/promises` in main; a memory fake in tests). */
export interface CredentialFs {
  readFile(file: string): Promise<Uint8Array>;
  /** Writes a new file (`wx`) and flushes it to disk before resolving (`flush`). */
  writeFile(file: string, data: string, options: { readonly mode: number; readonly flag: 'wx'; readonly flush: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { readonly force: true }): Promise<void>;
}

export interface CredentialStoreDeps {
  readonly safeStorage: SafeStorageLike;
  /** The credentials file (`<userData>/agent-credentials.json`). */
  readonly file: string;
  readonly fs: CredentialFs;
  /** `process.platform` (on Linux the encryptor's key source decides `os` or `weak`). */
  readonly platform?: NodeJS.Platform;
  /** One line per failure (never a key, never an error's text). */
  readonly log?: (line: string) => void;
  /** A random suffix for the temporary file (tests make it fixed). */
  readonly tempSuffix?: () => string;
}

/**
 * `setKey`'s answer: stored; refused as not a key; refused because no OS keychain protects keys
 * here (`protection()` is `weak` or `unavailable`: the settings page says "no OS keychain
 * available"); or failed (encryption, or reading or writing the file).
 */
export type SetKeyResult = 'stored' | 'invalid' | 'no-keychain' | 'failed';

/** `withKey`'s answer: the closure's value, or why it did not run. */
export type WithKeyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'no-key' | 'unavailable' | 'failed' };

/** What the settings page may use: no method here can return a key. */
export interface CredentialSettings {
  /** How well a stored key would be protected here (only `os` stores one; `weak` and `unavailable` say why not). */
  protection(): Promise<KeyProtection>;
  /** Whether the slot holds a key frost can use: stored, protected by the OS keychain, and decrypting. */
  hasKey(slot: CredentialSlot): Promise<boolean>;
  setKey(slot: CredentialSlot, key: string): Promise<SetKeyResult>;
  clearKey(slot: CredentialSlot): Promise<boolean>;
}

export interface CredentialStore extends CredentialSettings {
  /**
   * Runs `fn` with the slot's key (the model proxy only). The key is decrypted for this call and
   * dropped after; `fn` must not keep or return it.
   */
  withKey<T>(slot: CredentialSlot, fn: (key: string) => T | Promise<T>): Promise<WithKeyResult<T>>;
}

interface StoredFile {
  readonly version: 1;
  readonly keys: Partial<Record<CredentialSlot, string>>;
}

const EMPTY: StoredFile = { version: 1, keys: {} };

/** Chromium's tag for data keyed by the desktop's secret service (Linux); `v10` is its fixed key. */
const LINUX_SECRET_SERVICE_TAG = 'v11';
/** A constant encrypted once to see which key the encryptor uses (never stored). */
const PROBE = 'frost-protection-probe';

/** The file's content read back, or empty when missing or not one frost wrote (a tampered file stores nothing). */
function parseStored(bytes: Uint8Array): StoredFile {
  if (bytes.byteLength > CREDENTIAL_LIMITS.maxFileBytes) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return EMPTY;
  }
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1) return EMPTY;
  const keys = (value as { keys?: unknown }).keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return EMPTY;
  const kept: Partial<Record<CredentialSlot, string>> = {};
  for (const [slot, blob] of Object.entries(keys)) {
    if (isCredentialSlot(slot) && typeof blob === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(blob)) kept[slot] = blob;
  }
  return { version: 1, keys: kept };
}

/** A view of `store` for the settings page: no `withKey`, nothing that returns a key. */
export function credentialSettings(store: CredentialSettings): CredentialSettings {
  return {
    protection: () => store.protection(),
    hasKey: (slot) => store.hasKey(slot),
    setKey: (slot, key) => store.setKey(slot, key),
    clearKey: (slot) => store.clearKey(slot),
  };
}

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  const log = deps.log ?? (() => undefined);
  const platform = deps.platform ?? process.platform;
  const tempSuffix = deps.tempSuffix ?? (() => `${process.pid}-${crypto.randomUUID()}`);
  /** The file as last read or written; `null` until read, or after a read failed (read again next time). */
  let loaded: Promise<StoredFile | 'error'> | null = null;
  // Writes run one at a time, each on the latest content.
  let queue: Promise<unknown> = Promise.resolve();
  // Once the encryptor works, its key source doesn't change during a run.
  let known: Exclude<KeyProtection, 'unavailable'> | null = null;

  /** The stored file; `'error'` when it exists but could not be read (nothing is overwritten then). */
  const load = (): Promise<StoredFile | 'error'> => {
    if (loaded !== null) return loaded;
    const reading = deps.fs.readFile(deps.file).then(parseStored, (error: unknown) => {
      if ((error as { code?: unknown }).code === 'ENOENT') return EMPTY;
      log('agent credentials: the key file could not be read');
      // Not remembered: the next call reads again.
      if (loaded === reading) loaded = null;
      return 'error' as const;
    });
    loaded = reading;
    return reading;
  };

  const protection = async (): Promise<KeyProtection> => {
    if (known !== null) return known;
    try {
      if (!(await deps.safeStorage.isAsyncEncryptionAvailable())) return 'unavailable';
      if (platform !== 'linux') return (known = 'os');
      const probe = Buffer.from(await deps.safeStorage.encryptStringAsync(PROBE));
      return (known = probe.subarray(0, LINUX_SECRET_SERVICE_TAG.length).toString('latin1') === LINUX_SECRET_SERVICE_TAG ? 'os' : 'weak');
    } catch {
      return 'unavailable';
    }
  };

  /** Writes `next` atomically (a new 0600 file, then a rename over the old one). */
  const write = async (next: StoredFile): Promise<boolean> => {
    const temp = `${deps.file}.${tempSuffix()}.tmp`;
    try {
      await deps.fs.writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx', flush: true });
      await deps.fs.rename(temp, deps.file);
      loaded = Promise.resolve(next);
      return true;
    } catch {
      log('agent credentials: the key file could not be written');
      await deps.fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
  };

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Encrypts `key` into `slot` (it was normalized); `failed` when encryption or the write fails. */
  const store = async (slot: CredentialSlot, key: string): Promise<'stored' | 'failed'> => {
    let blob: string;
    try {
      blob = Buffer.from(await deps.safeStorage.encryptStringAsync(key)).toString('base64');
    } catch {
      log('agent credentials: encryption failed');
      return 'failed';
    }
    const current = await load();
    if (current === 'error') return 'failed';
    return (await write({ version: 1, keys: { ...current.keys, [slot]: blob } })) ? 'stored' : 'failed';
  };

  /** The slot's key, decrypted, if frost may use it (`os` protection, the right tag, a valid key). */
  const decrypt = async (slot: CredentialSlot): Promise<{ readonly key: string; readonly blob: string; readonly reEncrypt: boolean } | 'no-key' | 'unavailable' | 'failed'> => {
    const current = await load();
    if (current === 'error') return 'failed';
    const blob = current.keys[slot];
    if (blob === undefined) return 'no-key';
    if ((await protection()) !== 'os') return 'unavailable';
    const bytes = Buffer.from(blob, 'base64');
    // On Linux only the secret service's data is trusted (a `v10` blob needs no secret to make).
    if (platform === 'linux' && bytes.subarray(0, LINUX_SECRET_SERVICE_TAG.length).toString('latin1') !== LINUX_SECRET_SERVICE_TAG) return 'failed';
    try {
      const decrypted = await deps.safeStorage.decryptStringAsync(bytes);
      if (normalizeKey(decrypted.result) !== decrypted.result) return 'failed';
      return { key: decrypted.result, blob, reEncrypt: decrypted.shouldReEncrypt };
    } catch {
      log('agent credentials: a stored key could not be decrypted');
      return 'failed';
    }
  };

  return {
    protection,

    async hasKey(slot) {
      if (!isCredentialSlot(slot)) return false;
      // Decrypted to be sure it is usable (the key itself goes nowhere).
      return typeof (await decrypt(slot)) === 'object';
    },

    setKey(slot, key) {
      return serial(async (): Promise<SetKeyResult> => {
        const normalized = normalizeKey(key);
        if (!isCredentialSlot(slot) || normalized === null) return 'invalid';
        if ((await protection()) !== 'os') return 'no-keychain';
        return store(slot, normalized);
      });
    },

    clearKey(slot) {
      return serial(async () => {
        if (!isCredentialSlot(slot)) return false;
        const current = await load();
        if (current === 'error') return false;
        if (current.keys[slot] === undefined) return true;
        const keys = { ...current.keys };
        delete keys[slot];
        return write({ version: 1, keys });
      });
    },

    async withKey(slot, fn) {
      if (!isCredentialSlot(slot)) return { ok: false, reason: 'no-key' };
      const found = await decrypt(slot);
      if (typeof found !== 'object') return { ok: false, reason: found };
      const { key, blob, reEncrypt } = found;
      // The encryptor's key changed (rotated, or a secret service appeared): store it under the new one first.
      if (reEncrypt) {
        await serial(async () => {
          const current = await load();
          if (current !== 'error' && current.keys[slot] === blob) await store(slot, key);
        });
      }
      return { ok: true, value: await fn(key) };
    },
  };
}
