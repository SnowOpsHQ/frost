/**
 * Page type (Phase 9 Task 8, Decision 14; acceptance `page-type.feature.md`). What kind of page this
 * is (`PAGE_TYPES`), worked out **on this device** by `@app/seo-core` (`audit.pageType`,
 * `page-type/index.ts`) in the analysis worker, from the rendered page's existing snapshot only: no
 * extractor change, no snapshot-schema change, no request, no model. It is always on and sends
 * nothing anywhere. It is a fact shown on the Overview's "Page" card, never a rule of
 * `SEO_RULE_SPECS`: the health score never reads it.
 *
 * ## Signals (`PAGE_TYPE_SIGNALS`, in priority order)
 * - `schema-type`: the first top-level JSON-LD entity (in page order) with a type in
 *   `PAGE_TYPE_SCHEMA_MAP` (schema.org types shortened to the term, `https://schema.org/Article` is
 *   `Article`); its first such type decides.
 * - `og-type`: the page's `og:type` (trimmed, lowercased) in `PAGE_TYPE_OG_MAP`. `website`, every
 *   page's default, says nothing.
 * - `url-path`: the URL's path against `PAGE_TYPE_PATH_HINTS` (see there). The deepest matching
 *   segment decides (`/blog/tag/seo` is a tag listing, not a post).
 * - `structure`: counts the snapshot already has (`PAGE_TYPE_STRUCTURE`): the headings of one level,
 *   the internal links, the word count. Only `listing` is read from structure: long text alone does
 *   not tell an article from documentation.
 *
 * ## The type and its confidence (`PAGE_TYPE_CONFIDENCE`)
The highest-priority signal decides the type (structured data wins), and:
- `high`: two or more signals, all naming the same type;
- `low`: one signal;
- `unsure`: no signal (the type is `other`) or signals naming different types (a conflict).

The root path (`/` → `home`) is an ordinary `url-path` signal under the same rule. No structured
data type or Open Graph type names a home page today, so the root alone is `home` at `low`, and a
root whose structured data or structure names another type (a front page marked `CollectionPage`,
say) is a conflict: that type, `unsure`, with both signals shown.
 *
 * It is frost's heuristic: landing pages in particular are often mislabelled, so `unsure` is said
 * plainly rather than hidden. Every label, map and threshold here is frost's own.
 *
 * Plain values, Zod-free: the chrome renderer imports them.
 */

