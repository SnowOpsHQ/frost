/**
 * The declarative skill's Zod schema (Phase 5 Task 7; acceptance `skills.feature.md`). Main and
 * `@app/ai-skills` only: the renderer reads the plain values in `skills.spec.ts` and the skills main
 * lists in `AgentState.skills`. Every built-in validates against it, and Task 9's skills editor
 * validates the user's skills with it before they are stored or run.
 *
 * ```ts
 * {
 *   id: 'audit-this-page',                       // kebab-case, SKILL_LIMITS
 *   name: 'Audit this page',                     // one line
 *   description: 'Summarise the audit …',        // one line
 *   allowedTools: ['page_audit', 'page_data'],   // non-empty catalogue names, no repeats, no MCP tool
 *   instructions: 'Audit {{pageUrl}} …',         // {{slot}} from SKILL_SLOT_NAMES only
 *   inputs: [{ slot: 'userNote', label: 'Focus on' }],  // optional: the slots the user fills
 *   version: 1,
 * }
 * ```
 */
import { z } from 'zod';
import { MAX_USER_SKILLS, SKILL_FILE_FORMAT, SKILL_FILE_VERSION } from './agent-data.spec';
import { AGENT_TOOL_NAMES, isSafeInputText } from './agent-tools.spec';
import { SKILL_ID_PATTERN, SKILL_INPUT_SLOTS, SKILL_LIMITS as L, templateSlots } from './skills.spec';

/** One line of text the user may be shown: no control, format or separator character (`UNSAFE_INPUT_CHARS`), not blank. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => isSafeInputText(text), { message: 'holds a control or invisible character' })
    .refine((text) => text.trim() !== '' && text === text.trim(), { message: 'blank, or space around it' });

export const SkillIdSchema = z.string().min(L.minIdChars).max(L.maxIdChars).regex(SKILL_ID_PATTERN, { message: 'not a kebab-case id' });

export const SkillInputSchema = z.strictObject({
  /** The slot the user fills (`SKILL_INPUT_SLOTS`). */
  slot: z.enum(SKILL_INPUT_SLOTS),
  /** What the field is called in the composer. */
  label: line(L.maxInputLabelChars),
  /** The field's hint text, if any. */
  placeholder: line(L.maxInputPlaceholderChars).optional(),
});
export type SkillInput = z.output<typeof SkillInputSchema>;

export const SkillSchema = z
  .strictObject({
    id: SkillIdSchema,
    name: line(L.maxNameChars),
    description: line(L.maxDescriptionChars),
    /** frost's catalogue tools only (an MCP tool's name is refused), each at most once. */
    allowedTools: z
      .array(z.enum(AGENT_TOOL_NAMES))
      .min(1)
      .max(AGENT_TOOL_NAMES.length)
      .refine((tools) => new Set(tools).size === tools.length, { message: 'a tool is listed twice' }),
    /** The template: line feeds and tabs allowed, no other control or invisible character; `{{slot}}` from the allowlist only. */
    instructions: z
      .string()
      .min(1)
      .max(L.maxInstructionChars)
      .refine((text) => isSafeInputText(text, 'code'), { message: 'holds a control or invisible character' })
      .refine((text) => text.trim() !== '', { message: 'empty instructions' })
      .refine((text) => templateSlots(text) !== null, { message: 'a placeholder is not an allowed slot, or a brace pair is stray' }),
    inputs: z
      .array(SkillInputSchema)
      .max(SKILL_INPUT_SLOTS.length)
      .refine((inputs) => new Set(inputs.map((input) => input.slot)).size === inputs.length, { message: 'a slot is declared twice' })
      .optional(),
    version: z.int().min(1).max(L.maxVersion),
  })
  // A declared input is one the template reads: otherwise the user's value would go nowhere.
  .refine((skill) => (skill.inputs ?? []).every((input) => (templateSlots(skill.instructions) ?? []).includes(input.slot)), {
    message: 'an input is declared for a slot the instructions do not use',
    path: ['inputs'],
  });
export type Skill = z.output<typeof SkillSchema>;

/** `value` as a valid skill, or `null`. Never throws. */
export function parseSkill(value: unknown): Skill | null {
  const parsed = SkillSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---- Skill files: export and import (Phase 8 Task 6; `agent-data.spec.ts`, Skill files) ----------

/**
 * A skills file's envelope, as import reads it before any skill is checked: frost's format name and
 * version, when it was written, and 1 to `MAX_USER_SKILLS` entries (each checked on its own with
 * `SkillSchema`, so one bad entry is listed as invalid instead of refusing the file).
 */
export const SkillFileEnvelopeSchema = z.strictObject({
  format: z.literal(SKILL_FILE_FORMAT),
  version: z.literal(SKILL_FILE_VERSION),
  exportedAt: z.iso.datetime(),
  skills: z.array(z.unknown()).min(1).max(MAX_USER_SKILLS),
});

/**
 * A skills file as export writes it (`SKILL_FILE_FORMAT`, version `SKILL_FILE_VERSION`): every skill
 * valid. Main checks the whole file with it before writing.
 *
 * ```ts
 * { format: 'frost-skills', version: 1, exportedAt: '2026-10-30T12:00:00.000Z', skills: [Skill, …] }
 * ```
 */
export const SkillFileSchema = SkillFileEnvelopeSchema.extend({ skills: z.array(SkillSchema).min(1).max(MAX_USER_SKILLS) });
export type SkillFile = z.output<typeof SkillFileSchema>;
