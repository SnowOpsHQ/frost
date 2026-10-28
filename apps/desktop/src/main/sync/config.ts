import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import {
  MAX_SYNC_CONFIG_BYTES,
  SYNC_CONFIG_FILE_NAME,
  SYNC_WEAK_STORAGE_BACKENDS,
  syncEndpointProblem,
  syncTokenProblem,
  type SyncConfigFile,
  type SyncConfigProblem,
} from '@app/specs/sync.spec';
import { SyncConfigFileSchema } from '@app/specs/sync-config.schema';
import { readJson } from '../update/manifest';

// The opt-in sync config (spec `sync.spec.ts`, Sync config; acceptance `sync-config.feature.md`):
// `userData/frost-sync.json`, mode 0600 on POSIX, written atomically (a 0600 temporary file in the
// same directory, renamed over it), read strictly (`SyncConfigFileSchema`, no repeated key). A
// tampered file turns sync off for the run and is left alone (one log line, no content).
//
// No `url` is local staging only: rows are mirrored into the local replica and nothing leaves the
// device. The token is stored only as `safeStorage.encryptString` ciphertext (base64), only with a
// `url`, and only when `safeStorage` really encrypts (not when it is unavailable, nor through Linux's
// `basic_text` backend). It is never logged, never in an error, never in the config this store
// answers (`hasToken`), and reaches the service only as a `SyncToken`, which prints as `[redacted]`.
//
// Nothing here turns sync on by itself: this phase has no UI or IPC that calls `write` (it is for
// tests now, and the chrome later).

/** The part of Electron's `safeStorage` the config uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only (Electron). */
  getSelectedStorageBackend?(): string;
}

const REDACTED = '[redacted]';

