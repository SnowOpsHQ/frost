/**
 * The served snapshot and the served-HTML states (Phase 2.5 Task 2; plain values and the prose in
 * `seo-javascript.spec.ts`; acceptance `seo-javascript.feature.md`). Main-only (Zod): the analysis
 * worker validates what main hands it beside the rendered snapshot (`served` in the page's context)
 * with `ServedStateSchema`, on its own: an invalid one makes the comparison `unavailable`
 * (`invalid`), never the audit.
 *
 * The served snapshot has the rendered snapshot's shape (`seo-snapshot.spec.ts`) for every field
 * that does not need layout, with the same caps (`SNAPSHOT_LIMITS`), so the two can be compared
 * field by field.
 */
import { z } from 'zod';
import { CanonicalSchema, HeadingSchema, HreflangLinkSchema, JsonLdBlockSchema, LinkSchema, RobotsMetaSchema, SNAPSHOT_LIMITS as L } from './seo-snapshot.spec';
import { SERVED_FETCH_LIMITS, SERVED_UNAVAILABLE_REASONS } from './seo-javascript.spec';
import { isWebUrl } from './web-url.spec';

const count = z.int().nonnegative().max(L.maxCount);
const urlText = z.string().max(L.maxUrlChars);
const webUrl = urlText.min(1).refine(isWebUrl, { message: 'not an http(s) URL' });
const status = z.int().min(100).max(999);

/** As the rendered snapshot's measured texts: the first `maxChars` characters (normalised) and the whole value's length. */
function cappedText(maxChars: number) {
  return z
    .strictObject({ text: z.string().max(maxChars), length: count })
    .refine((value) => value.length >= [...value.text].length, { message: 'length is below the text kept' });
}

/** An `img` of the served HTML: its `src` resolved (`''` if none) and its `alt` (`null` when absent). */
export const ServedImageSchema = z.strictObject({ src: urlText, alt: cappedText(L.maxAltChars).nullable() });

/**
 * `<noscript>` in the served HTML (the browser that rendered the page ran scripts, so their content
 * is text there): how many there are, and the words and `a[href]` links of their content parsed as
 * HTML (what a crawler without JavaScript would read from them).
 */
export const ServedNoscriptSchema = z.strictObject({ count, wordCount: count, linkCount: count });

/**
 * The served snapshot: `url` is the URL the HTML came from (the fetch's final URL, what links resolve
 * against with any `<base href>`); the other fields as `PageSnapshotSchema` (headings with no
 * visibility check); `nodes`: the nodes parsed; `partial`: parsing stopped at `SERVED_PARSE_LIMITS`.
 */
export const ServedSnapshotSchema = z
  .strictObject({
    url: webUrl,
    lang: z.string().max(L.maxLangChars).nullable(),
    titles: z.array(cappedText(L.maxTextChars)).max(L.maxRepeated),
    titleTotal: count,
    metaDescriptions: z.array(cappedText(L.maxTextChars)).max(L.maxRepeated),
    metaDescriptionTotal: count,
    metaRobots: z.array(RobotsMetaSchema).max(L.maxRepeated),
    canonicals: z.array(CanonicalSchema).max(L.maxRepeated),
    canonicalTotal: count,
    ogUrl: urlText.nullable(),
    viewport: z.string().max(L.maxAttributeChars).nullable(),
    headings: z.array(HeadingSchema).max(L.maxHeadings),
    headingTotal: count,
    links: z.array(LinkSchema).max(L.maxLinks),
    linkTotal: count,
    images: z.array(ServedImageSchema).max(L.maxImages),
    imageTotal: count,
    jsonLd: z.array(JsonLdBlockSchema).max(L.maxJsonLdBlocks),
    jsonLdTotal: count,
    hreflang: z.array(HreflangLinkSchema).max(L.maxHreflang),
    hreflangTotal: count,
    wordCount: count,
    textTruncated: z.boolean(),
    noscript: ServedNoscriptSchema,
    nodes: count,
    partial: z.boolean(),
  })
  .refine(
    (s) =>
      s.titleTotal >= s.titles.length &&
      s.metaDescriptionTotal >= s.metaDescriptions.length &&
      s.canonicalTotal >= s.canonicals.length &&
      s.headingTotal >= s.headings.length &&
      s.linkTotal >= s.links.length &&
      s.imageTotal >= s.images.length &&
      s.jsonLdTotal >= s.jsonLd.length &&
      s.hreflangTotal >= s.hreflang.length,
    { message: 'a total is below its list' },
  )
  .refine((s) => s.jsonLd.reduce((sum, block) => sum + block.text.length, 0) <= L.maxJsonLdTotalChars, { message: 'JSON-LD over its total cap' });
export type ServedSnapshot = z.infer<typeof ServedSnapshotSchema>;

/**
 * How the served HTML was fetched: the URL asked for and the one that answered, its status, the
 * redirects followed, the bytes read (`truncated`: the page was longer than `maxBytes`), its media
 * type, the user agent sent (`null`: frost's own) and how long it took.
 */
export const ServedFetchSchema = z.strictObject({
  url: webUrl,
  finalUrl: webUrl,
  status,
  redirects: z.int().nonnegative().max(SERVED_FETCH_LIMITS.maxRedirects),
  bytes: z.int().nonnegative().max(SERVED_FETCH_LIMITS.maxBytes),
  truncated: z.boolean(),
  contentType: z.string().max(256).nullable(),
  userAgent: z.string().max(512).nullable(),
  durationMs: z.number().nonnegative(),
});
export type ServedFetch = z.infer<typeof ServedFetchSchema>;

/**
 * The page context's `served` input: `pending` (the stand-in while it is fetched and parsed),
 * `unavailable` with its reason (and the HTTP status / final URL when known), or `ready` with the
 * fetch and the served snapshot.
 */
export const ServedStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(SERVED_UNAVAILABLE_REASONS), httpStatus: status.nullable(), finalUrl: urlText.nullable() }),
  z.strictObject({ status: z.literal('ready'), fetch: ServedFetchSchema, snapshot: ServedSnapshotSchema }),
]);
export type ServedState = z.infer<typeof ServedStateSchema>;

/**
 * What the rules read beside the snapshot (`PageSnapshot`): the served state, validated on its own
 * (absent or `null`: nothing fetched; an invalid one is `unavailable` / `invalid`).
 */
export interface JavascriptContext {
  readonly served?: ServedState | null;
}

/** The parse job main gives the worker: the bytes as read, what they are, and the URL they came from. */
export interface ServedParseInput {
  readonly url: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}
/** The parse job's answer. */
export type ServedParseResult = { readonly ok: true; readonly snapshot: ServedSnapshot } | { readonly ok: false; readonly reason: 'parse-failed' | 'parse-timeout' };

/** `javascript.refetchServed` input: the tab. */
export const RefetchServedInputSchema = z.strictObject({ tabId: z.int().positive() });
export type RefetchServedInput = z.infer<typeof RefetchServedInputSchema>;
