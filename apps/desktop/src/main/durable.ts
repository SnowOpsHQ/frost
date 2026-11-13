import path from 'node:path';

// Durable writes for main's small files (the agent's, Task 3 review; the skills export and
// `private-file.ts`, through `writeFileAtomically`): after a new file is renamed over the
// old one, the directory is flushed too, so the rename itself survives a crash. Best effort: some
// platforms refuse to open or flush a directory (Windows answers EISDIR or EPERM), and the file's
// own data was flushed before the rename either way. The rename itself is tried again on Windows
// when another program has a file open for a moment (`renameOver`).

/** The part of `node:fs/promises` the directory flush uses. */
export interface DirectorySync {
  open?(file: string, flags: 'r'): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
}

/** Flushes the directory holding `file`; never rejects. */
export async function syncDirectoryOf(fs: DirectorySync, file: string): Promise<void> {
  if (typeof fs.open !== 'function') return;
  let handle: { sync(): Promise<void>; close(): Promise<void> } | undefined;
  try {
    handle = await fs.open(path.dirname(file), 'r');
    await handle.sync();
  } catch {
    // Not supported here (EISDIR, EPERM, EINVAL): the rename stands, unflushed.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * What Windows answers a rename while another program has either file open: a virus scanner or an
 * indexer reading the file just written, or anything reading the one being replaced.
 */
const BUSY_RENAME_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];

/** The waits between tries of a rename Windows refused as busy: seven more tries, about 1.3 s in all. */
export const RENAME_RETRY_WAITS_MS = [10, 20, 40, 80, 160, 320, 640] as const;

/**
 * Renames `from` over `to`. On Windows a rename refused because a file is busy
 * (`BUSY_RENAME_CODES`) is tried again after each of `RENAME_RETRY_WAITS_MS`; the last refusal, any
 * other error, and every error on other platforms (where these codes mean a real refusal) reject at
 * once.
 */
export async function renameOver(
  fs: { rename(from: string, to: string): Promise<void> },
  from: string,
  to: string,
  options: { readonly platform?: NodeJS.Platform; readonly wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const waitMs = RENAME_RETRY_WAITS_MS[attempt];
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (platform !== 'win32' || waitMs === undefined || typeof code !== 'string' || !BUSY_RENAME_CODES.includes(code)) throw error;
      await wait(waitMs);
    }
  }
}

/** The file operations an atomic write uses (`node:fs/promises` in main). */
export interface AtomicWriteFs extends DirectorySync {
  /** Writes a new file (`wx`) and flushes it to disk before resolving (`flush`). */
  writeFile(file: string, data: string, options: { readonly mode: number; readonly flag: 'wx'; readonly flush: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { readonly force: true }): Promise<void>;
}

/** Writes `text` to `file` atomically: a new owner-only file beside it, flushed, renamed over it. Removes the temporary file on failure. */
export async function writeFileAtomically(fs: AtomicWriteFs, file: string, text: string, suffix: string): Promise<boolean> {
  const temp = `${file}.${suffix}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx', flush: true });
    await renameOver(fs, temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
  await syncDirectoryOf(fs, file);
  return true;
}
