/**
 * frost's on-page SEO rule catalog and health score (Phase 2 Task 1; acceptance:
 * `seo-rules.feature.md`, one scenario per rule). Rules are data: id, category, severity, the
 * condition in prose, and the "why it matters" / "how to fix" text the sidebar shows. The checks
 * that implement each condition are in `packages/seo-core/src/rules/`, one named unit test per rule
 * (a passing and a failing snapshot).
 *
 * Clean-room: ids, wording, thresholds and scoring are frost's own, written from SEO first
 * principles (how search engines read titles, descriptions, headings, canonicals, robots directives
 * and links, and how people see them in results). Nothing is taken from another product's catalog.
 *
 * Plain values (importing only other plain specs), so the chrome renderer can use them without
 * bundling Zod.
 */
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { SCHEMA_PARSE_LIMITS, SCHEMA_SINGLETON_TYPES } from './schema-types.spec';
import { ROBOTS_FETCH_LIMITS } from './seo-indexability.spec';
import { PERFORMANCE_RULE_SPECS } from './seo-speed.spec';
import { COMPLIANCE_RULE_SPECS } from './seo-compliance.spec';
import { DESCRIPTION_WIDTH_RULE, TITLE_WIDTH_RULE } from './seo-content.spec';
import { JAVASCRIPT_RULE_SPECS } from './seo-javascript.spec';

/** How bad a failing rule is. Ordered: the sidebar ranks issues by it (then by catalog order). */
export const SEO_SEVERITIES = ['error', 'warning', 'info'] as const;
export type SeoSeverity = (typeof SEO_SEVERITIES)[number];

/** What a rule is about (the On-Page panel groups facts the same way). */
export const SEO_CATEGORIES = ['title', 'meta-description', 'headings', 'canonical', 'indexing', 'indexability', 'hreflang', 'language', 'mobile', 'content', 'images', 'links', 'url', 'social', 'schema', 'performance', 'security', 'accessibility', 'javascript'] as const;
export type SeoCategory = (typeof SEO_CATEGORIES)[number];

export const SEO_CATEGORY_LABELS: Readonly<Record<SeoCategory, string>> = {
  title: 'Title',
  'meta-description': 'Meta description',
  headings: 'Headings',
  canonical: 'Canonical',
  indexing: 'Indexing',
  indexability: 'Indexability',
  hreflang: 'hreflang',
  language: 'Language',
  mobile: 'Mobile',
  content: 'Content',
  images: 'Images',
  links: 'Links',
  url: 'URL',
  social: 'Social',
  schema: 'Structured data',
  performance: 'Page speed',
  security: 'Security',
  accessibility: 'Accessibility',
  javascript: 'JavaScript',
};

// ---- Thresholds ------------------------------------------------------------------------------
// Lengths are Unicode code points of the whitespace-normalised value (`CappedText.length`).

/**
 * A title shorter than this says too little to rank on or to be chosen in results. Measured as a
 * width since the Phase 2.5 Task 3 review: this many average lowercase Latin letters
 * (`seo-content.spec.ts`, `TITLE_WIDTH_RULE`), so a full-width title has a passing range too. Result pages
 * show about 50–60 characters of a title before cutting it: `TITLE_MAX_CHARS` is now only the
 * On-Page meter's guide range. Since Phase 2.5 Task 3 the cut is measured as a width
 * (`title-too-wide`, `seo-content.spec.ts`), which replaced the character rule.
 */
export const TITLE_MIN_CHARS = 30;
export const TITLE_MAX_CHARS = 60;

/**
 * A meta description is the usual source of a result's snippet: under `DESCRIPTION_MIN_CHARS` it
 * rarely describes the page well enough to be used. Past about `DESCRIPTION_MAX_CHARS` the snippet
 * is typically cut off on desktop results; that is measured as a width since Phase 2.5 Task 3
 * (`meta-description-too-wide`), and the maximum is only the On-Page meter's guide range.
 */
export const DESCRIPTION_MIN_CHARS = 70;
export const DESCRIPTION_MAX_CHARS = 160;

/** Fewer words than this in the page's visible text (and the count is complete): thin content. */
export const THIN_CONTENT_WORDS = 300;

/** Alt text longer than this is hard to listen to in a screen reader and reads as keyword stuffing. */
export const IMAGE_ALT_MAX_CHARS = 125;

/**
 * An image is oversized for display when its natural (intrinsic) size is more than this many times
 * its rendered size in either dimension. The factor leaves room for high-density screens, which
 * need up to about twice the CSS size; past it, the page downloads pixels nobody sees.
 */
export const IMAGE_OVERSIZE_FACTOR = 2;

/** A page URL (without its `#fragment`) longer than this is hard to read, share and remember. */
export const URL_MAX_CHARS = 100;

/** At most this many offending values (image sources, link targets, heading pairs …) per finding. */
export const FINDING_SAMPLE_LIMIT = 5;

// ---- Catalog ---------------------------------------------------------------------------------

export interface SeoRuleSpec {
  readonly id: string;
  readonly category: SeoCategory;
  readonly severity: SeoSeverity;
  /** What is wrong, as the issue's heading. */
  readonly title: string;
  /** When the rule fails, in prose (the check implements exactly this). */
  readonly condition: string;
  /** Why it matters. */
  readonly why: string;
  /** How to fix it. */
  readonly fix: string;
}

