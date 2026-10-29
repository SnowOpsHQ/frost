/**
 * The capture snapshot and its diff (Phase 6 Task 2; acceptance `changes-diff.feature.md`). Plain
 * values and types with no imports, so the chrome renderer and the pure diff engine
 * (`@app/change-intel`) can use them without bundling Zod (whose eval probe the app's strict Trusted
 * Types CSP blocks). The Zod schemas that enforce these shapes and caps are
 * `capture-snapshot.schema.ts` (main-only); each `satisfies` the interface here, so the two cannot
 * drift apart.
 *
 * A snapshot is what one capture keeps of a page: what it says to search engines (head, HTTP, the
 * audit's score and failing rules, structured data), its headings, links and text, each tagged
 * with the page region (ARIA landmark) it sits in. Main builds it from the tab's ready audit and a
 * region extraction run in `CAPTURE_WORLD_ID` (Task 3), validates it, and stores it as canonical
 * JSON. The page is untrusted, so every list and string has a cap here, applied while the page is
 * read and checked again by the schema.
 */

/** The snapshot format. A stored snapshot of another version is never diffed against this one. */
export const CAPTURE_SNAPSHOT_VERSION = 1;

/**
 * Where on the page a heading, link or text block sits: the nearest ancestor ARIA landmark
 * (`changes-diff.feature.md`, Regions). `other` is content outside every landmark on a page that has
 * a main landmark; on a page without one, that content counts as `main`.
 */
export const PAGE_REGIONS = ['main', 'nav', 'header', 'aside', 'footer', 'other'] as const;
export type PageRegion = (typeof PAGE_REGIONS)[number];

/**
 * The regions a diff groups its changes by, in display (and change) order: the page-wide parts first
 * (head tags, the HTTP response, structured data), then the page regions, then the audit (score,
 * failing rules and the page's link and image totals).
 */
export const DIFF_REGIONS = ['head', 'http', 'structured-data', 'main', 'nav', 'header', 'aside', 'footer', 'other', 'audit'] as const;
export type DiffRegion = (typeof DIFF_REGIONS)[number];

/** How the Changes panel names each diff region. */
export const DIFF_REGION_LABELS: Readonly<Record<DiffRegion, string>> = {
  head: 'Head',
  http: 'HTTP',
  'structured-data': 'Structured data',
  main: 'Main content',
  nav: 'Navigation',
  header: 'Header',
  aside: 'Sidebar',
  footer: 'Footer',
  other: 'Elsewhere on the page',
  audit: 'Audit',
};

/**
 * The isolated world the region extraction runs in (Phase 6 owns `1_600`–`1_602`; see
 * `seo-limits.spec.ts`' `SEO_WORLD_ID` for why a world of its own). Nothing the page defines reaches it.
 */
export const CAPTURE_WORLD_ID = 1_600;

/**
 * Caps on what a capture keeps. The extractor applies them while it reads the DOM (it stops a list at
 * its cap and cuts a string at its length, and says `partial` when its budget ran out); the schema
 * refuses anything over them, so a stored snapshot is always bounded.
 */
export const CAPTURE_LIMITS = {
  /** Headings kept (all regions together), in document order. */
  maxHeadings: 200,
  /** Longest heading text kept (normalised, then cut). */
  maxHeadingChars: 300,
  /** Links kept in the list (all regions together), in document order. The totals count every link. */
  maxLinks: 500,
  /** Longest anchor text and `rel` value kept. */
  maxAnchorChars: 200,
  /** Text blocks kept per region, in document order; past it the region is `truncated`. */
  maxBlocksPerRegion: 300,
  /** Longest text block kept (normalised, then cut). */
  maxBlockChars: 1_000,
  /** All of a region's kept blocks together; past it the region stops and is `truncated`. */
  maxRegionChars: 60_000,
  /**
   * The most of a region's text its `textHash` covers (UTF-16 units of the joined blocks; see
   * `CaptureRegionText`): four times what is kept, so an edit somewhat past the kept blocks still
   * changes the hash, while a huge page costs a bounded hash.
   */
  maxHashedRegionChars: 240_000,
  /** `hreflang` alternates kept. */
  maxHreflang: 50,
  /** JSON-LD blocks kept, in document order. */
  maxJsonLdBlocks: 20,
  /** Longest JSON-LD block text kept (the block's canonical JSON, cut). Its hash is of the whole block. */
  maxJsonLdBlockChars: 4_000,
  /** Structured-data types kept: the page's together, and each block's. */
  maxTypes: 100,
  /** Longest structured-data type name, and longest rule id in `audit.findings`. */
  maxTypeChars: 100,
  /** Failing rule ids kept (the rule catalog is far smaller; this is a backstop). */
  maxFindings: 200,
  /** Longest head value kept: title, meta description, robots meta, lang, viewport, Open Graph text, an `hreflang` code, `X-Robots-Tag`. */
  maxHeadChars: 2_000,
  /** Longest URL kept: the page, canonical, `og:image`, an `hreflang` target, a link `href`. */
  maxUrlChars: 2_048,
  /**
   * The extraction's one deadline, counted from its start. Each list read and the text walk check it
   * and stop there; whatever was read by then is answered with `partial: true`.
   */
  extractBudgetMs: 1_500,
  /** An extraction whose promise has not settled after this long is abandoned (no capture). */
  extractTimeoutMs: 5_000,
  /** Elements the text walk visits at most; past it the walk stops and the snapshot is `partial`. */
  maxNodeVisits: 50_000,
} as const;

