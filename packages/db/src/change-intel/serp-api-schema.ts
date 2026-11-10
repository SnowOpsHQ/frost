import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Phase 12 Task 4's table (spec `workspace-db.spec.ts`, `SERP_API_READINGS_TABLES`; acceptance
// `workspace-db.feature.md`, API readings (Phase 12)). Migration `0245_serp_api_readings`
// (`serp-api-migrations.ts`) creates exactly this, column for column; its guards are there too.

/**
 * The record of each purged `serp-api` reading (the `ci_tombstones` idea for a table whose `CHECK`
 * cannot name `ci_serp_readings`): a reading of that source may be deleted only once its id is here,
 * and an id here is never inserted again. Append-only, device-local. An API-only purge writes no
 * `ci_purges` row (no all-zero row is ever synced), so this is its only log.
 */
export const ciSerpApiPurges = sqliteTable(
  'ci_serp_api_purges',
  {
    readingId: text('reading_id').primaryKey(),
    /** The purge that removed it (a `ci_purges` id only when that purge also removed captured rows). */
    purgeId: text('purge_id').notNull(),
    /** One of `PURGE_REASONS`. */
    reason: text('reason').notNull(),
    projectId: text('project_id').notNull(),
    purgedAt: integer('purged_at').notNull(),
  },
  (table) => [index('ci_serp_api_purges_project_id_purged_at').on(table.projectId, table.purgedAt)],
);
