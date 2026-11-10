import { chmod, writeFile } from 'node:fs/promises';

// A file main writes for the user that may hold what they would not share (Export Diagnostics,
// Phase 11 Task 12; the network export, Task 4): readable by them alone where the platform has modes.

/**
 * Writes `text` to `file` with mode 0600. `mode` applies only to a new file, so an existing one is
 * narrowed after the write; Windows has no such modes, and a failed narrowing never fails the save.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') return;
  try {
    await chmod(file, 0o600);
  } catch {
    // Written; the mode stays as it was.
  }
}
