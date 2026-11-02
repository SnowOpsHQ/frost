/**
 * AI checks' shapes (Phase 9 Task 10; plain values and prose in `ai-checks.spec.ts`; acceptance
 * `ai-checks.feature.md`). Main-only Zod: the chrome imports types only.
 *
 * - `AiCheckInputSchema`: the page extract a check sends. It is built only from a `ServedState`
 *   `ready` (its `ServedSnapshot`, `leadText` included, and its `ServedFetch`) and the tab's URL
 *   (`main/ai-checks/input.ts`, `buildAiCheckInput`): there is no rendered field, and no on-device
 *   page type (`audit.pageType` is computed from the rendered snapshot; Decision 16).
 * - `AiCheckOutputSchema`: the model's answer, strict and capped (main parses it; Decision 17).
 * - `AiCheckResultSchema`: an answer as stored and shown (`seo_ai_checks`, one row per URL).
 * - `AiChecksStateSchema`: a tab's AI checks as the chrome sees them.
 * - The `aiChecks.*` procedures' inputs and outputs.
 */
import { z } from 'zod';
import { MODEL_ROUTES } from './agent-tools.spec';
import { AI_CHECK_LIMITS as L, AI_CHECK_MODES, AI_CHECK_UNAVAILABLE, AI_QUALITY_RATINGS } from './ai-checks.spec';
import { INTENT_LABELS } from './intent-classifier.spec';
import { PAGE_TYPES } from './page-type.spec';
import { TARGET_QUERY_MAX_CHARS } from './seo-content.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { isWebUrl } from './web-url.spec';

const count = z.int().nonnegative().max(SNAPSHOT_LIMITS.maxCount);
const tabId = z.int().positive();
const version = z.int().nonnegative();

/**
 * The page extract (what a check sends, wrapped as untrusted data): the page's URL (the tab's, its
 * fragment and userinfo dropped), and from the served HTML only: its language, titles and meta
 * descriptions (as served, already capped), headings, JSON-LD `@type` values, word count and lead
 * text.
 */
export const AiCheckInputSchema = z.strictObject({
  url: z.string().min(1).max(L.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' }),
  lang: z.string().max(SNAPSHOT_LIMITS.maxLangChars).nullable(),
  titles: z.array(z.string().max(SNAPSHOT_LIMITS.maxTextChars)).max(SNAPSHOT_LIMITS.maxRepeated),
  descriptions: z.array(z.string().max(SNAPSHOT_LIMITS.maxTextChars)).max(SNAPSHOT_LIMITS.maxRepeated),
  headings: z.array(z.strictObject({ level: z.int().min(1).max(6), text: z.string().max(SNAPSHOT_LIMITS.maxHeadingChars) })).max(L.maxHeadings),
  jsonLdTypes: z.array(z.string().min(1).max(L.maxTypeChars)).max(L.maxJsonLdTypes),
  wordCount: count,
  leadText: z.string().max(L.maxLeadChars),
});
export type AiCheckInput = z.infer<typeof AiCheckInputSchema>;

/** A model's text field as shown: plain text, no control or bidi-control character, capped. */
const shownText = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(value), { message: 'control character' });

/**
 * The model's answer (strict: any other key, or a value of another type, is `invalid-output`). Main
 * strips control and bidi-control characters, collapses whitespace and caps each text before it
 * checks the answer, so these caps hold for what is stored and shown.
 */
export const AiCheckOutputSchema = z.strictObject({
  pageType: z.enum(PAGE_TYPES).nullable(),
  intent: z.enum(INTENT_LABELS).nullable(),
  quality: z.enum(AI_QUALITY_RATINGS).nullable(),
  qualityReason: shownText(L.maxReasonChars),
  suggestedTarget: shownText(TARGET_QUERY_MAX_CHARS).min(1).nullable(),
});
export type AiCheckOutput = z.infer<typeof AiCheckOutputSchema>;

/** A sha-256 of a check's input (lowercase hex): the cache's key beside the URL. */
export const AiCheckInputHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A check's answer as stored and shown: the page, the input it judged, the model that answered, when. */
export const AiCheckResultSchema = z.strictObject({
  url: z.string().min(1).max(L.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' }),
  inputHash: AiCheckInputHashSchema,
  modelId: z.string().min(1).max(256),
  checkedAt: z.int().nonnegative(),
  output: AiCheckOutputSchema,
});
export type AiCheckResult = z.infer<typeof AiCheckResultSchema>;

/**
 * A tab's AI check for the page it shows:
 * - `idle`: nothing asked yet (`on-request`, before "Check this page"), or no web page;
 * - `queued`: asked for, waiting behind another page's check (one runs at a time);
 * - `checking`: the one request is running;
 * - `unavailable`: why there is no judgment (`AI_CHECK_UNAVAILABLE`; `served-pending` and
 *   `busy-chat` clear by themselves);
 * - `ready`: the answer (`cached`: read from an earlier check of the same input, no request sent).
 */
export const AiCheckViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({ status: z.literal('queued') }),
  z.strictObject({ status: z.literal('checking') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(AI_CHECK_UNAVAILABLE) }),
  z.strictObject({ status: z.literal('ready'), result: AiCheckResultSchema, cached: z.boolean() }),
]);
export type AiCheckView = z.infer<typeof AiCheckViewSchema>;

/**
 * The tab's AI checks: the mode, the route and model the agent settings name (for the cost note;
 * never a key), the page's URL (`''` without a web page) and its check.
 */
export const AiChecksStateSchema = z.strictObject({
  version,
  tabId,
  mode: z.enum(AI_CHECK_MODES),
  model: z.strictObject({ route: z.enum(MODEL_ROUTES), modelId: z.string().max(256) }).nullable(),
  url: z.string().max(L.maxUrlChars),
  check: AiCheckViewSchema,
});
export type AiChecksState = z.infer<typeof AiChecksStateSchema>;

/** `aiChecks.state`: the tab. */
export const AiChecksTabInputSchema = z.strictObject({ tabId });
export type AiChecksTabInput = z.infer<typeof AiChecksTabInputSchema>;
/** `aiChecks.watch`: the tab and the version last seen. */
export const AiChecksWatchInputSchema = z.strictObject({ tabId, sinceVersion: z.int().min(-1) });
export type AiChecksWatchInput = z.infer<typeof AiChecksWatchInputSchema>;
/** `aiChecks.setMode`: the mode asked for (leaving `off` asks in main's consent dialog first). */
export const AiChecksSetModeInputSchema = z.strictObject({ mode: z.enum(AI_CHECK_MODES) });
export type AiChecksSetModeInput = z.infer<typeof AiChecksSetModeInputSchema>;
/** `aiChecks.setMode`'s answer: the mode in effect afterwards (`off` still when the dialog was cancelled). */
export const AiChecksModeSchema = z.enum(AI_CHECK_MODES);
/** `aiChecks.checkNow`: "Check this page" (`again`: "Check again", past a cached answer). */
export const AiChecksCheckNowInputSchema = z.strictObject({ tabId, again: z.boolean().optional() });
export type AiChecksCheckNowInput = z.infer<typeof AiChecksCheckNowInputSchema>;
