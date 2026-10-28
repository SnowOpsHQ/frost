/**
 * The `agent.*` procedures' inputs (Phase 5 Task 6a; acceptance `agent-session.feature.md`,
 * Router). Zod, for `packages/ipc-contract/src/agent-router.ts`; every object is strict and every
 * string bounded. The answers' types are in `agent-session.spec.ts` (no Zod).
 *
 * `agent.setKey`'s `key` is the only secret that crosses IPC, and only renderer → main: no answer,
 * error or state carries a key back (main's store answers `hasKey` only).
 */
import { z } from 'zod';
import { APPROVAL_DECISIONS } from './agent-approvals.spec';
import { CREDENTIAL_LIMITS, CREDENTIAL_SLOTS, isValidModelSettings } from './agent-proxy.spec';
import { CHAT_TEXT_MAX_CHARS } from './agent-session.spec';
import { ALLOWED_MODEL_IDS, isSafeInputText, MODEL_ROUTES } from './agent-tools.spec';
import { SKILL_ID_PATTERN, SKILL_LIMITS, SKILL_SLOT_MAX_CHARS } from './skills.spec';

/** A chat id: main makes them with `crypto.randomUUID`. */
export const AgentChatIdSchema = z.uuid();

/** An approval id (main's `crypto.randomUUID`; bounded printable ASCII, so a test broker's ids fit too). */
export const AgentApprovalIdSchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);

export const AgentWatchInputSchema = z.strictObject({ sinceVersion: z.int().nonnegative() });

/** A message: `chatId` `null` starts a new chat. Not only whitespace. */
export const AgentSendTextInputSchema = z.strictObject({
  chatId: AgentChatIdSchema.nullable(),
  text: z
    .string()
    .min(1)
    .max(CHAT_TEXT_MAX_CHARS)
    .refine((text) => text.trim() !== '', { message: 'empty message' }),
});

/** A skill input the user typed: bounded, no control or invisible character but line feeds and tabs (main cleans it again when it renders). */
const skillValue = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => isSafeInputText(text, 'code'), { message: 'holds a control or invisible character' });

/**
 * A skill run (Task 7; `AgentSkillRequest`): the skill's id and the inputs the user filled, never
 * text beside them. Main resolves the id (`unknown-skill` if it has none) and refuses an input the
 * skill doesn't declare (`invalid`).
 */
export const AgentSendSkillInputSchema = z.strictObject({
  chatId: AgentChatIdSchema.nullable(),
  skillId: z.string().min(SKILL_LIMITS.minIdChars).max(SKILL_LIMITS.maxIdChars).regex(SKILL_ID_PATTERN),
  userNote: skillValue(SKILL_SLOT_MAX_CHARS.userNote).optional(),
  targetQuery: skillValue(SKILL_SLOT_MAX_CHARS.targetQuery).optional(),
});

/** `agent.send`: a typed message or a skill run. */
export const AgentSendInputSchema = z.union([AgentSendTextInputSchema, AgentSendSkillInputSchema]);

export const AgentChatInputSchema = z.strictObject({ chatId: AgentChatIdSchema });

export const AgentAnswerApprovalInputSchema = z.strictObject({ approvalId: AgentApprovalIdSchema, decision: z.enum(APPROVAL_DECISIONS) });

export const AgentSetModelInputSchema = z
  .strictObject({ route: z.enum(MODEL_ROUTES), modelId: z.enum(ALLOWED_MODEL_IDS) })
  .refine((value) => isValidModelSettings(value), { message: 'the route does not serve this model' });

/**
 * A key to store. Bounded loosely (whitespace around a pasted key is trimmed by main's store,
 * `normalizeKey`, which refuses anything that isn't a key with `invalid`). Zod's issues can quote
 * parts of an input (an unrecognized key's name), so the IPC's error formatter replaces every
 * refused input's message with its code (`BAD_REQUEST`): no error carries a key back.
 */
export const AgentSetKeyInputSchema = z.strictObject({ slot: z.enum(CREDENTIAL_SLOTS), key: z.string().min(1).max(CREDENTIAL_LIMITS.maxKeyChars * 2) });

export const AgentClearKeyInputSchema = z.strictObject({ slot: z.enum(CREDENTIAL_SLOTS) });
