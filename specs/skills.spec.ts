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
import { parseWebUrl } from './web-url.spec';

// ---- Ids -------------------------------------------------------------------------------------

/**
 * The skills frost ships (`@app/ai-skills`, `src/skills/`), in the order the picker lists them
 * within a category. Appending an id is a release-note event: a user's own skill that already has
 * it is re-keyed on load (`main/agent/user-skills.ts`), never hidden.
 */
export const BUILTIN_SKILL_IDS = [
  'audit-this-page',
  'rewrite-title-meta',
  'internal-link-suggestions',
  'content-brief',
  'rewrite-page-content',
  'content-quality-review',
  'match-page-to-queries',
  'check-structured-data',
  'check-hreflang',
  'diagnose-rendering',
  'check-crawl-and-indexing',
  'diagnose-search-performance',
  'analyse-serp',
  'write-social-tags',
] as const;
export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

/** The groups the skill picker puts the built-ins under, in the order it shows them. */
export const SKILL_CATEGORIES = ['page', 'content', 'technical', 'search'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** The picker's heading for each category, and for the user's own skills (listed last). */
export const SKILL_CATEGORY_LABELS: Readonly<Record<SkillCategory, string>> = {
  page: 'This page',
  content: 'Content',
  technical: 'Technical',
  search: 'Search',
};
export const SKILL_USER_GROUP_LABEL = 'Your skills';

/** The category each built-in is listed under. */
export const BUILTIN_SKILL_CATEGORY: Readonly<Record<BuiltinSkillId, SkillCategory>> = {
  'audit-this-page': 'page',
  'rewrite-title-meta': 'content',
  'internal-link-suggestions': 'page',
  'content-brief': 'content',
  'rewrite-page-content': 'content',
  'content-quality-review': 'content',
  'match-page-to-queries': 'search',
  'check-structured-data': 'technical',
  'check-hreflang': 'technical',
  'diagnose-rendering': 'technical',
  'check-crawl-and-indexing': 'technical',
  'diagnose-search-performance': 'search',
  'analyse-serp': 'search',
  'write-social-tags': 'content',
};

/**
 * The gap-analysis rows (`docs/research/serplens-gap-analysis.md`) each built-in answers, for the
 * record: nothing reads this at run time.
 */
export const BUILTIN_SKILL_SOURCES: Readonly<Record<BuiltinSkillId, readonly string[]>> = {
  'audit-this-page': ['SL-070'],
  'rewrite-title-meta': ['SL-071'],
  'internal-link-suggestions': ['SL-077'],
  'content-brief': ['SL-072'],
  'rewrite-page-content': ['SL-073'],
  'content-quality-review': ['SL-074', 'SL-019'],
  'match-page-to-queries': ['SL-076'],
  'check-structured-data': ['SL-078'],
  'check-hreflang': ['SL-079'],
  'diagnose-rendering': ['SL-080', 'SL-037'],
  'check-crawl-and-indexing': ['SL-081'],
  'diagnose-search-performance': ['SL-082'],
  'analyse-serp': ['SL-083'],
  'write-social-tags': ['SL-026'],
};

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

/** A page's address as a skill's `pageUrl` slot: an `http(s)` URL without user info or fragment, or `null`. */
export function skillPageUrl(url: unknown): string | null {
  const parsed = parseWebUrl(url);
  if (parsed === null) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href;
}

/** What the data block says for a slot with no value (a missing input, an empty tab). */
export const SKILL_SLOT_MISSING = '(not given)';

/** The data block's first and last lines (see `@app/ai-skills` `renderSkill`). */
export const SKILL_DATA_OPEN = '<skill-inputs>';
export const SKILL_DATA_CLOSE = '</skill-inputs>';

// ---- The skills editor's warnings (Task 7 review) --------------------------------------------

/**
 * Tools a user skill may list that act on pages or send model-chosen text to a third party: the
 * editor warns when a skill lists one (each call still needs the approval its risk class needs).
 */
export const SKILL_ACTING_TOOLS = ['navigate', 'click', 'execute_javascript', 'run_ai_search', 'run_visibility_probes'] as const;

export const SKILL_WARNINGS = {
  builtinName: "A built-in skill already has this name. Choose another, so the two can't be confused.",
  actingTools: 'This skill may open pages, click, run JavaScript, send a query out or fetch pages as crawlers would. frost still asks you before each of those, but text on a page could try to steer them.',
} as const;

/** How the picker and the palette mark the user's own skills. */
export const SKILL_USER_MARK = 'Your skill';

