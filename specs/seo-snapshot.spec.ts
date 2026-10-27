/**
 * The page snapshot the SEO audit runs on (Phase 2 Task 1; acceptance: `seo-sidebar.feature.md`,
 * Extraction and Auditor). The extractor (`apps/desktop/src/main/seo/extract.ts`) builds it in an
 * isolated world (`SEO_WORLD_ID`) from the page's DOM; main parses it with `PageSnapshotSchema`
 * before any rule sees it. The page is untrusted, so the schema is strict: exactly these keys, every
 * list and string within `SNAPSHOT_LIMITS`, every count a safe non-negative integer. A result that
 * does not parse is "audit unavailable" (`invalid-snapshot`).
 *
 * Main-only (Zod): the Zod-free limits are in `seo-limits.spec.ts` (re-exported here), and the
 * renderer imports this module for its types only.
 */
import { z } from 'zod';
import { AccessibilityContextSchema, PageSecuritySchema } from './seo-compliance.schema';
import { headerValueCap, RESPONSE_HEADER_ALLOWLIST, RESPONSE_LIMITS, RESPONSE_SOURCES, ROBOTS_FETCH_LIMITS, ROBOTS_FETCH_OUTCOMES } from './seo-indexability.spec';
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS as L, SOCIAL_TAGS, SOCIAL_URL_TAGS, type SocialTag } from './seo-limits.spec';
import { HIGHLIGHT_MODES, LINK_FILTER_QUERY_MAX_CHARS, LINK_REL_FILTERS, LINK_TYPE_FILTERS } from './seo-sidebar.spec';
import { BlockingScriptsSchema, type PerformanceContext } from './seo-speed.schema.spec';
import { VISIBLE_TEXT_LIMITS } from './seo-content.spec';
import type { JavascriptContext } from './seo-javascript.schema';
import { isWebUrl } from './web-url.spec';

export * from './seo-limits.spec';

const count = z.int().nonnegative().max(L.maxCount);

/**
 * A page string a rule measures: its first `maxChars` characters (whitespace runs collapsed to one
 * space, trimmed) and the length of the whole normalised value in Unicode code points. A value of
 * more than 65 536 UTF-16 code units is measured in code units instead (no full scan of a huge
 * string), which only ever over-counts.
 */
function cappedText(maxChars: number) {
  return z
    .strictObject({ text: z.string().max(maxChars), length: count })
    .refine((value) => value.length >= [...value.text].length, { message: 'length is below the text kept' });
}

/** A URL string the page supplied (resolved or raw): never longer than `maxUrlChars`. */
const urlText = z.string().max(L.maxUrlChars);
const attribute = z.string().max(L.maxAttributeChars);

/** A robots meta tag: its (lowercased) `name`, one of `ROBOTS_META_NAMES`, and its `content` (lowercased, normalised). */
export const RobotsMetaSchema = z.strictObject({ name: z.enum(ROBOTS_META_NAMES), content: attribute });

/*
 * Hidden elements (headings and the word count both skip them): an element with the `hidden`
 * attribute or inside one, and, where `Element.checkVisibility` exists (Chromium; not every test
 * DOM), an element for which `checkVisibility()` is false (no box: `display: none` on it or an
 * ancestor, or inside `content-visibility: hidden`). `visibility: hidden` and off-screen text count
 * as shown (they still take part in layout).
 */

/** `link[rel=canonical]`: the `href` attribute as written, and resolved against the document (`null` if it does not parse). */
export const CanonicalSchema = z.strictObject({ href: urlText, resolved: urlText.nullable() });

/**
 * `h1`…`h6` that are not hidden (see Hidden elements above), in document order: the level and text
 * (its text nodes read in order, normalised, capped; `''` if empty). `headingTotal` counts every
 * heading element, hidden ones too.
 */
export const HeadingSchema = z.strictObject({
  level: z.int().min(1).max(6),
  text: z.string().max(L.maxHeadingChars),
});

