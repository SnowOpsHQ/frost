import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { MIGRATIONS_TABLE } from '@app/specs/browser-session-db.spec';

// The browser-session schema (spec `browser-session-db.feature.md`, Schema). Migrations in
// `migrations.ts` create exactly these tables; `migrations.test.ts` checks they agree column for
// column. Times are Unix milliseconds.

/** Applied migration ids (the forward-only runner's ledger). */
export const schemaMigrations = sqliteTable(MIGRATIONS_TABLE, {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
});

/** The window's tab strip as last saved: one row per tab, by strip position. */
export const browserTabs = sqliteTable('browser_tabs', {
  position: integer('position').primaryKey(),
  /** An `http(s)` URL without userinfo, or `''` for an empty tab. */
  url: text('url').notNull(),
  title: text('title').notNull().default(''),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
});

/** One row per visited URL. */
export const recentVisits = sqliteTable(
  'recent_visits',
  {
    url: text('url').primaryKey(),
    title: text('title').notNull().default(''),
    visitCount: integer('visit_count').notNull().default(1),
    lastVisitAt: integer('last_visit_at').notNull(),
  },
  (table) => [index('recent_visits_last_visit_at').on(table.lastVisitAt)],
);

/** Remembered Allow / Block decisions, keyed as the permission broker keys them. */
export const sitePermissions = sqliteTable(
  'site_permissions',
  {
    origin: text('origin').notNull(),
    topLevelOrigin: text('top_level_origin').notNull(),
    permission: text('permission').notNull(),
    decision: text('decision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.origin, table.topLevelOrigin, table.permission] })],
);

/** "Pin to this site" render profiles (`render-profile.feature.md`): one per origin, the profile as JSON. */
export const renderProfilePins = sqliteTable(
  'render_profile_pins',
  {
    origin: text('origin').primaryKey(),
    profile: text('profile').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('render_profile_pins_updated_at').on(table.updatedAt)],
);
