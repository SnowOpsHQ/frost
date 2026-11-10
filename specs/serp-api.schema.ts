/**
 * The Zod side of the bring-your-own SERP API (Phase 12 Task 3; plain values and the mapping rules in
 * `serp-api.spec.ts`; plan Decision 7, Global constraints "Untrusted text", Threat model "Hostile
 * vendor JSON").
 *
 * - Per-vendor response schemas (`SerpApiResponseSchema`, `DataForSeoResponseSchema`,
 *   `SerperResponseSchema`) pick only the fields frost reads. The **envelope** (the top-level object,
 *   and DataForSEO's task and result wrappers) is a `z.looseObject`: whatever else a vendor sends at
 *   that level passes untouched and unread. **Below it** every picked field is strictly typed and
 *   capped (`SERP_API_LIMITS`: strings, arrays, ranks); a picked field of the wrong type fails the
 *   whole answer (`invalid-answer`). A result object's other fields (vendors send dozens and add more)
 *   are dropped, never read or validated: refusing unknown keys there would refuse every real answer.
 * - `SerpApiRequestSchema`: the search to check: a saved search (`SavedSearchInputSchema`) plus an
 *   optional location as typed (`SearchLocationLabelSchema`: printable, trimmed, at most
 *   `maxLocationChars`).
 * - `SerpApiJobSchema`: the SERP worker's `api` job (`serp-worker.ts`): the vendor, the answer's text
 *   and the search parameters and pack version main built, all validated again in the worker.
 */
import { z } from 'zod';
import { DATA_SERP_PROVIDERS, type DataApiRefusal } from './data-sources.spec';
import { SavedSearchInputSchema } from './projects.schema';
import { SERP_API_LIMITS, type SerpApiOutcome } from './serp-api.spec';
import { SearchLocationLabelSchema, SearchParamsSchema, type SearchParams } from './serp-search-params.schema';
import type { SerpSnapshot } from './serp-snapshot.schema';

const L = SERP_API_LIMITS;

/** A string the mapping reads (a title, a link, a query). */
const text = z.string().max(L.maxStringChars);
/** A vendor's rank or position field: a whole number from 1. */
const rank = z.int().min(1).max(10_000);
/** An array the mapping reads, at most `maxItems` entries. */
const list = <T extends z.ZodType>(item: T) => z.array(item).max(L.maxItems);

// ---- SerpApi -------------------------------------------------------------------------------------

/** A titled link (`title`, `link`), as several SerpApi sections give it. */
const serpApiLink = z.object({ title: text.nullish(), link: text.nullish() });

export const SerpApiOrganicSchema = z.object({ position: rank, title: text.nullish(), link: text });
/** An ad: one without a web link is dropped and counted as skipped, never a failure. */
export const SerpApiAdSchema = z.object({ position: rank.nullish(), block_position: text.nullish(), title: text.nullish(), link: text.nullish() });
const serpApiPlace = z.object({ position: rank.nullish(), title: text.nullish(), links: z.object({ website: text.nullish() }).nullish() });

export const SerpApiResponseSchema = z.looseObject({
  // Whether the search ran (`Success`), and the error it answers instead.
  search_metadata: z.looseObject({ status: text.nullish() }).optional(),
  error: text.optional(),
  // `organic_results_state` says when the page had no organic results (`Fully empty`).
  search_information: z.looseObject({ organic_results_state: text.nullish() }).optional(),
  ads: list(SerpApiAdSchema).optional(),
  ai_overview: z.object({ references: list(serpApiLink).nullish() }).optional(),
  answer_box: serpApiLink.optional(),
  knowledge_graph: z.object({ title: text.nullish(), website: text.nullish() }).optional(),
  local_results: z.union([z.object({ places: list(serpApiPlace).nullish() }), list(serpApiPlace)]).optional(),
  // An array on desktop; on mobile an object of arrays (`carousel`, `also_in_the_news`, …).
  top_stories: z
    .union([list(serpApiLink), z.record(z.string().max(64), list(serpApiLink))])
    .refine((value) => Array.isArray(value) || Object.keys(value).length <= L.maxItems, { message: 'too many top stories groups' })
    .optional(),
  organic_results: list(SerpApiOrganicSchema).optional(),
  related_questions: list(z.object({ question: text.nullish(), link: text.nullish() })).optional(),
  inline_videos: list(z.object({ position: rank.nullish(), title: text.nullish(), link: text.nullish() })).optional(),
  related_searches: list(z.object({ query: text.nullish(), link: text.nullish() })).optional(),
});
export type SerpApiResponse = z.infer<typeof SerpApiResponseSchema>;

