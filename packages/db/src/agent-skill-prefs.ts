import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { isSkillId, SKILL_LIMITS } from '@app/specs/skills.spec';
import type { SessionDatabase } from './client';
import { agentSkillPrefs } from './agent-skill-prefs-schema';

// The skills library's switches (Phase 8 Task 5; spec `specs/agent-data.spec.ts`; acceptance
// `specs/agent-data.feature.md`, Skills library). A row per skill the user switched on or off (no
// row: on), at most `SKILL_LIMITS.maxSkills`. Whether an id names a skill is main's check; main
// prunes the rows no skill has when it loads. A user skill's row moves with `rekeySkill` and goes
// with `deleteSkill` (`agent-skills.ts`), in the same batch as the skill's own row.

export interface StoredSkillPref {
  readonly id: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface AgentSkillPrefsRepository {
  /** The stored switches by id (at most `SKILL_LIMITS.maxSkills`); a malformed row is skipped. */
  prefs(): Promise<StoredSkillPref[]>;
  /**
   * Stores the switch for `id` (a skill's id), in place of a stored one. `false` (nothing written)
   * for a malformed id, a non-boolean, an invalid time, or a new id when `SKILL_LIMITS.maxSkills` rows are stored.
   */
  setEnabled(id: string, enabled: boolean, at: number): Promise<boolean>;
  /** Deletes the rows of `ids` (at most `SKILL_LIMITS.maxSkills`, all well-formed); `false` (nothing deleted) otherwise. */
  deletePrefs(ids: readonly string[]): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function createAgentSkillPrefsRepository(db: SessionDatabase): AgentSkillPrefsRepository {
  return {
    async prefs() {
      const rows = await db
        .select({
          id: sql<unknown>`substr(${agentSkillPrefs.id}, 1, ${SKILL_LIMITS.maxIdChars + 1})`,
          enabled: agentSkillPrefs.enabled,
          updatedAt: agentSkillPrefs.updatedAt,
        })
        .from(agentSkillPrefs)
        .orderBy(asc(agentSkillPrefs.id))
        .limit(SKILL_LIMITS.maxSkills);
      const out: StoredSkillPref[] = [];
      for (const row of rows) {
        if (!isSkillId(row.id) || (row.enabled !== 0 && row.enabled !== 1) || !isTime(row.updatedAt)) continue;
        out.push({ id: row.id, enabled: row.enabled === 1, updatedAt: row.updatedAt });
      }
      return out;
    },

    async setEnabled(id, enabled, at) {
      if (!isSkillId(id) || typeof enabled !== 'boolean' || !isTime(at)) return false;
      const [existing] = await db.select({ id: agentSkillPrefs.id }).from(agentSkillPrefs).where(eq(agentSkillPrefs.id, id)).limit(1);
      if (!existing) {
        const [total] = await db.select({ n: count() }).from(agentSkillPrefs);
        if ((total?.n ?? 0) >= SKILL_LIMITS.maxSkills) return false;
      }
      const flag = enabled ? 1 : 0;
      await db
        .insert(agentSkillPrefs)
        .values({ id, enabled: flag, updatedAt: at })
        .onConflictDoUpdate({ target: agentSkillPrefs.id, set: { enabled: flag, updatedAt: at } });
      return true;
    },

    async deletePrefs(ids) {
      if (!Array.isArray(ids) || ids.length > SKILL_LIMITS.maxSkills || !ids.every((id) => isSkillId(id))) return false;
      if (ids.length === 0) return true;
      await db.delete(agentSkillPrefs).where(inArray(agentSkillPrefs.id, [...ids]));
      return true;
    },
  };
}
