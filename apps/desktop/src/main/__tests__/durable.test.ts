// Spec: specs/agent-host.feature.md (Credentials, Settings: durable writes)
import { expect, test } from 'vitest';
import { RENAME_RETRY_WAITS_MS, renameOver, syncDirectoryOf } from '../durable';

test('directory-sync-best-effort', async () => {
  const done: string[] = [];
  await syncDirectoryOf({ open: async (file) => ({ sync: async () => void done.push(`sync ${file}`), close: async () => void done.push('close') }) }, '/user-data/agent-credentials.json');
  expect(done).toEqual(['sync /user-data', 'close']);
  // A platform that refuses to open or flush a directory: ignored, the handle still closed.
  await expect(syncDirectoryOf({ open: () => Promise.reject(Object.assign(new Error('EISDIR'), { code: 'EISDIR' })) }, '/x/f')).resolves.toBeUndefined();
  const closed: string[] = [];
  await expect(syncDirectoryOf({ open: async () => ({ sync: () => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })), close: async () => void closed.push('close') }) }, '/x/f')).resolves.toBeUndefined();
  expect(closed).toEqual(['close']);
  // No `open` at all: nothing to do.
  await expect(syncDirectoryOf({}, '/x/f')).resolves.toBeUndefined();
});

test('rename-waits-for-a-busy-file', async () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  /** A rename that fails with each of `failures` in turn, then succeeds; what was asked and waited. */
  const run = async (failures: readonly Error[], platform: NodeJS.Platform) => {
    const left = [...failures];
    const renames: string[] = [];
    const waits: number[] = [];
    const fs = {
      rename: async (from: string, to: string) => {
        renames.push(`${from} -> ${to}`);
        const failure = left.shift();
        if (failure) throw failure;
      },
    };
    const outcome = await renameOver(fs, 'a.tmp', 'a', { platform, wait: async (ms) => void waits.push(ms) }).then(
      () => 'renamed',
      (error: Error) => error.message,
    );
    return { outcome, renames: renames.length, waits };
  };

  // Windows: a busy file (each code it uses for one) is waited for, with a longer wait each time.
  expect(await run([coded('EPERM'), coded('EBUSY'), coded('EACCES')], 'win32')).toEqual({ outcome: 'renamed', renames: 4, waits: [10, 20, 40] });
  // A file that stays busy is given up on after the last wait, with the last refusal.
  const stuck = RENAME_RETRY_WAITS_MS.map(() => coded('EPERM'));
  expect(await run([...stuck, coded('EBUSY')], 'win32')).toEqual({ outcome: 'EBUSY', renames: RENAME_RETRY_WAITS_MS.length + 1, waits: [...RENAME_RETRY_WAITS_MS] });
  expect(RENAME_RETRY_WAITS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(2_000);
  // Any other error is final at once, on Windows too.
  expect(await run([coded('ENOENT')], 'win32')).toEqual({ outcome: 'ENOENT', renames: 1, waits: [] });
  expect(await run([new Error('no code')], 'win32')).toEqual({ outcome: 'no code', renames: 1, waits: [] });
  // Elsewhere these codes are a real refusal: never retried.
  for (const platform of ['linux', 'darwin'] as const) {
    expect(await run([coded('EPERM')], platform)).toEqual({ outcome: 'EPERM', renames: 1, waits: [] });
  }
  // The first try succeeding waits for nothing.
  expect(await run([], 'win32')).toEqual({ outcome: 'renamed', renames: 1, waits: [] });
});
