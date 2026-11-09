import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import type { RankCsvCell } from '@app/change-intel';
import { csvCell } from '@app/seo-core';

// The rank CSV as main writes it (Phase 10 Task 5; Decision 14; acceptance `rankings.feature.md`, Export):
// `rankCsvRows`' cells formatted here, never in the renderer. String cells go through `@app/seo-core`
// `csvCell` (the formula guard: queries, URLs and domains are page text, so a cell starting `=`, `+`,
// `-`, `@`, tab or CR gets a leading `'`; RFC 4180 quoting); number cells are written as numbers
// without the guard (`-3` stays `-3`; a number that is not finite is an empty cell). CRLF line ends,
// a final one included. A file is written owner-only (`writeOwnerOnly`), as chat export's is.

/** `rows` as CSV text: one line per row, CRLF, a final CRLF (none for no rows). */
export function rankCsvText(rows: readonly (readonly RankCsvCell[])[]): string {
  if (rows.length === 0) return '';
  const cell = (value: RankCsvCell): string => (typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : csvCell(String(value)));
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Mode changes a file system may refuse (FAT, some network shares): the file is still written. */
const CHMOD_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EINVAL']);

/**
 * Writes `text` to `file` (the one the user chose in main's save dialog) readable by its owner only.
 * Opened without truncating (`O_WRONLY | O_CREAT`, created `0o600`), then set to `0o600` (an existing
 * file too; POSIX only, a file system refusing it with `EPERM`, `ENOTSUP` or `EINVAL` is let be), and
 * only then emptied and written: any other failure stops before an existing file loses its content.
 * `chmod` is the mode change (tests inject a failing one).
 */
export async function writeOwnerOnly(file: string, text: string, chmod: (handle: FileHandle) => Promise<void> = (handle) => handle.chmod(0o600)): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT, 0o600);
  try {
    if (process.platform !== 'win32') {
      try {
        await chmod(handle);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code !== 'string' || !CHMOD_UNSUPPORTED.has(code)) throw error;
      }
    }
    await handle.truncate(0);
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
}
