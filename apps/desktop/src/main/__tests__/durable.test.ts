// Spec: specs/agent-host.feature.md (Credentials, Settings: durable writes)
import { expect, test } from 'vitest';
import { syncDirectoryOf } from '../durable';

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
