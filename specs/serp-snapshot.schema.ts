/**
 * The Zod side of SERP reading (Phase 3 Task 3; plain values in `serp.spec.ts`; acceptance
 * `serp-overlay.feature.md`; review focus `serp-reader-is-bounded`). Not for the chrome renderer (no
 * Zod there).
 *
 * - `SerpReadSchema` is the reader's raw answer (`read-script.ts`, `readSerp`): page data, so the
 *   SERP worker validates it before anything is derived from it (a failure is `invalid-answer`).
 *   Strict and capped like the reader itself (`SERP_READ_LIMITS`).
 * - `SerpSnapshotSchema` is the analysed result (`serp-analyse.ts`, `analyseSerp`), validated again
 *   as it leaves the analysis: `ready` with the page's results, composition and ownership, or
 *   `unreadable` with its reason.
 *
 * ## The result model (`ready`)
 * - `results` are every result read, in the page's document order, at most `maxResults`. Each has:
 *   - `rank`: its place among all results on the page (1, 2, … whatever their type);
 *   - `position`: for `organic`, its organic position on this page (1 … n, counting organic results
 *     only, the usual "position"); for `ad`, its place among the ads (1 … k, a count of their own);
 *     `null` for SERP features;
 *   - `featureSlot`: for a SERP feature (`SERP_FEATURE_TYPES`), the slot of its block among the
 *     page's feature blocks (1, 2, … in document order; every result of one block shares it);
 *     `null` for organic results and ads;
 *   - `type`, `title`, `url` (`null` when the result has no link, such as a related question) and
 *     `domain`: the URL host's registrable domain (`@app/seo-core` `registrableDomain`), or `null`.
 *   Positions are this page's: on page 2 the first organic result is position 1 (`params.page` says
 *   which page it is).
 * - `composition`: `counts`, the number of results per type (every type, zeros included), and
 *   `features`, the page's feature blocks in document order (slot, type, number of results).
 * - `ownership`: the page's organic results grouped by registrable domain (on page 1, who owns page
 *   1): per domain its count, its share of the page's organic results, its positions and its best
 *   position, sorted by count (most first), then best position. **Ads are not counted**: they are
 *   paid placements, not rankings, and their links usually go through the engine's click redirect,
 *   so their domain is the engine's. They stay in `results` and `composition` as `ad`.
 * - `truncated`: a reader cap cut the page (more than `maxResults` results or `maxBlocks` blocks).
 */
import { z } from 'zod';
import { SERP_RESULT_TYPES, type SerpResultType } from './serp-selector-pack.spec';
import { SERP_FEATURE_TYPES, SERP_READ_FAILURES, SERP_READ_LIMITS, SERP_UNREADABLE_REASONS, isSerpFeature } from './serp.spec';
import { SearchParamsSchema } from './serp-search-params.schema';

const L = SERP_READ_LIMITS;

/** A link as the reader answers it: an absolute `http:` / `https:` URL, at most `maxUrlChars`. */
const UrlSchema = z
  .string()
  .max(L.maxUrlChars)
  .regex(/^https?:\/\/[^\u0000- \u007f]+$/);

/** A box in document coordinates (CSS px, rounded): non-empty and within `maxCoordinate`. */
export const SerpRectSchema = z.strictObject({
  x: z.int().min(-L.maxCoordinate).max(L.maxCoordinate),
  y: z.int().min(-L.maxCoordinate).max(L.maxCoordinate),
  width: z.int().min(1).max(L.maxCoordinate),
  height: z.int().min(1).max(L.maxCoordinate),
});

/** One result as read: its title (collapsed text, possibly empty), its link and its box. */
export const SerpReadItemSchema = z.strictObject({
  title: z.string().max(L.maxTitleChars),
  url: UrlSchema.nullable(),
  rect: SerpRectSchema.optional(),
});

/**
 * A run of consecutive results of one pack block and one container, in document order. An item has
 * a title or a link (or both); organic results and ads always have a link.
 */
export const SerpReadBlockSchema = z
  .strictObject({
    type: z.enum(SERP_RESULT_TYPES),
    items: z.array(SerpReadItemSchema).min(1).max(L.maxResults),
    rect: SerpRectSchema.optional(),
  })
  .refine((block) => block.items.every((item) => item.url !== null || item.title.length > 0), { message: 'an item with neither a title nor a link' })
  .refine((block) => isSerpFeature(block.type) || block.items.every((item) => item.url !== null), { message: 'an organic result or ad without a link' });

/** What the read cost: node visits (capped at `maxNodesVisited`), time, and whether a cap cut it. */
export const SerpReadStatsSchema = z.strictObject({
  nodes: z.int().min(0).max(L.maxNodesVisited),
  elapsedMs: z.number().min(0).max(3_600_000),
  truncated: z.boolean(),
});

const blocksSchema = z
  .array(SerpReadBlockSchema)
  .max(L.maxBlocks)
  .refine((blocks) => blocks.reduce((sum, block) => sum + block.items.length, 0) <= L.maxResults, { message: 'more results than maxResults' });

