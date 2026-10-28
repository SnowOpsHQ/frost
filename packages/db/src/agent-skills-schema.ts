import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The user's own agent skills (Phase 5 Task 9; spec `specs/agent-data.spec.ts`, `AGENT_SKILL_TABLES`;
// acceptance `specs/agent-data.feature.md`, Skills editor). Migration `0032_agent_skills` creates
// exactly this table. `skill` is the skill's JSON as main validated it (`SkillSchema`); main
// validates it again when it reads it, so a tampered row never becomes a skill.

export const agentSkills = sqliteTable('agent_skills', {
  id: text('id').primaryKey(),
  skill: text('skill').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
