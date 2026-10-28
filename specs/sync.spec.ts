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
 * here; this file only fixes which file may carry a `syncUrl`.
 */
import { DB_FILE_NAME } from './browser-session-db.spec';

/** The SQL drivers Drizzle can run over (`SqlDriver.kind`). */
export const DB_DRIVER_IDS = ['node-sqlite', 'libsql'] as const;
export type DbDriverId = (typeof DB_DRIVER_IDS)[number];

/** The driver every database uses unless a caller asks for another. */
export const DEFAULT_DB_DRIVER: DbDriverId = 'node-sqlite';

/**
 * The local file of the libSQL embedded replica (Task 8), directly in `app.getPath('userData')`.
 * The only file opened with a `syncUrl`, so the only one that talks to the sync endpoint.
 */
export const SYNC_REPLICA_FILE_NAME = 'frost-sync.db' as const;

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
 * The SQLite each driver runs, which differ: `libsql` 0.5.29 bundles SQLite 3.45.1 (compiled with
 * `SQLITE_DEFAULT_RECURSIVE_TRIGGERS`; the driver's connections still read `PRAGMA
 * recursive_triggers` as 0, as `node:sqlite`'s do), while Node 26 and Electron 45's `node:sqlite`
 * bundle 3.53.4. A migration or query meant to run over both drivers (`MIGRATIONS`, and Phase 6's
 * `ci_*` tables when Task 8 mirrors them) uses only what SQLite 3.45 supports.
 */
export const LIBSQL_SQLITE_VERSION = '3.45.1' as const;

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
