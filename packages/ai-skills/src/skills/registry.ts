// Where main finds the skills it can run (Phase 5 Task 7; acceptance `specs/skills.feature.md`,
// Registry). The session manager resolves a skill id only through a `SkillRegistry`; today that is
// the built-ins, and Task 9 composes the user's stored skills (validated with `SkillSchema`) with
// them behind the same interface (`composeSkillRegistries`).
import { parseSkill, type Skill } from '@app/specs/skills-schema';
import { SKILL_LIMITS } from '@app/specs/skills.spec';
import { BUILTIN_SKILLS } from './builtins';

export interface SkillRegistry {
  /** Every skill that can run now, in the order the picker lists them (at most `SKILL_LIMITS.maxSkills`). */
  list(): readonly Skill[];
  /** The skill with `id`, or `null` (unknown, or no longer valid). */
  get(id: string): Skill | null;
}

/**
 * A registry over fixed `skills`: each is validated (`SkillSchema`) once, an invalid one or a
 * repeated id is left out, and at most `SKILL_LIMITS.maxSkills` are kept.
 */
export function createStaticSkillRegistry(skills: readonly unknown[]): SkillRegistry {
  const byId = new Map<string, Skill>();
  for (const candidate of skills) {
    if (byId.size >= SKILL_LIMITS.maxSkills) break;
    const skill = parseSkill(candidate);
    if (skill !== null && !byId.has(skill.id)) byId.set(skill.id, skill);
  }
  const listed = Object.freeze([...byId.values()]);
  return {
    list: () => listed,
    get: (id) => (typeof id === 'string' ? (byId.get(id) ?? null) : null),
  };
}

/** frost's built-in skills (`BUILTIN_SKILLS`). */
export function createBuiltinSkillRegistry(): SkillRegistry {
  return createStaticSkillRegistry(BUILTIN_SKILLS);
}

/**
 * The registries in order as one: an id resolves to the first registry that has it (so a user skill
 * can't take a built-in's id), and the list is theirs in order without repeats, capped. A registry
 * that throws counts as empty.
 */
export function composeSkillRegistries(...registries: readonly SkillRegistry[]): SkillRegistry {
  const safeList = (registry: SkillRegistry): readonly Skill[] => {
    try {
      const listed = registry.list();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  };
  return {
    list() {
      const seen = new Set<string>();
      const out: Skill[] = [];
      for (const registry of registries) {
        for (const skill of safeList(registry)) {
          if (out.length >= SKILL_LIMITS.maxSkills) return out;
          if (seen.has(skill.id)) continue;
          seen.add(skill.id);
          out.push(skill);
        }
      }
      return out;
    },
    get(id) {
      for (const registry of registries) {
        let skill: Skill | null = null;
        try {
          skill = registry.get(id);
        } catch {
          skill = null;
        }
        if (skill !== null && skill !== undefined) return skill;
      }
      return null;
    },
  };
}
