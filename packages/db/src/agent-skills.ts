import { and, asc, count, eq, notExists, sql } from 'drizzle-orm';
import { MAX_USER_SKILLS, STORED_SKILL_MAX_CHARS } from '@app/specs/agent-data.spec';
import { isSkillId, SKILL_LIMITS } from '@app/specs/skills.spec';
import type { SessionDatabase } from './client';
import { agentSkills } from './agent-skills-schema';

// The user's own agent skills (Phase 5 Task 9; spec `specs/agent-data.spec.ts`; acceptance
// `specs/agent-data.feature.md`, Skills editor). Each row is a skill's JSON as main validated it
// with `SkillSchema`; main validates it again when it reads it (the database never parses it). At
// most `MAX_USER_SKILLS`. Whether an id is a built-in's is main's check (`@app/ai-skills`).

export interface StoredAgentSkill {
  readonly id: string;
  /** The skill's JSON text. */
  readonly skill: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentSkillsRepository {
  /** The stored skills, oldest first (at most `MAX_USER_SKILLS`); a malformed row is skipped. */
  skills(): Promise<StoredAgentSkill[]>;
  /**
   * Stores `skill` (JSON text) under `id`, in place of a stored one (which keeps its `createdAt`).
   * `false` (nothing written) for a malformed id, text out of bounds, an invalid time, or a new id
   * when `MAX_USER_SKILLS` are stored.
   */
  saveSkill(id: string, skill: string, at: number): Promise<boolean>;
  deleteSkill(id: string): Promise<boolean>;
  /**
   * Moves the stored skill `oldId` to `newId`, with `skill` (JSON text) and `at` as its new text and
   * update time (Phase 8 Task 4: a built-in has since taken `oldId`). One `UPDATE` of the existing
   * row in one `db.batch`, never an insert: the table is never one over `MAX_USER_SKILLS`, and a
   * crash leaves the old row or the new one, never both or neither. `false` (nothing written) for a
   * malformed id or text, the same id twice, a missing `oldId` or a `newId` already stored.
   */
  rekeySkill(oldId: string, newId: string, skill: string, at: number): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function createAgentSkillsRepository(db: SessionDatabase): AgentSkillsRepository {
  return {
    async skills() {
      const rows = await db
        .select({
          id: sql<unknown>`substr(${agentSkills.id}, 1, ${SKILL_LIMITS.maxIdChars + 1})`,
          skill: sql<unknown>`CASE WHEN length(${agentSkills.skill}) <= ${STORED_SKILL_MAX_CHARS} THEN ${agentSkills.skill} ELSE NULL END`,
          createdAt: agentSkills.createdAt,
          updatedAt: agentSkills.updatedAt,
        })
        .from(agentSkills)
        .orderBy(asc(agentSkills.createdAt), asc(agentSkills.id))
        .limit(MAX_USER_SKILLS);
      const out: StoredAgentSkill[] = [];
      for (const row of rows) {
        if (!isSkillId(row.id) || typeof row.skill !== 'string' || !isTime(row.createdAt) || !isTime(row.updatedAt)) continue;
        out.push({ id: row.id, skill: row.skill, createdAt: row.createdAt, updatedAt: row.updatedAt });
      }
      return out;
    },

    async saveSkill(id, skill, at) {
      if (!isSkillId(id) || typeof skill !== 'string' || skill.length < 2 || skill.length > STORED_SKILL_MAX_CHARS || !isTime(at)) return false;
      const [existing] = await db.select({ id: agentSkills.id }).from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
      if (!existing) {
        const [total] = await db.select({ n: count() }).from(agentSkills);
        if ((total?.n ?? 0) >= MAX_USER_SKILLS) return false;
      }
      await db
        .insert(agentSkills)
        .values({ id, skill, createdAt: at, updatedAt: at })
        .onConflictDoUpdate({ target: agentSkills.id, set: { skill, updatedAt: at } });
      return true;
    },

    async rekeySkill(oldId, newId, skill, at) {
      if (!isSkillId(oldId) || !isSkillId(newId) || oldId === newId) return false;
      if (typeof skill !== 'string' || skill.length < 2 || skill.length > STORED_SKILL_MAX_CHARS || !isTime(at)) return false;
      // The statements of the move, built here and run as one batch (the pattern of `agent-chats.ts`).
      // The guard in the WHERE keeps the UPDATE from colliding with a row stored since a caller looked.
      const statements = [
        db
          .update(agentSkills)
          .set({ id: newId, skill, updatedAt: at })
          .where(and(eq(agentSkills.id, oldId), notExists(db.select({ id: agentSkills.id }).from(agentSkills).where(eq(agentSkills.id, newId)))))
          .returning({ id: agentSkills.id }),
      ] as const;
      const [moved] = await db.batch(statements);
      return (moved?.length ?? 0) === 1;
    },

    async deleteSkill(id) {
      if (!isSkillId(id)) return false;
      await db.delete(agentSkills).where(eq(agentSkills.id, id));
      return true;
    },
  };
}