/**
 * The diff engine's version, stored with each diff (`ci_diffs.engine_version`). Bumped whenever the
 * same pair of snapshots would diff differently, so a stored diff can be told from a fresh one.
 */
export const DIFF_ENGINE_VERSION = 1;

/**
 * Bounds on one diff (`changes-diff.feature.md`, Bounds). Every list alignment, pairing and inline
 * diff counts its work; past a bound the engine falls back to a cheaper, still correct answer, so a
 * diff of two snapshots at every cap finishes in tens of milliseconds.
 */
export const DIFF_LIMITS = {
  /**
   * The largest n×m one LCS may fill (after the common start and end of the two lists are taken off).
   * Over it, that list is compared as a multiset instead (order is ignored: an item is unchanged if
   * the other side has it too), and an inline diff answers "all deleted, all inserted".
   */
  maxLcsCells: 250_000,
  /**
   * All the work of one diff together: LCS cells, plus the tokens compared while pairing similar
   * blocks. Once spent, every further list is compared as a multiset, blocks stop being paired (they
   * are removed and added), and inline diffs answer "all deleted, all inserted". Regions are worked
   * in `DIFF_REGIONS` order, so the main content is never the part that loses detail first.
   */
  maxWorkCells: 2_000_000,
  /** Changes kept in a diff, in change order; past it the diff is `truncated` (the summary still counts all). */
  maxChanges: 500,
  /**
   * Inline diffs run on at most this many tokens (words, punctuation and the whitespace between them)
   * per side. Its square is `maxLcsCells`, so a side within it never needs more than one LCS's cells.
   */
  maxInlineWords: 500,
  /** A removed and an added text block are one edited block when their word sets' Jaccard index is at least this. */
  similarity: 0.5,
  /** Longest `context` of a text change (the nearest unchanged block before it), cut with `…`. */
  contextChars: 80,
  /** Longest `before` / `after` text of a change, cut with `…`. */
  maxChangeTextChars: 2_000,
} as const;

/**
 * What a change is about, in change order within a region. Head and HTTP fields are one value each;
 * `heading`, `link`, `text`, `hreflang`, `finding` and the structured-data ones are list items;
 * `words`, `links-total` and `images` are counts; `hidden-text` says a region's text hash changed
 * where no kept block did (before/after: the first 12 hex digits of each hash).
 */
export const DIFF_FIELDS = [
  'title',
  'meta-description',
  'canonical',
  'robots-meta',
  'lang',
  'viewport',
  'og-title',
  'og-description',
  'og-image',
  'hreflang',
  'status',
  'x-robots-tag',
  'indexable',
  'score',
  'finding',
  'heading',
  'link',
  'text',
  'words',
  'hidden-text',
  'structured-data-type',
  'structured-data-block',
  'images',
  'links-total',
] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

/** How the Changes panel names each field. */
export const DIFF_FIELD_LABELS: Readonly<Record<DiffField, string>> = {
  title: 'Title',
  'meta-description': 'Meta description',
  canonical: 'Canonical URL',
  'robots-meta': 'Robots meta',
  lang: 'Language',
  viewport: 'Viewport',
  'og-title': 'Open Graph title',
  'og-description': 'Open Graph description',
  'og-image': 'Open Graph image',
  hreflang: 'Hreflang',
  status: 'HTTP status',
  'x-robots-tag': 'X-Robots-Tag',
  indexable: 'Indexable',
  score: 'Score',
  finding: 'Failing check',
  heading: 'Heading',
  link: 'Link',
  text: 'Text',
  words: 'Word count',
  'hidden-text': 'Text past the kept blocks',
  'structured-data-type': 'Structured data type',
  'structured-data-block': 'Structured data block',
  images: 'Images',
  'links-total': 'Links',
};

