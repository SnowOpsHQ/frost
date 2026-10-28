/**
 * The Zod side of the SERP service (Phase 3 Task 4; plain values in `serp-service.spec.ts`;
 * acceptance `serp-overlay.feature.md`, Router and Service): what the stable read API answers
 * (`SerpStateSchema`, `IntentAnswerSchema`, `PackStatusSchema`), what `serp.watch` and `serp.state`
 * answer (`SerpTabStateSchema`) and the `serp.*` procedures' inputs. Not for the chrome renderer (no
 * Zod there).
 *
 * **Stable after merge** (Phase 5's agent tools import these answers through `SerpReadApi`): a
 * change is a new field, optional or nullable, never a changed one.
 *
 * ## A tab's SERP state (`SerpStateSchema`, discriminated on `status`)
 * - `not-serp`: the tab shows no result page of any engine in the pack (`url`: the tab's URL, `''`
 *   without a page or past `SERP_PARAM_LIMITS.maxUrlChars`);
 * - `pending`: a result page whose reading is under way, or will be once the page has loaded (or an
 *   in-page navigation has settled); its search parameters are known from the URL;
 * - `ready`: the page was read (`snapshot`, a ready `SerpSnapshot`), for document `documentSeq`
 *   (`TabState.documentSeq`) at `url`, at `readAt` (ms since the epoch);
 * - `unreadable`: "couldn't read this layout", with the reason (`SERP_UNREADABLE_REASONS`), the
 *   search parameters (`null` when they did not validate) and the pack's version;
 * - `disabled`: SERP reading is off because the bundled pack failed verification (`pack-invalid`).
 *
 * `url` is the page's own URL (the reading is of that page); the canonical one is `params.url`.
 */
import { z } from 'zod';
import { INTENT_LIMITS, INTENT_STATES, INTENT_ENABLE_OUTCOMES, type IntentAnswer } from './intent-classifier.spec';
import { IntentResultSchema } from './intent-classifier.schema';
import { PACK_SOURCES, PACK_UPDATE_OUTCOMES } from './serp-selector-pack.spec';
import { SearchParamsSchema } from './serp-search-params.schema';
import { SerpReadySchema } from './serp-snapshot.schema';
import { SERP_PARAM_LIMITS, SERP_UNREADABLE_REASONS } from './serp.spec';

const tabId = z.int().positive();
const documentSeq = z.int().nonnegative();
const time = z.int().min(0);
/** A result page's URL (`matchSerp` refuses a longer one). */
const pageUrl = z.string().max(SERP_PARAM_LIMITS.maxUrlChars);
const packVersion = z.int().min(1);

export const SerpNotSerpStateSchema = z.strictObject({ status: z.literal('not-serp'), tabId, url: pageUrl });
export const SerpPendingStateSchema = z.strictObject({ status: z.literal('pending'), tabId, documentSeq, url: pageUrl, params: SearchParamsSchema });
export const SerpReadyStateSchema = z.strictObject({ status: z.literal('ready'), tabId, documentSeq, url: pageUrl, readAt: time, snapshot: SerpReadySchema });
export const SerpUnreadableStateSchema = z.strictObject({
  status: z.literal('unreadable'),
  tabId,
  documentSeq,
  url: pageUrl,
  readAt: time,
  reason: z.enum(SERP_UNREADABLE_REASONS),
  params: SearchParamsSchema.nullable(),
  packVersion: packVersion.nullable(),
});
export const SerpDisabledStateSchema = z.strictObject({ status: z.literal('disabled'), tabId, reason: z.literal('pack-invalid') });

/** A tab's SERP reading (see above). */
export const SerpStateSchema = z.discriminatedUnion('status', [SerpNotSerpStateSchema, SerpPendingStateSchema, SerpReadyStateSchema, SerpUnreadableStateSchema, SerpDisabledStateSchema]);
export type SerpState = z.infer<typeof SerpStateSchema>;

