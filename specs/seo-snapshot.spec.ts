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
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS as L, SOCIAL_TAGS, SOCIAL_URL_TAGS, type SocialTag } from './seo-limits.spec';
import { HIGHLIGHT_MODES, LINK_FILTER_QUERY_MAX_CHARS, LINK_REL_FILTERS, LINK_TYPE_FILTERS } from './seo-sidebar.spec';
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
 *   `maxJsonLdTotalChars`; `microdata` / `rdfa`: the markup items (`MarkupItemSchema`), with
 *   `microdataTotal` / `rdfaTotal` the items the page has (Task 3).
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
    jsonLd: z.array(JsonLdBlockSchema).max(L.maxJsonLdBlocks),
    jsonLdTotal: count,
    microdata: markupItems,
    microdataTotal: count,
    rdfa: markupItems,
    rdfaTotal: count,
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
      s.rdfaTotal >= s.rdfa.length,
    { message: 'a total is below its list' },
  )
  .refine((s) => s.jsonLd.reduce((sum, block) => sum + block.text.length, 0) <= L.maxJsonLdTotalChars, { message: 'JSON-LD over its total cap' });
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
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
