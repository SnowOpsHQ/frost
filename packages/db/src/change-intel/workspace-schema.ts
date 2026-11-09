import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Phase 10's tables (Task 1; spec `workspace-db.spec.ts`, `WORKSPACE_TABLES`; acceptance
// `workspace-db.feature.md`, Tables). Migrations `0220_project_workspace` and `0222_serp_readings`
// create exactly these, column for column (`change-intel-migrations-create-schema`); their `CHECK`s
// and the `0221`/`0223` triggers are in `workspace-migrations.ts`. The new `ci_projects` columns are in
// `schema.ts`. Ids are UUIDv7 text, times Unix milliseconds, JSON text SQL never parses.

/** A project's competitor domains (mutable, tombstoned): one live row per `(projectId, domain)`. */
export const ciProjectCompetitors = sqliteTable(
  'ci_project_competitors',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    domain: text('domain').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    index('ci_project_competitors_project_id').on(table.projectId),
    uniqueIndex('ci_project_competitors_live_domain').on(table.projectId, table.domain).where(sql`deleted_at IS NULL`),
  ],
);

/** Tags on a project's pages and saved searches (mutable, tombstoned): one live row per `(entryKind, entryId, tag)`. */
export const ciEntryTags = sqliteTable(
  'ci_entry_tags',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    /** One of `ENTRY_KINDS`: `page` (a `ci_project_pages` id) or `search` (a `ci_project_queries` id). */
    entryKind: text('entry_kind').notNull(),
    entryId: text('entry_id').notNull(),
    tag: text('tag').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [index('ci_entry_tags_project_id').on(table.projectId), uniqueIndex('ci_entry_tags_live_tag').on(table.entryKind, table.entryId, table.tag).where(sql`deleted_at IS NULL`)],
);

/** SERP readings (append-only; deleted only once a `capture` reading's capture is gone). At most one per capture. */
export const ciSerpReadings = sqliteTable(
  'ci_serp_readings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    /** The capture it was read with (`source = 'capture'`), else `null`. */
    captureId: text('capture_id'),
    /** One of `SERP_READING_SOURCES`. */
    source: text('source').notNull(),
    /** SHA-256 hex of the search identity (`searchIdentityJson`) under `searchKeyVersion`. */
    searchKey: text('search_key').notNull(),
    searchKeyVersion: integer('search_key_version').notNull(),
    searchParams: text('search_params').notNull(),
    filters: text('filters').notNull(),
    pageUrl: text('page_url'),
    /** One of `SERP_READING_STATUSES`. */
    status: text('status').notNull(),
    packVersion: integer('pack_version'),
    /** The `SerpSnapshot` JSON. */
    reading: text('reading').notNull(),
    readingBytes: integer('reading_bytes').notNull(),
    observedAt: integer('observed_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('ci_serp_readings_project_id_search_key_observed_at').on(table.projectId, table.searchKey, table.observedAt),
    uniqueIndex('ci_serp_readings_capture_id').on(table.captureId).where(sql`capture_id IS NOT NULL`),
  ],
);
