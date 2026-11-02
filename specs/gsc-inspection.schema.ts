/**
 * URL Inspection's schemas (Phase 9 Task 2; acceptance `gsc-inspection.feature.md`; plan Decisions 2,
 * 3 and 6). Main-only (Zod): the chrome imports the plain values of `gsc-inspection.spec.ts` and this
 * module's types only.
 *
 * - Google's answer (`GoogleInspectionResponseSchema`) is parsed leniently: unknown members are
 *   stripped (so `sitemap`, `referringUrls`, `ampResult` and the deprecated `mobileUsabilityResult`
 *   never get past it), a malformed optional member reads as absent, and an enum string frost does not
 *   know reads as `unknown`. Main then rebuilds it into frost's answer with every string capped.
 * - frost's answer (`GscInspectionAnswerSchema`) and the inputs are **strict**: an answer with any
 *   other member (a token) is refused by the router rather than forwarded.
 */
import { z } from 'zod';
import {
  GSC_CRAWLED_AS,
  GSC_INDEXING_STATES,
  GSC_INSPECTION_CODE_PATTERN,
  GSC_INSPECTION_LIMITS,
  GSC_INSPECTION_VERDICTS,
  GSC_OPEN_LINK_RESULTS,
  GSC_PAGE_FETCH_STATES,
  GSC_RICH_SEVERITIES,
  GSC_ROBOTS_TXT_STATES,
  isGscInspectionLink,
  readGscInspectionCode,
  type GscInspectionCode,
  type GscOpenLinkResult,
} from './gsc-inspection.spec';
import { GSC_LIMITS, GscPropertySchema, GscUnavailableSchema } from './gsc.schema';
import { isWebUrl } from './web-url.spec';

export * from './gsc-inspection.spec';

// ---- Inputs -------------------------------------------------------------------------------------

const webUrl = z.string().min(1).max(GSC_LIMITS.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' });

/**
 * `gsc.inspect` (and `GscService.inspect`): the page `url` (`http(s)`; main drops its fragment), and
 * `fresh: true` to skip the cache ("Inspect again").
 */
export const GscInspectInputSchema = z.strictObject({ url: webUrl, fresh: z.boolean().optional() });
export type GscInspectInput = z.infer<typeof GscInspectInputSchema>;

/** `gsc.openInspectionLink`: the **page** (`url`), never the link; main reads the link from its own cached answer. */
export const GscOpenInspectionLinkInputSchema = z.strictObject({ url: webUrl });
export type GscOpenInspectionLinkInput = z.infer<typeof GscOpenInspectionLinkInputSchema>;

/** `gsc.openInspectionLink`'s answer (`GSC_OPEN_LINK_RESULTS`). */
export const GscOpenLinkResultSchema = z.enum(GSC_OPEN_LINK_RESULTS);
export type { GscOpenLinkResult };

// ---- frost's answer -----------------------------------------------------------------------------

/** An enum value of one of the tables: `{ value }`, or `{ value: 'unknown', code }` (`GscInspectionCode`). */
function codeSchema<K extends string>(table: Readonly<Record<K, string>>) {
  const values = Object.keys(table) as [K, ...K[]];
  return z.union([
    z.strictObject({ value: z.enum(values) }),
    z.strictObject({ value: z.literal('unknown'), code: z.string().regex(GSC_INSPECTION_CODE_PATTERN).nullable() }),
  ]);
}

const text = z.string().max(GSC_INSPECTION_LIMITS.maxTextChars);
const canonical = webUrl.nullable();

/**
 * Google's index status for the page: verdict, coverage (Google's text, capped), robots.txt, indexing
 * and fetch states, the last crawl (ISO time) and crawler, and the canonical Google chose and the one
 * the page declares (`http(s)` URLs, else `null`).
 */
export const GscInspectionIndexSchema = z.strictObject({
  verdict: codeSchema(GSC_INSPECTION_VERDICTS),
  coverageState: text,
  robotsTxtState: codeSchema(GSC_ROBOTS_TXT_STATES),
  indexingState: codeSchema(GSC_INDEXING_STATES),
  pageFetchState: codeSchema(GSC_PAGE_FETCH_STATES),
  lastCrawlTime: z.iso.datetime().nullable(),
  crawledAs: codeSchema(GSC_CRAWLED_AS).nullable(),
  googleCanonical: canonical,
  userCanonical: canonical,
});
export type GscInspectionIndex = z.infer<typeof GscInspectionIndexSchema>;

export const GscRichIssueSchema = z.strictObject({ message: text, severity: codeSchema(GSC_RICH_SEVERITIES) });
export type GscRichIssue = z.infer<typeof GscRichIssueSchema>;
export const GscRichItemSchema = z.strictObject({ name: text, issues: z.array(GscRichIssueSchema).max(GSC_INSPECTION_LIMITS.maxIssues) });
export type GscRichItem = z.infer<typeof GscRichItemSchema>;
export const GscRichTypeSchema = z.strictObject({ type: text, items: z.array(GscRichItemSchema).max(GSC_INSPECTION_LIMITS.maxItems) });
export type GscRichType = z.infer<typeof GscRichTypeSchema>;

/** The rich results Google detected: a verdict, and the types with their items and issues (at most `maxItems` items in all). */
export const GscRichResultsSchema = z
  .strictObject({ verdict: codeSchema(GSC_INSPECTION_VERDICTS), types: z.array(GscRichTypeSchema).max(GSC_INSPECTION_LIMITS.maxItems) })
  .refine((r) => r.types.reduce((sum, t) => sum + t.items.length, 0) <= GSC_INSPECTION_LIMITS.maxItems, { error: 'at most maxItems items in all', path: ['types'] });
export type GscRichResults = z.infer<typeof GscRichResultsSchema>;

/**
 * `gsc.inspect` (`GscService.inspect`): the property, the page inspected (without its fragment), when
 * frost asked (`inspectedAt`, ISO), Google's index status, its rich results (`null`: none reported), and
 * the Search Console link (`null` unless `https://search.google.com/…`; main keeps it for
 * `gsc.openInspectionLink`, the chrome never opens it itself). Or `unavailable` with a reason.
 */
export const GscInspectionAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    property: GscPropertySchema,
    url: webUrl,
    inspectedAt: z.iso.datetime(),
    index: GscInspectionIndexSchema,
    richResults: GscRichResultsSchema.nullable(),
    link: z.string().max(GSC_LIMITS.maxUrlChars).refine(isGscInspectionLink, { message: 'not a Search Console link' }).nullable(),
  }),
  GscUnavailableSchema,
]);
export type GscInspectionAnswer = z.infer<typeof GscInspectionAnswerSchema>;
export type GscInspectionOk = Extract<GscInspectionAnswer, { status: 'ok' }>;
export type { GscInspectionCode };

