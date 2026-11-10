import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Location profiles (Phase 12 Task 10b; spec `specs/location-profiles.spec.ts`; acceptance
// `specs/location-profiles.feature.md`). Migration `0244_location_profiles` creates exactly this
// table. No secret is ever stored here: a proxy's sign-in is in main's key store.

export const locationProfiles = sqliteTable('location_profiles', {
  id: text('id').primaryKey().notNull(),
  label: text('label').notNull(),
  scheme: text('scheme').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