/**
 * The reader's answer: `ok` with its blocks in document order, or a failure (`SERP_READ_FAILURES`).
 * A `timeout` carries what was read by then (`blocks`), for diagnosis only: a cut page is never
 * analysed (its composition and ownership would be wrong).
 */
export const SerpReadSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), blocks: blocksSchema, stats: SerpReadStatsSchema }),
  z
    .strictObject({ ok: z.literal(false), reason: z.enum(SERP_READ_FAILURES), stats: SerpReadStatsSchema, blocks: blocksSchema.optional() })
    .refine((read) => read.blocks === undefined || read.reason === 'timeout', { message: 'only a timeout carries blocks' }),
]);
export type SerpRead = z.infer<typeof SerpReadSchema>;
export type SerpReadBlock = z.infer<typeof SerpReadBlockSchema>;
export type SerpReadItem = z.infer<typeof SerpReadItemSchema>;
export type SerpRect = z.infer<typeof SerpRectSchema>;

const rankSchema = z.int().min(1).max(L.maxResults);
const slotSchema = z.int().min(1).max(L.maxBlocks);
const countSchema = z.int().min(0).max(L.maxResults);
const DomainSchema = z.string().min(1).max(253);

/** One analysed result (see the result model above). */
export const SerpResultSchema = z
  .strictObject({
    rank: rankSchema,
    type: z.enum(SERP_RESULT_TYPES),
    position: rankSchema.nullable(),
    featureSlot: slotSchema.nullable(),
    title: z.string().max(L.maxTitleChars),
    url: UrlSchema.nullable(),
    domain: DomainSchema.nullable(),
  })
  .refine((result) => (isSerpFeature(result.type) ? result.position === null && result.featureSlot !== null : result.position !== null && result.featureSlot === null), {
    message: 'a feature has a slot and no position; organic results and ads a position and no slot',
  });
export type SerpResult = z.infer<typeof SerpResultSchema>;

/** A feature block on the page: its slot, its type and how many results it holds. */
export const SerpFeatureSlotSchema = z.strictObject({
  slot: slotSchema,
  type: z.enum(SERP_FEATURE_TYPES),
  results: z.int().min(1).max(L.maxResults),
});

export const SerpCompositionSchema = z.strictObject({
  counts: z.strictObject(Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, countSchema])) as Record<SerpResultType, typeof countSchema>),
  features: z.array(SerpFeatureSlotSchema).max(L.maxBlocks),
});
export type SerpComposition = z.infer<typeof SerpCompositionSchema>;

/** One registrable domain's share of the page's organic results. */
export const SerpDomainShareSchema = z.strictObject({
  domain: DomainSchema,
  count: z.int().min(1).max(L.maxResults),
  share: z.number().min(0).max(1),
  positions: z.array(rankSchema).min(1).max(L.maxResults),
  best: rankSchema,
});

/** Ownership of the page's organic results (`organic`: how many have a domain; ads excluded). */
export const SerpOwnershipSchema = z.strictObject({
  page: z.int().min(1),
  organic: countSchema,
  domains: z.array(SerpDomainShareSchema).max(L.maxResults),
});
export type SerpOwnership = z.infer<typeof SerpOwnershipSchema>;

/** Why a page could not be read (`SERP_UNREADABLE_REASONS`), with what is known of it. */
export const SerpUnreadableSchema = z.strictObject({
  status: z.literal('unreadable'),
  reason: z.enum(SERP_UNREADABLE_REASONS),
  /** `null` when no search parameters are known (`pack-invalid`, or parameters that failed validation). */
  params: SearchParamsSchema.nullable(),
  packVersion: z.int().min(1).nullable(),
});

export const SerpReadySchema = z
  .strictObject({
    status: z.literal('ready'),
    params: SearchParamsSchema,
    packVersion: z.int().min(1),
    results: z.array(SerpResultSchema).min(1).max(L.maxResults),
    composition: SerpCompositionSchema,
    ownership: SerpOwnershipSchema,
    truncated: z.boolean(),
  })
  .refine((snapshot) => snapshot.results.every((result, index) => result.rank === index + 1), { message: 'ranks are not 1 … n in order', path: ['results'] })
  .refine(
    (snapshot) =>
      (['organic', 'ad'] as const).every((type) =>
        snapshot.results.filter((result) => result.type === type).every((result, index) => result.position === index + 1),
      ),
    { message: 'organic or ad positions are not 1 … n in order', path: ['results'] },
  )
  .refine((snapshot) => SERP_RESULT_TYPES.every((type) => snapshot.composition.counts[type] === snapshot.results.filter((result) => result.type === type).length), {
    message: 'composition counts do not match the results',
    path: ['composition'],
  })
  .refine((snapshot) => snapshot.ownership.page === snapshot.params.page, { message: 'ownership is of another page', path: ['ownership'] });

/** The analysed reading of one result page: `ready` or `unreadable`. */
export const SerpSnapshotSchema = z.union([SerpReadySchema, SerpUnreadableSchema]);
export type SerpSnapshot = z.infer<typeof SerpSnapshotSchema>;
export type SerpReady = z.infer<typeof SerpReadySchema>;
export type SerpUnreadable = z.infer<typeof SerpUnreadableSchema>;