export const PAGE_TYPES = ['home', 'article', 'product', 'listing', 'documentation', 'contact', 'landing', 'other'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_TYPE_LABELS: Readonly<Record<PageType, string>> = {
  home: 'Home page',
  article: 'Article',
  product: 'Product',
  listing: 'Listing',
  documentation: 'Documentation',
  contact: 'Contact',
  landing: 'Landing page',
  other: 'Other',
};

/** What a page type is read from, in priority order. */
export const PAGE_TYPE_SIGNALS = ['schema-type', 'og-type', 'url-path', 'structure'] as const;
export type PageTypeSignal = (typeof PAGE_TYPE_SIGNALS)[number];

export const PAGE_TYPE_SIGNAL_LABELS: Readonly<Record<PageTypeSignal, string>> = {
  'schema-type': 'Structured data',
  'og-type': 'Open Graph type',
  'url-path': 'URL path',
  structure: 'Page structure',
};

/** schema.org types (shortened to the term) and the page type each names. */
export const PAGE_TYPE_SCHEMA_MAP: Readonly<Record<string, PageType>> = {
  Article: 'article',
  BlogPosting: 'article',
  NewsArticle: 'article',
  Report: 'article',
  ScholarlyArticle: 'article',
  TechArticle: 'documentation',
  APIReference: 'documentation',
  Product: 'product',
  ProductGroup: 'product',
  CollectionPage: 'listing',
  ItemList: 'listing',
  SearchResultsPage: 'listing',
  ContactPage: 'contact',
};

/** `og:type` values (lowercased) and the page type each names. */
export const PAGE_TYPE_OG_MAP: Readonly<Record<string, PageType>> = {
  article: 'article',
  product: 'product',
  'product.item': 'product',
  'product.group': 'product',
};

/**
 * How a path hint matches the URL's path segments (lowercased; a trailing `.html`, `.htm`, `.php`,
 * `.asp` or `.aspx` is ignored):
 * - `root`: the path is `/` with no query (`segment` is empty);
 * - `below`: a segment is `segment` and at least one segment follows it (`/blog/a-post`, not `/blog/`);
 * - `segment`: a segment is `segment`, anywhere (`/contact`, `/en/contact-us`).
 */
export const PAGE_TYPE_PATH_MATCHES = ['root', 'below', 'segment'] as const;
export type PageTypePathMatch = (typeof PAGE_TYPE_PATH_MATCHES)[number];

export interface PageTypePathHint {
  readonly segment: string;
  readonly type: PageType;
  readonly match: PageTypePathMatch;
}

/** The URL path hints (`/` is `home`; a page under `/blog/` is an `article` …). */
export const PAGE_TYPE_PATH_HINTS: readonly PageTypePathHint[] = [
  { segment: '', type: 'home', match: 'root' },
  { segment: 'blog', type: 'article', match: 'below' },
  { segment: 'news', type: 'article', match: 'below' },
  { segment: 'articles', type: 'article', match: 'below' },
  { segment: 'posts', type: 'article', match: 'below' },
  { segment: 'post', type: 'article', match: 'below' },
  { segment: 'docs', type: 'documentation', match: 'below' },
  { segment: 'documentation', type: 'documentation', match: 'below' },
  { segment: 'reference', type: 'documentation', match: 'below' },
  { segment: 'help', type: 'documentation', match: 'below' },
  { segment: 'product', type: 'product', match: 'below' },
  { segment: 'products', type: 'product', match: 'below' },
  { segment: 'category', type: 'listing', match: 'segment' },
  { segment: 'categories', type: 'listing', match: 'segment' },
  { segment: 'collections', type: 'listing', match: 'segment' },
  { segment: 'tag', type: 'listing', match: 'segment' },
  { segment: 'tags', type: 'listing', match: 'segment' },
  { segment: 'search', type: 'listing', match: 'segment' },
  { segment: 'contact', type: 'contact', match: 'segment' },
  { segment: 'contact-us', type: 'contact', match: 'segment' },
  { segment: 'pricing', type: 'landing', match: 'segment' },
  { segment: 'lp', type: 'landing', match: 'below' },
  { segment: 'landing', type: 'landing', match: 'below' },
];

/**
 * The structure signal, from fields `PageSnapshot` already has (the headings list, the links list,
 * the word count and the heading total): a page is a `listing` when
 * - one heading level below H1 has at least `minSameLevelHeadings` headings (in the snapshot's list),
 * - at least `minInternalLinks` of its links (in the snapshot's list) are internal, and
 * - it has at most `maxWordsPerHeading` words per heading (`wordCount / headingTotal`): many short
 *   entries rather than prose.
 */
export const PAGE_TYPE_STRUCTURE = {
  listing: { minSameLevelHeadings: 6, minInternalLinks: 30, maxWordsPerHeading: 80 },
} as const;

export const PAGE_TYPE_CONFIDENCE = ['high', 'low', 'unsure'] as const;
export type PageTypeConfidence = (typeof PAGE_TYPE_CONFIDENCE)[number];

export const PAGE_TYPE_CONFIDENCE_LABELS: Readonly<Record<PageTypeConfidence, string>> = {
  high: 'Likely',
  low: 'Possibly',
  unsure: 'Unsure',
};

/** What the Overview's "Page" card says (frost's own words). */
export const PAGE_TYPE_COPY = {
  title: 'Page',
  signalsLabel: 'Signals',
  noSignals: 'No signal: no structured data type, Open Graph type, URL path or structure frost recognises.',
  conflict: 'The signals disagree, so frost is unsure.',
  note: 'Worked out on this device from the page’s structured data, Open Graph type, URL and structure. frost’s heuristic: it can be wrong, and it never changes the health score.',
  intentLabel: 'Target query intent',
  noTarget: 'No target query: set one in the Content panel to see its intent.',
  intentOff: 'On-device intent is off: enable it in the Visibility panel to see the target query’s intent.',
  intentUnavailable: 'On-device intent could not classify the target query right now.',
} as const;