/** A change adds something the older version did not have, removes something it had, or changes it. */
export const CHANGE_KINDS = ['added', 'removed', 'changed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The counters a `links-total` or `images` change names in its `context`. */
export const TOTAL_COUNTERS = ['total', 'internal', 'external', 'nofollow', 'missing-alt'] as const;
export type TotalCounter = (typeof TOTAL_COUNTERS)[number];

// ---- Shapes (mirrored by the Zod schemas in `capture-snapshot.schema.ts`) ----------------------

/** One `<link rel=alternate hreflang>`: its code as written and its resolved target. */
export interface HreflangEntry {
  hreflang: string;
  href: string;
}

/** A visible `h1`…`h6`, its normalised text and its region. */
export interface CaptureHeading {
  level: number;
  text: string;
  region: PageRegion;
}

/** A link of the page: resolved `href`, anchor text, `rel` tokens (lowercased) and its region. */
export interface CaptureLink {
  href: string;
  text: string;
  rel: string;
  region: PageRegion;
}

/** One JSON-LD block: its types (sorted, unique), the SHA-256 of its whole canonical JSON, and that JSON cut to `maxJsonLdBlockChars`. */
export interface CaptureJsonLdBlock {
  types: string[];
  hash: string;
  text: string;
}

/**
 * One region's text: its word count (every word the walk reached, also past the caps), its text hash,
 * its blocks, and whether the blocks stop short of the text the walk reached (a cap, or the deadline).
 *
 * Text is normalised by the extractor before anything else sees it: lone surrogates replaced with
 * U+FFFD, Unicode NFC, whitespace runs collapsed to one space, trimmed; empty blocks are dropped. A block is cut to `maxBlockChars`, and
 * blocks are kept until `maxBlocksPerRegion` or `maxRegionChars` (the block that would cross it is
 * not kept).
 *
 * `textHash` is the lowercase hex SHA-256 of the UTF-8 bytes of H, where H is every normalised block
 * the walk reached in the region, uncut and in document order, joined with `\n`, and then cut to its
 * first `maxHashedRegionChars` UTF-16 units (a final lone high surrogate dropped). When `truncated`
 * is false, H is exactly `blocks.join('\n')`; an empty region hashes the empty string.
 */
export interface CaptureRegionText {
  words: number;
  textHash: string;
  blocks: string[];
  truncated: boolean;
}

/** A capture snapshot, version `CAPTURE_SNAPSHOT_VERSION` (field by field: `changes-diff.feature.md`, The snapshot). */
export interface CaptureSnapshot {
  version: typeof CAPTURE_SNAPSHOT_VERSION;
  url: string;
  /** When the audit it was built from was taken (Unix ms). Not part of the version's identity (`changes-diff.feature.md`, Identity). */
  takenAt: number;
  partial: boolean;
  http: { status: number | null; xRobotsTag: string | null; indexable: boolean };
  head: {
    title: string | null;
    metaDescription: string | null;
    canonical: string | null;
    robotsMeta: string | null;
    lang: string | null;
    viewport: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    hreflang: HreflangEntry[];
  };
  /** The failing rules' ids (sorted, unique) and their health score, of the rules that read the page itself (`changes.spec.ts`, `CAPTURE_EXCLUDED_RULES`). */
  audit: { score: number; findings: string[] };
  /** The page's structured-data types (sorted, unique) and its JSON-LD blocks. */
  structuredData: { types: string[]; blocks: CaptureJsonLdBlock[] };
  headings: CaptureHeading[];
  links: { total: number; internal: number; external: number; nofollow: number; list: CaptureLink[] };
  images: { total: number; missingAlt: number };
  regions: Record<PageRegion, CaptureRegionText>;
}

/** A piece of an inline (word-level) diff: text both sides share, text only the old side had, or text only the new side has. */
export interface InlineSegment {
  op: 'same' | 'del' | 'ins';
  text: string;
}

/**
 * One change between two snapshots. `before` is `null` for `added`, `after` is `null` for
 * `removed`. `context` locates it (`changes-diff.feature.md`, How each part is compared); `segments`
 * are only on an edited text block.
 */
export interface Change {
  region: DiffRegion;
  field: DiffField;
  kind: ChangeKind;
  before: string | null;
  after: string | null;
  context: string | null;
  segments?: InlineSegment[];
}

/** Counts of each kind of change in one region. */
export interface ChangeCounts {
  added: number;
  removed: number;
  changed: number;
}

/**
 * The diff of two snapshots: the changes (at most `maxChanges`, in change order), counts per region
 * of every change found (also those past the cap), how many there were, whether `changes` stops
 * short of them, and whether either side is `partial` or has a `truncated` region (so the diff may
 * miss changes, and does not report removals it cannot be sure of).
 */
export interface SnapshotDiff {
  engine: number;
  changes: Change[];
  summary: Record<DiffRegion, ChangeCounts>;
  changeCount: number;
  truncated: boolean;
  partial: boolean;
}
