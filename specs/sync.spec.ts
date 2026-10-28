/**
 * Database drivers and what the libSQL driver may open (Phase 7 Task 6; acceptance:
 * `sync-driver.feature.md`). Plain values and pure functions, Zod-free, with no imports beyond
 * other Zod-free specs. Implemented by `packages/db/src/driver-*.ts` (`@app/db`).
 *
 * Design §2 (Data): `node:sqlite` now, libSQL when sync lands, as a driver swap behind the async
 * repository API. Drizzle (`sqlite-proxy`) runs over either driver; every repository factory takes
 * the same `SessionDatabase`. The browser-session database (`DB_FILE_NAME`) keeps `node:sqlite`:
 * `openSessionStore` is unchanged. libSQL is loaded only when something opens it (Task 8's sync
 * replica, `SYNC_REPLICA_FILE_NAME`); nothing in `@app/db`'s index reaches it.
 *
 * Sync itself (Task 8) mirrors rows, not files (plan, Sync design note): the session database is
 * never a libSQL embedded replica, because it also holds history, permission decisions, render
 * profile pins and content notes, which stay local. Task 8 adds `SYNC_TABLES` and the merge rules
 * (Sync tables, below; acceptance `sync-engine.feature.md`) and the config rules (Sync config;
 * acceptance `sync-config.feature.md`, Zod side `sync-config.schema.ts`).
 */
import { DB_FILE_NAME } from './browser-session-db.spec';
import { SYNC_CONFIG_FILE_NAME, SYNC_REPLICA_FILE_NAME, SYNC_STATE_TABLE } from './sync-package.spec';

/** The SQL drivers Drizzle can run over (`SqlDriver.kind`). */
export const DB_DRIVER_IDS = ['node-sqlite', 'libsql'] as const;
export type DbDriverId = (typeof DB_DRIVER_IDS)[number];

/** The driver every database uses unless a caller asks for another. */
export const DEFAULT_DB_DRIVER: DbDriverId = 'node-sqlite';

/**
 * The local file of the libSQL embedded replica (Task 8), directly in `app.getPath('userData')`.
 * The only file opened with a `syncUrl`, so the only one that talks to the sync endpoint. Defined
 * in `sync-package.spec.ts`, which the package verifiers load (`sync-replica-opens`).
 */
export { SYNC_REPLICA_FILE_NAME };

/** Files that are never opened with a `syncUrl`, whatever directory they are in. */
export const NEVER_SYNCED_FILE_NAMES = [DB_FILE_NAME] as const;

/** Longest `url` or `syncUrl` accepted (characters). */
export const MAX_LIBSQL_URL_CHARS = 2048;

/** Longest `authToken` accepted (characters; a Turso / sqld JWT is far shorter). */
export const MAX_LIBSQL_AUTH_TOKEN_CHARS = 8192;

/** `syncInterval` bounds, in whole seconds (libSQL's own unit). */
export const LIBSQL_SYNC_INTERVAL_SECONDS = { min: 1, max: 86_400 } as const;

/** The schemes a `syncUrl` may have. `libsql:` means TLS (`https:`) to libSQL. */
export const LIBSQL_SYNC_URL_SCHEMES = ['libsql:', 'https:'] as const;

/**
 * The only `http:` hosts a `syncUrl` may use, and only when the caller allows loopback `http:`
 * (`LibsqlUrlOptions.allowLoopbackHttp`: tests, and at most an unpackaged build). The loopback
 * literals, never `localhost` (a name can resolve anywhere).
 */
export const LIBSQL_LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'] as const;

/**
 * How the libSQL driver reads integers: `'number'`. Drizzle and every repository expect numbers,
 * as `node:sqlite` returns them. Integers are exact up to 2^53 − 1; libSQL throws a `RangeError`
 * when a stored integer outside ±(2^53 − 1) is read, rather than rounding it. frost stores Unix
 * milliseconds, counts and positions, all far below that. Booleans are read as 0/1 (Drizzle's
 * `mode: 'boolean'` maps them), as `node:sqlite` returns them.
 */