// ---- DataForSEO ----------------------------------------------------------------------------------

/** An element of `tasks[0].result[0].items` as first read: its type only (an unmapped one is skipped). */
const dataForSeoAnyElement = z.looseObject({ type: z.string().max(64) });

export const DataForSeoResponseSchema = z.looseObject({
  status_code: z.int(),
  tasks: z
    .array(
      z.looseObject({
        status_code: z.int(),
        result: z.array(z.looseObject({ items: list(dataForSeoAnyElement).nullish() })).max(1).nullish(),
      }),
    )
    .min(1)
    .max(1),
});
export type DataForSeoResponse = z.infer<typeof DataForSeoResponseSchema>;

/** A nested entry of an element: a titled link, an image (`alt`, `url`), or a related search (a string). */
const dataForSeoChild = z.union([text, z.object({ title: text.nullish(), url: text.nullish(), alt: text.nullish() })]);

/** A mapped element (`SERP_API_TYPE_MAP.dataforseo`), its picked fields. */
export const DataForSeoElementSchema = z.object({
  type: z.string().max(64),
  rank_group: rank,
  rank_absolute: rank,
  title: text.nullish(),
  url: text.nullish(),
  items: list(dataForSeoChild).nullish(),
  references: list(z.object({ title: text.nullish(), url: text.nullish() })).nullish(),
});
export type DataForSeoElement = z.infer<typeof DataForSeoElementSchema>;

// ---- Serper (unverified; see `serp-api.spec.ts`) -------------------------------------------------

export const SerperResponseSchema = z.looseObject({
  // An error answer (for instance, out of credits).
  message: text.optional(),
  knowledgeGraph: z.object({ title: text.nullish() }).optional(),
  organic: list(z.object({ position: rank, title: text.nullish(), link: text })).optional(),
  peopleAlsoAsk: list(z.object({ question: text.nullish(), title: text.nullish(), link: text.nullish() })).optional(),
  relatedSearches: list(z.object({ query: text.nullish() })).optional(),
});
export type SerperResponse = z.infer<typeof SerperResponseSchema>;

// ---- The request and the worker job --------------------------------------------------------------

/** The search `checkSearchViaApi` checks: a saved search plus an optional location as typed. */
export const SerpApiRequestSchema = SavedSearchInputSchema.extend({ location: SearchLocationLabelSchema.optional() });
export type SerpApiRequest = z.infer<typeof SerpApiRequestSchema>;

/** The SERP worker's `api` job (`{ id, kind: 'api', job }`). */
export const SerpApiJobSchema = z.strictObject({
  provider: z.enum(DATA_SERP_PROVIDERS),
  body: z.string().max(L.maxResponseBytes),
  params: SearchParamsSchema,
  packVersion: z.int().min(1),
});
export type SerpApiJob = z.infer<typeof SerpApiJobSchema>;

/** What the worker answers an `api` job: the snapshot (`analyseSerp`'s) and the vendor result types skipped. */
export interface SerpApiJobResult {
  readonly snapshot: SerpSnapshot;
  readonly skipped: number;
}

/**
 * What `checkSearchViaApi` answers: the snapshot (`ready`, or `unreadable` with `no-results` when the
 * vendor found nothing), the search parameters it is filed under (a saved search's exactly, plus
 * `location` when one was given), how many vendor result types were skipped, and the key-less URL;
 * or a failure (`SERP_API_OUTCOMES`).
 */
export type SerpApiCheck =
  | { readonly ok: true; readonly snapshot: SerpSnapshot; readonly params: SearchParams; readonly skipped: number; readonly url: string }
  | { readonly ok: false; readonly outcome: SerpApiOutcome; readonly message: string; readonly refusal?: DataApiRefusal; readonly status?: number };
