// Fixture `ci_*` tables for the sync engine's tests (specs/sync-engine.feature.md): Phase 6's
// conventions and guard triggers (docs/plans/phase-6-change-intelligence.md, Schema; its migrations
// 0040 / 0041 are not merged here), written in SQL both drivers run (SQLite 3.45). Not Phase 6's
// code: only the shape the engine relies on.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { libsqlFileUrl, openLibsqlDriver } from '@app/db/driver-libsql';
import { createNodeSqliteDriver } from '@app/db/driver-node-sqlite';
import type { SqlDriver } from '@app/db/driver-types';
import { SYNC_PURGE_DELETE_ORDER, SYNC_REPLICA_FILE_NAME, SYNC_TABLES, type SyncTableName } from '@app/specs/sync.spec';

const MUTABLE = ['ci_projects', 'ci_project_pages', 'ci_project_queries'] as const;

/** `CREATE TABLE` for `table`, every spec'd column (`id` the key), optionally leaving one out. */
export function tableSql(table: SyncTableName, { without }: { without?: string } = {}): string {
  const spec = SYNC_TABLES.find((t) => t.name === table)!;
  const columns = (spec.columns as readonly string[]).filter((c) => c !== without).map((c) => (c === 'id' ? 'id TEXT PRIMARY KEY NOT NULL' : `${c}`));
  const unique = table === 'ci_tombstones' ? ', UNIQUE (table_name, row_id)' : '';
  return `CREATE TABLE ${table} (${columns.join(', ')}${unique});`;
}

const raise = (message: string) => `BEGIN SELECT RAISE(ABORT, '${message}'); END;`;

/** Phase 6's guard triggers (0041), as its Schema section lists them. */
export function triggerSql(): string {
  const out: string[] = [];
  for (const t of SYNC_PURGE_DELETE_ORDER) {
    out.push(
      `CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} ${raise(`${t} is append-only`)}`,
      `CREATE TRIGGER ${t}_purge_only BEFORE DELETE ON ${t} WHEN NOT EXISTS (SELECT 1 FROM ci_tombstones t JOIN ci_purges p ON p.id = t.purge_id WHERE t.table_name = '${t}' AND t.row_id = OLD.id) ${raise(`${t} rows are deleted only by a recorded purge`)}`,
      `CREATE TRIGGER ${t}_no_resurrect BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ci_tombstones WHERE table_name = '${t}' AND row_id = NEW.id) ${raise(`${t} row was purged`)}`,
      `CREATE TRIGGER ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE id = NEW.id) ${raise(`${t} rows are never replaced`)}`,
    );
  }
  out.push(`CREATE TRIGGER ci_versions_unreferenced_only BEFORE DELETE ON ci_versions WHEN EXISTS (SELECT 1 FROM ci_captures WHERE version_id = OLD.id) ${raise('ci_versions row is still referenced')}`);
  for (const t of ['ci_purges', 'ci_tombstones']) {
    out.push(
      `CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} ${raise(`${t} is append-only`)}`,
      `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} ${raise(`${t} rows are never deleted`)}`,
      `CREATE TRIGGER ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE id = NEW.id) ${raise(`${t} rows are never replaced`)}`,
    );
  }
  out.push(
    `CREATE TRIGGER ci_tombstones_one_per_row BEFORE INSERT ON ci_tombstones WHEN EXISTS (SELECT 1 FROM ci_tombstones WHERE table_name = NEW.table_name AND row_id = NEW.row_id) ${raise('ci_tombstones row exists')}`,
  );
  for (const t of MUTABLE) {
    out.push(
      `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} ${raise(`${t} rows are tombstoned, never deleted`)}`,
      `CREATE TRIGGER ${t}_id_stays BEFORE UPDATE OF id ON ${t} WHEN NEW.id <> OLD.id ${raise(`${t} id never changes`)}`,
      `CREATE TRIGGER ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE id = NEW.id) ${raise(`${t} rows are never replaced`)}`,
    );
  }
  return out.join('\n');
}

/** Every fixture table and trigger. */
export const PHASE6_FIXTURE_SQL = `${SYNC_TABLES.map((t) => tableSql(t.name)).join('\n')}\n${triggerSql()}`;

