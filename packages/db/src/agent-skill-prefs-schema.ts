import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Which skills the user switched on or off (Phase 8 Task 5; spec `specs/agent-data.spec.ts`,
// `AGENT_SKILL_PREF_TABLES`; acceptance `specs/agent-data.feature.md`, Skills library). Migration
// `0200_agent_skill_prefs` creates exactly this table. One row per skill the user switched, a
// built-in's or their own; a skill with no row is on. `enabled` is 0 or 1.

export const agentSkillPrefs = sqliteTable('agent_skill_prefs', {
  id: text('id').primaryKey(),
  enabled: integer('enabled').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
