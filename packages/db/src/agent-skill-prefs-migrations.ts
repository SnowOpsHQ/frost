import type { Migration } from './migrations';

// The skills library's switches (Phase 8 Task 5; ids `0200`–`0209` are Phase 8's), spread at the end
// of `MIGRATIONS` after `...CHANGE_INTEL_MIGRATIONS`, so ids stay strictly increasing. It creates
// exactly the table of `agent-skill-prefs-schema.ts` (`AGENT_SKILL_PREF_TABLES`). No foreign key: a
// built-in has no `agent_skills` row, and main prunes rows no skill has.

export const AGENT_SKILL_PREFS_MIGRATIONS: readonly Migration[] = [
  {
    id: '0200_agent_skill_prefs',
    sql: `
      CREATE TABLE agent_skill_prefs (
        id TEXT PRIMARY KEY NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
