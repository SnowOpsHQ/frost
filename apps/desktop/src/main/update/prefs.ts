import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PREFS_BYTES, UPDATE_PREFS_FILE, UPDATE_PREFS_FORMAT, type UpdatePrefs } from '@app/specs/update-client.spec';
import { UpdatePrefsSchema } from '@app/specs/update-client.schema';
import { readJson } from './manifest';

// The update client's prefs (spec `update-client.spec.ts`, Prefs; `update-client.feature.md`,
// `prefs-defaults`, `prefs-round-trip`, `prefs-update-in-order`, `prefs-not-a-file`,
// `prefs-tamper-resets`): one small JSON file, `userData/frost-update.json`, mode 0600 on POSIX,
// written atomically (a temporary file in the same directory, created 0600, renamed over the old
// one). Anything but a regular file (a FIFO, a symbolic link, a directory), or anything that does
// not parse as `UpdatePrefsSchema` with no repeated key, is replaced by the defaults (a new install
// ID included), rewritten, and logged in one line. A file that is there but can't be read (EACCES,
// EMFILE, EIO…) is never replaced: this run uses in-memory defaults and writes nothing, so the file's
// install ID and high-water mark are still there next run (`prefs-unreadable-kept`). The install ID
// never leaves this file and the rollout bucket computed from it.
//
// Every change goes through `update(change)`: `change` runs inside the store's serial queue against
// the latest prefs, so two overlapping changes (a check raising the mark while the user turns checks
// off) both land.

export interface UpdatePrefsStore {
  /** The prefs (defaults, written, when the file is missing or invalid). Never rejects. */
  read(): Promise<UpdatePrefs>;
  /**
   * Applies `change` to the latest prefs and writes the result atomically, after every earlier
   * read, write and update; answers the prefs written. Rejects on a disk error (the prefs stay as
   * they were).
   */
  update(change: (prefs: UpdatePrefs) => UpdatePrefs): Promise<UpdatePrefs>;
  /** Writes `prefs` as they are (queued like `update`); rejects on a disk error. Setup and tests: the client uses `update`. */
  write(prefs: UpdatePrefs): Promise<void>;
}

const POSIX = process.platform !== 'win32';

/** Read-only, never blocking (a FIFO can't hang startup), never through a final symbolic link (POSIX). */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

const defaults = (newId: () => string): UpdatePrefs => ({ format: UPDATE_PREFS_FORMAT, installId: newId(), checks: 'on' });

/**
 * What reading the file found: its prefs, or why not: `missing` (ENOENT), `invalid` (not a regular
 * file, or its content is not valid prefs: both are reset), `unreadable` (any other error: kept).
 */
type FileRead = { readonly prefs: UpdatePrefs } | { readonly prefs: null; readonly problem: 'missing' | 'invalid' | 'unreadable' };
const INVALID: FileRead = { prefs: null, problem: 'invalid' };
const UNREADABLE: FileRead = { prefs: null, problem: 'unreadable' };

/** `ELOOP` (a symbolic link raced in after the `lstat`, refused by `O_NOFOLLOW`) is a file that isn't a regular one; anything else is an I/O failure. */
const openProblem = (error: unknown): FileRead => ((error as NodeJS.ErrnoException).code === 'ELOOP' ? INVALID : UNREADABLE);

/** The file's prefs (a lax mode fixed to 0600 through the open handle), or why there are none. */
async function readFile(file: string): Promise<FileRead> {
  try {
    if (!(await lstat(file)).isFile()) return INVALID;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { prefs: null, problem: 'missing' } : UNREADABLE;
  }
  let handle;
  try {
    handle = await open(file, READ_FLAGS);
  } catch (error) {
    return openProblem(error);
  }
  try {
    let info;
    let bytesRead: number;
    const buffer = Buffer.alloc(MAX_PREFS_BYTES + 1);
    try {
      info = await handle.stat();
      if (!info.isFile() || info.size > MAX_PREFS_BYTES) return INVALID;
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } catch {
      // EIO and the like: the content was never seen, so it is not judged (nor replaced).
      return UNREADABLE;
    }
    if (bytesRead > MAX_PREFS_BYTES) return INVALID;
    const json = readJson(buffer.subarray(0, bytesRead));
    if (!json.ok) return INVALID;
    const parsed = UpdatePrefsSchema.safeParse(json.value);
    if (!parsed.success) return INVALID;
    const prefs: UpdatePrefs = { format: parsed.data.format, installId: parsed.data.installId, checks: parsed.data.checks };
    if (parsed.data.skippedVersion !== undefined) prefs.skippedVersion = parsed.data.skippedVersion;
    if (parsed.data.highWaterMark !== undefined) prefs.highWaterMark = { ...parsed.data.highWaterMark };
    // Through the handle, so it is the file just read that is fixed, never what a path now names.
    if (POSIX && (info.mode & 0o077) !== 0) await handle.chmod(0o600).catch(() => undefined);
    return { prefs };
  } catch {
    return INVALID;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Writes `prefs` to `file` through a temporary file (created 0600, flushed) renamed over it. */
async function writeAtomically(file: string, prefs: UpdatePrefs): Promise<void> {
  const checked = UpdatePrefsSchema.parse(prefs);
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

/**
 * The prefs in `userData/UPDATE_PREFS_FILE`. `newId` (tests) defaults to `crypto.randomUUID` (v4);
 * `log` gets one line when an invalid file is reset (never the install ID or a path).
 */
export function createPrefsStore(userData: string, options: { newId?: () => string; log?: (line: string) => void } = {}): UpdatePrefsStore {
  const file = path.join(userData, UPDATE_PREFS_FILE);
  const newId = options.newId ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  /** The prefs as last read or written (inside the queue only). */
  let latest: UpdatePrefs | null = null;
  /** The file is there but could not be read: this run keeps its prefs in memory and never writes over it. */
  let memoryOnly = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `task` after every earlier one (a failed one does not stop the next). */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<UpdatePrefs> => {
    const read = await readFile(file);
    memoryOnly = read.prefs === null && read.problem === 'unreadable';
    if (read.prefs !== null) return read.prefs;
    const fresh = defaults(newId);
    if (memoryOnly) {
      log('update prefs could not be read; using defaults for this run without saving');
      return fresh;
    }
    if (read.problem === 'invalid') log('update prefs were not valid and have been reset to the defaults');
    // Best effort: an unwritable file still gives usable prefs for this run.
    await writeAtomically(file, fresh).catch(() => undefined);
    return fresh;
  };
  /** Writes `prefs`, unless this run is in memory only (the unreadable file is left as it is). */
  const save = async (prefs: UpdatePrefs): Promise<void> => {
    if (memoryOnly) UpdatePrefsSchema.parse(prefs);
    else await writeAtomically(file, prefs);
  };

  return {
    read: () =>
      serial(async () => {
        latest = await load();
        return latest;
      }),
    update: (change) =>
      serial(async () => {
        const current = latest ?? (await load());
        latest = current;
        const next = change(current);
        await save(next);
        latest = next;
        return next;
      }),
    write: (prefs) =>
      serial(async () => {
        await save(prefs);
        latest = prefs;
      }),
  };
}
