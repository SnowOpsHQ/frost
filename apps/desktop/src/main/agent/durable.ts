import path from 'node:path';

// Durable writes for the agent's small files (Task 3 review): after a new file is renamed over the
// old one, the directory is flushed too, so the rename itself survives a crash. Best effort: some
// platforms refuse to open or flush a directory (Windows answers EISDIR or EPERM), and the file's
// own data was flushed before the rename either way.

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
