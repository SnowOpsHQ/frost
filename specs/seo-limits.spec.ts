/**
 * SEO extraction limits (Phase 2 Task 1; acceptance: `seo-sidebar.feature.md`, `seo-rules.feature.md`).
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod (whose
 * eval probe the app's strict Trusted Types CSP blocks). The snapshot's Zod schema that enforces
 * them is `seo-snapshot.spec.ts`, which re-exports this module.
 *
 * The page is untrusted: the extractor (`apps/desktop/src/main/seo/extract.ts`) applies every cap
 * itself while it reads the DOM, and main validates the result against the same caps. Anything
 * over a cap, of the wrong shape, or late is an "audit unavailable", never a crash or a stall.
 */

/**
 * The isolated world the extractor runs in (`webContents.executeJavaScriptInIsolatedWorld`).
 * Electron reserves `0` (the page's main world) and `999` (its own `contextIsolation` world, unused
 * in tabs: they have no preload); the id must be in `1…536870911`. frost's SEO scripts use only
 * this one, so the page's scripts, globals and prototype changes never reach them.
 */
export const SEO_WORLD_ID = 1_207;

/** A run whose promise has not settled after this long is abandoned: "audit unavailable" (`timeout`). */
export const EXTRACT_TIMEOUT_MS = 3_000;

/**
 * The extractor's one deadline, counted from its start: every list read (`firstOf`), every
 * element-text read and the word-count walk check it, and stop there. Whatever was read by then
 * is answered with `partial: true` (and `textTruncated` if the word count was cut). Well below
 * `EXTRACT_TIMEOUT_MS`, so a huge DOM gives a partial result, not a timeout.
 */
export const EXTRACT_BUDGET_MS = 1_500;

/**
 * Everything derived from the page (the snapshot's Zod parse and `runAudit`, the structured-data
 * analysis included) runs in one long-lived `worker_threads` Worker spawned by main, never on the
 * Electron main thread (`apps/desktop/src/main/seo/analysis.ts`; acceptance `seo-schema.feature.md`,
 * Analysis off the main thread). The worker has no Electron APIs and receives only the extractor's
 * answer. An analysis not answered within this long is abandoned: the worker is terminated, that
 * audit is "unavailable" (`analysis-timeout`), and a fresh worker is spawned for the next one.
 */
export const ANALYSIS_TIMEOUT_MS = 2_000;

/**
 * Page events (`did-finish-load`, a main-frame `did-navigate-in-page` that changes more than the
 * `#fragment`) start an audit of the active tab only after this long without another one: a burst
 * of SPA route changes audits once. A burst that never pauses (a `replaceState` storm) still audits
 * once `AUDIT_MAX_WAIT_MS` has passed since its first event.
 */
export const AUDIT_DEBOUNCE_MS = 500;
export const AUDIT_MAX_WAIT_MS = 2_000;

/**
 * Robots meta tags read: the generic `robots` and these crawler-specific ones (`<meta name>` matched
 * case-insensitively; the snapshot keeps the lowercased name with each value).
 */
export const ROBOTS_META_NAMES = ['robots', 'googlebot', 'googlebot-news', 'bingbot'] as const;
export type RobotsMetaName = (typeof ROBOTS_META_NAMES)[number];

/**
 * The social sharing tags read (Phase 2 Task 2): Open Graph properties and Twitter card fields.
 * Each is the first `<meta>` whose `property` **or** `name` attribute is the tag
 * (case-insensitive; sites use both for either family), its `content` trimmed and
 * whitespace-normalised. `og:url` is not in this list: it is the snapshot's own `ogUrl`
 * (Task 1), read the same way from `property` only.
 */
export const SOCIAL_TAGS = [
  'og:title',
  'og:description',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:type',
  'og:site_name',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
  'twitter:site',
] as const;
export type SocialTag = (typeof SOCIAL_TAGS)[number];
/** The social tags whose value is a URL (cut to `maxUrlChars`, not normalised). */
export const SOCIAL_URL_TAGS = ['og:image', 'twitter:image'] as const satisfies readonly SocialTag[];

/**
 * Highlight mode (Phase 2 Task 2; acceptance `seo-panels.feature.md`, Highlight): the overlay
 * script runs in the same isolated world as the extractor (`SEO_WORLD_ID`) and draws at most
 * `maxLinks` link boxes or `maxHeadings` heading boxes (the snapshot's caps). A drawing pass
 * measures the elements a slice at a time, at most `HIGHLIGHT_FRAME_MS` per animation frame, and
 * gives up measuring after `HIGHLIGHT_BUDGET_MS` in all (it draws what it measured). Boxes follow
 * layout changes (a `ResizeObserver`, whose first, initial callback is skipped, and the window's
 * `resize`) and scrolling (a passive capture-phase `scroll` listener on the document, so inner
 * scroll containers and fixed elements are followed too): requests while a pass runs coalesce into
 * one more pass after it, never more than one pass per frame. A redraw reuses the box elements and
 * only writes what moved.
 */
export const HIGHLIGHT_BUDGET_MS = 500;
export const HIGHLIGHT_FRAME_MS = 8;

/**
 * Caps on the snapshot. Lists keep their **first** `max…` entries in document order and report the
 * page's full count beside them (`…Total`); strings keep their first `max…Chars` characters and,
 * where a rule measures the value, its full length too (`CappedText.length`).
 */
