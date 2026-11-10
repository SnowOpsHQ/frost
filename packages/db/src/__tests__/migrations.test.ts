// Spec: specs/browser-session-db.spec.ts (MIGRATIONS_TABLE, SESSION_TABLES), specs/render-profile.feature.md (pins),
// specs/seo-content.spec.ts (CONTENT_TABLES), specs/ai-checks.spec.ts (AI_CHECKS_TABLES), specs/workspace-db.spec.ts (WORKSPACE_TABLES),
// specs/capture-db.spec.ts (SCREENSHOT_EDIT_TABLES; Phase 11 Decision 18: PHASE11_MIGRATIONS after Phase 10's block, 0230 then 0231)
// Acceptance: specs/browser-session-db.feature.md (Migrations)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { MIGRATIONS_TABLE, SESSION_TABLES } from '@app/specs/browser-session-db.spec';
import { CONTENT_TABLES } from '@app/specs/seo-content.spec';
import { CHANGE_INTEL_TABLES, SCREENSHOT_EDIT_TABLES } from '@app/specs/capture-db.spec';
import { AI_CHECKS_TABLES } from '@app/specs/ai-checks.spec';
import { WORKSPACE_TABLES } from '@app/specs/workspace-db.spec';
import { seoAiChecks } from '../ai-checks-schema';
import * as changeIntel from '../change-intel/schema';
import * as workspace from '../change-intel/workspace-schema';
import { seoSnippetVariants, seoTargetQueries } from '../content-schema';
import { appSettings } from '../settings-schema';
import { MIGRATIONS, runMigrations, type Migration } from '../migrations';
import { PHASE11_MIGRATIONS } from '../phase11-migrations';
import { AGENT_TABLES } from '../agent-tables';
import { browserTabs, recentVisits, renderProfilePins, schemaMigrations, sitePermissions } from '../schema';
import { openSessionStore } from '../store';

const memory = () => new DatabaseSync(':memory:');

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row['name']));
}

