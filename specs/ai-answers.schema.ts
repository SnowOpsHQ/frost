/**
 * The Zod side of the AI answers view and its storage (Phase 12 Task 9; plain values in
 * `ai-answers.spec.ts`; acceptance `ai-answers.feature.md`). Main-side and IPC only: the renderer
 * imports this file for its types only (its schemas must stay out of the renderer bundle: strict
 * Trusted Types).
 *
 * - `AiAnswerRecordSchema`: one stored answer as the view gets it (`aiAnswers.get`).
 * - `AiAnswerSummarySchema`: a list row (`aiAnswers.list`): no answer text but a short preview.
 * - `AiAnswersViewSchema`: the view's state (`aiAnswers.view`): the retention, the default engine, and
 *   per engine whether its provider's gate is open (`available`), its key set, its via setting and
 *   whether it is `usable` now (Task 8's `aiSearchVia`). Never a key.
 * - The inputs: bounded, strict.
 */
import { z } from 'zod';
import { AI_SEARCH_ENGINES, AI_SEARCH_VIA_SETTINGS, AI_SEARCH_VIAS } from './ai-search.spec';
import { AiCitationSchema } from './ai-search.schema';
import { AGENT_TOOL_INPUT_LIMITS, UNSAFE_INPUT_CHARS } from './agent-tools.spec';
import { DATA_AI_SEARCH_PROVIDERS } from './data-sources.spec';
import { AI_ANSWER_ORIGINS, AI_ANSWER_RETENTIONS, AI_ANSWERS_LIMITS as L, AI_ANSWERS_RUN_REFUSALS } from './ai-answers.spec';

/** A row id (`INTEGER PRIMARY KEY AUTOINCREMENT`). */
export const AiAnswerIdSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

const domain = z.string().min(1).max(L.maxDomainChars);
const time = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const recordShape = {
  id: AiAnswerIdSchema,
  query: z.string().min(1).max(L.maxQueryChars),
  engine: z.enum(AI_SEARCH_ENGINES),
  via: z.enum(AI_SEARCH_VIAS),
  provider: z.enum(DATA_AI_SEARCH_PROVIDERS),
  origin: z.enum(AI_ANSWER_ORIGINS),
  answer: z.string().min(1).max(L.maxAnswerChars),
  answerTruncated: z.boolean(),
  citations: z.array(AiCitationSchema).max(L.maxCitations),
  citationsTotal: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  citedDomains: z.array(domain).max(L.maxCitedDomains),
  chatId: z.string().min(1).max(L.maxChatIdChars).nullable(),
  /** When the answer arrived (Unix ms). */
  createdAt: time,
};

export const AiAnswerRecordSchema = z.strictObject(recordShape);
export type AiAnswerRecord = z.infer<typeof AiAnswerRecordSchema>;

export const AiAnswerSummarySchema = z.strictObject({
  id: recordShape.id,
  query: recordShape.query,
  engine: recordShape.engine,
  via: recordShape.via,
  provider: recordShape.provider,
  origin: recordShape.origin,
  preview: z.string().max(L.previewChars),
  citationCount: z.int().min(0).max(L.maxCitations),
  citedDomains: recordShape.citedDomains,
  chatId: recordShape.chatId,
  createdAt: recordShape.createdAt,
});
export type AiAnswerSummary = z.infer<typeof AiAnswerSummarySchema>;

// ---- Inputs -------------------------------------------------------------------------------------

export const AiAnswersListInputSchema = z.strictObject({
  /** Rows older than this id (the previous page's last); none: the newest. */
  beforeId: AiAnswerIdSchema.optional(),
  limit: z.int().min(1).max(L.maxPageSize),
});
export type AiAnswersListInput = z.infer<typeof AiAnswersListInputSchema>;

export const AiAnswersListAnswerSchema = z.strictObject({
  rows: z.array(AiAnswerSummarySchema).max(L.maxPageSize),
  /** Whether older rows remain. */
  more: z.boolean(),
  /** Rows kept in all. */
  total: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type AiAnswersListAnswer = z.infer<typeof AiAnswersListAnswerSchema>;

export const AiAnswerIdInputSchema = z.strictObject({ id: AiAnswerIdSchema });

/** The view's question: one line, the tool's limits (`AGENT_TOOL_INPUT_LIMITS.maxQueryChars`, no unsafe character). */
export const AiAnswersRunInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(AGENT_TOOL_INPUT_LIMITS.maxQueryChars)
    .refine((value) => value.trim() !== '' && !UNSAFE_INPUT_CHARS.test(value), 'not a question'),
  /** None: the default engine, else the first usable (Task 8's `resolveAiSearch`). */
  engine: z.enum(AI_SEARCH_ENGINES).optional(),
});
export type AiAnswersRunInput = z.infer<typeof AiAnswersRunInputSchema>;

export const AiAnswersRunAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    /** The answer as kept, or with `id: null` when the retention is `off` (shown, not stored). */
    answer: z.strictObject({ ...recordShape, id: AiAnswerIdSchema.nullable() }),
  }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(AI_ANSWERS_RUN_REFUSALS), note: z.string().min(1).max(300) }),
]);
export type AiAnswersRunAnswer = z.infer<typeof AiAnswersRunAnswerSchema>;

export const AiAnswersSetRetentionInputSchema = z.strictObject({ retention: z.enum(AI_ANSWER_RETENTIONS) });
export const AiAnswersSetViaInputSchema = z.strictObject({ engine: z.enum(AI_SEARCH_ENGINES), via: z.enum(AI_SEARCH_VIA_SETTINGS) });
export const AiAnswersSetDefaultEngineInputSchema = z.strictObject({ engine: z.enum(AI_SEARCH_ENGINES).nullable() });

// ---- The view -----------------------------------------------------------------------------------

export const AiAnswersEngineViewSchema = z.strictObject({
  engine: z.enum(AI_SEARCH_ENGINES),
  /** Its `api` provider (`null`: none in this build). */
  provider: z.enum(DATA_AI_SEARCH_PROVIDERS).nullable(),
  /** Whether its provider's legal gate is open (`false` as shipped, and for an engine without one). */
  available: z.boolean(),
  /** Whether its provider's key is set (looked up only while the gate is open). */
  hasKey: z.boolean(),
  /** The via setting (`null`: never set, read as the API when usable). */
  via: z.enum(AI_SEARCH_VIA_SETTINGS).nullable(),
  /** Whether a run would use it now (gate open, key set, not switched off). */
  usable: z.boolean(),
});
export type AiAnswersEngineView = z.infer<typeof AiAnswersEngineViewSchema>;

export const AiAnswersViewSchema = z.strictObject({
  retention: z.enum(AI_ANSWER_RETENTIONS),
  defaultEngine: z.enum(AI_SEARCH_ENGINES).nullable(),
  engines: z.array(AiAnswersEngineViewSchema).length(AI_SEARCH_ENGINES.length),
});
export type AiAnswersView = z.infer<typeof AiAnswersViewSchema>;
