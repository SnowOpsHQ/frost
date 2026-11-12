import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { writeFileAtomically } from './durable';

// A file main writes for the user that may hold what they would not share (a chat export, Phase 5
// Task 9; Export Diagnostics, Phase 11 Task 12; the network export, Task 4): readable by them alone
// where the platform has modes.

/**
 * Writes `text` to `file` owner-only (mode 0600) and atomically, as a skills export: a new file
 * beside it, flushed, renamed over it. `mode` applies only to a new file, so an existing one is never
 * written in place (its mode would stay, and the text would sit in it); Windows has no such modes.
 * Rejects if the file could not be written.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  if (!(await writeFileAtomically(fs, file, text, `${process.pid}-${randomUUID()}`))) throw new Error('the file could not be written');
}
