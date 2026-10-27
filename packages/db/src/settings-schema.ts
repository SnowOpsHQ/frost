import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Local preferences by key (Phase 2.5 Task 6; spec `browser-polish.spec.ts`,
// `SEARCH_ENGINE_SETTING_KEY`). Migration `0005_app_settings` creates exactly this table. Times are
// Unix milliseconds.

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
