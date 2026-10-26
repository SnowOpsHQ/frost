import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CORRUPT_FILE_INFIX, DB_FILE_NAME, DB_SIDECAR_SUFFIXES } from '@app/specs/browser-session-db.spec';
import { runMigrations } from './migrations';

// Opening the browser-session database (spec `browser-session-db.feature.md`, Corrupt or
// unreadable file). Synchronous: main opens it once at startup. The app always gets a database.

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** The file in use, or `':memory:'` when nothing on disk could be used (nothing persists). */
  readonly file: string;
}

export interface OpenOptions {
  /** The directory holding `DB_FILE_NAME` (`app.getPath('userData')`); created if missing. */
  readonly dir: string;
  /** Reports why the file on disk was not used (called at most once per open). */
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

// SQLite primary result codes (the low byte of an extended code).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function primaryCode(error: unknown): number | null {
  const code = typeof error === 'object' && error !== null ? (error as { errcode?: unknown }).errcode : undefined;
  return typeof code === 'number' ? code & 0xff : null;
}

/** Busy or locked: another process holds the file; it is not broken, so it must not be moved. */
function isBusy(error: unknown): boolean {
  const code = primaryCode(error);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens `file`, checks it is an intact database and migrates it; throws (closing it) otherwise. */
function openChecked(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    const check = db.prepare('PRAGMA quick_check').all();
    const result = check.map((row) => Object.values(row)[0]);
    if (result.length !== 1 || result[0] !== 'ok') throw new Error(`quick_check failed: ${result.slice(0, 3).join('; ')}`);
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openMemory(): OpenedDatabase {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return { db, file: ':memory:' };
}

/** Renames `file` and its sidecars to `<name>CORRUPT_FILE_INFIX<now>`; answers the new name. */
function moveAside(file: string, now: number): string {
  const target = `${file}${CORRUPT_FILE_INFIX}${now}`;
  // Sidecars first: a hot journal must never be left next to a fresh database of the same name.
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${target}${suffix}`);
  }
  if (existsSync(file)) renameSync(file, target);
  return target;
}

/**
 * Opens `<dir>/DB_FILE_NAME`, migrated. A file that cannot be opened, is not an intact database or
 * fails its migrations is moved aside and a fresh one is created; a busy one is left alone. When
 * no file can be used, an in-memory database is answered instead. Logs once whenever the file
 * on disk was not used as is.
 */
export function openSessionDatabase({ dir, log = () => {}, now = Date.now }: OpenOptions): OpenedDatabase {
  const file = path.join(dir, DB_FILE_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    return { db: openChecked(file), file };
  } catch (error) {
    if (isBusy(error)) {
      log(`browser-session database ${file} is in use (${describe(error)}); this session will not be saved`);
      return openMemory();
    }
    const why = describe(error);
    let moved: string;
    try {
      moved = moveAside(file, now());
    } catch (moveError) {
      log(`browser-session database ${file} is unusable (${why}) and could not be moved aside (${describe(moveError)}); this session will not be saved`);
      return openMemory();
    }
    try {
      const db = openChecked(file);
      log(`browser-session database ${file} was unusable (${why}); moved aside to ${moved}, starting fresh`);
      return { db, file };
    } catch (freshError) {
      log(`browser-session database ${file} was unusable (${why}); moved aside to ${moved}, but a fresh one could not be created (${describe(freshError)}); this session will not be saved`);
      return openMemory();
    }
  }
}
