import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The data API usage counter (Phase 12 Task 2; spec `specs/data-sources.spec.ts`, `DATA_USAGE_TABLES`,
// `DATA_USAGE_LIMITS`; acceptance `specs/data-sources.feature.md`, Usage counter). Migration
// `0243_data_api_usage` creates exactly this table: one row per provider (`DATA_PROVIDERS`) and UTC
// month (`YYYY-MM`), counting the requests the data API client sent. No key, URL or body is stored.

export const dataApiUsage = sqliteTable(
  'data_api_usage',
  {
    provider: text('provider').notNull(),
    month: text('month').notNull(),
    requests: integer('requests').notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.month] })],
);
