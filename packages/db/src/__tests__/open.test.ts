// Spec: specs/browser-session-db.spec.ts (DB_FILE_NAME, CORRUPT_FILE_INFIX, DB_SIDECAR_SUFFIXES, MIGRATIONS_TABLE)
// Acceptance: specs/browser-session-db.feature.md (Opening)
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CORRUPT_FILE_INFIX,
  CORRUPTION_RESULT_CODES,
  DB_BUSY_TIMEOUT_MS,
  DB_FILE_MODE,
  DB_FILE_NAME,
  DB_SIDECAR_SUFFIXES,
  MIGRATIONS_TABLE,
} from '@app/specs/browser-session-db.spec';
import { MIGRATIONS } from '../migrations';
import { CorruptDatabaseError, openSessionDatabase, shouldMoveAside } from '../open';

let dir: string;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-db-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const asideFiles = () => readdirSync(dir).filter((name) => name.includes(CORRUPT_FILE_INFIX));
const migrated = (db: DatabaseSync) => db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all().map((row) => row['id']);

describe('opening', () => {
  test('db-file-in-given-dir', () => {
    const nested = path.join(dir, 'profile', 'frost');
    const log = vi.fn();
    const first = openSessionDatabase({ dir: nested, log });
    expect(first.file).toBe(path.join(nested, DB_FILE_NAME));
    expect(existsSync(first.file)).toBe(true);
    expect(migrated(first.db)).toEqual(MIGRATIONS.map((m) => m.id));
    first.db.prepare("INSERT INTO browser_tabs (position, url) VALUES (0, 'https://a.example/')").run();
    first.db.close();
    const second = openSessionDatabase({ dir: nested, log });
    expect(second.db.prepare('SELECT url FROM browser_tabs').all()).toEqual([{ url: 'https://a.example/' }]);
    second.db.close();
    expect(log).not.toHaveBeenCalled();
  });

  test('corrupt-db-moved-aside', () => {
    const file = path.join(dir, DB_FILE_NAME);
    writeFileSync(file, 'this is not a database, just some bytes '.repeat(200));
    for (const suffix of DB_SIDECAR_SUFFIXES) writeFileSync(`${file}${suffix}`, 'stale sidecar');
    const log = vi.fn();
    const opened = openSessionDatabase({ dir, log, now: () => NOW });
    expect(opened.file).toBe(file);
    expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
    opened.db.close();
    const aside = `${DB_FILE_NAME}${CORRUPT_FILE_INFIX}${NOW}`;
    // No stale sidecar is left next to the fresh database (SQLite drops those of a file it rejects;
    // any it leaves are moved aside with the file).
    const names = readdirSync(dir);
    expect(names).toContain(DB_FILE_NAME);
    expect(names).toContain(aside);
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      const sidecar = path.join(dir, `${DB_FILE_NAME}${suffix}`);
      if (existsSync(sidecar)) expect(readFileSync(sidecar, 'utf8')).not.toBe('stale sidecar');
    }
    expect(names.every((name) => name === DB_FILE_NAME || name.startsWith(aside))).toBe(true);
    expect(readFileSync(path.join(dir, aside), 'utf8')).toContain('this is not a database');
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain(aside);
  });

  test('non-regular-file-moved-aside', () => {
    // A directory where the file should be: never opened, moved aside, a fresh file created.
    mkdirSync(path.join(dir, DB_FILE_NAME));
    const log = vi.fn();
    const opened = openSessionDatabase({ dir, log, now: () => NOW });
    expect(opened.file).toBe(path.join(dir, DB_FILE_NAME));
    expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
    opened.db.close();
    expect(statSync(path.join(dir, `${DB_FILE_NAME}${CORRUPT_FILE_INFIX}${NOW}`)).isDirectory()).toBe(true);
    expect(log).toHaveBeenCalledOnce();

    // A symlink (even to a valid database, even dangling) is not followed: it is moved aside.
    const other = mkdtempSync(path.join(tmpdir(), 'frost-db-elsewhere-'));
    try {
      const target = path.join(other, 'elsewhere.db');
      const elsewhere = new DatabaseSync(target);
      elsewhere.exec("CREATE TABLE mine (x TEXT); INSERT INTO mine VALUES ('untouched')");
      elsewhere.close();
      for (const [link, to] of [['linked', target], ['dangling', path.join(other, 'missing.db')]] as const) {
        const linkDir = path.join(dir, link);
        mkdirSync(linkDir);
        symlinkSync(to, path.join(linkDir, DB_FILE_NAME));
        const viaLink = openSessionDatabase({ dir: linkDir, log, now: () => NOW });
        expect(viaLink.file).toBe(path.join(linkDir, DB_FILE_NAME));
        expect(statSync(viaLink.file).isFile()).toBe(true);
        viaLink.db.close();
        expect(readdirSync(linkDir)).toContain(`${DB_FILE_NAME}${CORRUPT_FILE_INFIX}${NOW}`);
      }
      expect(existsSync(path.join(other, 'missing.db'))).toBe(false);
      const check = new DatabaseSync(target);
      expect(check.prepare('SELECT x FROM mine').all()).toEqual([{ x: 'untouched' }]);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'browser_tabs'").all()).toEqual([]);
      check.close();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test.skipIf(!posix || root)('unreadable-db-left-in-place', () => {
    // A file that cannot be opened is not known to be broken: it stays, and nothing persists.
    const file = path.join(dir, DB_FILE_NAME);
    const first = openSessionDatabase({ dir });
    first.db.prepare("INSERT INTO browser_tabs (position, url) VALUES (0, 'https://a.example/')").run();
    first.db.close();
    chmodSync(file, 0o000);
    try {
      const log = vi.fn();
      const opened = openSessionDatabase({ dir, log, now: () => NOW });
      expect(opened.file).toBe(':memory:');
      expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
      opened.db.close();
      expect(asideFiles()).toEqual([]);
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).not.toMatch(/moved aside/);
    } finally {
      chmodSync(file, 0o600);
    }
    const again = openSessionDatabase({ dir });
    expect(again.db.prepare('SELECT url FROM browser_tabs').all()).toEqual([{ url: 'https://a.example/' }]);
    again.db.close();
  });

  test('only-corruption-moves-aside', () => {
    // Primary codes (and extended ones, low byte) of corruption move the file aside ...
    for (const code of CORRUPTION_RESULT_CODES) {
      expect(shouldMoveAside(Object.assign(new Error('x'), { errcode: code }))).toBe(true);
      expect(shouldMoveAside(Object.assign(new Error('x'), { errcode: code | (1 << 8) }))).toBe(true);
    }
    expect(shouldMoveAside(new CorruptDatabaseError('quick_check failed: row 3 missing'))).toBe(true);
    // ... nothing else does: busy, locked, I/O error, disk full, out of memory, cannot open,
    // read-only, permission, a plain error (a failed migration's SQL error included).
    for (const code of [1, 5, 6, 7, 8, 10, 13, 14, 23, 266, 778]) {
      expect(shouldMoveAside(Object.assign(new Error('x'), { errcode: code })), String(code)).toBe(false);
    }
    expect(shouldMoveAside(new Error('ENOSPC'))).toBe(false);
    expect(shouldMoveAside('not even an error')).toBe(false);
  });

  test.skipIf(!posix)('db-file-is-private', () => {
    const fresh = openSessionDatabase({ dir });
    fresh.db.close();
    expect(statSync(fresh.file).mode & 0o777).toBe(DB_FILE_MODE);
    // An existing file with wider permissions is narrowed when opened.
    chmodSync(fresh.file, 0o644);
    const reopened = openSessionDatabase({ dir });
    reopened.db.close();
    expect(statSync(reopened.file).mode & 0o777).toBe(DB_FILE_MODE);
  });

  test('busy-db-waits-for-lock', async () => {
    const file = path.join(dir, DB_FILE_NAME);
    openSessionDatabase({ dir }).db.close();
    // Another process holds an exclusive lock for a moment, well inside the busy timeout.
    const holdMs = Math.floor(DB_BUSY_TIMEOUT_MS / 4);
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      db.exec('COMMIT');
      db.close();`;
    const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const log = vi.fn();
    const opened = openSessionDatabase({ dir, log });
    expect(opened.file).toBe(file);
    opened.db.close();
    expect(log).not.toHaveBeenCalled();
    await new Promise((resolve) => child.once('exit', resolve));
  });

  test('busy-db-not-moved-aside', () => {
    const file = path.join(dir, DB_FILE_NAME);
    const other = new DatabaseSync(file);
    other.exec('CREATE TABLE held (x INTEGER)');
    other.exec('BEGIN EXCLUSIVE');
    try {
      const log = vi.fn();
      const opened = openSessionDatabase({ dir, log, now: () => NOW });
      expect(opened.file).toBe(':memory:');
      expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
      opened.db.close();
      expect(asideFiles()).toEqual([]);
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).not.toMatch(/moved aside/);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    // The other process's data is untouched.
    const check = new DatabaseSync(file);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'held'").all()).toHaveLength(1);
    check.close();
  });

  test('memory-fallback-when-nothing-opens', () => {
    // The profile "directory" is a file: nothing can be created under it.
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, '');
    const log = vi.fn();
    const opened = openSessionDatabase({ dir: notADir, log, now: () => NOW });
    expect(opened.file).toBe(':memory:');
    expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
    opened.db.close();
    expect(log).toHaveBeenCalledOnce();
    // The log tells what happened: nothing was moved.
    expect(log.mock.calls[0]?.[0]).not.toMatch(/moved aside/);
    expect(readFileSync(notADir, 'utf8')).toBe('');
  });
});
