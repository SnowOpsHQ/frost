import { chmodSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CORRUPT_FILE_INFIX,
  CORRUPTION_RESULT_CODES,
  DB_BUSY_TIMEOUT_MS,
  DB_FILE_MODE,
  DB_FILE_NAME,
  DB_SIDECAR_SUFFIXES,
} from '@app/specs/browser-session-db.spec';
import { runMigrations } from './migrations';

// Opening the browser-session database (spec `browser-session-db.feature.md`, Corrupt or
// unusable file). Synchronous: main opens it once at startup. The app always gets a database.
// Only a file known to be broken is moved aside; any other failure leaves it alone for the next
// launch and runs this session on an in-memory database.

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** The file in use, or `':memory:'` when the file on disk could not be used (nothing persists). */
  readonly file: string;
}

export interface OpenOptions {
  /** The directory holding `DB_FILE_NAME` (`app.getPath('userData')`); created if missing. */
  readonly dir: string;
  /** Reports why the file on disk was not used as is (called at most once per open). */
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** The file opened but is not intact (`PRAGMA quick_check` reported problems). */
export class CorruptDatabaseError extends Error {
  override readonly name = 'CorruptDatabaseError';
}

function primaryCode(error: unknown): number | null {
  const code = typeof error === 'object' && error !== null ? (error as { errcode?: unknown }).errcode : undefined;
  return typeof code === 'number' ? code & 0xff : null;
}

/**
 * Whether `error` (from opening, checking or migrating the file) means the file is broken:
 * `CORRUPTION_RESULT_CODES` (primary or extended) or a failed `quick_check`. Anything else —
 * busy, I/O error, disk full, out of memory, cannot open, a migration's own error — does not.
 */
export function shouldMoveAside(error: unknown): boolean {
  if (error instanceof CorruptDatabaseError) return true;
  const code = primaryCode(error);
  return code !== null && (CORRUPTION_RESULT_CODES as readonly number[]).includes(code);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What is at `file`: nothing, a regular file, or something else (directory, symlink, …). */
function entryAt(file: string): 'missing' | 'file' | 'other' {
  try {
    return lstatSync(file).isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

/**
 * Opens `file` (waiting up to `DB_BUSY_TIMEOUT_MS` for another connection's lock), narrows it to
 * `DB_FILE_MODE`, checks it is intact and migrates it; throws (closing it) otherwise.
 */
function openChecked(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS });
  try {
    // Created by SQLite with the umask's mode (often 0644): the profile's history is the user's alone.
    if (process.platform !== 'win32') chmodSync(file, DB_FILE_MODE);
    const result = db
      .prepare('PRAGMA quick_check')
      .all()
      .map((row) => Object.values(row)[0]);
    if (result.length !== 1 || result[0] !== 'ok') throw new CorruptDatabaseError(`quick_check failed: ${result.slice(0, 3).join('; ')}`);
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

/**
 * Renames `file` and any sidecar beside it to `<name>CORRUPT_FILE_INFIX<now>` (never following a
 * symlink: the link itself is renamed). Answers the new name, or `null` if nothing was there.
 */
function moveAside(file: string, now: number): string | null {
  const target = `${file}${CORRUPT_FILE_INFIX}${now}`;
  // Sidecars first: a hot journal must never be left next to a fresh database of the same name.
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    if (entryAt(`${file}${suffix}`) !== 'missing') renameSync(`${file}${suffix}`, `${target}${suffix}`);
  }
  if (entryAt(file) === 'missing') return null;
  renameSync(file, target);
  return target;
}

/**
 * Opens `<dir>/DB_FILE_NAME`, migrated. A path that is not a regular file, or a file that is not
 * an intact database, is moved aside and a fresh one is created; on any other failure the file is
 * left in place and an in-memory database is answered. Logs once, with what really happened,
 * whenever the file on disk was not used as is.
 */
export function openSessionDatabase({ dir, log = () => {}, now = Date.now }: OpenOptions): OpenedDatabase {
  const file = path.join(dir, DB_FILE_NAME);
  const unsaved = 'this session will not be saved';
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    log(`browser-session directory ${dir} could not be created (${describe(error)}); ${unsaved}`);
    return openMemory();
  }

  let why: string;
  if (entryAt(file) === 'other') {
    why = 'not a regular file';
  } else {
    try {
      return { db: openChecked(file), file };
    } catch (error) {
      if (!shouldMoveAside(error)) {
        log(`browser-session database ${file} could not be used (${describe(error)}); left in place, ${unsaved}`);
        return openMemory();
      }
      why = describe(error);
    }
  }

  let moved: string | null;
  try {
    moved = moveAside(file, now());
  } catch (moveError) {
    log(`browser-session database ${file} is unusable (${why}) and could not be moved aside (${describe(moveError)}); ${unsaved}`);
    return openMemory();
  }
  const outcome = moved === null ? 'it was gone before it could be moved aside' : `moved aside to ${moved}`;
  try {
    const db = openChecked(file);
    log(`browser-session database ${file} was unusable (${why}); ${outcome}, starting fresh`);
    return { db, file };
  } catch (freshError) {
    log(`browser-session database ${file} was unusable (${why}); ${outcome}, but a fresh one could not be created (${describe(freshError)}); ${unsaved}`);
    return openMemory();
  }
}