function recordedIds(db: DatabaseSync): string[] {
  return db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).all().map((row) => String(row['id']));
}

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** The columns SQLite reports for `table` (a column of a composite key counts as primary key). */
function sqliteColumns(db: DatabaseSync, table: string): Column[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({
      name: String(row['name']),
      type: String(row['type']).toLowerCase(),
      // An INTEGER PRIMARY KEY is a rowid alias: never null whatever `notnull` says.
      notNull: row['notnull'] === 1 || row['pk'] !== 0,
      primaryKey: row['pk'] !== 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The columns the Drizzle schema declares for `table`. */
function drizzleColumns(table: SQLiteTable): Column[] {
  const config = getTableConfig(table);
  const keyColumns = new Set(config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)));
  return config.columns
    .map((column) => ({
      name: column.name,
      type: column.getSQLType().toLowerCase(),
      notNull: column.notNull || column.primary || keyColumns.has(column.name),
      primaryKey: column.primary || keyColumns.has(column.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('migrations', () => {
  test('migrations-create-schema', () => {
    const db = memory();
    expect(runMigrations(db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(tableNames(db)).toEqual([...SESSION_TABLES, ...CHANGE_INTEL_TABLES, MIGRATIONS_TABLE, ...AGENT_TABLES, ...AI_CHECKS_TABLES, ...WORKSPACE_TABLES, ...SCREENSHOT_EDIT_TABLES].sort());
    // Phase 2.5 Task 3's Content panel notes are session tables too (`seo-content.feature.md`, content-tables-migrate).
    expect(SESSION_TABLES).toEqual(expect.arrayContaining([...CONTENT_TABLES]));
    for (const table of [schemaMigrations, browserTabs, recentVisits, sitePermissions, renderProfilePins, seoTargetQueries, seoSnippetVariants, appSettings, seoAiChecks, changeIntel.screenshotEdits]) {
      const name = getTableConfig(table).name;
      expect(sqliteColumns(db, name), name).toEqual(drizzleColumns(table));
    }
    // The schema's indexes exist too.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row['name']);
    expect(indexes).toEqual([recentVisits, renderProfilePins, ...Object.values(changeIntel), ...Object.values(workspace)].flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)).sort());
    expect(recordedIds(db)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  test('migrations-are-idempotent', () => {
    const db = memory();
    runMigrations(db);
    db.prepare("INSERT INTO browser_tabs (position, url, title, active) VALUES (0, 'https://example.com/', 'Example', 1)").run();
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    expect(recordedIds(db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(db.prepare('SELECT url FROM browser_tabs').all()).toEqual([{ url: 'https://example.com/' }]);
  });

  test('migrations-are-forward-only', () => {
    // Ids are strictly increasing; there is nothing but forward SQL.
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids.every((id, i) => /^\d{4}_[a-z0-9_]+$/.test(id) && (i === 0 || id > ids[i - 1]!))).toBe(true);
    // Phase 11's block (Decision 18) sits contiguously and in id order within its range, after every
    // lower id; a later phase's block may follow it (the strictly-increasing check covers the rest).
    expect(PHASE11_MIGRATIONS.map((m) => m.id)).toEqual(['0230_agent_chat_lifecycle', '0231_screenshot_edits']);
    expect(PHASE11_MIGRATIONS.every((m) => m.id >= '0230' && m.id < '0240')).toBe(true);
    const first = MIGRATIONS.indexOf(PHASE11_MIGRATIONS[0]!);
    expect(first).toBeGreaterThan(0);
    expect(MIGRATIONS.slice(first, first + PHASE11_MIGRATIONS.length)).toEqual(PHASE11_MIGRATIONS);
    expect(ids.slice(0, first).every((id) => id < '0230')).toBe(true);
    // The test-only ids sit above every real one (`9000_`, `9001_`, `9999_`).
    expect(ids.every((id) => id < '9000')).toBe(true);
    for (const migration of MIGRATIONS) expect(Object.keys(migration).sort()).toEqual(['id', 'sql']);

    const db = memory();
    runMigrations(db);
    // An applied migration is not run again, even if its SQL would now fail.
    const rewritten: Migration[] = MIGRATIONS.map((m) => ({ id: m.id, sql: 'THIS IS NOT SQL' }));
    expect(runMigrations(db, rewritten)).toEqual([]);
    // An id recorded by a newer build is left alone; a new one is applied after the known ones.
    db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES ('9999_from_the_future', 1)`).run();
    const next: Migration = { id: '9000_test_extra', sql: 'CREATE TABLE extra (x INTEGER)' };
    expect(runMigrations(db, [...MIGRATIONS, next])).toEqual(['9000_test_extra']);
    expect(recordedIds(db)).toEqual([...ids, '9000_test_extra', '9999_from_the_future']);
  });

  test('migration-0002-drops-stored-allows', () => {
    const db = memory();
    // A database an earlier build left at 0001, with Allows and Blocks stored.
    expect(runMigrations(db, MIGRATIONS.filter((m) => m.id < '0002'))).toEqual(['0001_browser_session']);
    const insert = db.prepare('INSERT INTO site_permissions (origin, top_level_origin, permission, decision, updated_at) VALUES (?, ?, ?, ?, 1)');
    insert.run('https://a.example', 'https://a.example', 'notifications', 'allow');
    insert.run('https://a.example', 'https://a.example', 'geolocation', 'block');
    insert.run('https://w.example', 'https://a.example', 'camera', 'allow');
    insert.run('https://w.example', 'https://a.example', 'microphone', 'block');
    const applied = runMigrations(db);
    expect(applied).toContain('0002_block_only_permissions');
    const rows = db.prepare('SELECT origin, permission, decision FROM site_permissions ORDER BY origin, permission').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { origin: 'https://a.example', permission: 'geolocation', decision: 'block' },
      { origin: 'https://w.example', permission: 'microphone', decision: 'block' },
    ]);
    expect(recordedIds(db).filter((id) => id === '0002_block_only_permissions')).toHaveLength(1);
  });

  test('failed-migration-rolls-back', () => {
    const db = memory();
    runMigrations(db);
    const broken: Migration = { id: '9000_broken', sql: 'CREATE TABLE half (x INTEGER); CREATE TABLE half (y INTEGER);' };
    expect(() => runMigrations(db, [...MIGRATIONS, broken])).toThrow();
    expect(tableNames(db)).not.toContain('half');
    expect(recordedIds(db)).toEqual(MIGRATIONS.map((m) => m.id));
    // The database is still usable and the migration can be retried once fixed.
    expect(runMigrations(db, [...MIGRATIONS, { id: '9000_broken', sql: 'CREATE TABLE half (x INTEGER)' }])).toEqual(['9000_broken']);
  });

  test('failed-migration-keeps-its-own-error', () => {
    // SQLite rolls a transaction back by itself on some failures (disk full, I/O error). Stood in for
    // here by a migration that ends its transaction and then fails: the runner must not answer with
    // "cannot rollback - no transaction is active" in place of the real error.
    const db = memory();
    runMigrations(db);
    const broken: Migration = { id: '9001_ended', sql: 'ROLLBACK; SELECT * FROM no_such_table;' };
    expect(() => runMigrations(db, [...MIGRATIONS, broken])).toThrow(/no_such_table/);
    expect(db.isTransaction).toBe(false);
    expect(recordedIds(db)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  // Phase 11 Task 12 (specs/diagnostics.spec.ts, DIAGNOSTICS_FIELDS `migrations`): the store lists the applied ids.
  test('store-lists-applied-migration-ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-db-ids-'));
    try {
      const store = openSessionStore({ dir });
      expect(store.migrationIds()).toEqual(MIGRATIONS.map((m) => m.id).sort());
      await store.close();
      // Closed: nothing to read, and no throw.
      expect(store.migrationIds()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