// ---- Google's answer (main only; parsed leniently, never forwarded) -------------------------------

/** A string member that reads as absent when it is anything else. */
const looseText = z.string().optional().catch(undefined);
/** A list member that reads as absent when it is not a list of that shape. */
const looseArray = <T extends z.ZodType>(item: T) => z.array(item).optional().catch(undefined);
/**
 * An enum member read against `table`: unknown or absent is `unknown` (`readGscInspectionCode`).
 * (`.optional()` so an absent key reaches the transform instead of failing its object.)
 */
const googleCode = <K extends string>(table: Readonly<Record<K, string>>) =>
  z
    .unknown()
    .optional()
    .transform((raw): GscInspectionCode<K> => readGscInspectionCode(table, raw));
/** As `googleCode`, but absent (or `null`) stays `null`. */
const optionalGoogleCode = <K extends string>(table: Readonly<Record<K, string>>) =>
  z
    .unknown()
    .optional()
    .transform((raw): GscInspectionCode<K> | null => (raw === undefined || raw === null ? null : readGscInspectionCode(table, raw)));

/**
 * `POST /urlInspection/index:inspect`: `inspectionResult` with `inspectionResultLink`,
 * `indexStatusResult` and `richResultsResult` (each optional). Members frost does not read are
 * stripped.
 */
export const GoogleInspectionResponseSchema = z.object({
  inspectionResult: z.object({
    inspectionResultLink: looseText,
    indexStatusResult: z
      .object({
        verdict: googleCode(GSC_INSPECTION_VERDICTS),
        coverageState: looseText,
        robotsTxtState: googleCode(GSC_ROBOTS_TXT_STATES),
        indexingState: googleCode(GSC_INDEXING_STATES),
        lastCrawlTime: looseText,
        pageFetchState: googleCode(GSC_PAGE_FETCH_STATES),
        googleCanonical: looseText,
        userCanonical: looseText,
        crawledAs: optionalGoogleCode(GSC_CRAWLED_AS),
      })
      .optional()
      .catch(undefined),
    richResultsResult: z
      .object({
        verdict: googleCode(GSC_INSPECTION_VERDICTS),
        detectedItems: looseArray(
          z.object({
            richResultType: looseText,
            items: looseArray(z.object({ name: looseText, issues: looseArray(z.object({ issueMessage: looseText, severity: googleCode(GSC_RICH_SEVERITIES) })) })),
          }),
        ),
      })
      .optional()
      .catch(undefined),
  }),
});
export type GoogleInspectionResponse = z.infer<typeof GoogleInspectionResponseSchema>;
