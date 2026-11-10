// Spec: specs/diagnostics.spec.ts (DIAGNOSTICS_SAVE_DIALOG)
// Acceptance: specs/diagnostics.feature.md (End to end: the file is written with mode 0600, also over an existing file)
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { writeReport } from '../main';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

test('report-file-is-private-even-when-overwritten', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frost-diagnostics-write-'));
  try {
    const file = path.join(dir, 'report.txt');
    await writeFile(file, 'old', { mode: 0o644 });
    await writeReport(file, 'frost diagnostics report\n');
    expect(await readFile(file, 'utf8')).toBe('frost diagnostics report\n');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const fresh = path.join(dir, 'fresh.txt');
    await writeReport(fresh, 'x\n');
    if (process.platform !== 'win32') expect((await stat(fresh)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
