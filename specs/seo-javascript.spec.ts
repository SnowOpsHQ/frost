/**
 * Served HTML vs the rendered DOM (Phase 2.5 Task 2; acceptance `seo-javascript.feature.md`).
 * Main fetches the page's URL as the server sends it (through the bounded fetcher,
 * `fetcher.spec.ts`), the analysis worker parses it with a spec-compliant HTML parser (`parse5`)
 * into a served snapshot, and the audit compares it field by field with the rendered snapshot the
 * extractor read from the live DOM. The JavaScript panel shows the difference, a verdict and the
 * `javascript` rules.
 *
 * Plain values with type-only imports, so the chrome renderer can use them without bundling Zod.
 * The Zod schemas of the served snapshot and its states are `seo-javascript.schema.ts` (validated in
 * the analysis worker).
 *
 * Clean-room: the thresholds, wording and verdicts are frost's own, written from how search engines
 * describe crawling and rendering (a first pass over the HTML as served; JavaScript rendering, when
 * it happens, later).
 */
import type { SeoRuleSpec } from './seo-rules.spec';

// ---- Fetching ----------------------------------------------------------------------------------

/**
 * The served-HTML fetch: the audited page's URL (without its `#fragment`), `GET`, through the bounded
 * fetcher's rules (browse session, cookies omitted, no referrer, http(s) only, private hosts only
 * for a private page, per-origin rate limit), with these caps:
 * - `maxBytes`: about 5 MB of body is read; a longer page is compared on what was read (`partial`);
 * - `timeoutMs`: 10 s for the whole fetch (the origin's queue, redirects and body included);
 * - `maxRedirects`: as robots.txt.
 *
 * The user agent is the tab's render profile's (`render-profile.spec.ts`, `profileUserAgent`) when
 * the tab has one, else frost's own (the browse session's). The page is never fetched for a
 * non-`http(s)` URL or a tab showing its load-error or crash panel (no audit runs there).
 *
 * The answer is kept per URL and user agent for the tab's document (a new document, a reload
 * included, fetches again; an SPA route is another URL), at most `maxCachedPerTab` per tab, and Clear
 * Browsing Data forgets them all. "Fetch again" (`javascript.refetchServed`) drops the tab's answer
 * for its current URL and audits it again.
 *
 * The audit never waits for it: it is a later input of the page's context (`context-source.ts`),
 * `pending` until it settles, then the page is analysed again (`CONTEXT_TIMEOUT_MS` covers
 * `timeoutMs` and the parse).
 */
export const SERVED_FETCH_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 5,
  maxCachedPerTab: 8,
} as const;

/** The `Accept` header of the served fetch (what a browser's navigation sends, in short). */
export const SERVED_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' as const;

/** Media types parsed as HTML (`Content-Type` without parameters, lowercased). A response without a `Content-Type` is parsed too. */
export const SERVED_HTML_TYPES = ['text/html', 'application/xhtml+xml'] as const;

// ---- Parsing (in the analysis worker) ------------------------------------------------------------

/**
 * The served HTML is decoded and parsed in the analysis worker, never on main's thread:
 * - decoding: a byte order mark, else the `Content-Type` `charset`, else a `<meta charset>` /
 *   `<meta http-equiv="Content-Type">` in the first `prescanBytes` bytes, else UTF-8; an encoding
 *   label the runtime does not know is UTF-8;
 * - parsing: `parse5` (the WHATWG HTML parsing algorithm, scripting enabled, as in the browser that
 *   rendered the page, so `<noscript>` holds text and the head is built as the browser built it;
 *   scripting disabled when the tab's render profile turns JavaScript off, as that browser did);
 * - bounds: at most `maxNodes` nodes (elements, text and comments) are created and at most
 *   `maxDepth` levels deep, `<template>` contents counted at their template's depth: past either,
 *   parsing stops and what was built is read (`partial`). At most `maxAttributes` attributes of a
 *   tag are kept (the tokenizer drops the rest, so a tag with a million attributes costs no more
 *   than one with `maxAttributes`). The job runs in a worker of its own (main's served analyzer, not
 *   the audits'), with `timeoutMs` (`parse-timeout`): a hostile page that is ended there never
 *   restarts the audits' worker. `<noscript>` text is parsed as a fragment within the same node budget.
 */
