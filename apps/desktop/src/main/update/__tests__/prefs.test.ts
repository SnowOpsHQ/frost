// Spec: specs/update-client.spec.ts, specs/update-client.schema.ts · Acceptance: specs/update-client.feature.md (Prefs)
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_PREFS_BYTES, UPDATE_PREFS_FILE, type UpdatePrefs } from '@app/specs/update-client.spec';
import { createPrefsStore } from '../prefs';

const POSIX = process.platform !== 'win32';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'frost-update-prefs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, UPDATE_PREFS_FILE);
const onDisk = async () => JSON.parse(await readFile(file(), 'utf8')) as unknown;
const modeOf = async () => (await stat(file())).mode & 0o777;

describe('update prefs', () => {
  test('prefs-defaults', async () => {
    const logs: string[] = [];
    const store = createPrefsStore(dir, { log: (line) => logs.push(line) });
    const first = await store.read();
    // A first run is not a reset: nothing logged.
    expect(logs).toEqual([]);
    expect(first).toEqual({ format: 1, installId: expect.stringMatching(UUID_V4), checks: 'on' });
    expect(await onDisk()).toEqual(first);
    if (POSIX) expect(await modeOf()).toBe(0o600);
    // The same install ID on every later read, from any store over the same directory.
    expect(await createPrefsStore(dir).read()).toEqual(first);
    // Different installs get different IDs.
    const other = await mkdtemp(path.join(os.tmpdir(), 'frost-update-prefs-'));
    try {
      expect((await createPrefsStore(other).read()).installId).not.toBe(first.installId);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test('prefs-round-trip', async () => {
    const store = createPrefsStore(dir);
    const prefs: UpdatePrefs = {
      ...(await store.read()),
      checks: 'off',
      skippedVersion: '1.3.0-beta.1',
      highWaterMark: { version: '1.4.0', releasedAt: '2026-10-28T12:00:00Z' },
    };
    await store.write(prefs);
    expect(await createPrefsStore(dir).read()).toEqual(prefs);
    expect(await onDisk()).toEqual(prefs);
    // Written through a temporary file renamed into place: nothing else is left in the directory.
    expect(await readdir(dir)).toEqual([UPDATE_PREFS_FILE]);
    if (POSIX) {
      // A lax mode is put back to 0600 by the next write and the next read.
      await chmod(file(), 0o644);
      await store.write({ ...prefs, checks: 'on' });
      expect(await modeOf()).toBe(0o600);
      await chmod(file(), 0o666);
      await createPrefsStore(dir).read();
      expect(await modeOf()).toBe(0o600);
    }
    // Concurrent writes land in order.
    await Promise.all([store.write({ ...prefs, checks: 'on' }), store.write({ ...prefs, checks: 'off' })]);
    expect(((await onDisk()) as UpdatePrefs).checks).toBe('off');
    expect(await readdir(dir)).toEqual([UPDATE_PREFS_FILE]);
  });

  test('prefs-update-in-order', async () => {
    const store = createPrefsStore(dir);
    const first = await store.read();
    // Each change runs against the latest prefs, so overlapping changes all land.
    const [a, b] = await Promise.all([
      store.update((prefs) => ({ ...prefs, highWaterMark: { version: '1.3.0', releasedAt: '2026-10-28T12:00:00Z' } })),
      store.update((prefs) => ({ ...prefs, checks: 'off' })),
    ]);
    expect(a).toEqual({ ...first, highWaterMark: { version: '1.3.0', releasedAt: '2026-10-28T12:00:00Z' } });
    expect(b).toEqual({ ...first, checks: 'off', highWaterMark: { version: '1.3.0', releasedAt: '2026-10-28T12:00:00Z' } });
    expect(await onDisk()).toEqual(b);
    // A change that fails to write leaves the prefs as they were.
    const broken = createPrefsStore(path.join(dir, 'missing-directory'));
    const before = await broken.read();
    await expect(broken.update((prefs) => ({ ...prefs, checks: 'off' }))).rejects.toThrow();
    await mkdir(path.join(dir, 'missing-directory'));
    expect(await broken.update((prefs) => prefs)).toEqual(before);
    // An update before any read starts from the file.
    expect(await createPrefsStore(dir).update((prefs) => prefs)).toEqual(b);
  });

  test('prefs-not-a-file', async () => {
    if (!POSIX) return;
    // A FIFO at the prefs path: refused at once (never opened for a blocking read), and replaced.
    execFileSync('mkfifo', [file()]);
    const logs: string[] = [];
    const read = await createPrefsStore(dir, { log: (line) => logs.push(line) }).read();
    expect(read).toEqual({ format: 1, installId: expect.stringMatching(UUID_V4), checks: 'on' });
    expect((await lstat(file())).isFile()).toBe(true);
    expect(logs).toHaveLength(1);
    // A symbolic link to a valid prefs file elsewhere: refused too, and replaced by a regular file.
    const elsewhere = path.join(os.tmpdir(), `frost-update-prefs-target-${process.pid}.json`);
    await writeFile(elsewhere, JSON.stringify({ format: 1, installId: '2f1e6a8e-3c1b-4d5e-9f00-112233445566', checks: 'off' }));
    try {
      await rm(file());
      await symlink(elsewhere, file());
      const viaLink = await createPrefsStore(dir).read();
      expect(viaLink.checks).toBe('on');
      expect((await lstat(file())).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(elsewhere, 'utf8')).checks).toBe('off');
    } finally {
      await rm(elsewhere, { force: true });
    }
  });

  test('prefs-unreadable-kept', async () => {
    // Spec: update-client.feature.md, `prefs-unreadable-kept` (EACCES stands for EMFILE, EIO…).
    if (!POSIX || process.getuid?.() === 0) return;
    const saved: UpdatePrefs = {
      ...(await createPrefsStore(dir).read()),
      highWaterMark: { version: '1.4.0', releasedAt: '2026-10-28T12:00:00Z' },
    };
    await createPrefsStore(dir).write(saved);
    const before = await readFile(file());
    await chmod(file(), 0o000);
    try {
      const logs: string[] = [];
      const store = createPrefsStore(dir, { log: (line) => logs.push(line) });
      const read = await store.read();
      // In-memory defaults for this run (a fresh install ID, no mark), and one log line without the ID or a path.
      expect(read).toEqual({ format: 1, installId: expect.stringMatching(UUID_V4), checks: 'on' });
      expect(read.installId).not.toBe(saved.installId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(read.installId);
      expect(logs[0]).not.toContain(dir);
      // A later change lands in memory only: the unreadable file is never replaced.
      const next = await store.update((prefs) => ({ ...prefs, checks: 'off', highWaterMark: { version: '1.0.0', releasedAt: '2026-10-28T12:00:00Z' } }));
      expect(next.checks).toBe('off');
      expect((await stat(file())).mode & 0o777).toBe(0o000);
      expect(await readdir(dir)).toEqual([UPDATE_PREFS_FILE]);
    } finally {
      await chmod(file(), 0o600);
    }
    // Next run, readable again: the install ID and the high-water mark are still there.
    expect(await readFile(file())).toEqual(before);
    expect(await createPrefsStore(dir).read()).toEqual(saved);
  });

  test('prefs-tamper-resets', async () => {
    const good = await createPrefsStore(dir).read();
    const base = { ...good, highWaterMark: { version: '1.2.0', releasedAt: '2026-10-28T12:00:00Z' } };
    const tampered: [string, string | Buffer][] = [
      ['not json', '{'],
      ['not utf-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])],
      ['an array', '[]'],
      ['null', 'null'],
      ['a repeated key', `{"format":1,"installId":"${good.installId}","checks":"on","checks":"off"}`],
      ['an unknown key', JSON.stringify({ ...base, extra: 1 })],
      ['another format', JSON.stringify({ ...base, format: 2 })],
      ['no format', JSON.stringify({ installId: good.installId, checks: 'on' })],
      ['a non-UUID install ID', JSON.stringify({ ...base, installId: 'install-1' })],
      ['a UUIDv1 install ID', JSON.stringify({ ...base, installId: 'c232ab00-9414-11ec-b3c8-9f6bdeced846' })],
      ['checks maybe', JSON.stringify({ ...base, checks: 'maybe' })],
      ['a skipped non-version', JSON.stringify({ ...base, skippedVersion: '../1.2' })],
      ['a mark without releasedAt', JSON.stringify({ ...base, highWaterMark: { version: '1.2.0' } })],
      ['a mark with a non-version', JSON.stringify({ ...base, highWaterMark: { version: 'v1.2.0', releasedAt: '2026-10-28T12:00:00Z' } })],
      ['a mark with an extra key', JSON.stringify({ ...base, highWaterMark: { ...base.highWaterMark, x: 1 } })],
      ['too large', JSON.stringify({ ...base, skippedVersion: undefined }).replace('}', `${' '.repeat(MAX_PREFS_BYTES)}}`)],
    ];
    const seen = new Set([good.installId]);
    for (const [name, content] of tampered) {
      await writeFile(file(), content);
      const logs: string[] = [];
      const read = await createPrefsStore(dir, { log: (line) => logs.push(line) }).read();
      // One line, holding neither the install ID nor a path.
      expect([name, logs.length]).toEqual([name, 1]);
      expect(logs[0]).not.toContain(read.installId);
      expect(logs[0]).not.toContain(good.installId);
      expect(logs[0]).not.toContain(dir);
      expect([name, read]).toEqual([name, { format: 1, installId: expect.stringMatching(UUID_V4), checks: 'on' }]);
      // A new install ID each time, and the file rewritten with the defaults.
      expect([name, seen.has(read.installId)]).toEqual([name, false]);
      seen.add(read.installId);
      expect([name, await onDisk()]).toEqual([name, read]);
      if (POSIX) expect(await modeOf()).toBe(0o600);
    }
    // A directory where the file should be: defaults in memory, never a rejection.
    await rm(file());
    await mkdir(file());
    const read = await createPrefsStore(dir).read();
    expect(read).toEqual({ format: 1, installId: expect.stringMatching(UUID_V4), checks: 'on' });
  });
});
