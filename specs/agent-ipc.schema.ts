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
import { ALLOWED_MODEL_IDS, MODEL_ROUTES } from './agent-tools.spec';

/** A chat id: main makes them with `crypto.randomUUID`. */
export const AgentChatIdSchema = z.uuid();

/** An approval id (main's `crypto.randomUUID`; bounded printable ASCII, so a test broker's ids fit too). */
export const AgentApprovalIdSchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);

export const AgentWatchInputSchema = z.strictObject({ sinceVersion: z.int().nonnegative() });

/** A message: `chatId` `null` starts a new chat. Not only whitespace. */
export const AgentSendInputSchema = z.strictObject({
  chatId: AgentChatIdSchema.nullable(),
  text: z
    .string()
    .min(1)
    .max(CHAT_TEXT_MAX_CHARS)
    .refine((text) => text.trim() !== '', { message: 'empty message' }),
});

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
