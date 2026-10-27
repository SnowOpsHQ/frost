/**
 * Local browser-session database constants (Phase 1 Task 5; acceptance:
 * `browser-session-db.feature.md`). Plain values with no imports beyond other Zod-free specs. A
 * stored tab or visit URL must have one of `BROWSABLE_SCHEMES` (`browser.spec.ts`).
 *
 * Storage: Node's built-in `node:sqlite` (`DatabaseSync`) in Electron's main process, queried
 * through Drizzle's SQLite dialect (`drizzle-orm/sqlite-proxy`), so moving to libSQL when sync
 * lands (design §2, Data) is a driver swap. Implemented by `packages/db` (`@app/db`).
 */
import { MAX_TABS } from './tabs.spec';

/** The database file, directly in `app.getPath('userData')`. */
export const DB_FILE_NAME = 'frost-browser.db' as const;

/**
 * A database file that cannot be opened, is not a database, fails `PRAGMA quick_check`, or fails
 * its migrations is renamed to `<DB_FILE_NAME><CORRUPT_FILE_INFIX><timestamp>` (with any
 * `DB_SIDECAR_SUFFIXES` sidecar still beside it renamed alongside), and a fresh database is created.
 * `<timestamp>` is the Unix time in milliseconds.
 */
export const CORRUPT_FILE_INFIX = '.corrupt-' as const;

/**
 * SQLite sidecar files of a database file, moved aside with it if still present (SQLite itself
 * deletes the sidecars of a file it rejects when it closes it).
 */
export const DB_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/** The table the forward-only migration runner records applied migration ids in. */
export const MIGRATIONS_TABLE = 'schema_migrations' as const;

/**
 * The tables the migrations create (besides `MIGRATIONS_TABLE`): `0001` the first three, `0003`
 * `render_profile_pins` (Phase 2.5 Task 1, `render-profile.feature.md`: one pinned render profile
 * per origin, as JSON, at most `MAX_RENDER_PROFILE_PINS`), `0004` the Content panel's notes
 * (Phase 2.5 Task 3, `CONTENT_TABLES` in `seo-content.spec.ts`: target queries and snippet drafts
 * per page URL).
 */
export const SESSION_TABLES = ['browser_tabs', 'recent_visits', 'site_permissions', 'render_profile_pins', 'seo_target_queries', 'seo_snippet_variants'] as const;

/** At most this many tabs are saved, and restored (the window holds no more). */
export const MAX_RESTORED_TABS = MAX_TABS;

/**
 * At most this many `recent_visits` rows are kept: after each batch of visits the rows with the
 * oldest `last_visit_at` beyond this count are deleted.
 */
export const MAX_RECENT_VISITS = 1_000;

/**
 * Longest URL stored (UTF-16 code units, as serialized). A longer tab URL is saved as an empty tab;
 * a longer visit URL is not recorded.
 */
export const MAX_STORED_URL_LENGTH = 16_384;

/** Longest title stored (characters, i.e. code points); longer titles are cut to this length. */
export const MAX_STORED_TITLE_LENGTH = 512;

/**
 * Session and visit writes are batched: the first change after a write schedules one write this
 * long later, which carries every change made meanwhile (the latest tab list, all visits). Pending
 * writes are flushed when the app quits. Permission decisions are written at once.
 */
export const SESSION_WRITE_BATCH_MS = 1_000;

/**
 * How long opening the database waits for another connection's lock (SQLite busy timeout,
 * `DatabaseSync`'s `timeout`) before it gives up and the app runs on an in-memory database.
 */
export const DB_BUSY_TIMEOUT_MS = 1_000;

/** The database file's permissions on POSIX: readable and writable by the user only. */
export const DB_FILE_MODE = 0o600;

/**
 * The SQLite primary result codes that mean the file is broken (`SQLITE_CORRUPT`,
 * `SQLITE_NOTADB`): only these, a failed `PRAGMA quick_check`, or a path that is not a regular
 * file (a directory, a symlink — never followed) move the file aside. Every other failure (busy,
 * I/O error, disk full, out of memory, cannot open, a failed migration, …) leaves it in place and
 * the app runs on an in-memory database for that session.
 */
export const CORRUPTION_RESULT_CODES = [11, 26] as const;

/**
 * **Clear Browsing Data…** (`browser-session-db.feature.md`, Clear browsing data): an application
 * menu item (the File menu; the app menu on macOS) that asks first, in a native message box main
 * shows parented to the window, and on confirmation clears the visits, every permission decision
 * (stored and in memory) with the prompt back-off, every pinned render profile (stored and in memory,
 * `render-profile.feature.md`), and the browse partition's storage and cache. The Content panel's
 * target queries and snippet drafts are the user's own work and are kept (`MAX_CONTENT_NOTE_URLS` in
 * `seo-content.spec.ts`); the dialog says so. It closes no tab. `buttons[confirmIndex]` clears; Cancel is the default and the cancel answer.
 */
export const CLEAR_BROWSING_DATA = {
  menuItemId: 'clear-browsing-data',
  menuLabel: 'Clear Browsing Data\u2026',
  dialog: {
    type: 'warning',
    message: 'Clear browsing data?',
    detail:
      'This clears your recent visits, every site permission you allowed or blocked, the render profiles pinned to sites, and the cookies, site data and cache of every site. Your target queries and snippet drafts are kept, and open tabs stay open.',
    buttons: ['Clear Browsing Data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;
