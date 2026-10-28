import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

// The change-intelligence tables (Phase 6 Task 1; spec `capture-db.spec.ts`, `CHANGE_INTEL_TABLES`;
// acceptance `capture-db.feature.md`, Schema). Migration `0040_change_intelligence` creates exactly
// these, column for column (`change-intel-migrations-create-schema`); its `CHECK`s and the `0041`
// triggers are in `migrations.ts`. Ids are UUIDv7 text, times Unix milliseconds, JSON canonical text
// SQL never parses, hashes lowercase hex SHA-256.

/** Projects (mutable, tombstoned with `deletedAt`). `UNFILED_PROJECT_ID` is inserted by the migration. */
export const ciProjects = sqliteTable('ci_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  renderProfile: text('render_profile'),
  /** One of `RETENTION_MODES`; `retentionValue` is N for `versions` and `days`, else `null`. */
  retentionMode: text('retention_mode').notNull(),
  retentionValue: integer('retention_value'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/** A project's pages: one live row per `(projectId, url)`. */
export const ciProjectPages = sqliteTable(
  'ci_project_pages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    url: text('url').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [index('ci_project_pages_project_id').on(table.projectId), uniqueIndex('ci_project_pages_live_url').on(table.projectId, table.url).where(sql`deleted_at IS NULL`)],
);

/** A project's queries with their search parameters (JSON): one live row per `(projectId, query, searchParams)`. */
export const ciProjectQueries = sqliteTable(
  'ci_project_queries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    query: text('query').notNull(),
    searchParams: text('search_params').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    index('ci_project_queries_project_id').on(table.projectId),
    uniqueIndex('ci_project_queries_live_query').on(table.projectId, table.query, table.searchParams).where(sql`deleted_at IS NULL`),
  ],
);

/** One distinct state of a page in a lane (append-only). */
export const ciVersions = sqliteTable(
  'ci_versions',
  {
    id: text('id').primaryKey(),
    laneKey: text('lane_key').notNull(),
    pageUrl: text('page_url').notNull(),
    renderProfile: text('render_profile'),
    searchParams: text('search_params'),
    snapshot: text('snapshot').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    snapshotBytes: integer('snapshot_bytes').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** The lane's latest version when this one was inserted; it may since have been purged. */
    parentVersionId: text('parent_version_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('ci_versions_lane_key_created_at').on(table.laneKey, table.createdAt), index('ci_versions_page_url_created_at').on(table.pageUrl, table.createdAt)],
);

/** Every capture, changed or not, pointing at its version (append-only). */
export const ciCaptures = sqliteTable(
  'ci_captures',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    versionId: text('version_id').notNull(),
    laneKey: text('lane_key').notNull(),
    pageUrl: text('page_url').notNull(),
    renderProfile: text('render_profile'),
    renderProfilePartial: integer('render_profile_partial', { mode: 'boolean' }).notNull(),
    searchParams: text('search_params'),
    source: text('source').notNull(),
    auditTakenAt: integer('audit_taken_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('ci_captures_project_id_created_at').on(table.projectId, table.createdAt),
    index('ci_captures_version_id').on(table.versionId),
    index('ci_captures_page_url_created_at').on(table.pageUrl, table.createdAt),
  ],
);

/** The diff stored with each new version that has a parent (append-only). */
export const ciDiffs = sqliteTable(
  'ci_diffs',
  {
    id: text('id').primaryKey(),
    laneKey: text('lane_key').notNull(),
    fromVersionId: text('from_version_id').notNull(),
    toVersionId: text('to_version_id').notNull(),
    engineVersion: integer('engine_version').notNull(),
    diff: text('diff').notNull(),
    summary: text('summary').notNull(),
    changeCount: integer('change_count').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('ci_diffs_to_version_id').on(table.toVersionId)],
);

/** Screenshots: the PNG is `<CAPTURES_DIR_NAME>/screenshots/<sha256>.png`, shared by hash (append-only). */
export const ciScreenshots = sqliteTable(
  'ci_screenshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    pageUrl: text('page_url').notNull(),
    captureId: text('capture_id'),
    kind: text('kind').notNull(),
    rect: text('rect'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    segments: integer('segments').notNull(),
    renderProfile: text('render_profile'),
    searchParams: text('search_params'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('ci_screenshots_project_id_created_at').on(table.projectId, table.createdAt),
    index('ci_screenshots_page_url_created_at').on(table.pageUrl, table.createdAt),
    index('ci_screenshots_sha256').on(table.sha256),
  ],
);

/** The audit log of deletions (append-only, never deleted). */
export const ciPurges = sqliteTable('ci_purges', {
  id: text('id').primaryKey(),
  reason: text('reason').notNull(),
  projectId: text('project_id'),
  policy: text('policy'),
  captures: integer('captures').notNull(),
  versions: integer('versions').notNull(),
  diffs: integer('diffs').notNull(),
  screenshots: integer('screenshots').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** One per purged row, naming its purge (append-only, never deleted). */
export const ciTombstones = sqliteTable(
  'ci_tombstones',
  {
    id: text('id').primaryKey(),
    purgeId: text('purge_id').notNull(),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [unique().on(table.tableName, table.rowId), index('ci_tombstones_purge_id').on(table.purgeId)],
);