/** A lowercase UUIDv7-shaped id whose order follows `n` (time-ordered, like Phase 6's). */
export const uuid7 = (n: number, tail = 0): string => {
  const hex = n.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail.toString(16).padStart(12, '0')}`;
};

export interface Fixture {
  readonly dir: string;
  readonly replica: SqlDriver;
  /** A device's session database (`node:sqlite`, a file), with or without the fixture tables. */
  device(name: string, options?: { tables?: boolean }): Promise<SqlDriver>;
  /** A raw handle on a device's file (for triggers the test adds). */
  raw(name: string): DatabaseSync;
  close(): Promise<void>;
}

/** A temporary directory with a libSQL `file:` replica (fixture tables in it unless `replicaTables: false`). */
export async function openFixture({ replicaTables = true }: { replicaTables?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-sync-engine-'));
  const replica = await openLibsqlDriver({ url: libsqlFileUrl(path.join(dir, SYNC_REPLICA_FILE_NAME)) });
  if (replicaTables) await replica.exec(PHASE6_FIXTURE_SQL);
  const handles = new Map<string, DatabaseSync>();
  const drivers: SqlDriver[] = [replica];
  return {
    dir,
    replica,
    async device(name, { tables = true } = {}) {
      const db = new DatabaseSync(path.join(dir, `${name}.db`));
      handles.set(name, db);
      const driver = createNodeSqliteDriver(db);
      drivers.push(driver);
      if (tables) await driver.exec(PHASE6_FIXTURE_SQL);
      return driver;
    },
    raw: (name) => handles.get(name)!,
    async close() {
      for (const driver of drivers) await driver.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** Every row of `table` (spec'd columns, in order), sorted by `id`. */
export async function rowsOf(driver: SqlDriver, table: SyncTableName): Promise<unknown[][]> {
  const spec = SYNC_TABLES.find((t) => t.name === table)!;
  return (await driver.execute(`SELECT ${spec.columns.join(', ')} FROM ${table} ORDER BY id`, [], 'all')).rows as unknown[][];
}

/** Inserts `values` (spec'd column order) into `table` with plain SQL, as Phase 6's code would. */
export async function insert(driver: SqlDriver, table: SyncTableName, values: readonly unknown[]): Promise<void> {
  const spec = SYNC_TABLES.find((t) => t.name === table)!;
  await driver.execute(`INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${spec.columns.map(() => '?').join(', ')})`, values, 'run');
}

/** The names of the tables in `driver`'s database. */
export async function tableNames(driver: SqlDriver): Promise<string[]> {
  const rows = (await driver.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", [], 'all')).rows as [string][];
  return rows.map(([name]) => name);
}

// Row builders (values in the spec's column order).
export const project = (id: string, name: string, updatedAt: number, deletedAt: number | null = null) => [id, name, null, 'forever', null, 1_000, updatedAt, deletedAt];
export const page = (id: string, projectId: string, url: string, updatedAt: number) => [id, projectId, url, 1_000, updatedAt, null];
export const query = (id: string, projectId: string, text: string, updatedAt: number) => [id, projectId, text, '{"engine":"google"}', 1_000, updatedAt, null];
export const version = (id: string, createdAt: number, parent: string | null = null) => [id, 'lane', 'https://example.com/', null, null, '{"title":"t"}', 'ab'.repeat(32), 15, 1, parent, createdAt];
export const capture = (id: string, projectId: string, versionId: string, createdAt: number) => [id, projectId, versionId, 'lane', 'https://example.com/', '{}', 0, null, 'manual', createdAt, createdAt];
export const diff = (id: string, from: string, to: string, createdAt: number) => [id, 'lane', from, to, 1, '{"changes":[]}', '{"title":1}', 1, createdAt];
export const screenshot = (id: string, projectId: string, captureId: string | null, createdAt: number) => [id, projectId, 'https://example.com/', captureId, 'viewport', null, 800, 600, 1234, 'cd'.repeat(32), 1, '{}', null, createdAt];
export const purge = (id: string, createdAt: number) => [id, 'purge-now', null, null, 1, 1, 1, 0, 100, createdAt];
export const tombstone = (id: string, purgeId: string, table: string, rowId: string, createdAt: number) => [id, purgeId, table, rowId, createdAt];
