import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The Content panel's local notes (Phase 2.5 Task 3; spec `seo-content.spec.ts`, `CONTENT_TABLES`;
// acceptance `seo-content.feature.md`, Store). Migration `0003_seo_content_notes` creates exactly
// these tables. Times are Unix milliseconds.

/** One target query per page URL (`http(s)`, without its fragment). */
export const seoTargetQueries = sqliteTable('seo_target_queries', {
  url: text('url').primaryKey(),
  query: text('query').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Snippet drafts: up to `MAX_SNIPPET_VARIANTS` numbered slots per page URL. */
export const seoSnippetVariants = sqliteTable(
  'seo_snippet_variants',
  {
    url: text('url').notNull(),
    slot: integer('slot').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.url, table.slot] })],
);