/** The endpoint's token, as only the service sees it: `reveal()` gives the text; anything else prints `[redacted]`. */
export class SyncToken {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

/** A config refused as written; the message names the problem, never a value. */
export class SyncConfigError extends Error {
  override readonly name = 'SyncConfigError';
  constructor(readonly problem: SyncConfigProblem) {
    super(`sync config refused: ${problem}`);
  }
}

/** The config as the store answers it: never the token. `problem`: why sync is off despite the file. */
export interface SyncConfigView {
  readonly enabled: boolean;
  readonly url?: string;
  readonly hasToken: boolean;
  readonly deviceId?: string;
  readonly problem?: SyncConfigProblem;
}

/** A change to write: an omitted field keeps the stored value, `null` removes it. */
export interface SyncConfigChange {
  readonly enabled: boolean;
  readonly url?: string | null;
  readonly token?: string | null;
}

export interface SyncConfigStore {
  /** The config (off when missing, tampered or unusable). Never rejects. */
  read(): Promise<SyncConfigView>;
  /** The config and, when it is usable and holds one, the decrypted token. Never rejects. */
  load(): Promise<{ readonly config: SyncConfigView; readonly token: SyncToken | null }>;
  /** Writes `change` over the stored config; rejects with `SyncConfigError` (nothing written) when refused. */
  write(change: SyncConfigChange): Promise<SyncConfigView>;
  /** This device's ID, made (and written) the first time. Rejects when the file is missing or tampered. */
  deviceId(): Promise<string>;
}

export interface SyncConfigOptions {
  readonly safeStorage: SafeStorageLike;
  /** One line per problem (never a value from the file). */
  readonly log?: (line: string) => void;
  /** Default `process.platform` (whether the Linux backend is consulted). */
  readonly platform?: NodeJS.Platform;
  /** Default `crypto.randomUUID` (v4). */
  readonly newId?: () => string;
}

/** Read-only, never blocking (a FIFO can't hang startup), never through a final symbolic link (POSIX). */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

type FileRead = { readonly file: SyncConfigFile } | { readonly file: null; readonly problem: 'missing' | 'tampered' | 'unreadable' };
const TAMPERED: FileRead = { file: null, problem: 'tampered' };
const UNREADABLE: FileRead = { file: null, problem: 'unreadable' };

async function readConfigFile(file: string, posix: boolean): Promise<FileRead> {
  try {
    if (!(await lstat(file)).isFile()) return TAMPERED;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { file: null, problem: 'missing' } : UNREADABLE;
  }
  let handle;
  try {
    handle = await open(file, READ_FLAGS);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP' ? TAMPERED : UNREADABLE;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SYNC_CONFIG_BYTES) return TAMPERED;
    const buffer = Buffer.alloc(MAX_SYNC_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SYNC_CONFIG_BYTES) return TAMPERED;
    const json = readJson(buffer.subarray(0, bytesRead));
    if (!json.ok) return TAMPERED;
    const parsed = SyncConfigFileSchema.safeParse(json.value);
    if (!parsed.success) return TAMPERED;
    // Through the handle, so it is the file just read that is narrowed.
    if (posix && (info.mode & 0o077) !== 0) await handle.chmod(0o600).catch(() => undefined);
    return { file: parsed.data };
  } catch {
    return UNREADABLE;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeAtomically(file: string, config: SyncConfigFile): Promise<void> {
  const checked = SyncConfigFileSchema.parse(config);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const viewOf = (file: SyncConfigFile, problem?: SyncConfigProblem): SyncConfigView => ({
  enabled: problem === undefined && file.enabled,
  ...(file.url === undefined ? {} : { url: file.url }),
  hasToken: file.encryptedToken !== undefined,
  ...(file.deviceId === undefined ? {} : { deviceId: file.deviceId }),
  ...(problem === undefined ? {} : { problem }),
});

/** The sync config in `userData/SYNC_CONFIG_FILE_NAME` (see the top of this file). */
export function createSyncConfigStore(userData: string, options: SyncConfigOptions): SyncConfigStore {
  const file = path.join(userData, SYNC_CONFIG_FILE_NAME);
  const { safeStorage } = options;
  const log = options.log ?? (() => undefined);
  const platform = options.platform ?? process.platform;
  const posix = platform !== 'win32';
  const newId = options.newId ?? (() => randomUUID());
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Why `safeStorage` can't hold a token here, or `null`. */
  const encryptionProblem = (): SyncConfigProblem | null => {
    if (!safeStorage.isEncryptionAvailable()) return 'encryption-unavailable';
    if (platform === 'linux' && (SYNC_WEAK_STORAGE_BACKENDS as readonly string[]).includes(safeStorage.getSelectedStorageBackend?.() ?? '')) return 'encryption-weak';
    return null;
  };

  const readFile = async (): Promise<FileRead> => {
    const read = await readConfigFile(file, posix);
    if (read.file === null && read.problem === 'tampered') log('sync config is not valid; sync is off for this run (the file is left as it is)');
    if (read.file === null && read.problem === 'unreadable') log('sync config could not be read; sync is off for this run');
    return read;
  };

  const load = async (): Promise<{ config: SyncConfigView; token: SyncToken | null }> => {
    const read = await readFile();
    if (read.file === null) return { config: read.problem === 'tampered' ? { enabled: false, hasToken: false, problem: 'tampered' } : { enabled: false, hasToken: false }, token: null };
    const stored = read.file;
    if (stored.encryptedToken === undefined) return { config: viewOf(stored), token: null };
    const problem = encryptionProblem();
    if (problem !== null) {
      log(`sync is off for this run: the stored token can't be read (${problem})`);
      return { config: viewOf(stored, problem), token: null };
    }
    try {
      const text = safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64'));
      if (syncTokenProblem(text) !== null) throw new Error('not a token');
      return { config: viewOf(stored), token: new SyncToken(text) };
    } catch {
      log('sync is off for this run: the stored token could not be decrypted');
      return { config: viewOf(stored, 'token-undecryptable'), token: null };
    }
  };

  return {
    read: () => serial(async () => (await load()).config),
    load: () => serial(load),
    write: (change) =>
      serial(async () => {
        const read = await readConfigFile(file, posix);
        const current: SyncConfigFile = read.file ?? { enabled: false };
        const url = change.url === undefined ? current.url : (change.url ?? undefined);
        if (url !== undefined && syncEndpointProblem(url) !== null) throw new SyncConfigError('endpoint-invalid');
        let encryptedToken = change.token === undefined ? current.encryptedToken : undefined;
        if (typeof change.token === 'string') {
          if (syncTokenProblem(change.token) !== null) throw new SyncConfigError('token-invalid');
          if (url === undefined) throw new SyncConfigError('token-needs-endpoint');
          const problem = encryptionProblem();
          if (problem !== null) throw new SyncConfigError(problem);
          encryptedToken = safeStorage.encryptString(change.token).toString('base64');
        }
        if (encryptedToken !== undefined && url === undefined) throw new SyncConfigError('token-needs-endpoint');
        const next: SyncConfigFile = {
          enabled: change.enabled,
          ...(url === undefined ? {} : { url }),
          ...(encryptedToken === undefined ? {} : { encryptedToken }),
          ...(current.deviceId === undefined ? {} : { deviceId: current.deviceId }),
        };
        await writeAtomically(file, next);
        return viewOf(next);
      }),
    deviceId: () =>
      serial(async () => {
        const read = await readFile();
        if (read.file === null) throw new Error(`sync config is ${read.problem}`);
        if (read.file.deviceId !== undefined) return read.file.deviceId;
        const deviceId = newId();
        await writeAtomically(file, { ...read.file, deviceId });
        return deviceId;
      }),
  };
}