export const SEO_RULE_SPECS = [
  // Title
  {
    id: 'title-missing',
    category: 'title',
    severity: 'error',
    title: 'Page has no title',
    condition: 'The document has no HTML <title> element.',
    why: 'The title is the main signal of what a page is about and is usually the clickable headline of its search result. Without one, search engines make up a title from other text on the page.',
    fix: 'Add one <title> inside <head> that names the page’s topic first, then the site.',
  },
  {
    id: 'title-empty',
    category: 'title',
    severity: 'error',
    title: 'Title is empty',
    condition: 'The first <title> element has no text (after whitespace is collapsed).',
    why: 'An empty title gives search engines and people nothing to go on: the result headline is generated from other text, and tabs and bookmarks show only the URL.',
    fix: 'Write a specific, descriptive title for this page.',
  },
  {
    id: 'title-multiple',
    category: 'title',
    severity: 'warning',
    title: 'More than one title',
    condition: 'The document has more than one HTML <title> element.',
    why: 'Only one title is used. Which one wins is up to the browser or crawler, so the page may be shown with the wrong headline.',
    fix: 'Keep a single <title> in <head> and remove the others (often added twice by a theme and a plugin).',
  },
  {
    id: 'title-too-short',
    category: 'title',
    severity: 'warning',
    title: 'Title is too short',
    condition: `The first title with text is narrower than ${TITLE_MIN_CHARS} average lowercase Latin letters at the result title size (frost’s width table: about 15 full-width characters), so short titles in every script are measured alike.`,
    why: 'A very short title rarely says enough to match what people search for or to stand out among other results.',
    fix: `Describe the page’s main topic more fully, in about ${TITLE_MIN_CHARS}–${TITLE_MAX_CHARS} characters.`,
  },
  // Phase 2.5 Task 3: the width rule replaces the character maximum (`seo-content.spec.ts`).
  TITLE_WIDTH_RULE,
  // Meta description
  {
    id: 'meta-description-missing',
    category: 'meta-description',
    severity: 'warning',
    title: 'No meta description',
    condition: 'The document has no meta description with text (none at all, or only empty ones).',
    why: 'The meta description is the usual source of the snippet under a result. Without one, search engines pick text from the page, which may not sell the click.',
    fix: 'Add <meta name="description" content="…"> with a one- or two-sentence summary of the page.',
  },
  {
    id: 'meta-description-too-short',
    category: 'meta-description',
    severity: 'info',
    title: 'Meta description is short',
    condition: `The first meta description with text is narrower than ${DESCRIPTION_MIN_CHARS} average lowercase Latin letters at the result description size (frost’s width table: about 35 full-width characters).`,
    why: 'A very short description rarely summarises the page well, so search engines often replace it with text of their own.',
    fix: `Expand it to a useful summary of about ${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS} characters.`,
  },
  DESCRIPTION_WIDTH_RULE,
  {
    id: 'meta-description-multiple',
    category: 'meta-description',
    severity: 'warning',
    title: 'More than one meta description',
    condition: 'The document has more than one <meta name="description">.',
    why: 'Crawlers use only one of them (or join them unpredictably), so the snippet may not be the one you wrote.',
    fix: 'Keep one meta description and remove the duplicates.',
  },
  // Headings
  {
    id: 'h1-missing',
    category: 'headings',
    severity: 'error',
    title: 'No H1 heading',
    condition: 'The document has no <h1> element.',
    why: 'The H1 is the visible headline of the page. It tells readers and search engines what the page is about and anchors the heading outline.',
    fix: 'Add one <h1> that states the page’s main topic (it may match the title).',
  },
  {
    id: 'h1-multiple',
    category: 'headings',
    severity: 'warning',
    title: 'More than one H1',
    condition: 'The document has more than one <h1> element.',
    why: 'Several H1s blur which topic is the main one and flatten the outline that screen readers and crawlers rely on.',
    fix: 'Keep one H1 for the main topic and turn the others into H2s (or lower).',
  },
  {
    id: 'h1-empty',
    category: 'headings',
    severity: 'warning',
    title: 'Empty H1',
    condition: 'An <h1> element has no text.',
    why: 'An empty H1 (often a logo image without alt text) gives no headline to readers or crawlers.',
    fix: 'Put the page’s headline text in the H1; for an image heading, give the image alt text.',
  },
  {
    id: 'heading-level-skipped',
    category: 'headings',
    severity: 'info',
    title: 'Heading levels are skipped',
    condition: 'A heading is more than one level deeper than the heading before it (for example an H2 followed by an H4).',
    why: 'Skipped levels break the outline that screen-reader users navigate by and that crawlers read as the page’s structure.',
    fix: 'Use heading levels in order (H2 under H1, H3 under H2 …) and style them with CSS instead of picking a level for its size.',
  },
  // Canonical
  {
    id: 'canonical-missing',
    category: 'canonical',
    severity: 'warning',
    title: 'No canonical URL',
    condition: 'The document has no <link rel="canonical">.',
    why: 'The same page is often reachable at several URLs (tracking parameters, trailing slashes, http/https). A canonical tells search engines which one to index and credit.',
    fix: 'Add <link rel="canonical" href="…"> with the page’s preferred absolute URL (usually its own).',
  },
  {
    id: 'canonical-multiple',
    category: 'canonical',
    severity: 'error',
    title: 'More than one canonical',
    condition: 'The document has more than one <link rel="canonical">.',
    why: 'Conflicting canonicals are ignored, so search engines choose the preferred URL themselves.',
    fix: 'Keep exactly one canonical link and remove the others.',
  },
  {
    id: 'canonical-relative',
    category: 'canonical',
    severity: 'warning',
    title: 'Canonical URL is relative',
    condition: 'The canonical’s href does not start with a scheme (for example "/page" or "//example.com/page").',
    why: 'Relative canonicals are resolved against whatever URL the page was fetched from, so a copy on another host or protocol can point at itself.',
    fix: 'Use an absolute URL, including https:// and the host.',
  },
  {
    id: 'canonical-off-host',
    category: 'canonical',
    severity: 'info',
    title: 'Canonical points to another host',
    condition: 'The canonical resolves to a host other than the page’s own (ignoring a leading "www.").',
    why: 'A cross-host canonical asks search engines to index the other site’s URL instead of this one. That is right for syndicated copies and wrong almost everywhere else.',
    fix: 'Check that the other host is really the preferred home of this content; otherwise point the canonical at this page.',
  },
  {
    id: 'canonical-og-url-mismatch',
    category: 'canonical',
    severity: 'info',
    title: 'Canonical and og:url disagree',
    condition: 'The page has both a canonical and an og:url, and they name different URLs (the #fragment ignored).',
    why: 'Social shares then count toward a different URL than the one search engines index, splitting signals between the two.',
    fix: 'Set og:url to the same URL as the canonical.',
  },
  {
    id: 'canonical-has-query',
    category: 'canonical',
    severity: 'info',
    title: 'Canonical URL has query parameters',
    condition: 'The canonical resolves to a URL with a ?query.',
    why: 'Parameters in a canonical often come from tracking or session values, which makes the preferred URL unstable.',
    fix: 'Point the canonical at the clean URL, unless the parameter really selects different content.',
  },
  // Indexing
  {
    id: 'robots-noindex',
    category: 'indexing',
    severity: 'warning',
    title: 'Page asks not to be indexed',
    condition: 'The robots meta tag for all crawlers ("robots") or the "googlebot" one contains "noindex" or "none". The finding names each tag that does. The page is not indexable (NOT_INDEXABLE_RULES), so the health score is capped (NOINDEX_SCORE_CAP).',
    why: 'Search engines drop a noindex page from their results. That is often deliberate (staging, thank-you pages) but costly when it is left on by mistake, and a crawler-specific tag is easy to miss.',
    fix: 'If this page should be found in search, remove noindex from the robots meta tags (including a googlebot one).',
  },
  {
    id: 'robots-noindex-other-bot',
    category: 'indexing',
    severity: 'warning',
    title: 'Page asks one crawler not to index it',
    condition: 'A robots meta tag for a crawler other than Googlebot ("googlebot-news", "bingbot") contains "noindex" or "none". The finding names each tag that does. The page stays indexable for other crawlers, so the score is not capped.',
    why: 'That crawler’s search product drops the page (its web results, or the news results googlebot-news feeds). A crawler-specific tag is easy to leave on by mistake and easy to miss.',
    fix: 'If the page should appear there too, remove noindex from that crawler’s robots meta tag.',
  },
  {
    id: 'robots-nofollow',
    category: 'indexing',
    severity: 'warning',
    title: 'Page asks crawlers not to follow its links',
    condition: 'A robots meta tag ("robots", "googlebot", "googlebot-news" or "bingbot") contains "nofollow" or "none". The finding names each tag that does.',
    why: 'A page-wide nofollow stops crawlers from discovering pages through this one and passing value along its links.',
    fix: 'Remove nofollow from the robots meta tag; mark individual links rel="nofollow" where needed instead.',
  },
  // Indexability (Task 4; `seo-indexability.feature.md`): the HTTP response, X-Robots-Tag, robots.txt and canonicals.
  {
    id: 'http-status-redirect',
    category: 'indexability',
    severity: 'warning',
    title: 'Page answered with a redirect status',
    condition: 'The page’s final HTTP status is 3xx (the browser showed the redirect response’s own body, with no usable Location).',
    why: 'Search engines index the target of a redirect, not the redirect itself. A 3xx page that renders content is usually a misconfigured redirect.',
    fix: 'Send a 200 for this URL, or give the redirect a Location header that points at the real page.',
  },
  {
    id: 'http-status-client-error',
    category: 'indexability',
    severity: 'error',
    title: 'Page answered with a client error',
    condition: 'The page’s final HTTP status is 4xx (for example 404 Not Found or 410 Gone). The page is not indexable (NOT_INDEXABLE_RULES).',
    why: 'A 4xx status tells search engines the page does not exist, whatever it shows. They drop it from results and stop crawling it as often.',
    fix: 'If the page should exist, make the server answer 200. If it moved, redirect it (301) to its new URL; if it is gone, keep the 404 or 410 and remove links to it.',
  },
  {
    id: 'http-status-server-error',
    category: 'indexability',
    severity: 'error',
    title: 'Page answered with a server error',
    condition: 'The page’s final HTTP status is 5xx. The page is not indexable (NOT_INDEXABLE_RULES).',
    why: 'Search engines treat a 5xx as a temporary failure: they retry later, and a page that keeps failing is dropped from results.',
    fix: 'Fix the server error (check the server’s logs for this URL) so the page answers 200.',
  },
  {
    id: 'http-redirect-chain',
    category: 'indexability',
    severity: 'warning',
    title: 'Page is behind a chain of redirects',
    condition: 'The page was reached through more than one server redirect (redirects the browser made up itself, such as HSTS upgrades, are not counted).',
    why: 'Every hop costs crawl time and a little reliability; crawlers stop following long chains, and links to the first URL pass value less directly.',
    fix: 'Point links, sitemaps and the first redirect straight at the final URL.',
  },
  {
    id: 'x-robots-noindex',
    category: 'indexability',
    severity: 'warning',
    title: 'X-Robots-Tag header asks not to index',
    condition: 'An X-Robots-Tag response header for all crawlers, or for googlebot (as "googlebot: noindex"), contains "noindex" or "none". The page is not indexable (NOT_INDEXABLE_RULES).',
    why: 'The header works like a robots meta tag but is invisible in the page’s HTML, so a server or CDN rule can de-index pages without anyone noticing.',
    fix: 'Remove noindex from the X-Robots-Tag header for this URL (check the server, CDN and framework config that adds it).',
  },
  {
    id: 'x-robots-noindex-other-bot',
    category: 'indexability',
    severity: 'warning',
    title: 'X-Robots-Tag header asks one crawler not to index',
    condition: 'An X-Robots-Tag response header for a crawler other than Googlebot ("googlebot-news: noindex", "bingbot: noindex") contains "noindex" or "none". The finding names the crawler. The score is not capped.',
    why: 'That crawler’s search product drops the page, and the header is invisible in the HTML, so it is easy to leave on by mistake.',
    fix: 'If the page should appear there too, remove that crawler’s noindex from the X-Robots-Tag header.',
  },
  {
    id: 'x-robots-nofollow',
    category: 'indexability',
    severity: 'warning',
    title: 'X-Robots-Tag header asks not to follow links',
    condition: 'An X-Robots-Tag response header for all crawlers, or for googlebot, googlebot-news or bingbot, contains "nofollow" or "none".',
    why: 'A page-wide nofollow stops crawlers from discovering pages through this one, and the header is easy to miss because it is not in the HTML.',
    fix: 'Remove nofollow from the X-Robots-Tag header; mark individual links rel="nofollow" where needed instead.',
  },
  {
    id: 'robots-txt-blocks-googlebot',
    category: 'indexability',
    severity: 'error',
    title: 'robots.txt blocks Googlebot from this page',
    condition: 'The site’s robots.txt (fetched and parsed by frost) has a Disallow rule that is the most specific match for this URL in the group Googlebot follows (its own, else "*"). The page is not indexable (NOT_INDEXABLE_RULES).',
    why: 'Googlebot will not fetch a blocked page, so it cannot read its content or its tags. A blocked URL can still appear in results, but only as a bare link with no description.',
    fix: 'Remove or narrow the Disallow rule (an Allow rule for this path also works). To keep a page out of results, allow crawling and use noindex instead.',
  },
  {
    id: 'robots-txt-blocks-all',
    category: 'indexability',
    severity: 'warning',
    title: 'robots.txt blocks other crawlers from this page',
    condition: 'The robots.txt "*" group’s most specific match for this URL is a Disallow rule, while Googlebot (through a group of its own) may crawl it.',
    why: 'Crawlers without a group of their own, such as smaller search engines and preview bots, follow the "*" group and will not fetch this page.',
    fix: 'Allow the page in the "*" group too, unless keeping other crawlers out is intended.',
  },
  {
    id: 'robots-txt-unreachable',
    category: 'indexability',
    severity: 'warning',
    title: 'robots.txt could not be read',
    condition: `Fetching the site’s robots.txt failed: a 5xx or 429 status, a network error, no answer within ${ROBOTS_FETCH_LIMITS.timeoutMs / 1000} seconds, a redirect to a non-web address, or a redirect without a Location (ROBOTS_UNKNOWN_OUTCOMES).`,
    why: 'When robots.txt cannot be read, crawlers assume the whole site is disallowed and stop crawling until it can. A short outage is fine; a lasting one takes the site out of search.',
    fix: 'Make /robots.txt answer quickly with 200 (or 404 if you have none), and check the server or firewall rules that block it.',
  },
  {
    id: 'robots-txt-no-sitemap',
    category: 'indexability',
    severity: 'info',
    title: 'robots.txt lists no sitemap',
    condition: 'The site’s robots.txt was fetched and has no Sitemap line.',
    why: 'A Sitemap line is the simplest way to tell every crawler where the site’s sitemap is, without submitting it to each search engine.',
    fix: 'Add a line such as "Sitemap: https://example.com/sitemap.xml" to robots.txt (an absolute URL; any number of them).',
  },
  {
    id: 'canonical-elsewhere',
    category: 'indexability',
    severity: 'info',
    title: 'Page defers to another URL',
    condition: 'The canonical (the first <link rel="canonical">, else an HTTP Link header with rel="canonical") resolves to a URL other than this page’s (the #fragment ignored).',
    why: 'Search engines usually index the canonical URL instead of this one. That is right for duplicates and variants, and a costly mistake on a page that should rank itself.',
    fix: 'If this page should be indexed under its own URL, point its canonical at itself.',
  },
  {
    id: 'canonical-header-conflict',
    category: 'indexability',
    severity: 'warning',
    title: 'HTML and HTTP canonicals disagree',
    condition: 'The page has a <link rel="canonical"> and an HTTP Link header with rel="canonical", and they resolve to different URLs (the #fragment ignored).',
    why: 'Faced with two different canonicals, search engines may ignore both and choose the preferred URL themselves.',
    fix: 'Declare the canonical in one place, or make both name the same absolute URL.',
  },
  // hreflang (Task 4; `seo-indexability.feature.md`)
  {
    id: 'hreflang-invalid-code',
    category: 'hreflang',
    severity: 'error',
    title: 'hreflang has an invalid language or region',
    condition: 'An hreflang value (in <head> or an HTTP Link header) is not "x-default" or a language code from ISO 639-1, optionally with a script and an ISO 3166-1 region (such as "en", "en-GB" or "zh-Hant-TW").',
    why: 'Search engines ignore an annotation whose code they cannot read, so that language version is never offered to its audience. "en-UK" (it is GB) and "en_US" (underscore) are common slips.',
    fix: 'Use the two-letter language code, then optionally a hyphen and the two-letter country code: "en-GB", "pt-BR", "es".',
  },
  {
    id: 'hreflang-missing-self',
    category: 'hreflang',
    severity: 'warning',
    title: 'hreflang set does not include this page',
    condition: 'The page has hreflang annotations, and none of them points to this page’s URL or its canonical (the #fragment ignored).',
    why: 'Each language version must list itself among its alternates. Without the self-reference, search engines may not trust the set.',
    fix: 'Add an hreflang link for this page’s own language that points to this page’s canonical URL.',
  },
  {
    id: 'hreflang-no-x-default',
    category: 'hreflang',
    severity: 'info',
    title: 'hreflang set has no x-default',
    condition: 'The page has hreflang annotations and none of them is "x-default".',
    why: 'x-default names the page for everyone whose language matches no version (often a language picker or the main site), so they still land somewhere sensible.',
    fix: 'Add <link rel="alternate" hreflang="x-default" href="…"> pointing at the fallback page.',
  },
  {
    id: 'hreflang-duplicate',
    category: 'hreflang',
    severity: 'warning',
    title: 'hreflang value used more than once',
    condition: 'The same hreflang value (case aside) appears in more than one annotation.',
    why: 'Each language and region should have exactly one URL. With two, search engines pick one themselves, or ignore both.',
    fix: 'Keep one annotation per hreflang value and remove the duplicates.',
  },
  {
    id: 'hreflang-relative-url',
    category: 'hreflang',
    severity: 'warning',
    title: 'hreflang URL is relative',
    condition: 'An hreflang annotation’s URL does not start with a scheme (for example "/de/" or "//example.com/de/").',
    why: 'Search engines expect fully-qualified URLs in hreflang. A relative one is resolved against wherever the page was fetched from, which may not be the version you meant.',
    fix: 'Write every hreflang URL in full, including https:// and the host.',
  },
  // Language and mobile
  {
    id: 'lang-missing',
    category: 'language',
    severity: 'warning',
    title: 'No page language',
    condition: 'The <html> element has no lang attribute, or it is empty.',
    why: 'The language helps search engines serve the page to the right audience and lets screen readers pronounce it correctly.',
    fix: 'Add the language to the root element, for example <html lang="en">.',
  },
  {
    id: 'viewport-missing',
    category: 'mobile',
    severity: 'warning',
    title: 'No viewport meta tag',
    condition: 'The document has no <meta name="viewport">, or it is empty.',
    why: 'Without a viewport, phones render the page at desktop width and shrink it. Search engines index the mobile version of pages first.',
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
  },
  // Content
  {
    id: 'content-thin',
    category: 'content',
    severity: 'warning',
    title: 'Thin content',
    condition: `The page’s visible text has fewer than ${THIN_CONTENT_WORDS} words (and the count is complete).`,
    why: 'Pages with little text give search engines little to understand or rank, and rarely answer a searcher’s question fully.',
    fix: 'Add useful, original text that covers the topic, or merge this page into a fuller one.',
  },
  // Images
  {
    id: 'images-missing-alt',
    category: 'images',
    severity: 'warning',
    title: 'Images without alt text',
    condition: 'One or more <img> elements have no alt attribute (alt="" marks a decorative image and passes).',
    why: 'Alt text is what screen readers announce and what image search uses to understand a picture. A missing alt is announced as the file name, or skipped.',
    fix: 'Describe each meaningful image in its alt attribute; give purely decorative images alt="".',
  },
  {
    id: 'image-alt-too-long',
    category: 'images',
    severity: 'info',
    title: 'Alt text is very long',
    condition: `An image’s alt text has more than ${IMAGE_ALT_MAX_CHARS} characters.`,
    why: 'Long alt text is tiring to listen to and often reads as keyword stuffing.',
    fix: 'Keep alt text to a short description; put longer explanations in a caption or the surrounding text.',
  },
  {
    id: 'images-missing-dimensions',
    category: 'images',
    severity: 'warning',
    title: 'Images without width and height',
    condition:
      'One or more rendered <img> elements (they have a layout box) lack a width or a height attribute (absent or empty), and CSS does not fix their box either (no computed aspect-ratio, no width and height declared together: ImageSchema.cssSized).',
    why: 'Without both attributes the browser cannot reserve the image’s space before it loads, so the content below jumps when it arrives (layout shift, which hurts reading and Core Web Vitals).',
    fix: 'Add width and height attributes with the image’s intrinsic size (CSS can still scale it; the browser keeps the aspect ratio).',
  },
  {
    id: 'images-oversized',
    category: 'images',
    severity: 'warning',
    title: 'Images larger than they are shown',
    condition: `One or more images have a file size more than ${IMAGE_OVERSIZE_FACTOR}× their rendered size in either dimension (both known; the file size corrected for srcset density). SVG images are vectors and never count; they are recognised by URL only (a .svg or .svgz path, or a data:image/svg+xml URL), so an SVG served from another URL is judged like a raster image.`,
    why: 'The browser downloads and decodes every pixel of the file, then throws most of them away. That costs bandwidth and memory and slows the page down, most of all on phones.',
    fix: 'Serve images close to the size they are shown at, using srcset and sizes for different screens.',
  },
  {
    id: 'images-lazy-in-first-viewport',
    category: 'images',
    severity: 'warning',
    title: 'Lazy-loaded images in the first screen',
    condition:
      'One or more images whose box overlaps the first viewport (the top of the page as it first appears) have loading="lazy". The first viewport is the page area’s size when the audit ran (a narrower window or open sidebar changes it), and a lazy image that has not loaded and has no width and height has no box, so it is not seen.',
    why: 'Lazy loading waits until layout to start fetching, so images people see first arrive late. When one of them is the largest element on screen, it delays Largest Contentful Paint.',
    fix: 'Remove loading="lazy" from images near the top of the page (keep it for those further down), and consider fetchpriority="high" for the main one.',
  },
  // Links
  {
    id: 'links-empty-anchor',
    category: 'links',
    severity: 'warning',
    title: 'Links without anchor text',
    condition: 'One or more links have no text, aria-label, image alt or title.',
    why: 'Anchor text tells people and crawlers what the target is about. A link with none is announced as just "link" and passes no context.',
    fix: 'Give each link descriptive text, or an aria-label for icon-only links.',
  },
  {
    id: 'links-javascript-href',
    category: 'links',
    severity: 'warning',
    title: 'Links with javascript: URLs',
    condition: 'One or more links have an href with the javascript: scheme.',
    why: 'Crawlers cannot follow javascript: links, and they break opening in a new tab or copying the address.',
    fix: 'Use a real URL in href, or a <button> for actions that do not navigate.',
  },
  {
    id: 'links-nofollow',
    category: 'links',
    severity: 'info',
    title: 'Links marked nofollow',
    condition: 'One or more links have rel="nofollow".',
    why: 'Nofollow links pass no ranking credit. That suits ads and untrusted user content, but not your own pages.',
    fix: 'Check that only paid, untrusted or user-generated links are nofollow (or use sponsored / ugc).',
  },
  // URL
  {
    id: 'url-too-long',
    category: 'url',
    severity: 'info',
    title: 'URL is long',
    condition: `The page URL (without its #fragment) has more than ${URL_MAX_CHARS} characters.`,
    why: 'Long URLs are hard to read, share and remember, and are often truncated in results.',
    fix: 'Use a short, readable path made of a few descriptive words.',
  },
  {
    id: 'url-uppercase',
    category: 'url',
    severity: 'info',
    title: 'URL path has uppercase letters',
    condition: 'The page URL’s path contains an uppercase letter outside percent-escapes (the hex digits of %E6 are not letters of the path).',
    why: 'Paths are case-sensitive on most servers, so mixed case invites duplicate URLs and broken links when people type them.',
    fix: 'Use lowercase paths and redirect mixed-case variants to them.',
  },
  {
    id: 'url-underscores',
    category: 'url',
    severity: 'info',
    title: 'URL path has underscores',
    condition: 'The page URL’s path contains an underscore.',
    why: 'Hyphens are the conventional word separator in URLs; underscores can join words together for search engines.',
    fix: 'Separate words in paths with hyphens.',
  },
  // Social
  {
    id: 'og-title-missing',
    category: 'social',
    severity: 'warning',
    title: 'No Open Graph title',
    condition: 'The page has no og:title tag with text.',
    why: 'Social networks and chat apps build a shared link’s card from Open Graph tags. Without og:title they guess a headline, often the bare <title> with the site name, or the URL.',
    fix: 'Add <meta property="og:title" content="…"> with the headline the card should show.',
  },
  {
    id: 'og-description-missing',
    category: 'social',
    severity: 'info',
    title: 'No Open Graph description',
    condition: 'The page has no og:description tag with text.',
    why: 'The description is the line under a shared link’s headline. Without it, apps take any text from the page or show none.',
    fix: 'Add <meta property="og:description" content="…"> with a one-sentence summary.',
  },
  {
    id: 'og-image-missing',
    category: 'social',
    severity: 'warning',
    title: 'No Open Graph image',
    condition: 'The page has no og:image tag with a value.',
    why: 'Shared links with an image get far more attention than text-only cards, and without og:image apps either pick an image from the page or show none.',
    fix: 'Add <meta property="og:image" content="https://…"> pointing at an image made for sharing (about 1200×630 px).',
  },
  {
    id: 'og-image-not-https',
    category: 'social',
    severity: 'warning',
    title: 'Open Graph image is not an absolute https URL',
    condition: 'The og:image value is relative (it has no scheme) or uses a scheme other than https.',
    why: 'Apps fetch og:image on their own, without the page around it, so a relative URL has nothing to resolve against. Many of them refuse plain http images.',
    fix: 'Use the image’s full https:// URL in og:image.',
  },
  {
    id: 'twitter-card-missing',
    category: 'social',
    severity: 'info',
    title: 'No Twitter card type',
    condition: 'The page has no twitter:card tag with a value.',
    why: 'twitter:card picks the card layout (a small summary, or a large image) in apps that read Twitter card tags. Without it they fall back to their default, usually the small card.',
    fix: 'Add <meta name="twitter:card" content="summary_large_image"> (or "summary").',
  },
  // Structured data (Phase 2 Task 3; acceptance `seo-schema.feature.md`). The type and property
  // sets the checks use are `schema-types.spec.ts`. Each finding lists the nodes it is about; the
  // Schema panel shows the same issues on the nodes themselves.
  {
    id: 'schema-none',
    category: 'schema',
    severity: 'info',
    title: 'No structured data',
    condition: 'The page has no JSON-LD block, no microdata item and no RDFa item.',
    why: 'Structured data tells search engines in plain terms what a page is (a product, a recipe, an article, a business) and is what makes it eligible for richer results such as ratings, prices and breadcrumbs.',
    fix: 'Describe the page’s main entity with schema.org JSON-LD in a <script type="application/ld+json"> block.',
  },
  {
    id: 'schema-json-invalid',
    category: 'schema',
    severity: 'error',
    title: 'JSON-LD block is not valid JSON',
    condition: 'A JSON-LD block (kept whole) does not parse as JSON, or is empty. The finding gives the block, the line and column of the first error, and what was wrong there.',
    why: 'A block with a syntax error is thrown away whole: none of the structured data in it is read.',
    fix: 'Fix the JSON at the reported position (often a trailing comma, a missing comma or quote, or an unescaped quote inside a string), or generate the block with a JSON serialiser instead of by hand.',
  },
  {
    id: 'schema-over-limit',
    category: 'schema',
    severity: 'warning',
    title: 'Structured data too large to check fully',
    condition: `A JSON-LD block is longer than ${SNAPSHOT_LIMITS.maxJsonLdChars.toLocaleString('en-US')} characters (or past the page’s ${SNAPSHOT_LIMITS.maxJsonLdTotalChars.toLocaleString('en-US')} in all), nests objects and arrays deeper than ${SCHEMA_PARSE_LIMITS.maxDepth} levels, the page’s structured data (JSON-LD, microdata and RDFa together) holds more than ${SCHEMA_PARSE_LIMITS.maxNodes.toLocaleString('en-US')} values, or checking it would take more than ${SCHEMA_PARSE_LIMITS.maxWork.toLocaleString('en-US')} steps. frost checks what fits within these bounds and skips the rest.`,
    why: 'Very large or deeply nested structured data adds weight to every page view and is easy to get wrong; search engines may not read all of it either.',
    fix: 'Keep each block to what describes this page: move long lists (all reviews, every product variant) to their own pages and flatten needless nesting.',
  },
  {
    id: 'schema-context-missing',
    category: 'schema',
    severity: 'warning',
    title: 'Structured data names no vocabulary',
    condition: 'A top-level JSON-LD node has no @context (its own or its block’s), or an RDFa item uses a bare type (such as "Product") with no vocab in effect.',
    why: 'Without a vocabulary, "Product" or "name" are just words: the data cannot be read as schema.org.',
    fix: 'Add "@context": "https://schema.org" to the block’s top-level object (for RDFa, vocab="https://schema.org/" on an enclosing element).',
  },
  {
    id: 'schema-context-not-schema-org',
    category: 'schema',
    severity: 'warning',
    title: 'Structured data is not schema.org',
    condition: 'A top-level JSON-LD node’s @context, a microdata item’s itemtype, or an RDFa item’s vocabulary names no schema.org IRI (http or https, with or without www.).',
    why: 'Search engines read structured data in the schema.org vocabulary. Data in another vocabulary, or a mistyped schema.org address, is ignored for search features.',
    fix: 'Use https://schema.org as the @context (or itemtype prefix, or RDFa vocab), spelled exactly.',
  },
  {
    id: 'schema-type-missing',
    category: 'schema',
    severity: 'warning',
    title: 'Structured data without a type',
    condition: 'A top-level node (a JSON-LD block’s object, an entry of its @graph or top-level array, a top-level microdata or RDFa item) has no @type, itemtype or typeof. A node that only references another by @id is not one, nor is one that adds properties to a typed node with the same @id.',
    why: 'The type is what says what a node is. An untyped node cannot be matched to any search feature.',
    fix: 'Give the node the most specific schema.org type that fits, for example "@type": "Product".',
  },
  {
    id: 'schema-type-unknown',
    category: 'schema',
    severity: 'info',
    title: 'Uncommon schema.org type',
    condition: 'A node’s schema.org type is not one of the common types frost recognises (SCHEMA_COMMON_TYPES and their known subtypes). The list is not all of schema.org, so this is a prompt to check the spelling, not an error.',
    why: 'Types are case-sensitive and a misspelt type ("product", "Organisation") is not recognised by search engines, so the data is ignored.',
    fix: 'Check the type’s exact spelling and capitalisation against schema.org; keep it if it is a real, more specific type.',
  },
  {
    id: 'schema-required-missing',
    category: 'schema',
    severity: 'error',
    title: 'Structured data lacks required properties',
    condition:
      'A top-level node of a type frost checks (SCHEMA_TYPE_RULES, subtypes included), or a structural node anywhere (SCHEMA_STRUCTURAL_TYPES: a ListItem, a Question, an Answer; a breadcrumb trail’s ListItems use SCHEMA_BREADCRUMB_ITEM_RULE), lacks one of its required properties, or every alternative of a required choice. A nested node of another checked type only needs its identity (SCHEMA_NESTED_IDENTITY: a name). Properties of other nodes with the same @id count; nodes sharing an @id are checked once, together.',
    why: 'Without these properties the node does not describe its thing well enough to be used: a product with nothing to buy and no rating, an event without a date, a business without an address.',
    fix: 'Add the listed properties with real values from the page.',
  },
  {
    id: 'schema-recommended-missing',
    category: 'schema',
    severity: 'info',
    title: 'Structured data could say more',
    condition: 'A top-level node of a type frost checks lacks one of its recommended properties (SCHEMA_TYPE_RULES).',
    why: 'Recommended properties are optional, but they are what richer results show (images, dates, authors, prices) and help search engines tell similar entities apart.',
    fix: 'Add the listed properties where the page has the information.',
  },
  {
    id: 'schema-url-not-absolute',
    category: 'schema',
    severity: 'warning',
    title: 'Structured data URL is not absolute',
    condition: 'A text value of a URL property (SCHEMA_URL_PROPERTIES: url, image, logo, sameAs, item …) is not an absolute http or https URL.',
    why: 'Structured data is often read apart from the page, so a relative URL may be resolved wrongly or not at all, and other schemes (javascript:, data:) are useless to a crawler.',
    fix: 'Write the full https:// URL, host included.',
  },
  {
    id: 'schema-date-invalid',
    category: 'schema',
    severity: 'warning',
    title: 'Date or duration is not ISO 8601',
    condition:
      'A date property (SCHEMA_DATE_PROPERTIES: datePublished, startDate, uploadDate …) is not an ISO 8601 date or date-time (2024-05-01, 2024-05-01T09:30, 2024-05-01T09:30:00+02:00; a lowercase t or z is accepted, as RFC 3339 allows), or a duration property (SCHEMA_DURATION_PROPERTIES: duration, cookTime …) is not an ISO 8601 duration (PT1H30M).',
    why: 'Dates written for people ("May 1st", "01/05/2024") are ambiguous to a machine, so dates in results may be wrong or left out.',
    fix: 'Write dates as YYYY-MM-DD, with a time and a time zone where it matters (YYYY-MM-DDThh:mm+hh:mm), and durations as P…T…H…M.',
  },
  {
    id: 'schema-breadcrumb-positions',
    category: 'schema',
    severity: 'warning',
    title: 'Breadcrumb positions are out of order',
    condition: 'A BreadcrumbList’s items do not have the positions 1, 2, 3 … one each, with no gap or repeat (a missing or non-integer position fails too).',
    why: 'The positions order the trail. Gaps, repeats or missing positions make the trail ambiguous, so it may be shown wrongly or not at all.',
    fix: 'Number the ListItems 1 to n in the order of the trail, starting from the home page.',
  },
  {
    id: 'schema-price-invalid',
    category: 'schema',
    severity: 'warning',
    title: 'Product price is not machine-readable',
    condition:
      'A Product’s offer (an Offer: price, or its priceSpecification’s price; an AggregateOffer: lowPrice) has no numeric price (digits with an optional decimal point: no currency sign, no thousands separator), or no priceCurrency.',
    why: 'Prices in results are read from these two values. "$1,299" or a missing currency cannot be shown reliably, so the price is dropped.',
    fix: 'Give each offer "price": "1299.00" and "priceCurrency": "USD" (a three-letter ISO 4217 code).',
  },
  {
    id: 'schema-entity-conflict',
    category: 'schema',
    severity: 'info',
    title: `The same site described twice, differently`,
    condition: `Two top-level nodes of the same type (${SCHEMA_SINGLETON_TYPES.join(' or ')}), not sharing an @id, claim the same site under different names (case aside): their URLs are on the same host (a leading www. aside), or one of them has no URL. Nodes on different hosts describe different sites and never conflict.`,
    why: 'A site is one organisation and one website. Conflicting descriptions (often from a theme and a plugin both adding them) leave search engines to guess which is right.',
    fix: 'Describe the organisation and the website once, and refer to them from other nodes by @id.',
  },
  // Page speed (Task 5): the Core Web Vitals bands and frost's weight, request, DOM and blocking checks (`seo-speed.spec.ts`).
  ...PERFORMANCE_RULE_SPECS,
  // Security and accessibility (Phase 2 Task 6): `seo-compliance.spec.ts`.
  ...COMPLIANCE_RULE_SPECS,
  // Served HTML vs the rendered DOM (Phase 2.5 Task 2): `seo-javascript.spec.ts`.
  ...JAVASCRIPT_RULE_SPECS,
] as const satisfies readonly SeoRuleSpec[];

