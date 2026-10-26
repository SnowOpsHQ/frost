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
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS as L } from './seo-limits.spec';
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
 * Where a link goes: `internal` (an `http(s)` URL on the page's host, `www.` ignored), `external`
 * (any other `http(s)` URL), or `other` (`javascript:`, `mailto:`, `tel:` … or an `href` that does
 * not resolve).
 */
export const LINK_KINDS = ['internal', 'external', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * `a[href]` / `area[href]`, in document order: `href` resolved against the document (`''` if it
 * does not parse), its `scheme` (lowercased `URL.protocol`, `''` if none), `rel` (lowercased,
 * whitespace-normalised tokens), and the anchor text: its text content, else `aria-label`, else the
 * `alt` of an image inside it, else `title` (normalised, capped; `''` when there is none).
 */
export const LinkSchema = z.strictObject({
  href: urlText,
  scheme: z.string().max(32),
  rel: attribute,
  text: z.string().max(L.maxAnchorChars),
  kind: z.enum(LINK_KINDS),
});

/**
 * `img`, in document order: `src` resolved (`currentSrc` if set; `''` if none), its `alt` (`null`
 * when the attribute is absent; `alt=""` marks a decorative image), and the `width`, `height` and
 * `loading` attributes as written (`null` when absent).
 */
export const ImageSchema = z.strictObject({
  src: urlText,
  alt: cappedText(L.maxAltChars).nullable(),
  width: z.string().max(L.maxImageAttributeChars).nullable(),
  height: z.string().max(L.maxImageAttributeChars).nullable(),
  loading: z.string().max(L.maxImageAttributeChars).nullable(),
});

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
  })
  .refine(
    (s) =>
      s.titleTotal >= s.titles.length &&
      s.metaDescriptionTotal >= s.metaDescriptions.length &&
      s.canonicalTotal >= s.canonicals.length &&
      s.headingTotal >= s.headings.length &&
      s.linkTotal >= s.links.length &&
      s.imageTotal >= s.images.length,
    { message: 'a total is below its list' },
  );
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
export type PageLink = z.infer<typeof LinkSchema>;
export type PageImage = z.infer<typeof ImageSchema>;
export type PageHeading = z.infer<typeof HeadingSchema>;
export type RobotsMeta = z.infer<typeof RobotsMetaSchema>;
export type CappedText = PageSnapshot['titles'][number];

/** `seo.getAudit` / `seo.rerun` input: a tab's id (as `browser.closeTab`'s `TabIdInputSchema`). */
export const SeoTabInputSchema = z.strictObject({ tabId: z.int().positive() });
export type SeoTabInput = z.infer<typeof SeoTabInputSchema>;
