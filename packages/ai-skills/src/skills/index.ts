// The agent's declarative SEO skills (Phase 5 Task 7): the built-ins, the template renderer and the
// registry main resolves skill ids through. Schema `specs/skills-schema.ts`; plain values
// `specs/skills.spec.ts`; acceptance `specs/skills.feature.md`.
export { auditThisPageSkill, BUILTIN_SKILLS, internalLinkSuggestionsSkill, rewriteTitleMetaSkill } from './builtins';
export { cleanSlotValue, renderSkill, type SkillSlotValues } from './render';
export { composeSkillRegistries, createBuiltinSkillRegistry, createStaticSkillRegistry, type SkillRegistry } from './registry';
export type { Skill, SkillInput } from '@app/specs/skills-schema';
