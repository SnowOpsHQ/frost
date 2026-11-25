// Spec: specs/capture-db.spec.ts (CHANGE_INTEL_TABLES, CAPTURED_TABLES, AUDIT_TABLES, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME,
// PROJECT_PAGES_URL_INDEX_MIGRATION_IDS),
// specs/workspace-db.spec.ts (WORKSPACE_TABLES: Phase 10's tables and `ci_projects` columns)
// Acceptance: specs/capture-db.feature.md (Schema), specs/workspace-db.feature.md (Tables, Triggers; API readings (Phase 12))
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { AUDIT_TABLES, CAPTURED_TABLES, CHANGE_INTEL_TABLES, PROJECT_PAGES_URL_INDEX_MIGRATION_IDS, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import { SERP_API_READINGS_TABLES, WORKSPACE_TABLES } from '@app/specs/workspace-db.spec';
import { AGENT_SKILL_PREFS_MIGRATIONS } from '../../agent-skill-prefs-migrations';
import { createDrizzle } from '../../client';
import { createHistoryRepository } from '../../history';
import { MIGRATIONS, runMigrations } from '../../migrations';
import { CHANGE_INTEL_MIGRATIONS, PROJECT_PAGES_URL_INDEX_MIGRATIONS } from '../migrations';
import { createChangeIntelRepository } from '../repository';
import { ciCaptures, ciDiffs, ciProjectPages, ciProjectQueries, ciProjects, ciPurges, ciScreenshots, ciTombstones, ciVersions } from '../schema';
import { ciSerpApiPurges } from '../serp-api-schema';
import { ciEntryTags, ciProjectCompetitors, ciSerpReadings } from '../workspace-schema';

const DRIZZLE_TABLES: readonly SQLiteTable[] = [ciProjects, ciProjectPages, ciProjectQueries, ciVersions, ciCaptures, ciDiffs, ciScreenshots, ciPurges, ciTombstones];
/** Phase 10's tables (`workspace-schema.ts`), created after Phase 6's. */
const WORKSPACE_DRIZZLE_TABLES: readonly SQLiteTable[] = [ciProjectCompetitors, ciEntryTags, ciSerpReadings];
/** Phase 12's API readings purge record (`serp-api-schema.ts`, `0245`). */
const SERP_API_DRIZZLE_TABLES: readonly SQLiteTable[] = [ciSerpApiPurges];

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
    // Registered in the session migrations, numbered in Phase 6's range, together, and before the later
    // phases' (Phase 8's skill prefs are spread after them).
    expect(CHANGE_INTEL_MIGRATIONS.map((m) => m.id)).toEqual(['0040_change_intelligence', '0041_change_intelligence_guards']);
    const start = MIGRATIONS.indexOf(CHANGE_INTEL_MIGRATIONS[0]!);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(MIGRATIONS.slice(start, start + CHANGE_INTEL_MIGRATIONS.length)).toEqual(CHANGE_INTEL_MIGRATIONS);
    expect(start + CHANGE_INTEL_MIGRATIONS.length).toBeLessThanOrEqual(MIGRATIONS.indexOf(AGENT_SKILL_PREFS_MIGRATIONS[0]!));

    // Tables, in creation order, column for column with the Drizzle schema (`ci_projects` with Phase 10's columns).
    expect(named(db, 'table')).toEqual([...CHANGE_INTEL_TABLES, ...WORKSPACE_TABLES, ...SERP_API_READINGS_TABLES]);
    expect(SERP_API_DRIZZLE_TABLES.map((table) => getTableConfig(table).name)).toEqual([...SERP_API_READINGS_TABLES]);
    expect(DRIZZLE_TABLES.map((table) => getTableConfig(table).name)).toEqual([...CHANGE_INTEL_TABLES]);
    expect(WORKSPACE_DRIZZLE_TABLES.map((table) => getTableConfig(table).name)).toEqual([...WORKSPACE_TABLES]);
    expect(sqliteColumns(db, 'ci_projects').map((column) => column.name)).toEqual(
      expect.arrayContaining(['favorite', 'site_domain', 'site_subdomains', 'capture_cadence', 'auto_capture']),
    );
    for (const table of [...DRIZZLE_TABLES, ...WORKSPACE_DRIZZLE_TABLES, ...SERP_API_DRIZZLE_TABLES]) {
      const name = getTableConfig(table).name;
      expect(sqliteColumns(db, name), name).toEqual(drizzleColumns(table));
    }

    // Indexes: exactly the Drizzle schema's.
    const declared = [...DRIZZLE_TABLES, ...WORKSPACE_DRIZZLE_TABLES, ...SERP_API_DRIZZLE_TABLES].flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)).sort();
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
        'ci_project_competitors_project_id',
        'ci_project_competitors_live_domain',
        'ci_entry_tags_project_id',
        'ci_entry_tags_live_tag',
        'ci_serp_readings_project_id_search_key_observed_at',
        'ci_serp_readings_capture_id',
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
      // Phase 10 (`workspace-db.feature.md`, Triggers).
      ...['ci_project_competitors', 'ci_entry_tags'].flatMap((t) => [`${t}_no_delete`, `${t}_id_stays`, `${t}_no_replace`, `${t}_live_key_unique`]),
      'ci_serp_readings_no_update',
      'ci_serp_readings_no_replace',
      // Phase 12's `0245` (`workspace-db.feature.md`, API readings): Phase 10's `_capture_gone_only` replaced.
      'ci_serp_readings_delete_guard',
      'ci_serp_readings_no_resurrect',
      'ci_serp_api_purges_no_update',
      'ci_serp_api_purges_no_delete',
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
      favorite: 0,
      site_domain: null,
      site_subdomains: 1,
      capture_cadence: 'off',
      auto_capture: 0,
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

  test('project-pages-url-index', async () => {
    const db = new DatabaseSync(':memory:');
    // Every statement the repositories prepare on `db`, by its SQL text.
    const prepared: string[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (key === 'prepare' && typeof value === 'function') return (text: string) => (prepared.push(text), value.call(target, text));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    runMigrations(db);
    const drizzle = createDrizzle(watched);
    const projects = createChangeIntelRepository(drizzle);
    const history = createHistoryRepository(drizzle);
    /** The query plan of each statement `read` prepared that reads `ci_project_pages`. */
    const plansOf = async (read: () => Promise<unknown>): Promise<string[][]> => {
      prepared.length = 0;
      await read();
      const statements = prepared.filter((text) => text.includes('ci_project_pages'));
      expect(statements.length).toBeGreaterThan(0);
      return statements.map((text) => db.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map((row) => String(row['detail'])));
    };
    const PAGE = 'https://example.com/a';
    const SEARCH = /^SEARCH (p|ci_project_pages) USING (COVERING )?INDEX ci_project_pages_live_by_url \(url=\?/;
    // A page's projects, and the history's prune that keeps project pages: a search of the index by
    // URL, never a read of every project page.
    for (const read of [() => projects.projectsForPage(PAGE), () => history.prune(Date.now(), true)]) {
      for (const plan of await plansOf(read)) {
        expect(plan.some((step) => SEARCH.test(step)), plan.join('\n')).toBe(true);
        expect(plan.filter((step) => /^SCAN (p|ci_project_pages)\b/.test(step)), plan.join('\n')).toEqual([]);
      }
    }
    // The history's list in one project: a search too (by project and URL, the unique live index).
    for (const plan of await plansOf(() => history.list({ query: '', after: null, projectId: UNFILED_PROJECT_ID }))) {
      expect(plan.filter((step) => /^SCAN (p|ci_project_pages)\b/.test(step)), plan.join('\n')).toEqual([]);
    }

    // The migration: its own, after every earlier one, adding just the index to a database that has them.
    expect(PROJECT_PAGES_URL_INDEX_MIGRATIONS.map((m) => m.id)).toEqual([...PROJECT_PAGES_URL_INDEX_MIGRATION_IDS]);
    const at = MIGRATIONS.indexOf(PROJECT_PAGES_URL_INDEX_MIGRATIONS[0]!);
    expect(MIGRATIONS.slice(0, at).every((m) => m.id < PROJECT_PAGES_URL_INDEX_MIGRATION_IDS[0])).toBe(true);
    const earlier = new DatabaseSync(':memory:');
    runMigrations(earlier, MIGRATIONS.slice(0, at));
    const indexes = (handle: DatabaseSync) => handle.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ci_project_pages' AND sql IS NOT NULL ORDER BY name").all().map((row) => ({ ...row }));
    const before = indexes(earlier);
    expect(runMigrations(earlier)).toEqual([...PROJECT_PAGES_URL_INDEX_MIGRATION_IDS]);
    expect(indexes(earlier)).toEqual(indexes(db));
    expect(indexes(earlier).filter((index) => !before.some((old) => old.name === index.name))).toEqual([
      { name: 'ci_project_pages_live_by_url', sql: 'CREATE INDEX ci_project_pages_live_by_url ON ci_project_pages (url, project_id) WHERE deleted_at IS NULL' },
    ]);
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
    for (const migration of [...CHANGE_INTEL_MIGRATIONS, ...PROJECT_PAGES_URL_INDEX_MIGRATIONS]) {
      for (const [what, pattern] of forbidden) expect(pattern.test(migration.sql), `${migration.id}: ${what}`).toBe(false);
    }
  });
});