/** Where on-device intent stands (`INTENT_STATES`). */
export const IntentStateSchema = z.enum(INTENT_STATES);
/** How "Enable on-device intent" ended (`INTENT_ENABLE_OUTCOMES`). */
export const IntentEnableOutcomeSchema = z.enum(INTENT_ENABLE_OUTCOMES);

/**
 * What classifying a query answers (`IntentAnswer`, `intent-classifier.spec.ts`): `ready` with the
 * result, the classifier's state when it cannot classify (it never downloads by itself), or
 * `no-query` for a blank query.
 */
export const IntentAnswerSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), result: IntentResultSchema }),
  z.strictObject({ state: z.enum(INTENT_STATES.filter((state) => state !== 'ready') as [Exclude<(typeof INTENT_STATES)[number], 'ready'>, ...Exclude<(typeof INTENT_STATES)[number], 'ready'>[]]) }),
  z.strictObject({ state: z.literal('no-query') }),
]);
type IntentAnswerParsed = z.infer<typeof IntentAnswerSchema>;
// The schema and the spec's type describe one shape.
const _answerMatches: [IntentAnswerParsed extends IntentAnswer ? true : false, IntentAnswer extends IntentAnswerParsed ? true : false] = [true, true];
void _answerMatches;
export type { IntentAnswer };

/**
 * The selector pack in use: `ready` with its version, where it came from (`bundled` / `remote`) and
 * when it was published, or `disabled` (the bundled pack failed verification; the rest `null`).
 * `lastUpdate`: how the last "Check for selector updates" of this session ended, and when (`null`
 * before one); `checking`: one runs now.
 */
export const PackStatusSchema = z.strictObject({
  state: z.enum(['ready', 'disabled']),
  version: packVersion.nullable(),
  source: z.enum(PACK_SOURCES).nullable(),
  published: z.iso.date().nullable(),
  lastUpdate: z.strictObject({ outcome: z.enum(PACK_UPDATE_OUTCOMES), at: time }).nullable(),
  checking: z.boolean(),
});
export type PackStatus = z.infer<typeof PackStatusSchema>;

/**
 * What `serp.watch` and `serp.state` answer for a tab: its SERP state, whether its outlines are
 * drawn, the intent of its current query (`null` until a `ready` reading has one, or while it is
 * being classified), the service's `version` (`0` before any change) and the pack's status.
 */
export const SerpTabStateSchema = z.strictObject({
  version: z.int().nonnegative(),
  tabId,
  serp: SerpStateSchema,
  outlines: z.boolean(),
  intent: IntentAnswerSchema.nullable(),
  pack: PackStatusSchema,
});
export type SerpTabState = z.infer<typeof SerpTabStateSchema>;

// ---- Procedures ---------------------------------------------------------------------------------

/** `serp.state` input: the tab. */
export const SerpTabInputSchema = z.strictObject({ tabId });
/** `serp.watch` input: the tab, and the last version the chrome has (`-1`: none yet, answered at once). */
export const SerpWatchInputSchema = z.strictObject({ tabId, sinceVersion: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
/** `serp.setOutlines` input: the tab, and whether its outlines should be drawn. */
export const SerpOutlinesInputSchema = z.strictObject({ tabId, on: z.boolean() });
/**
 * `serp.classify` input: any query (the Visibility panel's box), at most a result page query's
 * length; the classifier trims it and cuts it to `INTENT_LIMITS.maxQueryChars`.
 */
export const SerpClassifyInputSchema = z.strictObject({ query: z.string().max(Math.max(SERP_PARAM_LIMITS.maxQueryChars, INTENT_LIMITS.maxQueryChars)) });
export type SerpTabInput = z.infer<typeof SerpTabInputSchema>;
export type SerpWatchInput = z.infer<typeof SerpWatchInputSchema>;
export type SerpOutlinesInput = z.infer<typeof SerpOutlinesInputSchema>;
export type SerpClassifyInput = z.infer<typeof SerpClassifyInputSchema>;
