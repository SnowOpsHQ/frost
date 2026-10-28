import path from 'node:path';
import type { Client, InArgs, ResultSet } from '@libsql/client/sqlite3';
import { DB_BUSY_TIMEOUT_MS } from '@app/specs/browser-session-db.spec';
import { LIBSQL_INT_MODE, libsqlConfigProblem, type LibsqlConfig, type LibsqlConfigProblem, type LibsqlUrlOptions } from '@app/specs/sync.spec';
import { isScript, type SqlDriver, type SqlMethod, type SqlQuery, type SqlResult } from './driver-types';

// The libSQL driver (Phase 7 Task 6; spec `sync.spec.ts`; acceptance `sync-driver.feature.md`):
// `@libsql/client` over a local `file:` database, or an embedded replica of a remote primary when
// a `syncUrl` is given (Task 8's `SYNC_REPLICA_FILE_NAME`). Its `sqlite3` entry: the local client,
// which is all `libsqlConfigProblem` allows (`file:` URLs; the native `libsql` module syncs an
// embedded replica itself), so its WebSocket / HTTP clients (`hrana-client`, `ws`) never load. It
// is loaded with `await import()` the first time a driver is opened, never by importing
// `@app/db`: its index does not reach this file, so the main bundle never contains it.
//
// Same values as `node:sqlite`: `intMode: 'number'` (`LIBSQL_INT_MODE`; exact to 2^53 − 1, a
// larger stored integer throws a `RangeError` when read), booleans as 0/1, blobs converted from
// libSQL's `ArrayBuffer` to `Uint8Array`, and rows (libSQL's objects keyed by column, and indexed)
// turned into arrays in column order. One connection (`concurrency: 1`), like the single
// `DatabaseSync` handle: an embedded replica allows no more anyway, and every call is serialized.

/** The config is refused (`libsqlConfigProblem`); the message names the problem, never a value. */
export class LibsqlConfigError extends Error {
  override readonly name = 'LibsqlConfigError';
  constructor(readonly problem: LibsqlConfigProblem) {
    super(`libSQL config refused: ${problem}`);
  }
}

/** What one `sync()` pulled from the primary. */
export interface LibsqlSyncResult {
  readonly framesSynced: number;
  readonly frameNo: number;
}

export interface LibsqlDriver extends SqlDriver {
  readonly kind: 'libsql';
  /** Pulls the primary's new frames into the replica. Present only when opened with a `syncUrl`. */
  readonly sync?: () => Promise<LibsqlSyncResult>;
}

/**
 * The `file:` URL of the absolute path `file`, percent-encoded per segment, as `libsqlFilePath`
 * reads it back: `file:///a/b.db` on POSIX, `file:C:/a/b.db` on Windows (`pathApi` `path.win32`;
 * libSQL opens whatever follows `file:`, and Windows can't open `/C:/…`). A Windows path that is
 * not on a drive (a UNC share, `\\?\` device paths) is refused.
 */
export function libsqlFileUrl(file: string, pathApi: typeof path = path): string {
  if (!pathApi.isAbsolute(file)) throw new Error('libsqlFileUrl needs an absolute path');
  const normalized = pathApi.normalize(file);
  const encode = (segments: string) => segments.split('/').map(encodeURIComponent).join('/');
  if (pathApi.sep === '/') return `file://${encode(normalized)}`;
  const forward = normalized.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(forward)) throw new Error('libsqlFileUrl needs a path on a drive');
  return `file:${forward.slice(0, 2)}${encode(forward.slice(2))}`;
}

/** `value` as `node:sqlite` would read it: a blob as `Uint8Array`, anything else as is. */
const valueOf = (value: unknown): unknown => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);

/** `result`'s rows as arrays in column order (by index: two columns may share a name). */
function rowsOf(result: ResultSet): unknown[][] {
  const width = result.columns.length;
  return result.rows.map((row) => Array.from({ length: width }, (_, i) => valueOf(row[i])));
}

function resultOf(result: ResultSet, method: SqlMethod): SqlResult {
  if (method === 'run') return { rows: [] };
  const rows = rowsOf(result);
  return { rows: method === 'get' ? rows[0] : rows };
}

const statement = (sql: string, params: readonly unknown[]) => ({ sql, args: params as InArgs });

function driverOver(client: Client): LibsqlDriver {
  return {
    kind: 'libsql',
    get isOpen() {
      return !client.closed;
    },
    execute: async (sql, params, method) => resultOf(await client.execute(statement(sql, params)), method),
    async batch(items) {
      if (items.length === 0) return [];
      const queries = items.filter((item): item is SqlQuery => !isScript(item));
      if (queries.length === items.length) {
        // `'write'` is `BEGIN IMMEDIATE`; libSQL commits, or rolls back on any error, inside one call.
        const results = await client.batch(
          queries.map(({ sql, params }) => statement(sql, params)),
          'write',
        );
        return results.map((result, i) => resultOf(result, queries[i]!.method));
      }
      // A script (a migration) needs `executeMultiple`, which `batch` lacks: an explicit write
      // transaction, holding the one connection until it settles (any other call meanwhile is
      // refused by libSQL rather than run inside it).
      const transaction = await client.transaction('write');
      try {
        const results: SqlResult[] = [];
        for (const item of items) {
          if (isScript(item)) {
            await transaction.executeMultiple(item.script);
            if (transaction.closed) throw new Error('a batch script ended its transaction');
            results.push({ rows: [] });
          } else {
            results.push(resultOf(await transaction.execute(statement(item.sql, item.params)), item.method));
          }
        }
        await transaction.commit();
        return results;
      } finally {
        // Rolls back unless committed, and hands the connection back.
        transaction.close();
      }
    },
    // libSQL's pool rolls back a transaction the script left open when the connection is released.
    exec: async (script) => client.executeMultiple(script),
    async close() {
      try {
        client.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Opens `config` with libSQL (loading it now, if not yet). Refuses, before loading anything, a
 * config `libsqlConfigProblem` rejects (`LibsqlConfigError`).
 */
export async function openLibsqlDriver(config: LibsqlConfig, options: LibsqlUrlOptions = {}): Promise<LibsqlDriver> {
  const problem = libsqlConfigProblem(config, options);
  if (problem !== null) throw new LibsqlConfigError(problem);
  const { createClient } = await import('@libsql/client/sqlite3');
  const { url, syncUrl, authToken, syncInterval } = config;
  const client = createClient({
    url,
    ...(syncUrl === undefined ? {} : { syncUrl }),
    ...(authToken === undefined ? {} : { authToken }),
    ...(syncInterval === undefined ? {} : { syncInterval }),
    intMode: LIBSQL_INT_MODE,
    concurrency: 1,
    timeout: DB_BUSY_TIMEOUT_MS,
  });
  const driver = driverOver(client);
  if (syncUrl === undefined) return driver;
  const sync = async (): Promise<LibsqlSyncResult> => {
    const replicated = await client.sync();
    return { framesSynced: replicated?.frames_synced ?? 0, frameNo: replicated?.frame_no ?? 0 };
  };
  // Added to the driver itself (its `isOpen` getter stays live).
  return Object.assign(driver, { sync });
}