export const SERVED_PARSE_LIMITS = {
  maxNodes: 200_000,
  maxDepth: 512,
  prescanBytes: 1_024,
  /** Characters of one `<noscript>`'s text parsed for its words and links. */
  maxNoscriptChars: 100_000,
  /** Attributes kept per tag. */
  maxAttributes: 256,
  /** The served parse's own deadline in its worker. */
  timeoutMs: 1_500,
} as const;

// ---- The comparison's states ------------------------------------------------------------------------

/**
 * Why there is no served snapshot to compare with:
 * - `not-fetched`: nothing was fetched for this audit (no fetcher, or a page frost does not fetch);
 * - `http-status`: the server answered frost's fetch with a non-2xx status (`httpStatus`);
 * - `not-html`: the answer is not HTML (`SERVED_HTML_TYPES`);
 * - `redirected`: the fetch ended at another URL than the page (its fragment aside): a login page
 *   for a fetch without cookies, another locale, … The rendered page is not that page, so nothing is
 *   compared and no rule is checked; the panel shows where it ended (`finalUrl`);
 * - `private-address`, `private-redirect`, `too-many-redirects`, `bad-redirect`, `no-location`,
 *   `unreachable`, `timeout`, `busy`: the fetch ended so (`fetcher.spec.ts`, `FETCH_OUTCOMES`);
 * - `parse-timeout`, `parse-failed`: the worker did not parse it in time, or failed;
 * - `invalid`: the served snapshot did not validate.
 */
export const SERVED_UNAVAILABLE_REASONS = [
  'not-fetched',
  'http-status',
  'not-html',
  'redirected',
  'private-address',
  'private-redirect',
  'too-many-redirects',
  'bad-redirect',
  'no-location',
  'unreachable',
  'timeout',
  'busy',
  'parse-timeout',
  'parse-failed',
  'invalid',
] as const;
export type ServedUnavailableReason = (typeof SERVED_UNAVAILABLE_REASONS)[number];

/** What the panel says for each reason (frost's own strings; `{status}` is the HTTP status). */
export const SERVED_UNAVAILABLE_MESSAGES: Readonly<Record<ServedUnavailableReason, string>> = {
  'not-fetched': 'frost did not fetch the served HTML for this page.',
  'http-status': 'The server answered frost’s fetch with HTTP {status}, so there is no served page to compare.',
  'not-html': 'The server did not answer frost’s fetch with an HTML page.',
  redirected: 'The server sent frost’s fetch (without cookies) to another address, so the served page is not the one shown here.',
  'private-address': 'The page is on a private address, which frost does not fetch for a public page.',
  'private-redirect': 'The server redirected frost’s fetch to a private address, which frost does not follow.',
  'too-many-redirects': 'The server redirected frost’s fetch too many times.',
  'bad-redirect': 'The server redirected frost’s fetch to an address that is not a web page.',
  'no-location': 'The server answered frost’s fetch with a redirect that has no destination.',
  unreachable: 'frost could not connect to the server to fetch the served HTML.',
  timeout: 'The server took too long to send the served HTML.',
  busy: 'frost has too many requests waiting for this site. Try again in a moment.',
  'parse-timeout': 'The served HTML took too long to read. It may be very large or deeply nested.',
  'parse-failed': 'frost could not read the served HTML.',
  invalid: 'The served HTML gave data frost could not read safely.',
};

/** The reasons "Fetch again" may fix (the others need the site or the page to change). */
export const SERVED_RETRYABLE_REASONS = ['unreachable', 'timeout', 'busy', 'parse-timeout', 'parse-failed', 'http-status'] as const satisfies readonly ServedUnavailableReason[];

/**
 * The JavaScript panel's states (`JavascriptReport.status`):
 * - `pending`: the served HTML is still being fetched or parsed;
 * - `unavailable`: there is none to compare (`SERVED_UNAVAILABLE_REASONS`);
 * - `identical`: every compared field is the same and no list gained or lost an entry;
 * - `ready`: the comparison, with its differences.
 */
export const JAVASCRIPT_STATES = ['pending', 'unavailable', 'identical', 'ready'] as const;
export type JavascriptState = (typeof JAVASCRIPT_STATES)[number];

// ---- The comparison -------------------------------------------------------------------------------------

