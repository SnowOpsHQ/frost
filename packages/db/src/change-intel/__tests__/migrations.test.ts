// Spec: specs/capture-db.spec.ts (CHANGE_INTEL_TABLES, CAPTURED_TABLES, AUDIT_TABLES, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME)
// Acceptance: specs/capture-db.feature.md (Schema)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { AUDIT_TABLES, CAPTURED_TABLES, CHANGE_INTEL_TABLES, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import { MIGRATIONS, runMigrations } from '../../migrations';
import { CHANGE_INTEL_MIGRATIONS } from '../migrations';
import { ciCaptures, ciDiffs, ciProjectPages, ciProjectQueries, ciProjects, ciPurges, ciScreenshots, ciTombstones, ciVersions } from '../schema';

const DRIZZLE_TABLES: readonly SQLiteTable[] = [ciProjects, ciProjectPages, ciProjectQueries, ciVersions, ciCaptures, ciDiffs, ciScreenshots, ciPurges, ciTombstones];

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

function sqliteColumns(db: DatabaseSync, table: string): Column[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0, primaryKey: row['pk'] !== 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

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

const named = (db: DatabaseSync, type: string): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'ci\\_%' ESCAPE '\\' ORDER BY rowid")
    .all(type)
    .map((row) => String(row['name']));

describe('change-intelligence migrations', () => {
  test('change-intel-migrations-create-schema', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    // Registered in the session migrations, numbered in Phase 6's range.
    expect(CHANGE_INTEL_MIGRATIONS.map((m) => m.id)).toEqual(['0040_change_intelligence', '0041_change_intelligence_guards']);
    expect(MIGRATIONS.slice(-CHANGE_INTEL_MIGRATIONS.length)).toEqual(CHANGE_INTEL_MIGRATIONS);

    // Tables, in creation order, column for column with the Drizzle schema.
    expect(named(db, 'table')).toEqual([...CHANGE_INTEL_TABLES]);
    expect(DRIZZLE_TABLES.map((table) => getTableConfig(table).name)).toEqual([...CHANGE_INTEL_TABLES]);
    for (const table of DRIZZLE_TABLES) {
      const name = getTableConfig(table).name;
      expect(sqliteColumns(db, name), name).toEqual(drizzleColumns(table));
    }

    // Indexes: exactly the Drizzle schema's.
    const declared = DRIZZLE_TABLES.flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)).sort();
    expect(named(db, 'index').sort()).toEqual(declared);
    expect(declared).toEqual(
      expect.arrayContaining([
        'ci_versions_lane_key_created_at',
        'ci_versions_page_url_created_at',
        'ci_captures_project_id_created_at',
        'ci_captures_version_id',
        'ci_captures_page_url_created_at',
        'ci_diffs_to_version_id',
        'ci_diffs_from_version_id',
        'ci_screenshots_project_id_created_at',
        'ci_screenshots_page_url_created_at',
        'ci_screenshots_sha256',
        'ci_project_pages_project_id',
        'ci_project_pages_live_url',
        'ci_project_queries_project_id',
        'ci_project_queries_live_query',
        'ci_tombstones_purge_id',
      ]),
    );

    // Triggers, by name.
    const triggers = [
      ...CAPTURED_TABLES.flatMap((t) => [`${t}_no_update`, `${t}_purge_only`, `${t}_no_resurrect`, `${t}_no_replace`]),
      ...AUDIT_TABLES.flatMap((t) => [`${t}_no_update`, `${t}_no_delete`, `${t}_no_replace`]),
      ...['ci_projects', 'ci_project_pages', 'ci_project_queries'].flatMap((t) => [`${t}_no_delete`, `${t}_id_stays`, `${t}_no_replace`]),
      'ci_project_pages_live_key_unique',
      'ci_project_queries_live_key_unique',
      'ci_projects_unfiled_stays',
      'ci_versions_unreferenced_only',
    ];
    expect(named(db, 'trigger').sort()).toEqual(triggers.sort());

    // The Unfiled project.
    expect({ ...db.prepare('SELECT * FROM ci_projects').get() }).toEqual({
      id: UNFILED_PROJECT_ID,
      name: UNFILED_PROJECT_NAME,
      render_profile: null,
      retention_mode: 'forever',
      retention_value: null,
      created_at: 0,
      updated_at: 0,
      deleted_at: null,
    });

    // CHECKs: enums and id length.
    const project = db.prepare('INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, ?, NULL, 1, 1, NULL)');
    expect(() => project.run('0190a000-0000-7000-8000-000000000001', 'P', 'sometimes')).toThrow();
    expect(() => project.run('short', 'P', 'forever')).toThrow();
    project.run('0190a000-0000-7000-8000-000000000001', 'P', 'forever');
    const tombstone = db.prepare("INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, '0190a000-0000-7000-8000-00000000000f', ?, '0190a000-0000-7000-8000-0000000000aa', 1)");
    expect(() => tombstone.run('0190a000-0000-7000-8000-000000000002', 'ci_projects')).toThrow();
    tombstone.run('0190a000-0000-7000-8000-000000000003', 'ci_versions');
    // One tombstone per (table, row).
    expect(() => tombstone.run('0190a000-0000-7000-8000-000000000004', 'ci_versions')).toThrow();
    // Every migration statement is plain SQL a fresh database accepts again (no IF NOT EXISTS needed).
    expect(() => runMigrations(new DatabaseSync(':memory:'))).not.toThrow();
  });

  test('change-intel-sql-is-portable', () => {
    const forbidden: [string, RegExp][] = [
      ['PRAGMA', /\bPRAGMA\b/i],
      ['ATTACH', /\bATTACH\b/i],
      ['virtual table', /\bVIRTUAL\b/i],
      ['JSON function', /\bjson\w*\s*\(/i],
      ['JSON operator', /->/],
      ['generated column', /\bGENERATED\b|\bAS\s*\(/i],
      ['STRICT', /\bSTRICT\b/i],
      ['WITHOUT ROWID', /\bWITHOUT\s+ROWID\b/i],
      ['AUTOINCREMENT', /\bAUTOINCREMENT\b/i],
    ];
    expect(CHANGE_INTEL_MIGRATIONS.length).toBeGreaterThan(0);
    for (const migration of CHANGE_INTEL_MIGRATIONS) {
      for (const [what, pattern] of forbidden) expect(pattern.test(migration.sql), `${migration.id}: ${what}`).toBe(false);
    }
  });
});
