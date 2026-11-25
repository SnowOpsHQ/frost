// Spec: specs/agent-host.feature.md (Credentials, Settings: durable writes; rename-over-sync-waits-for-a-busy-file)
import { expect, test } from 'vitest';
import { RENAME_RETRY_WAITS_MS, renameOverSync } from '../rename-over-sync';

test('rename-over-sync-waits-for-a-busy-file', () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  /** A rename that fails with each of `failures` in turn, then succeeds; what was asked and waited. */
  const run = (failures: readonly Error[], platform: NodeJS.Platform) => {
    const left = [...failures];
    let renames = 0;
    const waits: number[] = [];
    const fs = {
      renameSync: () => {
        renames += 1;
        const failure = left.shift();
        if (failure) throw failure;
      },
    };
    let outcome = 'renamed';
    try {
      renameOverSync(fs, 'a.tmp', 'a', { platform, wait: (ms) => void waits.push(ms) });
    } catch (error) {
      outcome = (error as Error).message;
    }
    return { outcome, renames, waits };
  };

  // Windows: a busy file (each code it uses for one) is waited for, with a longer wait each time.
  expect(run([coded('EPERM'), coded('EBUSY'), coded('EACCES')], 'win32')).toEqual({ outcome: 'renamed', renames: 4, waits: [10, 20, 40] });
  // A file that stays busy is given up on after the last wait, with the last refusal.
  const stuck = RENAME_RETRY_WAITS_MS.map(() => coded('EPERM'));
  expect(run([...stuck, coded('EBUSY')], 'win32')).toEqual({ outcome: 'EBUSY', renames: RENAME_RETRY_WAITS_MS.length + 1, waits: [...RENAME_RETRY_WAITS_MS] });
  // Any other error is final at once, on Windows too.
  expect(run([coded('ENOENT')], 'win32')).toEqual({ outcome: 'ENOENT', renames: 1, waits: [] });
  expect(run([new Error('no code')], 'win32')).toEqual({ outcome: 'no code', renames: 1, waits: [] });
  // Elsewhere these codes are a real refusal: never retried.
  for (const platform of ['linux', 'darwin'] as const) {
    expect(run([coded('EPERM')], platform)).toEqual({ outcome: 'EPERM', renames: 1, waits: [] });
  }
  // The first try succeeding waits for nothing.
  expect(run([], 'win32')).toEqual({ outcome: 'renamed', renames: 1, waits: [] });
});

test('rename-over-sync-really-waits', () => {
  // The default wait blocks the thread for about the time asked.
  const failures = [Object.assign(new Error('EBUSY'), { code: 'EBUSY' })];
  const started = performance.now();
  renameOverSync({ renameSync: () => { const failure = failures.shift(); if (failure) throw failure; } }, 'a', 'b', { platform: 'win32' });
  expect(performance.now() - started).toBeGreaterThanOrEqual(RENAME_RETRY_WAITS_MS[0] - 1);
});
