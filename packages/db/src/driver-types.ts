import type { DbDriverId } from '@app/specs/sync.spec';

// The driver seam (Phase 7 Task 6; spec `sync.spec.ts`; acceptance `sync-driver.feature.md`): the
// few async calls Drizzle's `sqlite-proxy` driver and the migration runner need, so the same
// repositories run over `node:sqlite` (`driver-node-sqlite.ts`, the default) or libSQL
// (`driver-libsql.ts`). Rows always come back as arrays in column order, with integers as numbers,
// booleans as 0/1 and blobs as `Uint8Array`, as `node:sqlite` reads them.

/** How Drizzle runs a statement: `run` answers no rows, `get` one row (or none), the others every row. */
export type SqlMethod = 'run' | 'all' | 'values' | 'get';

/** One prepared statement and its bound values. */
export interface SqlQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: SqlMethod;
}

/** A multi-statement script (a migration), run inside a `batch`. */
export interface SqlScript {
  readonly script: string;
}

export type SqlBatchItem = SqlQuery | SqlScript;

/**
 * What one statement answers, in the shape `sqlite-proxy` expects: `[]` for `run` (and a script),
 * the rows as arrays for `all` / `values`, the first row as an array (or `undefined`) for `get`.
 */
export interface SqlResult {
  readonly rows: unknown;
}

export interface SqlDriver {
  readonly kind: DbDriverId;
  /** Whether the database is still open (`close()` closes it). */
  readonly isOpen: boolean;
  /** Runs one statement. */
  execute(sql: string, params: readonly unknown[], method: SqlMethod): Promise<SqlResult>;
  /**
   * Runs `items` in order in one write transaction (`BEGIN IMMEDIATE`), answering one result per
   * item; any error rolls the whole batch back and rejects. Nothing else runs on the database
   * while it does. A script must not begin or end a transaction itself.
   */
  batch(items: readonly SqlBatchItem[]): Promise<SqlResult[]>;
  /** Runs a multi-statement script outside any transaction; one it left open is rolled back. */
  exec(script: string): Promise<void>;
  /** Closes the database (idempotent; never rejects). */
  close(): Promise<void>;
}

export const isScript = (item: SqlBatchItem): item is SqlScript => 'script' in item;