export const LIBSQL_INT_MODE = 'number' as const;

/**
 * The SQLite libSQL bundles (3.45.1; `node:sqlite` runs 3.53.4): a migration or query meant to run
 * over both drivers uses only what SQLite 3.45 supports. Defined in `sync-package.spec.ts`, which
 * the package verifiers load (`libsql-loads`).
 */
export { LIBSQL_SQLITE_VERSION } from './sync-package.spec';

/** What the libSQL driver is asked to open. */
export interface LibsqlConfig {
  /** The local database: a `file:` URL with an absolute, percent-encoded path. */
  readonly url: string;
  /** The remote primary of an embedded replica (`libsql:` / `https:`). */
  readonly syncUrl?: string;
  /** The remote's token; only with a `syncUrl`. Never put in a URL. */
  readonly authToken?: string;
  /** Background sync period in seconds; only with a `syncUrl`. */
  readonly syncInterval?: number;
}

export interface LibsqlUrlOptions {
  /** Allow `http:` to a `LIBSQL_LOOPBACK_HOSTS` literal as a `syncUrl` (tests). Default `false`. */
  readonly allowLoopbackHttp?: boolean;
}

/** Why a `LibsqlConfig` is refused. */
export const LIBSQL_CONFIG_PROBLEMS = [
  'url-not-file',
  'url-not-absolute',
  'url-invalid',
  'sync-url-scheme',
  'sync-url-invalid',
  'sync-file-not-replica',
  'auth-token-invalid',
  'sync-interval-invalid',
  'needs-sync-url',
] as const;
export type LibsqlConfigProblem = (typeof LIBSQL_CONFIG_PROBLEMS)[number];

/** Printable ASCII, no space: what any URL or token here may hold (others are percent-encoded). */
const PRINTABLE = /^[\x21-\x7e]+$/;