/**
 * The fields compared, in the panel's order. Each is read the same way from both snapshots (the
 * served one has no layout, so it cannot tell hidden elements apart: its headings include hidden
 * ones, and its word count skips only `[hidden]` subtrees, not CSS-hidden ones):
 * - `title`: every `<title>`'s text; `meta-description`: every meta description;
 * - `robots`: every robots meta (generic and crawler-specific) as `name: content`, as a set;
 * - `canonical`: every canonical, resolved; `og-url`; `lang`; `viewport`;
 * - `h1`: every `<h1>`'s text; `hreflang`: every head hreflang link as `code → URL`, as a set;
 * - `word-count`: words in the body's text (as the rendered snapshot counts them);
 * - `links`, `headings`, `images`, `structured-data`: how many of each (JSON-LD blocks).
 */
export const JS_FIELDS = ['title', 'meta-description', 'robots', 'canonical', 'og-url', 'lang', 'viewport', 'h1', 'hreflang', 'word-count', 'links', 'headings', 'images', 'structured-data'] as const;
export type JsFieldId = (typeof JS_FIELDS)[number];
export const JS_FIELD_LABELS: Readonly<Record<JsFieldId, string>> = {
  title: 'Title',
  'meta-description': 'Meta description',
  robots: 'Robots meta',
  canonical: 'Canonical',
  'og-url': 'og:url',
  lang: 'Language',
  viewport: 'Viewport',
  h1: 'H1',
  hreflang: 'hreflang',
  'word-count': 'Word count',
  links: 'Links',
  headings: 'Headings',
  images: 'Images',
  'structured-data': 'JSON-LD blocks',
};
/** The fields whose change makes a page at least partly JavaScript-dependent (`JS_VERDICT_THRESHOLDS`). */
export const JS_KEY_FIELDS = ['title', 'meta-description', 'robots', 'canonical', 'og-url', 'lang', 'h1', 'hreflang'] as const satisfies readonly JsFieldId[];

/**
 * A field's status: the same in both, `changed`, only in the served HTML (JavaScript removed it),
 * or only after rendering (JavaScript added it). A list field is absent when it is empty; a count
 * when it is zero.
 */
export const JS_FIELD_STATUSES = ['same', 'changed', 'only-served', 'only-rendered'] as const;
export type JsFieldStatus = (typeof JS_FIELD_STATUSES)[number];
export const JS_FIELD_STATUS_LABELS: Readonly<Record<JsFieldStatus, string>> = {
  same: 'Same',
  changed: 'Changed by JavaScript',
  'only-served': 'Only in served HTML',
  'only-rendered': 'Only after JavaScript',
};

/** Word counts this close are the same (`max(words, share × the larger count)`). */
export const WORD_COUNT_TOLERANCE = { words: 5, share: 0.02 } as const;

/**
 * The added / removed lists: links (by resolved `href`, as a set; `http(s)` links only for the
 * counts and rules), headings (by level and text, counted) and structured data (JSON-LD blocks, by
 * their JSON when it parses, else their trimmed text, counted). At most `maxListItems` entries of
 * each are kept, with the totals.
 */
export const JS_DIFF_LIMITS = {
  maxListItems: 100,
  /** Characters of a field value or list label shown. */
  maxValueChars: 300,
} as const;

/**
 * The verdict, from the share of the rendered page that JavaScript added:
 * - words: `wordShare = max(0, rendered − served) / rendered` (0 when the rendered page has none);
 * - links: `linkShare = (http(s) links only after rendering) / (http(s) links after rendering)`.
 *
 * `heavily`: `wordShare ≥ heavyShare` with at least `minWords` rendered words, or `linkShare ≥
 * heavyShare` with at least `minLinks` rendered links. `partly`: not heavily, and `wordShare ≥
 * partlyShare` (at least `minWords`), `linkShare ≥ partlyShare` (at least one link added), a key
 * field (`JS_KEY_FIELDS`) differs, or a JSON-LD block was added or removed. Otherwise
 * `independent`: what a crawler that does not run JavaScript reads is what people see.
 */
