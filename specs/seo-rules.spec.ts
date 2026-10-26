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
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod.
 */

/** How bad a failing rule is. Ordered: the sidebar ranks issues by it (then by catalog order). */
export const SEO_SEVERITIES = ['error', 'warning', 'info'] as const;
export type SeoSeverity = (typeof SEO_SEVERITIES)[number];

/** What a rule is about (the On-Page panel groups facts the same way). */
export const SEO_CATEGORIES = ['title', 'meta-description', 'headings', 'canonical', 'indexing', 'language', 'mobile', 'content', 'images', 'links', 'url', 'social'] as const;
export type SeoCategory = (typeof SEO_CATEGORIES)[number];

export const SEO_CATEGORY_LABELS: Readonly<Record<SeoCategory, string>> = {
  title: 'Title',
  'meta-description': 'Meta description',
  headings: 'Headings',
  canonical: 'Canonical',
  indexing: 'Indexing',
  language: 'Language',
  mobile: 'Mobile',
  content: 'Content',
  images: 'Images',
  links: 'Links',
  url: 'URL',
  social: 'Social',
};

// ---- Thresholds ------------------------------------------------------------------------------
// Lengths are Unicode code points of the whitespace-normalised value (`CappedText.length`).

/**
 * A title shorter than this says too little to rank on or to be chosen in results; result pages
 * show about 50–60 characters of a title before cutting it, so longer than `TITLE_MAX_CHARS` is
 * likely truncated (pixel width comes later; characters are the Phase 2 proxy).
 */
export const TITLE_MIN_CHARS = 30;
export const TITLE_MAX_CHARS = 60;

/**
 * A meta description is the usual source of a result's snippet: under `DESCRIPTION_MIN_CHARS` it
 * rarely describes the page well enough to be used; past `DESCRIPTION_MAX_CHARS` the snippet is
 * typically cut off on desktop results.
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
    condition: `The title has fewer than ${TITLE_MIN_CHARS} characters.`,
    why: 'A very short title rarely says enough to match what people search for or to stand out among other results.',
    fix: `Describe the page’s main topic more fully, in about ${TITLE_MIN_CHARS}–${TITLE_MAX_CHARS} characters.`,
  },
  {
    id: 'title-too-long',
    category: 'title',
    severity: 'warning',
    title: 'Title is too long',
    condition: `The title has more than ${TITLE_MAX_CHARS} characters.`,
    why: 'Search results cut long titles off, so the end of the title (often the brand or a key detail) is not seen.',
    fix: `Put the most important words first and shorten the title to ${TITLE_MAX_CHARS} characters or fewer.`,
  },
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
    condition: `The first meta description with text has fewer than ${DESCRIPTION_MIN_CHARS} characters.`,
    why: 'A very short description rarely summarises the page well, so search engines often replace it with text of their own.',
    fix: `Expand it to a useful summary of about ${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS} characters.`,
  },
  {
    id: 'meta-description-too-long',
    category: 'meta-description',
    severity: 'warning',
    title: 'Meta description is too long',
    condition: `The first meta description with text has more than ${DESCRIPTION_MAX_CHARS} characters.`,
    why: 'Long descriptions are cut off in results, so the end of the message is lost.',
    fix: `Lead with the key point and trim the description to ${DESCRIPTION_MAX_CHARS} characters or fewer.`,
  },
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
    condition: 'A robots meta tag for all crawlers ("robots") or for one ("googlebot", "googlebot-news", "bingbot") contains "noindex" or "none". The finding names each tag that does. While it fails, the health score is capped (NOINDEX_SCORE_CAP).',
    why: 'Search engines drop a noindex page from their results. That is often deliberate (staging, thank-you pages) but costly when it is left on by mistake, and a crawler-specific tag is easy to miss.',
    fix: 'If this page should be found in search, remove noindex from the robots meta tags (including googlebot or bingbot ones).',
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
    condition: 'One or more rendered <img> elements (they have a layout box) lack a width or a height attribute (absent or empty).',
    why: 'Without both attributes the browser cannot reserve the image’s space before it loads, so the content below jumps when it arrives (layout shift, which hurts reading and Core Web Vitals).',
    fix: 'Add width and height attributes with the image’s intrinsic size (CSS can still scale it; the browser keeps the aspect ratio).',
  },
  {
    id: 'images-oversized',
    category: 'images',
    severity: 'warning',
    title: 'Images larger than they are shown',
    condition: `One or more images have a natural size more than ${IMAGE_OVERSIZE_FACTOR}× their rendered size in either dimension (both sizes known; SVG images are vectors and never count).`,
    why: 'The browser downloads and decodes every pixel of the file, then throws most of them away. That costs bandwidth and memory and slows the page down, most of all on phones.',
    fix: 'Serve images close to the size they are shown at, using srcset and sizes for different screens.',
  },
  {
    id: 'images-lazy-in-first-viewport',
    category: 'images',
    severity: 'warning',
    title: 'Lazy-loaded images in the first screen',
    condition: 'One or more images whose box overlaps the first viewport (the top of the page as it first appears) have loading="lazy".',
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
 * 64. When `robots-noindex` fails the result is then capped at `NOINDEX_SCORE_CAP`. The score only
 * ever goes down as issues are added, never below 0, and does not depend on the order of the
 * findings.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<SeoSeverity, number>> = {
  error: 0.2,
  warning: 0.07,
  info: 0.01,
};

/**
 * A page that asks not to be indexed (`robots-noindex`) gets at most this score, so it always
 * lands in the `poor` band and the score card says "Not indexable". The rule stays a warning, since
 * noindex is often intentional, but whatever else is right about the page, it will not appear in
 * search results while the tag is there, and a "Good" score would hide that.
 */
export const NOINDEX_SCORE_CAP = 59;
export const NOT_INDEXABLE_LABEL = 'Not indexable' as const;

/** The score's band (the ring's colour and label): at least `min`, the first match wins. */
export const SCORE_BANDS = [
  { id: 'good', min: 90, label: 'Good' },
  { id: 'fair', min: 60, label: 'Needs work' },
  { id: 'poor', min: 0, label: 'Poor' },
] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number]['id'];