export type SeoRuleId = (typeof SEO_RULE_SPECS)[number]['id'];

// ---- Health score ----------------------------------------------------------------------------

/**
 * The health score (0–100). Each failing rule counts once, however many elements fail it, and
 * removes its severity's share of what is left:
 *
 *     score = round(100 × Π over failing rules (1 − SEVERITY_WEIGHTS[severity]))
 *
 * So no issues is 100, one error is 80, one warning 93, one info 99, an error and three warnings
 * 64. When a rule in `NOT_INDEXABLE_RULES` fails the result is then capped at `NOINDEX_SCORE_CAP`. The score only
 * ever goes down as issues are added, never below 0, and does not depend on the order of the
 * findings.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<SeoSeverity, number>> = {
  error: 0.2,
  warning: 0.07,
  info: 0.01,
};

/**
 * A page that cannot be indexed (`NOT_INDEXABLE_RULES`: noindex, an error status, robots.txt) gets at most this score, so it always
 * lands in the `poor` band and the score card says "Not indexable". The rule stays a warning, since
 * noindex is often intentional, but whatever else is right about the page, it will not appear in
 * search results while the tag is there, and a "Good" score would hide that.
 */
export const NOINDEX_SCORE_CAP = 59;

/**
 * The rules that make a page "Not indexable" (Task 4; `seo-indexability.spec.ts`, verdicts): while any
 * of them fails the audit is `indexable: false`, the score is capped at `NOINDEX_SCORE_CAP` and the
 * score card says `NOT_INDEXABLE_LABEL` with the reasons.
 */
export const NOT_INDEXABLE_RULES = ['robots-noindex', 'x-robots-noindex', 'robots-txt-blocks-googlebot', 'http-status-client-error', 'http-status-server-error'] as const satisfies readonly SeoRuleId[];
export const NOT_INDEXABLE_LABEL = 'Not indexable' as const;

/** The score's band (the ring's colour and label): at least `min`, the first match wins. */
export const SCORE_BANDS = [
  { id: 'good', min: 90, label: 'Good' },
  { id: 'fair', min: 60, label: 'Needs work' },
  { id: 'poor', min: 0, label: 'Poor' },
] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number]['id'];