function decodes(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** A Windows drive path, `C:/…` (a drive-relative `C:x` is not absolute). */
const WINDOWS_DRIVE = /^[A-Za-z]:\//;

/**
 * The local file path a `file:` URL names (as libSQL will open it), or why it is refused:
 * - POSIX: `file:///<path>` or `file:/<path>`, naming `/<path>`;
 * - Windows: `file:<drive>:/<path>`, naming `<drive>:/<path>`. libSQL's URL parser hands the path
 *   after `file:` to the native module as is, so `file:///C:/…` would name `/C:/…`, which Windows
 *   can't open; that form is refused.
 *
 * Always an absolute path with no host (not even `localhost`), no `?query` (libSQL would read
 * `authToken` or `tls` from it) and no `#fragment`. Once decoded it holds no `\`, no NUL and no
 * leading `//`, so no UNC / SMB share (`//server/share`, `\\server\share`) can be named, however
 * it is encoded. Checked on the string itself, not through a URL parser, so libSQL's own parser
 * can't read it differently.
 */
export function libsqlFilePath(url: string): string | LibsqlConfigProblem {
  if (url.length > MAX_LIBSQL_URL_CHARS || !PRINTABLE.test(url)) return 'url-invalid';
  if (!url.startsWith('file:')) return 'url-not-file';
  const rest = url.slice('file:'.length);
  const encoded = WINDOWS_DRIVE.test(rest) ? rest : rest.startsWith('///') ? rest.slice(2) : rest.startsWith('/') && !rest.startsWith('//') ? rest : null;
  if (encoded === null) return 'url-not-absolute';
  if (/[?#\\]/.test(encoded) || encoded.endsWith('/')) return 'url-invalid';
  const path = decodes(encoded);
  if (path === null || /[\0\\]/.test(path)) return 'url-invalid';
  const local = WINDOWS_DRIVE.test(path) ? path.slice(2) : path;
  if (!local.startsWith('/') || local.startsWith('//') || local.length < 2 || /^\/[A-Za-z]:/.test(path)) return 'url-invalid';
  return path;
}

/** The last path segment of `path` (either separator). */
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function syncUrlProblem(syncUrl: string, { allowLoopbackHttp = false }: LibsqlUrlOptions): LibsqlConfigProblem | null {
  if (syncUrl.length > MAX_LIBSQL_URL_CHARS || !PRINTABLE.test(syncUrl)) return 'sync-url-invalid';
  // The string's own scheme, lowercase as written: `libsql://` or `https://` (or loopback `http://`).
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(syncUrl)?.[1];
  const allowed: readonly string[] = allowLoopbackHttp ? [...LIBSQL_SYNC_URL_SCHEMES, 'http:'] : LIBSQL_SYNC_URL_SCHEMES;
  if (scheme === undefined || !allowed.includes(`${scheme}:`)) return 'sync-url-scheme';
  // No user name or password, no query (`?tls=0` would turn `libsql:` into `http:`; `?authToken`
  // would bypass `authToken`), no fragment, no backslash.
  if (/[@?#\\]/.test(syncUrl)) return 'sync-url-invalid';
  let parsed: URL;
  try {
    parsed = new URL(syncUrl);
  } catch {
    return 'sync-url-invalid';
  }
  if (parsed.hostname === '') return 'sync-url-invalid';
  // Loopback `http:` exactly as written (a parser would also map `0x7f.1` or `2130706433` to 127.0.0.1).
  if (scheme === 'http') {
    const authority = syncUrl.slice('http://'.length).split('/')[0]!;
    const host = authority.replace(/:\d{1,5}$/, '');
    if (!(LIBSQL_LOOPBACK_HOSTS as readonly string[]).includes(host)) return 'sync-url-scheme';
  }
  return null;
}

/**
 * Why the libSQL driver must refuse `config`, or `null` when it may open it:
 * - `url` is a `file:` URL (`libsqlFilePath`): libSQL here opens local files and embedded
 *   replicas only, never a remote database directly;
 * - a `syncUrl` is `libsql:` or `https:` with a host (`http:` only to a `LIBSQL_LOOPBACK_HOSTS`
 *   literal, and only with `allowLoopbackHttp`), and no user name, password, query or fragment;
 * - a `syncUrl` is only for `SYNC_REPLICA_FILE_NAME`: never `NEVER_SYNCED_FILE_NAMES` (the
 *   browser-session database), never any other file;
 * - `authToken` (printable ASCII, at most `MAX_LIBSQL_AUTH_TOKEN_CHARS`) and `syncInterval` (whole
 *   seconds in `LIBSQL_SYNC_INTERVAL_SECONDS`) only with a `syncUrl`.
 */
export function libsqlConfigProblem(config: LibsqlConfig, options: LibsqlUrlOptions = {}): LibsqlConfigProblem | null {
  const path = libsqlFilePath(config.url);
  if ((LIBSQL_CONFIG_PROBLEMS as readonly string[]).includes(path)) return path as LibsqlConfigProblem;
  const { syncUrl, authToken, syncInterval } = config;
  if (authToken !== undefined && (typeof authToken !== 'string' || authToken.length > MAX_LIBSQL_AUTH_TOKEN_CHARS || !PRINTABLE.test(authToken))) return 'auth-token-invalid';
  if (syncInterval !== undefined && (!Number.isInteger(syncInterval) || syncInterval < LIBSQL_SYNC_INTERVAL_SECONDS.min || syncInterval > LIBSQL_SYNC_INTERVAL_SECONDS.max)) return 'sync-interval-invalid';
  if (syncUrl === undefined) return authToken !== undefined || syncInterval !== undefined ? 'needs-sync-url' : null;
  if (typeof syncUrl !== 'string') return 'sync-url-invalid';
  const problem = syncUrlProblem(syncUrl, options);
  if (problem !== null) return problem;
  const name = baseName(path);
  if ((NEVER_SYNCED_FILE_NAMES as readonly string[]).includes(name) || name !== SYNC_REPLICA_FILE_NAME) return 'sync-file-not-replica';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sync tables (Task 8; acceptance `sync-engine.feature.md`; plan, Sync design note)
// ---------------------------------------------------------------------------------------------

/**
 * How a table's rows merge (Phase 6's conventions, `docs/plans/phase-6-change-intelligence.md`,
 * Schema):
 * - `append-only`: captured rows, immutable. Inserted by `id` when missing, never updated, and never
 *   inserted when a `ci_tombstones` row names them (Phase 6's `no_resurrect`). Deleted only by an
 *   arriving tombstone, children first (`SYNC_PURGE_DELETE_ORDER`).
 * - `mutable-lww`: inserted by `id` when missing; otherwise the version with the later `updated_at`
 *   wins (one more than `SYNC_MAX_CLOCK_SKEW_MS` ahead counts as `now` plus that). Deletion is a `deleted_at` value carried like any other column, never a `DELETE`.
 * - `purge-log`: `ci_purges`, the audit log of deletions. Inserted by `id` when missing.
 * - `tombstone`: `ci_tombstones`. Inserted by `id` when missing and when no tombstone for the same
 *   `(table_name, row_id)` exists yet (its `UNIQUE` key: two devices may purge the same row). Once
 *   they have all arrived (`SYNC_PAGE_ROWS`), every row of an `append-only` table that a tombstone
 *   names is deleted, children first.
 *
 * Every insert is `INSERT … SELECT … WHERE NOT EXISTS (…)`: Phase 6's `_no_replace` triggers abort
 * even `ON CONFLICT DO NOTHING`.
 */
export const SYNC_MERGE_RULES = ['append-only', 'mutable-lww', 'purge-log', 'tombstone'] as const;
export type SyncMergeRule = (typeof SYNC_MERGE_RULES)[number];

/** One table the engine mirrors, with every column it copies (Phase 6's Schema, in its order). */
export interface SyncTable {
  readonly name: string;
  readonly rule: SyncMergeRule;
  /** The primary key: a lowercase UUIDv7, the same on every device. */
  readonly key: 'id';
  /** The time a push pass orders and marks by: `updated_at` for `mutable-lww`, else `created_at`. */
  readonly time: 'created_at' | 'updated_at';
  /** The tombstone column of a `mutable-lww` table. */
  readonly deleted?: 'deleted_at';
  /** Every column copied, `key` first. Nothing else is read or written. */
  readonly columns: readonly string[];
}

/**
 * The tables sync mirrors, in the order a pass applies them (parents before children, purges and
 * tombstones before the captured rows they may veto). Exactly Phase 6's nine `ci_*` tables; every
 * other table of the session database (history, permissions, render-profile pins, content notes,
 * settings) is never read by the engine. Identifiers here, and only these, are put into SQL (quoted).
 */
export const SYNC_TABLES = [
  {
    name: 'ci_projects',
    rule: 'mutable-lww',
    key: 'id',
    time: 'updated_at',
    deleted: 'deleted_at',
    columns: ['id', 'name', 'render_profile', 'retention_mode', 'retention_value', 'created_at', 'updated_at', 'deleted_at'],
  },
  {
    name: 'ci_project_pages',
    rule: 'mutable-lww',
    key: 'id',
    time: 'updated_at',
    deleted: 'deleted_at',
    columns: ['id', 'project_id', 'url', 'created_at', 'updated_at', 'deleted_at'],
  },
  {
    name: 'ci_project_queries',
    rule: 'mutable-lww',
    key: 'id',
    time: 'updated_at',
    deleted: 'deleted_at',
    columns: ['id', 'project_id', 'query', 'search_params', 'created_at', 'updated_at', 'deleted_at'],
  },
  {
    name: 'ci_purges',
    rule: 'purge-log',
    key: 'id',
    time: 'created_at',
    columns: ['id', 'reason', 'project_id', 'policy', 'captures', 'versions', 'diffs', 'screenshots', 'bytes', 'created_at'],
  },
  {
    name: 'ci_tombstones',
    rule: 'tombstone',
    key: 'id',
    time: 'created_at',
    columns: ['id', 'purge_id', 'table_name', 'row_id', 'created_at'],
  },
  {
    name: 'ci_versions',
    rule: 'append-only',
    key: 'id',
    time: 'created_at',
    columns: [
      'id',
      'lane_key',
      'page_url',
      'render_profile',
      'search_params',
      'snapshot',
      'snapshot_hash',
      'snapshot_bytes',
      'schema_version',
      'parent_version_id',
      'created_at',
    ],
  },
  {
    name: 'ci_captures',
    rule: 'append-only',
    key: 'id',
    time: 'created_at',
    columns: [
      'id',
      'project_id',
      'version_id',
      'lane_key',
      'page_url',
      'render_profile',
      'render_profile_partial',
      'search_params',
      'source',
      'audit_taken_at',
      'created_at',
    ],
  },
  {
    name: 'ci_diffs',
    rule: 'append-only',
    key: 'id',
    time: 'created_at',
    columns: ['id', 'lane_key', 'from_version_id', 'to_version_id', 'engine_version', 'diff', 'summary', 'change_count', 'created_at'],
  },
  {
    name: 'ci_screenshots',
    rule: 'append-only',
    key: 'id',
    time: 'created_at',
    columns: [
      'id',
      'project_id',
      'page_url',
      'capture_id',
      'kind',
      'rect',
      'width',
      'height',
      'bytes',
      'sha256',
      'segments',
      'render_profile',
      'search_params',
      'created_at',
    ],
  },
] as const satisfies readonly SyncTable[];
export type SyncTableName = (typeof SYNC_TABLES)[number]['name'];

/** The tombstone table: an `append-only` row is never inserted while one of its rows names it. */
export const SYNC_TOMBSTONE_TABLE = 'ci_tombstones' as const satisfies SyncTableName;

/**
 * The order arriving tombstones delete rows in, children first, as Phase 6's purge path does
 * (diffs, screenshots, captures, then versions), so its `_purge_only` and
 * `ci_versions_unreferenced_only` triggers still pass. Exactly the `append-only` tables.
 */
export const SYNC_PURGE_DELETE_ORDER = ['ci_diffs', 'ci_screenshots', 'ci_captures', 'ci_versions'] as const satisfies readonly SyncTableName[];

/**
 * The replica-only change log: one row (`seq`, `table_name`, `row_id`) for each row a push inserted
 * or changed in the replica. Pull reads it by `seq` (the primary's commit order), not by row time,
 * so a row whose `created_at` / `updated_at` is older than a mark (another device's clock, or a
 * device that was offline) still arrives.
 */
export const SYNC_LOG_TABLE = 'frost_sync_log' as const;

/**
 * The replica-only pull-back queue: one row (`device_id`, `table_name`, `row_id`) for each mutable
 * row whose push lost to the replica's newer version. Written in the push's own transaction, and
 * removed only in the transaction that moves the pull marks after the winner was applied to the
 * session database, so a pass that stops at its page limit (or a crash between push and pull) never
 * loses one: its winner's log entry may be behind the pull mark, so nothing else would fetch it.
 */
export const SYNC_PENDING_TABLE = 'frost_sync_pending' as const;

/**
 * `SYNC_STATE_TABLE` (`frost_sync_state`): per `device_id` (`SyncConfig.deviceId`), direction and
 * table, a pass's high-water mark. Push: the last `(time, id)` of the session database's rows
 * copied (never later than `now − SYNC_PUSH_SETTLE_MS`, so a row committed late with an earlier
 * time is read again). Pull: the last `SYNC_LOG_TABLE` `seq` applied. Lives in the replica only,
 * never in the session database. With an endpoint the replica is the primary's copy, hence the
 * device key; the device ID is random and local, and identifies nothing but these marks.
 */
export { SYNC_STATE_TABLE };

/** The directions of a pass: push (session database → replica), then pull (replica → session). */
export const SYNC_DIRECTIONS = ['push', 'pull'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

/**
 * Rows per table read in one page of a pass, every table alike (`ci_purges` and `ci_tombstones`
 * too). Tombstones' deletes run only on a page where `ci_tombstones` is caught up (its page was not
 * full), as a sweep of every tombstoned row still present, so a purge split across pages is
 * applied once all of it has arrived.
 */
export const SYNC_PAGE_ROWS = 500;

/** Pages a pass runs in each direction before it stops until the next one. */
export const SYNC_MAX_PAGES_PER_PASS = 20;

/** How far behind `now` a push mark stays, so rows committed late are not skipped (ms). */
export const SYNC_PUSH_SETTLE_MS = 60_000;

/**
 * How far ahead of this device's `now` an `updated_at` counts in a last-writer-wins comparison
 * (ms). A later one (a device whose clock is wrong, or a forged row) is compared as
 * `now + SYNC_MAX_CLOCK_SKEW_MS`; the row's stored value is kept as it is. So a row dated far in
 * the future can't win against every later edit: once this device's clock passes the cap, an edit
 * made then is newer. Two devices whose clocks differ can compare such a row differently until
 * their clocks pass it (a known limit).
 */
export const SYNC_MAX_CLOCK_SKEW_MS = 24 * 60 * 60_000;

/**
 * The largest pulled row (bytes: the sum over its spec'd columns of SQLite's `length()` of each value
 * cast to a blob). Larger rows are measured in SQL, never read, and skipped (`SyncTableReport.tooLarge`);
 * the pull mark still moves past them. Phase 6's largest values are snapshot and diff JSON.
 */
export const SYNC_MAX_ROW_BYTES = 16 * 1024 * 1024;

/** How often the service runs a pass (push, `sync()` with an endpoint, pull) after the first (ms). */
export const SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * **Where sync runs.** The engine and the replica's `sync()` run on Electron's main thread. libSQL's
 * `sync()` is synchronous native code (`databaseSyncSync`): with an endpoint it blocks the main
 * thread on network I/O, with no timeout. Moving the engine, or at least `sync()`, to a worker or
 * utility process is required before remote sync is turned on; local staging only does local I/O.
 * Each pull page is one `BEGIN IMMEDIATE` transaction on the session database, through a second
 * handle on its file; while it runs, the store's own writes wait (up to its busy timeout, then
 * fail as they would under any other lock).
 *
 * **What a pull page does when the session database refuses a row.** A page is one transaction,
 * so one row the session database refuses (a trigger, a foreign key; for example a tombstone for a
 * version that a capture from a device still offline references) rolls the whole page back, and
 * every later pass retries the same page: pull stalls for every table until the cause is handled.
 * Per-row quarantine is required before real tables are synced.
 *
 * **What a purge does not remove.** Arriving tombstones delete the rows they name in the replica
 * and in the session database, but the bytes can remain in SQLite's free pages (no `VACUUM` or
 * `secure_delete`), in the remote primary's history (its WAL frames and backups), and the row IDs
 * remain in `SYNC_LOG_TABLE`.
 *
 * **Device ID.** A copied profile (its `frost-sync.json`) shares its `deviceId` with the original,
 * and so its marks: the two would skip rows each other pushed. Making a new ID on a copy is not done.
 */

/**
 * Why a table is left out of a pass: it is not in the session database or not in the replica
 * (today, before Phase 6 merges, every `ci_*` table is missing), a `SyncTable.columns` entry is
 * missing on one side, or (an `append-only` table) `SYNC_TOMBSTONE_TABLE` is not on both sides.
 */
export const SYNC_SKIP_REASONS = ['missing-in-source', 'missing-in-replica', 'columns-missing', 'needs-tombstones'] as const;
export type SyncSkipReason = (typeof SYNC_SKIP_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Sync config (Task 8; acceptance `sync-config.feature.md`; Zod side `sync-config.schema.ts`)
// ---------------------------------------------------------------------------------------------

/**
 * `userData/SYNC_CONFIG_FILE_NAME`: mode 0600 on POSIX, written atomically (a 0600 temporary file
 * renamed over it), read with the strict `SyncConfigFileSchema`. A file that is not a regular
 * file, is larger than `MAX_SYNC_CONFIG_BYTES`, has a repeated key or does not match the schema is
 * tampered: sync is off for that run (one log line, no content) and the file is left alone. No file
 * means sync is off.
 */
export { SYNC_CONFIG_FILE_NAME };

/** The largest sync config file read (bytes). */
export const MAX_SYNC_CONFIG_BYTES = 32 * 1024;

/**
 * The file's shape:
 * - `enabled`: sync on or off;
 * - `url`: the endpoint (`syncEndpointProblem`). **No `url` means local staging only**: rows are
 *   mirrored into the local replica file and nothing leaves the device;
 * - `encryptedToken`: the endpoint's token as `safeStorage.encryptString` ciphertext, base64. Only
 *   with a `url`. The token itself is never written, logged, returned to the chrome or kept in state;
 * - `deviceId`: random (UUID v4), made locally the first time sync runs; keys the replica's marks.
 */
export interface SyncConfigFile {
  enabled: boolean;
  url?: string;
  encryptedToken?: string;
  deviceId?: string;
}

/** The endpoint schemes (`LIBSQL_SYNC_URL_SCHEMES`): `libsql:` (TLS) or `https:`; never `http:`. */
export const SYNC_ENDPOINT_SCHEMES = LIBSQL_SYNC_URL_SCHEMES;

/** Longest endpoint and token accepted (`MAX_LIBSQL_URL_CHARS`, `MAX_LIBSQL_AUTH_TOKEN_CHARS`). */
export const MAX_SYNC_ENDPOINT_CHARS = MAX_LIBSQL_URL_CHARS;
export const MAX_SYNC_TOKEN_CHARS = MAX_LIBSQL_AUTH_TOKEN_CHARS;

/** Why a sync config is refused (as it is written, or as it is read). */
export const SYNC_CONFIG_PROBLEMS = [
  'endpoint-invalid',
  'token-invalid',
  'token-needs-endpoint',
  'encryption-unavailable',
  'encryption-weak',
  'tampered',
  'token-undecryptable',
] as const;
export type SyncConfigProblem = (typeof SYNC_CONFIG_PROBLEMS)[number];

/**
 * Linux `safeStorage` backends that are no real protection: `basic_text` encrypts with a key
 * hard-coded in Chromium. A token is never stored or read through one (`encryption-weak`).
 */
export const SYNC_WEAK_STORAGE_BACKENDS = ['basic_text'] as const;

/**
 * Whether `url` may be the sync endpoint: `libsql:` or `https:` with a host, written lowercase, at
 * most `MAX_SYNC_ENDPOINT_CHARS`, with no user name or password, query, fragment, backslash, space
 * or non-ASCII (the `syncUrl` rules of `libsqlConfigProblem`, never with loopback `http:`).
 */
export function syncEndpointProblem(url: string): 'endpoint-invalid' | null {
  return typeof url === 'string' && syncUrlProblem(url, { allowLoopbackHttp: false }) === null ? null : 'endpoint-invalid';
}

/** Whether `token` may be stored: printable ASCII, no space, 1 to `MAX_SYNC_TOKEN_CHARS` characters. */
export function syncTokenProblem(token: string): 'token-invalid' | null {
  return typeof token === 'string' && token.length <= MAX_SYNC_TOKEN_CHARS && PRINTABLE.test(token) ? null : 'token-invalid';
}
