import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_TABLE } from '@app/specs/browser-session-db.spec';

// Forward-only migrations (spec `browser-session-db.feature.md`, Migrations). Each one is a
// numbered SQL string compiled into the main bundle: nothing is read from disk at runtime. Append
// new migrations; never edit or remove an applied one.

export interface Migration {
  /** Strictly increasing, zero-padded (`0001_…`), so string order is numeric order. */
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_browser_session',
    sql: `
      CREATE TABLE browser_tabs (
        position INTEGER PRIMARY KEY NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE recent_visits (
        url TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 1,
        last_visit_at INTEGER NOT NULL
      );
      CREATE INDEX recent_visits_last_visit_at ON recent_visits (last_visit_at);
      CREATE TABLE site_permissions (
        origin TEXT NOT NULL,
        top_level_origin TEXT NOT NULL,
        permission TEXT NOT NULL,
        decision TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (origin, top_level_origin, permission)
      );
    `,
  },
  {
    // Only Blocks persist (`PERSISTED_DECISIONS`): an Allow is for the app session it was given in.
    // Drops what earlier builds stored besides Blocks.
    id: '0002_block_only_permissions',
    sql: `DELETE FROM site_permissions WHERE decision <> 'block';`,
  },
  {
    // Render profiles pinned to a site (Phase 2.5 Task 1).
    id: '0003_render_profile_pins',
    sql: `
      CREATE TABLE render_profile_pins (
        origin TEXT PRIMARY KEY NOT NULL,
        profile TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX render_profile_pins_updated_at ON render_profile_pins (updated_at);
    `,
  },
  {
    // The Content panel's notes (Phase 2.5 Task 3, `seo-content.spec.ts`, `CONTENT_TABLES`):
    // target queries and snippet drafts per page URL (`content-schema.ts`). `IF NOT EXISTS`: a dev
    // profile from before the Phase 2.5 merge has them already, recorded as `0003_seo_content_notes`.
    id: '0004_seo_content_notes',
    sql: `
      CREATE TABLE IF NOT EXISTS seo_target_queries (
        url TEXT PRIMARY KEY NOT NULL,
        query TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seo_snippet_variants (
        url TEXT NOT NULL,
        slot INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (url, slot)
      );
    `,
  },
];

/**
 * Applies, in order, every migration of `migrations` whose id `MIGRATIONS_TABLE` lacks, each in its
 * own transaction with its id row (a failure rolls that migration back and throws). Ids recorded
 * but unknown here (a newer build's) are left alone. Answers the ids it applied.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => number = Date.now): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`);
  const recorded = new Set(db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all().map((row) => String(row['id'])));
  const record = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`);
  const applied: string[] = [];
  for (const migration of migrations) {
    if (recorded.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      record.run(migration.id, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.id);
  }
  return applied;
}