/**
 * Where a link goes: `internal` (an `http(s)` URL on the page's host: `URL.host`, so the port counts
 * (`example.com:8080` is another host than `example.com`), one leading `www.` ignored), `external`
 * (any other `http(s)` URL), or `other` (`javascript:`, `mailto:`, `tel:` … or an `href` that does
 * not resolve).
 */
export const LINK_KINDS = ['internal', 'external', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * `a[href]` / `area[href]`, in document order: `href` resolved against the document (`''` if it
 * does not parse), its `scheme` (lowercased `URL.protocol`, `''` if none), `rel` (lowercased,
 * whitespace-normalised tokens), the anchor text: its text content, else `aria-label`, else the
 * `alt` of an image inside it, else `title` (normalised, capped; `''` when there is none), and its
 * `target` attribute as written (trimmed, capped at `maxTargetChars`; `null` when absent).
 */
export const LinkSchema = z.strictObject({
  href: urlText,
  scheme: z.string().max(32),
  rel: attribute,
  text: z.string().max(L.maxAnchorChars),
  kind: z.enum(LINK_KINDS),
  target: z.string().max(L.maxTargetChars).nullable(),
});

const pixels = z.int().nonnegative().max(L.maxImagePixels);
/** A width × height in CSS pixels (integers, each at most `maxImagePixels`). */
export const ImageSizeSchema = z.strictObject({ width: pixels, height: pixels });

/**
 * `img`, in document order: `src` resolved (`currentSrc` if set; `''` if none), its `alt` (`null`
 * when the attribute is absent; `alt=""` marks a decorative image), and the `width`, `height` and
 * `loading` attributes as written (`null` when absent). Measured in the page (Task 2):
 * - `rendered`: the size of its layout box (`getBoundingClientRect()`, rounded); `null` when it
 *   has none (hidden, see Hidden elements, or a box with no area);
 * - `natural`: the size of the image file shown (`currentSrc`); `null` while it has none (not
 *   loaded yet, e.g. a lazy image below the fold, or broken). `naturalWidth` × `naturalHeight` is
 *   divided by the density the browser picked, so when `currentSrc` is a `srcset` candidate (the
 *   image's own, or a `<source>`'s in its `<picture>`, matched by resolved URL) it is corrected:
 *   a `w` descriptor gives the file's width, its height from the natural aspect ratio; an `x`
 *   descriptor multiplies the natural size by it; otherwise the natural size is the file's. The
 *   first candidate with that URL is used, so when the same URL is also the `src` (an implicit `1x`)
 *   and a denser candidate, the browser's choice between them cannot be told apart;
 * - `cssSized`: CSS fixes the image's box before it loads: its computed `aspect-ratio` has a ratio,
 *   or its inline style or a same-origin stylesheet rule matching it declares both `width` and
 *   `height` (other than `auto`; bounded by `maxSizingRules` / `maxSizingSelectors`). Only measured
 *   for an image missing its `width` or `height` attribute (`false` otherwise);
 * - `inFirstViewport`: its box overlaps the first viewport, the top `innerHeight` × `innerWidth`
 *   CSS px of the document (wherever the page is scrolled to now); `false` without a box.
 */
export const ImageSchema = z.strictObject({
  src: urlText,
  alt: cappedText(L.maxAltChars).nullable(),
  width: z.string().max(L.maxImageAttributeChars).nullable(),
  height: z.string().max(L.maxImageAttributeChars).nullable(),
  loading: z.string().max(L.maxImageAttributeChars).nullable(),
  rendered: ImageSizeSchema.nullable(),
  natural: ImageSizeSchema.nullable(),
  inFirstViewport: z.boolean(),
  cssSized: z.boolean(),
});

const isUrlTag = (tag: SocialTag): boolean => (SOCIAL_URL_TAGS as readonly SocialTag[]).includes(tag);
/**
 * The social sharing tags (`SOCIAL_TAGS`, Task 2): each tag's first value (see `SOCIAL_TAGS`), or
 * `null` when the page has none. URL values (`SOCIAL_URL_TAGS`) are kept as written (trimmed, cut
 * to `maxUrlChars`), so a rule can tell a relative one; the others are normalised and cut to
 * `maxSocialChars`.
 */
export const SocialSchema = z.strictObject(
  Object.fromEntries(SOCIAL_TAGS.map((tag) => [tag, z.string().max(isUrlTag(tag) ? L.maxUrlChars : L.maxSocialChars).nullable()])) as Record<
    SocialTag,
    z.ZodNullable<z.ZodString>
  >,
);

/**
 * A JSON-LD block (Task 3): its text exactly as written (no normalising), the first
 * `maxJsonLdChars` UTF-16 code units (fewer, down to none, once the page's `maxJsonLdTotalChars`
 * are used up), and the full text's length in code units. A block whose `length` is above its
 * text's was cut: main does not parse it (`schema-over-limit`). The page never parses it either.
 */
export const JsonLdBlockSchema = z
  .strictObject({ text: z.string().max(L.maxJsonLdChars), length: count })
  .refine((block) => block.length >= block.text.length, { message: 'length is below the text kept' });

const schemaName = z.string().max(L.maxSchemaNameChars);

/**
 * A property of a markup item: its name as written (one `itemprop` / `property` token) with a text
 * value (`maxSchemaValueChars`), or with a nested item (`item`: that item's index in the same list).
 */
export const MarkupPropertySchema = z.union([
  z.strictObject({ name: schemaName.min(1), value: z.string().max(L.maxSchemaValueChars) }),
  z.strictObject({ name: schemaName.min(1), item: z.int().nonnegative().max(L.maxMarkupItems - 1) }),
]);

/**
 * A microdata item (`[itemscope]`) or an RDFa item (`[typeof]`), Task 3:
 * - `types`: its `itemtype` / `typeof` tokens as written (at most `maxItemTypes`);
 * - `id`: `itemid` (microdata) or `resource`, else `about` (RDFa), trimmed; `null` when absent;
 * - `vocab`: the RDFa `vocab` in effect (the nearest `[vocab]` at or above it); always `null` for
 *   microdata, whose `itemtype` is a full IRI;
 * - `properties`: in document order, at most `maxItemProperties`.
 *
 * A property's value: microdata reads a `content` attribute when the element has one (any element:
 * pages put it on spans too), else `src` (`audio`, `embed`, `iframe`, `img`, `source`, `track`,
 * `video`), `href` (`a`, `area`, `link`) or `data` (`object`) resolved, `value` (`data`, `meter`),
 * `datetime` (`time`), else the element's text (normalised, bounded like other element text). RDFa
 * reads `content`, else `resource`, `href` or `src` (resolved), else `datetime` (`time`), else the
 * text. `itemref` is not followed; a nested item is the value of its first property name only.
 */
export const MarkupItemSchema = z.strictObject({
  types: z.array(schemaName).max(L.maxItemTypes),
  id: z.string().max(L.maxSchemaValueChars).nullable(),
  vocab: schemaName.nullable(),
  properties: z.array(MarkupPropertySchema).max(L.maxItemProperties),
});

/**
 * Markup items in document order, at most `maxMarkupItems`. A nested item comes after the item that
 * holds it (`item` above its holder's index, within the list), and is held by one property at most,
 * so the items form a forest: never a cycle, never a shared subtree. An item no property holds is a
 * top-level item.
 */
const markupItems = z
  .array(MarkupItemSchema)
  .max(L.maxMarkupItems)
  .refine(
    (items) => {
      const held = new Set<number>();
      for (let i = 0; i < items.length; i++) {
        for (const property of items[i]!.properties) {
          if (!('item' in property)) continue;
          if (property.item <= i || property.item >= items.length || held.has(property.item)) return false;
          held.add(property.item);
        }
      }
      return true;
    },
    { message: 'items do not form a forest' },
  );

/**
 * `<link rel~="alternate" hreflang>` in `<head>` (Task 4), in document order: the `hreflang` value
 * (trimmed, cut to `maxHreflangChars`), the `href` as written (trimmed, cut) and resolved against
 * the document (`null` if it does not parse).
 */
export const HreflangLinkSchema = z.strictObject({ hreflang: z.string().max(L.maxHreflangChars), href: urlText, resolved: urlText.nullable() });

/**
 * The page's visible text for the content analysis (Phase 2.5 Task 3, `seo-content.spec.ts`,
 * `VISIBLE_TEXT_LIMITS`): the text nodes the word count reads, a `\n` at each block boundary, the
 * first `maxVisibleTextChars` code units; `truncated` when cut or when the walk stopped early.
 */
export const VisibleTextSchema = z.strictObject({ text: z.string().max(VISIBLE_TEXT_LIMITS.maxVisibleTextChars), truncated: z.boolean() });

/** Characters of the items' text values together. */
function markupChars(items: readonly { readonly properties: readonly ({ readonly value: string } | { readonly item: number })[] }[]): number {
  let sum = 0;
  for (const item of items) for (const property of item.properties) if ('value' in property) sum += property.value.length;
  return sum;
}

/**
 * The snapshot. Lists hold the first entries in document order (at most their `SNAPSHOT_LIMITS`
 * cap); each `…Total` is the page's full count (at least the list's length).
 *
 * - `url`: `document.URL`, cut to `maxUrlChars`; it must be an `http(s)` URL (the auditor only
 *   runs on those, and checks it is the URL it expected).
 * - `extractedAt`: when the extractor ran (epoch ms); `durationMs`: how long it took.
 * - `lang`: `<html lang>` as written (trimmed; `null` when absent or empty).
 * - `titles`: each HTML `<title>` element's text (SVG titles are not page titles).
 * - `metaDescriptions`: each `meta[name=description]`'s `content`.
 * - `metaRobots`: each robots meta (`ROBOTS_META_NAMES`, together at most `maxRepeated`), in
 *   document order, with its name.
 * - `canonicals`: each `link[rel~=canonical]`.
 * - `ogUrl`: the first `meta[property="og:url"]`'s `content` (`null` when absent).
 * - `social`: the Open Graph and Twitter card tags (`SocialSchema`).
 * - `viewport`: the first `meta[name=viewport]`'s `content` (`null` when absent).
 * - `wordCount`: words in the body's text nodes outside `script`, `style`, `noscript`,
 *   `template`, `svg`, `math`, `iframe` and `object` subtrees and hidden elements
 *   (see Hidden elements above). A word is an `Intl.Segmenter` (`granularity: 'word'`) segment that is
 *   `isWordLike`, so Chinese, Japanese and Thai text without spaces is counted word by word; where
 *   `Intl.Segmenter` is missing, a run of letters or digits. Words split across text nodes count
 *   once per node. `textTruncated` when the walk stopped at `maxTextNodes`, `maxTextScanChars` or
 *   the deadline (`EXTRACT_BUDGET_MS`).
 * - `partial`: the extractor reached `EXTRACT_BUDGET_MS` and stopped early: some lists may hold
 *   fewer entries than their cap allows (their totals are still the page's).
 * - `jsonLd`: each JSON-LD block (`JsonLdBlockSchema`), their text together at most
 *   `maxJsonLdTotalChars`; `microdata` / `rdfa`: the markup items (`MarkupItemSchema`), their text
 *   values together at most `maxMarkupTotalChars`, with `microdataTotal` / `rdfaTotal` the items the
 *   page has (Task 3).
 * - `hreflang`: the head's hreflang links (`HreflangLinkSchema`), `hreflangTotal` how many it has (Task 4).
 * - `security`: http subresources of an https page, meta CSP and meta referrer (`PageSecuritySchema`, Task 6).
 * - `visibleText`: the visible text for the content analysis (`VisibleTextSchema`, Phase 2.5 Task 3).
 */
export const PageSnapshotSchema = z
  .strictObject({
    url: urlText.min(1).refine(isWebUrl, { message: 'not an http(s) URL' }),
    extractedAt: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
    lang: z.string().max(L.maxLangChars).nullable(),
    titles: z.array(cappedText(L.maxTextChars)).max(L.maxRepeated),
    titleTotal: count,
    metaDescriptions: z.array(cappedText(L.maxTextChars)).max(L.maxRepeated),
    metaDescriptionTotal: count,
    metaRobots: z.array(RobotsMetaSchema).max(L.maxRepeated),
    canonicals: z.array(CanonicalSchema).max(L.maxRepeated),
    canonicalTotal: count,
    ogUrl: urlText.nullable(),
    social: SocialSchema,
    viewport: attribute.nullable(),
    headings: z.array(HeadingSchema).max(L.maxHeadings),
    headingTotal: count,
    wordCount: count,
    textTruncated: z.boolean(),
    partial: z.boolean(),
    links: z.array(LinkSchema).max(L.maxLinks),
    linkTotal: count,
    images: z.array(ImageSchema).max(L.maxImages),
    imageTotal: count,
    security: PageSecuritySchema,
    jsonLd: z.array(JsonLdBlockSchema).max(L.maxJsonLdBlocks),
    jsonLdTotal: count,
    microdata: markupItems,
    microdataTotal: count,
    rdfa: markupItems,
    rdfaTotal: count,
    hreflang: z.array(HreflangLinkSchema).max(L.maxHreflang),
    hreflangTotal: count,
    // Task 5 (`seo-speed.schema.spec.ts`): the head's render-blocking scripts.
    blockingScripts: BlockingScriptsSchema.optional(),
    // Phase 2.5 Task 3 (`seo-content.spec.ts`): the visible text the content analysis reads.
    visibleText: VisibleTextSchema.optional(),
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
      s.microdataTotal >= s.microdata.length &&
      s.rdfaTotal >= s.rdfa.length &&
      s.hreflangTotal >= s.hreflang.length,
    { message: 'a total is below its list' },
  )
  .refine((s) => s.jsonLd.reduce((sum, block) => sum + block.text.length, 0) <= L.maxJsonLdTotalChars, { message: 'JSON-LD over its total cap' })
  .refine((s) => markupChars(s.microdata) + markupChars(s.rdfa) <= L.maxMarkupTotalChars, { message: 'markup values over their total cap' });
/** What the extractor answers (`PageSnapshotSchema`): the page's DOM only. */
export type ExtractedSnapshot = z.infer<typeof PageSnapshotSchema>;

// ---- What main collects beside the snapshot (Task 4; `seo-indexability.spec.ts`) ------------

const status = z.int().min(100).max(999);

/**
 * A response header main kept (`RESPONSE_HEADER_ALLOWLIST`, lowercased), its value cut to
 * `headerValueCap(name)` (`maxHeaderValueChars`, or `maxLongHeaderValueChars` for the CSP headers);
 * `truncated: true` when it was cut (absent otherwise).
 */
export const ResponseHeaderSchema = z
  .strictObject({ name: z.enum(RESPONSE_HEADER_ALLOWLIST), value: z.string().max(RESPONSE_LIMITS.maxLongHeaderValueChars), truncated: z.literal(true).optional() })
  .refine((header) => header.value.length <= headerValueCap(header.name), { message: 'value over its cap' });

/**
 * A redirect the main-frame request went through: the URL that answered, its status and where it
 * sent the request (each cut to `maxUrlChars`). `internal`: Chromium made it up itself (an HSTS or
 * `upgrade-insecure-requests` upgrade, status line "Internal Redirect"); no server answered it.
 */
export const RedirectHopSchema = z.strictObject({ url: urlText, status, location: urlText, internal: z.boolean() });

/**
 * A tab's main-frame response, recorded by main from the browse session (`RESPONSE_SOURCES`):
 * - `url`: the URL the response is for (the document's URL; for `in-page`, the tab's URL now);
 * - `status`: the final HTTP status, `null` when unknown (`in-page`, or no code);
 * - `headers`: the allowlisted headers in arrival order (empty when not `headersAvailable`);
 * - `redirects`: the first `maxRedirects` hops before it, `redirectTotal` all of them.
 */
export const ResponseMetaSchema = z
  .strictObject({
    url: urlText.min(1),
    source: z.enum(RESPONSE_SOURCES),
    status: status.nullable(),
    headersAvailable: z.boolean(),
    headers: z.array(ResponseHeaderSchema).max(RESPONSE_LIMITS.maxHeaders),
    redirects: z.array(RedirectHopSchema).max(RESPONSE_LIMITS.maxRedirects),
    redirectTotal: count,
  })
  .refine((r) => r.redirectTotal >= r.redirects.length, { message: 'a total is below its list' })
  .refine((r) => r.headersAvailable || r.headers.length === 0, { message: 'headers without headersAvailable' });

/**
 * Main's fetch of the page origin's robots.txt (`ROBOTS_FETCH_LIMITS`, `ROBOTS_FETCH_OUTCOMES`):
 * the URL asked for, how it ended (`pending` while it runs), the final HTTP status (`null` without
 * a response), the URL that answered (`null` without one), how many redirects were followed, the
 * body exactly as read (bytes, at most `maxBytes`; empty unless `ok`: main never decodes it, the
 * worker does, `decodeRobotsBytes`) and whether the file was longer.
 */
export const RobotsFetchSchema = z.strictObject({
  url: urlText.min(1).refine(isWebUrl, { message: 'not an http(s) URL' }),
  outcome: z.enum(ROBOTS_FETCH_OUTCOMES),
  status: status.nullable(),
  finalUrl: urlText.nullable(),
  redirects: z.int().nonnegative().max(ROBOTS_FETCH_LIMITS.maxRedirects),
  body: z.instanceof(Uint8Array).refine((body) => body.byteLength <= ROBOTS_FETCH_LIMITS.maxBytes, { message: 'robots.txt over its cap' }),
  truncated: z.boolean(),
});

/**
 * What main collected about the page beside the extractor's snapshot, handed to the analysis worker
 * with it and validated there: its response (`null`: none recorded) and its origin's robots.txt
 * (`null`: not fetched); and the accessibility check's answer for the tab's document
 * (`AccessibilityContextSchema`, Task 6; absent or `null`: none; `'invalid'`: rejected).
 */
export const PageContextSchema = z.strictObject({ response: ResponseMetaSchema.nullable(), robots: RobotsFetchSchema.nullable(), accessibility: AccessibilityContextSchema.optional() });
export type PageContext = z.infer<typeof PageContextSchema>;
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;
export type ResponseHeader = z.infer<typeof ResponseHeaderSchema>;
export type RedirectHop = z.infer<typeof RedirectHopSchema>;
export type RobotsFetch = z.infer<typeof RobotsFetchSchema>;
export type HreflangLink = z.infer<typeof HreflangLinkSchema>;
export type { A11yNode, A11yViolation, AccessibilityContext, AccessibilityResult, InsecureResource, PageSecurity } from './seo-compliance.schema';
/** Nothing collected (`PageContext` with neither part). */
export const NO_PAGE_CONTEXT: PageContext = { response: null, robots: null };

/** What the rules read: the extractor's snapshot, and what main collected beside it (the speed measurement too, Task 5; the served HTML, Phase 2.5 Task 2). */
export type PageSnapshot = ExtractedSnapshot & PageContext & PerformanceContext & JavascriptContext;
export type PageLink = z.infer<typeof LinkSchema>;
export type PageImage = z.infer<typeof ImageSchema>;
export type PageHeading = z.infer<typeof HeadingSchema>;
export type ImageSize = z.infer<typeof ImageSizeSchema>;
export type PageSocial = z.infer<typeof SocialSchema>;
export type RobotsMeta = z.infer<typeof RobotsMetaSchema>;
export type CappedText = PageSnapshot['titles'][number];
export type JsonLdBlock = z.infer<typeof JsonLdBlockSchema>;
export type MarkupItem = z.infer<typeof MarkupItemSchema>;
export type MarkupProperty = z.infer<typeof MarkupPropertySchema>;

/** `seo.getAudit` / `seo.rerun` input: a tab's id (as `browser.closeTab`'s `TabIdInputSchema`). */
export const SeoTabInputSchema = z.strictObject({ tabId: z.int().positive() });
export type SeoTabInput = z.infer<typeof SeoTabInputSchema>;

/**
 * The Links panel's filter (Task 2; `seo-sidebar.spec.ts`, `LINK_TYPE_FILTERS`, `LINK_REL_FILTERS`):
 * by type, by rel, and a case-insensitive text search over the href and the anchor text (at most
 * `LINK_FILTER_QUERY_MAX_CHARS`; `''` matches every link).
 */
export const LinkFilterSchema = z.strictObject({
  type: z.enum(LINK_TYPE_FILTERS),
  rel: z.enum(LINK_REL_FILTERS),
  query: z.string().max(LINK_FILTER_QUERY_MAX_CHARS),
});
export type LinkFilter = z.infer<typeof LinkFilterSchema>;

/**
 * The audit a panel rendered (its `url` and `takenAt`): main copies only from that audit, so rows or
 * URLs from an older or newer audit than the one on screen are never written.
 */
export const SeoAuditRefSchema = z.strictObject({ url: urlText.min(1), takenAt: z.number().nonnegative() });
export type SeoAuditRef = z.infer<typeof SeoAuditRefSchema>;

/** `seo.copyLinksCsv` input: the tab, the audit the panel shows, and the filter whose rows are copied (what the panel shows). */
export const SeoLinksCsvInputSchema = z.strictObject({ tabId: z.int().positive(), audit: SeoAuditRefSchema, filter: LinkFilterSchema });
export type SeoLinksCsvInput = z.infer<typeof SeoLinksCsvInputSchema>;

/**
 * `seo.copyUrl` input: the tab, the audit the panel shows, and a URL that audit lists, parsed
 * (`pageUrls`: a link's `href`, an image's `src`, the canonical, `og:url` or a social image, each
 * as `URL.href`). Any other value copies nothing.
 */
export const SeoCopyUrlInputSchema = z.strictObject({ tabId: z.int().positive(), audit: SeoAuditRefSchema, url: urlText.min(1) });
export type SeoCopyUrlInput = z.infer<typeof SeoCopyUrlInputSchema>;

/**
 * `seo.copySchemaJson` input (Task 3): the tab, the audit the Schema panel shows, and the index of
 * one of that audit's JSON-LD blocks. Main writes that block from its own ready audit: pretty-printed
 * when it parsed, its text as kept otherwise. Any other block index copies nothing.
 */
export const SeoCopySchemaInputSchema = z.strictObject({ tabId: z.int().positive(), audit: SeoAuditRefSchema, block: z.int().nonnegative().max(L.maxJsonLdBlocks - 1) });
export type SeoCopySchemaInput = z.infer<typeof SeoCopySchemaInputSchema>;

/** `seo.setHighlight` input: the tab and the mode (`HIGHLIGHT_MODES`). */
export const SeoHighlightInputSchema = z.strictObject({ tabId: z.int().positive(), mode: z.enum(HIGHLIGHT_MODES) });
export type SeoHighlightInput = z.infer<typeof SeoHighlightInputSchema>;
