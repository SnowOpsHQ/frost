/**
 * The agent's declarative SEO skills (Phase 5 Task 7; acceptance `skills.feature.md`): the plain,
 * Zod-free values the chrome renderer may import (strict Trusted Types): the built-in skill ids,
 * the template's slot names, which slots the user may fill, and the bounds. The skill's Zod schema
 * is `skills-schema.ts` (main and `@app/ai-skills` only); the built-ins and the renderer of a skill's
 * template are in `@app/ai-skills` (`src/skills/`).
 *
 * A skill is data, never code: an id, a name, a description, the catalogue tools it may use (a turn
 * running it is offered those and no others), an instruction template with `{{slot}}` placeholders
 * from a fixed allowlist, the slots the user fills (optional inputs) and a version. Main renders a
 * skill into the user turn the model reads: every slot's value is quoted data inside a delimited
 * block, so a page title can't become an instruction.
 */
import { AGENT_TOOL_INPUT_LIMITS } from './agent-tools.spec';

// ---- Ids -------------------------------------------------------------------------------------

/** The skills frost ships (`@app/ai-skills`, `src/skills/`). */
export const BUILTIN_SKILL_IDS = ['audit-this-page', 'rewrite-title-meta', 'internal-link-suggestions'] as const;
export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

/**
 * A skill id: lower-case words of letters and digits joined by single hyphens (kebab-case). It also
 * fits a palette action id (`agent.skill.<id>`, `PALETTE_ACTION_ID_PATTERN`, at most 64 characters).
 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `id` is a well-formed skill id (`SKILL_ID_PATTERN`, within `SKILL_LIMITS`). */
export function isSkillId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= SKILL_LIMITS.minIdChars && id.length <= SKILL_LIMITS.maxIdChars && SKILL_ID_PATTERN.test(id);
}

// ---- Slots -----------------------------------------------------------------------------------

/**
 * The placeholders a template may hold (`{{pageUrl}}` …), and nothing else:
 * - `pageUrl`: the chat tab's page, without its fragment (main fills it);
 * - `pageTitle`: that page's title as the tab shows it (main fills it);
 * - `targetQuery`: a search query the user wants the page to rank for (the user fills it);
 * - `userNote`: anything else the user wants the skill to keep in mind (the user fills it).
 */
export const SKILL_SLOT_NAMES = ['pageUrl', 'pageTitle', 'targetQuery', 'userNote'] as const;
export type SkillSlotName = (typeof SKILL_SLOT_NAMES)[number];

/** The slots a skill may ask the user to fill (its `inputs`); main fills the others from the tab. */
export const SKILL_INPUT_SLOTS = ['targetQuery', 'userNote'] as const satisfies readonly SkillSlotName[];
export type SkillInputSlot = (typeof SKILL_INPUT_SLOTS)[number];

export function isSkillSlotName(name: unknown): name is SkillSlotName {
  return typeof name === 'string' && (SKILL_SLOT_NAMES as readonly string[]).includes(name);
}

export function isSkillInputSlot(name: unknown): name is SkillInputSlot {
  return typeof name === 'string' && (SKILL_INPUT_SLOTS as readonly string[]).includes(name);
}

/**
 * A placeholder in a template: `{{` a name of letters and digits `}}`, no spaces. Any other use of
 * `{{` or `}}` in a template is refused, so what looks like a slot always is one.
 */
export const SKILL_SLOT_PATTERN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/**
 * The slots `template` uses, each once, in `SKILL_SLOT_NAMES` order, or `null` when the template
 * names a slot outside the allowlist or holds a stray `{{` / `}}`.
 */
export function templateSlots(template: string): SkillSlotName[] | null {
  const used = new Set<string>();
  for (const match of template.matchAll(SKILL_SLOT_PATTERN)) used.add(match[1]!);
  if ([...used].some((name) => !isSkillSlotName(name))) return null;
  // What is left once every placeholder is taken out holds no brace pair.
  const rest = template.replace(SKILL_SLOT_PATTERN, '');
  if (rest.includes('{{') || rest.includes('}}')) return null;
  return SKILL_SLOT_NAMES.filter((name) => used.has(name));
}

// ---- Bounds ----------------------------------------------------------------------------------

export const SKILL_LIMITS = {
  /** A skill id (characters): `agent.skill.` plus the id stays within a palette id's 64. */
  minIdChars: 3,
  maxIdChars: 48,
  /** A skill's name (one line, characters). */
  maxNameChars: 60,
  /** A skill's description (one line, characters). */
  maxDescriptionChars: 280,
  /** A skill's instruction template (characters; line feeds and tabs allowed). */
  maxInstructionChars: 6000,
  /** An input's label and placeholder (one line, characters). */
  maxInputLabelChars: 60,
  maxInputPlaceholderChars: 120,
  /** A skill's version: a positive integer, raised when its text changes. */
  maxVersion: 1_000_000,
  /** Skills a registry lists (built-ins and the user's, Task 9). */
  maxSkills: 100,
} as const;

/**
 * The longest value each slot is filled with (characters): longer values are cut, never refused,
 * when main renders a skill; the user's own inputs are refused over it at the IPC.
 */
export const SKILL_SLOT_MAX_CHARS: Readonly<Record<SkillSlotName, number>> = {
  pageUrl: AGENT_TOOL_INPUT_LIMITS.maxUrlChars,
  pageTitle: 300,
  targetQuery: AGENT_TOOL_INPUT_LIMITS.maxQueryChars,
  userNote: 2000,
};

/** What the data block says for a slot with no value (a missing input, an empty tab). */
export const SKILL_SLOT_MISSING = '(not given)';

/** The data block's first and last lines (see `@app/ai-skills` `renderSkill`). */
export const SKILL_DATA_OPEN = '<skill-inputs>';
export const SKILL_DATA_CLOSE = '</skill-inputs>';
