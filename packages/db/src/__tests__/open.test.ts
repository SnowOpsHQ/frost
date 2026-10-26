// Spec: specs/browser-session-db.spec.ts (DB_FILE_NAME, CORRUPT_FILE_INFIX, DB_SIDECAR_SUFFIXES, MIGRATIONS_TABLE)
// Acceptance: specs/browser-session-db.feature.md (Opening)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CORRUPT_FILE_INFIX, DB_FILE_NAME, DB_SIDECAR_SUFFIXES, MIGRATIONS_TABLE } from '@app/specs/browser-session-db.spec';
import { MIGRATIONS } from '../migrations';
import { openSessionDatabase } from '../open';

let dir: string;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-db-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

  test('unreadable-db-moved-aside', () => {
    // A directory where the file should be: SQLite cannot open it.
    mkdirSync(path.join(dir, DB_FILE_NAME));
    const log = vi.fn();
    const opened = openSessionDatabase({ dir, log, now: () => NOW });
    expect(opened.file).toBe(path.join(dir, DB_FILE_NAME));
    expect(migrated(opened.db)).toEqual(MIGRATIONS.map((m) => m.id));
    opened.db.close();
    expect(existsSync(path.join(dir, `${DB_FILE_NAME}${CORRUPT_FILE_INFIX}${NOW}`))).toBe(true);
    expect(log).toHaveBeenCalledOnce();
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
      expect(readdirSync(dir).filter((name) => name.includes(CORRUPT_FILE_INFIX))).toEqual([]);
      expect(log).toHaveBeenCalledOnce();
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
  });
});
