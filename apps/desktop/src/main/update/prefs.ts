import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PREFS_BYTES, UPDATE_PREFS_FILE, UPDATE_PREFS_FORMAT, type UpdatePrefs } from '@app/specs/update-client.spec';
import { UpdatePrefsSchema } from '@app/specs/update-client.schema';
import { readJson } from './manifest';

// The update client's prefs (spec `update-client.spec.ts`, Prefs; `update-client.feature.md`,
// `prefs-defaults`, `prefs-round-trip`, `prefs-tamper-resets`): one small JSON file,
// `userData/frost-update.json`, mode 0600 on POSIX, written atomically (a temporary file in the same
// directory, renamed over the old one). Anything that does not parse as `UpdatePrefsSchema` (with
// no repeated key) is replaced by the defaults, a new install ID included, and rewritten. The
// install ID never leaves this file and the rollout bucket computed from it.

export interface UpdatePrefsStore {
  /** The prefs (defaults, written, when the file is missing or invalid). Never rejects. */
  read(): Promise<UpdatePrefs>;
  /** Writes `prefs` atomically (writes run one at a time, in call order); rejects on a disk error. */
  write(prefs: UpdatePrefs): Promise<void>;
}

const POSIX = process.platform !== 'win32';

const defaults = (newId: () => string): UpdatePrefs => ({ format: UPDATE_PREFS_FORMAT, installId: newId(), checks: 'on' });

/** The file's prefs, or `null` when it is missing, unreadable or invalid (and whether its mode is lax). */
async function readFile(file: string): Promise<{ prefs: UpdatePrefs | null; laxMode: boolean }> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return { prefs: null, laxMode: false };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PREFS_BYTES) return { prefs: null, laxMode: false };
    const buffer = Buffer.alloc(MAX_PREFS_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PREFS_BYTES) return { prefs: null, laxMode: false };
    const json = readJson(buffer.subarray(0, bytesRead));
    if (!json.ok) return { prefs: null, laxMode: false };
    const parsed = UpdatePrefsSchema.safeParse(json.value);
    if (!parsed.success) return { prefs: null, laxMode: false };
    // Optional keys present as `undefined` are dropped by JSON anyway; keep the object minimal.
    const prefs: UpdatePrefs = { format: parsed.data.format, installId: parsed.data.installId, checks: parsed.data.checks };
    if (parsed.data.skippedVersion !== undefined) prefs.skippedVersion = parsed.data.skippedVersion;
    if (parsed.data.highWaterMark !== undefined) prefs.highWaterMark = { ...parsed.data.highWaterMark };
    return { prefs, laxMode: POSIX && (info.mode & 0o077) !== 0 };
  } catch {
    return { prefs: null, laxMode: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Writes `prefs` to `file` through a temporary file (mode 0600, flushed) renamed over it. */
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
  if (POSIX) await chmod(file, 0o600).catch(() => undefined);
}

/** The prefs in `userData/UPDATE_PREFS_FILE`. `newId` (tests) defaults to `crypto.randomUUID` (v4). */
export function createPrefsStore(userData: string, options: { newId?: () => string } = {}): UpdatePrefsStore {
  const file = path.join(userData, UPDATE_PREFS_FILE);
  const newId = options.newId ?? (() => randomUUID());
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `task` after every earlier write (a failed one does not stop the next). */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    read: () =>
      serial(async () => {
        const { prefs, laxMode } = await readFile(file);
        if (prefs !== null) {
          if (laxMode) await chmod(file, 0o600).catch(() => undefined);
          return prefs;
        }
        const fresh = defaults(newId);
        // Best effort: an unwritable file still gives usable prefs for this run.
        await writeAtomically(file, fresh).catch(() => undefined);
        return fresh;
      }),
    write: (prefs) => serial(() => writeAtomically(file, prefs)),
  };
}
