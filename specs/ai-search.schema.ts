/**
 * The Zod side of `run_ai_search` via provider APIs (Phase 12 Task 8; plain values in
 * `ai-search.spec.ts`; plan Decision 8, Global constraints "Untrusted text", Threat model "Hostile
 * vendor or AI JSON").
 *
 * - Provider response schemas pick only the answer text and the citation fields. The **envelope** (the
 *   top-level object, Perplexity's choice and message, OpenAI's output items) is a `z.looseObject`:
 *   whatever else a provider sends at that level passes unread. Every picked field is strictly typed
 *   and capped (`AI_SEARCH_LIMITS`: strings, arrays); a picked field of the wrong type fails the whole
 *   answer (`invalid-answer`). OpenAI output items other than `message`, content parts other than
 *   `output_text` and annotations other than `url_citation` are skipped (their other fields are
 *   never read).
 * - `AiAnswerJobSchema`: the SERP worker's `ai-answer` job (the provider and the answer's text);
 *   `AiAnswerParsedSchema` its answer (the text cut, the citations kept).
 * - `AiAnswerSchema`: one answer as main hands it on (the agent's tool data; Task 9 stores it).
 */
import { z } from 'zod';
import { AI_SEARCH_ENGINES, AI_SEARCH_LIMITS as L, AI_SEARCH_VIAS } from './ai-search.spec';
import { DATA_AI_SEARCH_PROVIDERS } from './data-sources.spec';

/** A string the mapping reads. */
const text = z.string().max(L.maxStringChars);
/** An array the mapping reads, at most `maxItems` entries. */
const list = <T extends z.ZodType>(item: T) => z.array(item).max(L.maxItems);

// ---- Perplexity (Sonar) -------------------------------------------------------------------------

export const PerplexityResponseSchema = z.looseObject({
  choices: list(z.looseObject({ message: z.looseObject({ content: text }) })).min(1),
  /** The cited sources' URLs, in the answer's order. */
  citations: list(text).nullish(),
  /** The sources with their titles. */
  search_results: list(z.looseObject({ url: text, title: text.nullish() })).nullish(),
});
export type PerplexityResponse = z.infer<typeof PerplexityResponseSchema>;

// ---- OpenAI Responses with `web_search` ---------------------------------------------------------

/** Any output item: only its `type` is read here; a `message` is then read with `OpenAiMessageSchema`. */
export const OpenAiResponseSchema = z.looseObject({
  output: list(z.looseObject({ type: z.string().max(64) })),
});

/** An annotation: only `url_citation` ones are read, with `OpenAiUrlCitationSchema`. */
const annotation = z.looseObject({ type: z.string().max(64) });
export const OpenAiUrlCitationSchema = z.looseObject({ type: z.literal('url_citation'), url: text, title: text.nullish() });

/** A content part: only `output_text` ones are read. */
const contentPart = z.looseObject({ type: z.string().max(64), text: text.optional(), annotations: list(annotation).optional() });
export const OpenAiMessageSchema = z.looseObject({ type: z.literal('message'), content: list(contentPart) });

// ---- The worker's job and answer ----------------------------------------------------------------

export const AiAnswerJobSchema = z.strictObject({
  provider: z.enum(DATA_AI_SEARCH_PROVIDERS),
  body: z.string().max(L.maxResponseBytes),
});
export type AiAnswerJob = z.infer<typeof AiAnswerJobSchema>;

export const AiCitationSchema = z.strictObject({
  url: z.string().min(1).max(L.maxCitationUrlChars),
  title: z.string().max(L.maxCitationTitleChars),
});
export type AiCitation = z.infer<typeof AiCitationSchema>;

export const AiAnswerParsedSchema = z.strictObject({
  answer: z.string().min(1).max(L.maxAnswerChars),
  answerTruncated: z.boolean(),
  citations: z.array(AiCitationSchema).max(L.maxCitations),
  /** Distinct `http(s)` citations the provider gave, before the cap. */
  citationsTotal: z.int().min(0),
});
export type AiAnswerParsed = z.infer<typeof AiAnswerParsedSchema>;

/** The worker's answer to an `ai-answer` job. */
export type AiAnswerJobResult = { readonly ok: true; readonly answer: AiAnswerParsed } | { readonly ok: false };

// ---- One answer as main hands it on ------------------------------------------------------------

export const AiAnswerSchema = z.strictObject({
  query: z.string().min(1).max(256),
  engine: z.enum(AI_SEARCH_ENGINES),
  via: z.enum(AI_SEARCH_VIAS),
  provider: z.enum(DATA_AI_SEARCH_PROVIDERS),
  ...AiAnswerParsedSchema.shape,
  /** When the answer arrived (ISO 8601). */
  fetchedAt: z.iso.datetime(),
});
export type AiAnswer = z.infer<typeof AiAnswerSchema>;