export const SNAPSHOT_LIMITS = {
  /** `document.URL`, every resolved `href` / `src`, and canonical / `og:url` values. */
  maxUrlChars: 2_048,
  /** `<title>` and meta description text kept (their full length is reported separately). */
  maxTextChars: 1_024,
  /** `<title>` elements, `meta[name=description]`, robots metas (all names together), `link[rel=canonical]` kept. */
  maxRepeated: 8,
  /** Meta robots / viewport `content`, `rel` values. */
  maxAttributeChars: 256,
  /** `<html lang>`. */
  maxLangChars: 64,
  /** Headings (`h1`…`h6`) kept, in document order. */
  maxHeadings: 300,
  /** Characters of each heading's text kept. */
  maxHeadingChars: 300,
  /**
   * Hidden headings kept apart (`hiddenHeadings`, Phase 2.5 Task 2 review), in document order: the
   * served-HTML comparison counts them with the shown ones, as the served HTML has no layout.
   */
  maxHiddenHeadings: 50,
  /** Links (`a[href]`, `area[href]`) kept, in document order. */
  maxLinks: 1_000,
  /** Characters of each link's anchor text kept. */
  maxAnchorChars: 200,
  /** Images (`img`) kept, in document order. */
  maxImages: 500,
  /** Characters of each image's `alt` kept (its full length is reported separately). */
  maxAltChars: 500,
  /** `width` / `height` / `loading` attribute values of an image. */
  maxImageAttributeChars: 32,
  /**
   * An image's rendered and natural sizes (CSS px, integers) are reported up to this; a larger
   * value is reported as this (Phase 2 Task 2).
   */
  maxImagePixels: 100_000,
  /** A link's `target` attribute value (Phase 2 Task 2). */
  maxTargetChars: 64,
  /** An image's `srcset` (its own, and each `<picture><source>`'s) is read up to this many characters … */
  maxSrcsetChars: 4_096,
  /** … and up to this many candidates each. */
  maxSrcsetCandidates: 32,
  /** `<source>` elements of an image's `<picture>` looked at. */
  maxPictureSources: 8,
  /**
   * Stylesheet rules scanned, once per extraction, for ones that declare both `width` and `height`
   * (same-origin sheets only; nested `@media` / `@supports` / `@layer` rules count), and how many
   * such rules' selectors are kept to match images against (`ImageSchema.cssSized`).
   */
  maxSizingRules: 5_000,
  maxSizingSelectors: 100,
  /**
   * Text values of the social tags (`SOCIAL_TAGS`: titles, descriptions, types, names, sizes);
   * their URL values (`SOCIAL_URL_TAGS`) are cut to `maxUrlChars` instead (Phase 2 Task 2).
   */
  maxSocialChars: 1_024,
  /**
   * Nodes (elements and text) visited at most when reading one element's text (a heading, a
   * link's anchor, a title): a link wrapping a huge subtree costs no more than this.
   */
  maxElementTextVisits: 500,
  /**
   * Structured data (Phase 2 Task 3; `seo-schema.feature.md`). JSON-LD blocks
   * (`script[type="application/ld+json"]`, the type matched case-insensitively) kept, in document
   * order. Their text is only ever read here, never parsed: main parses it (`@app/seo-core`).
   */
  maxJsonLdBlocks: 32,
  /** UTF-16 code units of one block's text kept; its full length is reported beside it (a cut block is not parsed). */
  maxJsonLdChars: 131_072,
  /** Code units of JSON-LD kept across all blocks: once used up, later blocks are kept empty (with their full length). */
  maxJsonLdTotalChars: 524_288,
  /** Microdata items (`[itemscope]`) and, separately, RDFa items (`[typeof]`) kept, in document order. */
  maxMarkupItems: 300,
  /** Elements with `itemscope` or `itemprop` (and, separately, `typeof` or `property`) looked at. */
  maxMarkupElements: 10_000,
  /** Properties kept per item. */
  maxItemProperties: 64,
  /** How deep items nest: a top-level item is depth 0; items deeper than this (and what they hold) are dropped. */
  maxMarkupDepth: 12,
  /** Types (`itemtype` / `typeof` tokens) kept per item, and property names per element. */
  maxItemTypes: 8,
  /** Characters of an item type, a property name or a vocabulary. */
  maxSchemaNameChars: 256,
  /** Characters of a property value (text, or a resolved URL) and of an item id. */
  maxSchemaValueChars: 2_048,
  /**
   * Characters of property values kept across all microdata and RDFa items together: once used up,
   * later values are kept empty (so a page of long values costs no more than this, however many items).
   */
  maxMarkupTotalChars: 262_144,
  /**
   * hreflang annotations (Phase 2 Task 4): `<link rel~="alternate" hreflang>` elements in `<head>`
   * kept, in document order, and the characters of each `hreflang` value kept.
   */
  maxHreflang: 300,
  maxHreflangChars: 64,
  /** Text nodes the word count walks at most (it then reports `textTruncated`; it visits at most four times as many nodes in all). */
  maxTextNodes: 50_000,
  /** Characters of visible text the word count reads at most (then `textTruncated`). */
  maxTextScanChars: 1_000_000,
  /** A page's full counts (`…Total`, `CappedText.length`) above this are reported as this. */
  maxCount: 100_000_000,
} as const;

/** The caps' shape (numbers, so tests can run the extractor with smaller ones). */
export type SnapshotLimits = { readonly [K in keyof typeof SNAPSHOT_LIMITS]: number };
