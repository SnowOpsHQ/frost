import type { Migration } from './migrations';

// The agent's migrations (Phase 5 Task 4; ids `0030`–`0039` are Phase 5's), appended to `MIGRATIONS`.
// They create exactly the tables of `agent-grants-schema.ts` (`AGENT_GRANT_TABLES`).

export const AGENT_GRANTS_MIGRATIONS: readonly Migration[] = [
  {
    // Standing grants (an `act` tool on one origin) and the agent's preferences (read tools on or off).
    id: '0030_agent_grants',
    sql: `
      CREATE TABLE agent_grants (
        tool TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tool, origin)
      );
      CREATE TABLE agent_preferences (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
