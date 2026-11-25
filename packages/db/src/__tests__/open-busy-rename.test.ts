// Spec: specs/browser-session-db.feature.md (Opening: moved-aside-rename-waits-for-a-busy-file)
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CORRUPT_FILE_INFIX, DB_FILE_NAME } from '@app/specs/browser-session-db.spec';

// A rename that Windows refuses once as busy, then lets through.
const busy = vi.hoisted(() => ({ left: 0, seen: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      busy.seen += 1;
      if (busy.left > 0) {
        busy.left -= 1;
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      actual.renameSync(from, to);
    },
  };
});

const { openSessionDatabase } = await import('../open');
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dir: string | undefined;

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (dir) rmSync(dir, { recursive: true, force: true });
  busy.left = 0;
  busy.seen = 0;
});

test('moved-aside-rename-waits-for-a-busy-file', () => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-db-busy-'));
  writeFileSync(path.join(dir, DB_FILE_NAME), 'this is not a database, and long enough to be read as one'.repeat(40));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  busy.left = 1;
  const log = vi.fn();
  const opened = openSessionDatabase({ dir, log, now: () => 1 });
  opened.db.close();
  // The refused rename was tried again, the damaged file is aside, a fresh one is in use.
  expect(busy.seen).toBe(2);
  expect(opened.file).toBe(path.join(dir, DB_FILE_NAME));
  expect(readdirSync(dir).some((name) => name.startsWith(`${DB_FILE_NAME}${CORRUPT_FILE_INFIX}`))).toBe(true);
});
