import type { Migration } from './migrations';

// The user's agent skills (Phase 5 Task 9; ids `0030`–`0039` are Phase 5's), appended to
// `MIGRATIONS` after `0031_agent_chats`. It creates exactly the table of `agent-skills-schema.ts`
// (`AGENT_SKILL_TABLES`).

export const AGENT_SKILLS_MIGRATIONS: readonly Migration[] = [
  {
    id: '0032_agent_skills',
    sql: `
      CREATE TABLE agent_skills (
        id TEXT PRIMARY KEY NOT NULL,
        skill TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