export const JS_VERDICT_THRESHOLDS = { heavyShare: 0.5, partlyShare: 0.1, minWords: 50, minLinks: 5 } as const;
export const JS_VERDICTS = ['independent', 'partly', 'heavily'] as const;
export type JsVerdict = (typeof JS_VERDICTS)[number];
export const JS_VERDICT_LABELS: Readonly<Record<JsVerdict, string>> = {
  independent: 'JS-independent',
  partly: 'Partly JS-dependent',
  heavily: 'Heavily JS-dependent',
};
export const JS_VERDICT_SUMMARIES: Readonly<Record<JsVerdict, string>> = {
  independent: 'The served HTML already holds what people see. Crawlers that do not run JavaScript read the same page.',
  partly: 'JavaScript changes some of what search engines read. Crawlers that do not run JavaScript see only the served HTML.',
  heavily: 'Most of this page is built by JavaScript. Crawlers that do not run JavaScript see little of it, and others see it only once they render it.',
};

/** What the panel says under the comparison (frost's own words). */
export const JS_CRAWLER_NOTE = 'Crawlers that do not run JavaScript see only the served HTML. Search engines that render pages see the rendered side, but may render later or with limits.' as const;
/** When the served snapshot is partial: the cap stopped parsing or reading. */
export const JS_PARTIAL_NOTE = 'The served HTML is larger or deeper than frost reads, so it was compared on its first part only. Rules are not checked on a partial page.' as const;

// ---- Rules (category `javascript`) -------------------------------------------------------------------------

/**
 * Checked only when the comparison is `ready` or `identical` and the served snapshot is complete
 * (not `partial`): an unavailable or partial served page never fails a rule.
 */
export const JAVASCRIPT_RULE_SPECS = [
  {
    id: 'js-canonical-changed',
    category: 'javascript',
    severity: 'warning',
    title: 'JavaScript changes the canonical URL',
    condition: 'The canonical URLs (resolved) in the served HTML and after JavaScript runs differ: one was added, removed or changed by JavaScript.',
    why: 'Crawlers read the canonical in the served HTML first, and some never see the rendered one. Two different canonicals send mixed signals about which URL to index.',
    fix: 'Put the correct <link rel="canonical"> in the HTML the server sends, and do not change it with JavaScript.',
  },
  {
    id: 'js-robots-changed',
    category: 'javascript',
    severity: 'warning',
    title: 'JavaScript changes the robots meta tags',
    condition: 'The robots meta tags (generic and crawler-specific, as name and content) in the served HTML and after JavaScript runs differ.',
    why: 'A noindex in the served HTML can stop a page from being rendered at all, so removing it with JavaScript may not work; adding one with JavaScript is seen only by crawlers that render.',
    fix: 'Send the robots meta tags you mean in the served HTML, and do not add, remove or change them with JavaScript.',
  },
  {
    id: 'js-title-changed',
    category: 'javascript',
    severity: 'info',
    title: 'JavaScript changes the title',
    condition: 'The first <title>’s text in the served HTML and after JavaScript runs differ (or only one has a title).',
    why: 'Crawlers that do not run JavaScript use the served title. Others may see either, depending on when they render the page.',
    fix: 'Send the final title in the served HTML (render it on the server), so every crawler reads the same one.',
  },
  {
    id: 'js-content-added',
    category: 'javascript',
    severity: 'info',
    title: 'Most of the content is added by JavaScript',
    condition: `JavaScript adds at least half of the words in the body (the rendered page has at least ${JS_VERDICT_THRESHOLDS.minWords} words, and the served HTML fewer than half as many).`,
    why: 'Crawlers that do not run JavaScript see a mostly empty page, and rendering crawlers index the content only after rendering it, which can be later and is not guaranteed.',
    fix: 'Render the main content on the server (or pre-render it), so the served HTML holds it.',
  },
  {
    id: 'js-links-added',
    category: 'javascript',
    severity: 'info',
    title: 'Some links appear only after JavaScript runs',
    condition: 'At least one http(s) link (by resolved URL) is in the rendered page but not in the served HTML.',
    why: 'Crawlers discover pages through links in the HTML. Links that only JavaScript adds are found only by crawlers that render the page, and later.',
    fix: 'Put important links in the served HTML as <a href> elements, not only in JavaScript.',
  },
] as const satisfies readonly SeoRuleSpec[];
export type JavascriptRuleId = (typeof JAVASCRIPT_RULE_SPECS)[number]['id'];
