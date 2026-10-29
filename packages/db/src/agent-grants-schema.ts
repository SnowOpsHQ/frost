import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The agent's standing grants and preferences (Phase 5 Task 4; spec `specs/agent-approvals.spec.ts`,
// `AGENT_GRANT_TABLES`; acceptance `specs/agent-approvals.feature.md`, Grants). Migration
// `0030_agent_grants` creates exactly these tables. Times are Unix milliseconds.

/** One row per standing grant: an `act` tool allowed on one public origin (`canGrant`). */
export const agentGrants = sqliteTable(
  'agent_grants',
  {
    tool: text('tool').notNull(),
    origin: text('origin').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tool, table.origin] })],
);

/** The agent's preferences by key, such as `READ_TOOLS_PREFERENCE_KEY`. */
export const agentPreferences = sqliteTable('agent_preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
