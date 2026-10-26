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
   * Nodes (elements and text) visited at most when reading one element's text (a heading, a
   * link's anchor, a title): a link wrapping a huge subtree costs no more than this.
   */
  maxElementTextVisits: 500,
  /** Text nodes the word count walks at most (it then reports `textTruncated`; it visits at most four times as many nodes in all). */
  maxTextNodes: 50_000,
  /** Characters of visible text the word count reads at most (then `textTruncated`). */
  maxTextScanChars: 1_000_000,
  /** A page's full counts (`…Total`, `CappedText.length`) above this are reported as this. */
  maxCount: 100_000_000,
} as const;

/** The caps' shape (numbers, so tests can run the extractor with smaller ones). */
export type SnapshotLimits = { readonly [K in keyof typeof SNAPSHOT_LIMITS]: number };
