// Spec: specs/browser-session-db.spec.ts (MIGRATIONS_TABLE, SESSION_TABLES), specs/render-profile.feature.md (pins)
// Acceptance: specs/browser-session-db.feature.md (Migrations)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { MIGRATIONS_TABLE, SESSION_TABLES } from '@app/specs/browser-session-db.spec';
import { MIGRATIONS, runMigrations, type Migration } from '../migrations';
import { browserTabs, recentVisits, renderProfilePins, schemaMigrations, sitePermissions } from '../schema';

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
    expect(tableNames(db)).toEqual([...SESSION_TABLES, MIGRATIONS_TABLE].sort());
    for (const table of [schemaMigrations, browserTabs, recentVisits, sitePermissions, renderProfilePins]) {
      const name = getTableConfig(table).name;
      expect(sqliteColumns(db, name), name).toEqual(drizzleColumns(table));
    }
    // The schema's indexes exist too.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row['name']);
    expect(indexes).toEqual([recentVisits, renderProfilePins].flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)).sort());
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
    for (const migration of MIGRATIONS) expect(Object.keys(migration).sort()).toEqual(['id', 'sql']);

    const db = memory();
    runMigrations(db);
    // An applied migration is not run again, even if its SQL would now fail.
    const rewritten: Migration[] = MIGRATIONS.map((m) => ({ id: m.id, sql: 'THIS IS NOT SQL' }));
    expect(runMigrations(db, rewritten)).toEqual([]);
    // An id recorded by a newer build is left alone; a new one is applied after the known ones.
    db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES ('9999_from_the_future', 1)`).run();
    const next: Migration = { id: '0100_test_extra', sql: 'CREATE TABLE extra (x INTEGER)' };
    expect(runMigrations(db, [...MIGRATIONS, next])).toEqual(['0100_test_extra']);
    expect(recordedIds(db)).toEqual([...ids, '0100_test_extra', '9999_from_the_future']);
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
    const broken: Migration = { id: '0100_broken', sql: 'CREATE TABLE half (x INTEGER); CREATE TABLE half (y INTEGER);' };
    expect(() => runMigrations(db, [...MIGRATIONS, broken])).toThrow();
    expect(tableNames(db)).not.toContain('half');
    expect(recordedIds(db)).toEqual(MIGRATIONS.map((m) => m.id));
    // The database is still usable and the migration can be retried once fixed.
    expect(runMigrations(db, [...MIGRATIONS, { id: '0100_broken', sql: 'CREATE TABLE half (x INTEGER)' }])).toEqual(['0100_broken']);
  });
});
