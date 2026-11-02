/**
 * URL Inspection (Phase 9 Task 2; acceptance `gsc-inspection.feature.md`; plan Decisions 1, 2, 3 and
 * 6). Plain values and functions with no Zod, so the chrome renderer (Task 4's card) can use them: its
 * strict Trusted Types CSP blocks Zod's eval probe. The Zod schemas (Google's answer, frost's answer,
 * the inputs) are in `gsc-inspection.schema.ts`.
 *
 * Main asks Google's URL Inspection API (`POST <GSC_ENDPOINTS.inspectionBase>/urlInspection/index:inspect`)
 * about one page, only when the user asks, over the same read-only connection (`GSC_SCOPE`). What Google
 * answers is untrusted text: every string is capped, every enum read against the tables below (a code
 * frost does not know is `unknown`, with Google's raw code kept for display), and Google's
 * `inspectionResultLink` is kept only when it is `https://search.google.com/…`. `sitemap`,
 * `referringUrls`, AMP and the deprecated mobile-usability result are dropped while parsing.
 *
 * Clean-room: the labels are frost's own words; the codes are Google's public API.
 */

// ---- Enums --------------------------------------------------------------------------------------

/**
 * A verdict (the index status and the rich results), with frost's label. Google's `PARTIAL` (reserved,
 * no longer used) and `VERDICT_UNSPECIFIED` are not here: they read as `unknown`.
 */
export const GSC_INSPECTION_VERDICTS = Object.freeze({
  PASS: 'Passed',
  FAIL: 'Failed',
  NEUTRAL: 'Excluded',
} as const);
export type GscInspectionVerdict = keyof typeof GSC_INSPECTION_VERDICTS;

/** Whether Google's last crawl found the page allowed by robots.txt. */
export const GSC_ROBOTS_TXT_STATES = Object.freeze({
  ALLOWED: 'Allowed',
  DISALLOWED: 'Blocked by robots.txt',
} as const);
export type GscRobotsTxtState = keyof typeof GSC_ROBOTS_TXT_STATES;

/** Whether indexing is allowed, and what blocked it. */
export const GSC_INDEXING_STATES = Object.freeze({
  INDEXING_ALLOWED: 'Indexing allowed',
  BLOCKED_BY_META_TAG: 'Blocked by a robots meta tag',
  BLOCKED_BY_HTTP_HEADER: 'Blocked by an X-Robots-Tag header',
  BLOCKED_BY_ROBOTS_TXT: 'Blocked by robots.txt',
} as const);
export type GscIndexingState = keyof typeof GSC_INDEXING_STATES;

/** How Google's last fetch of the page went. */
export const GSC_PAGE_FETCH_STATES = Object.freeze({
  SUCCESSFUL: 'Fetched',
  SOFT_404: 'Soft 404',
  BLOCKED_ROBOTS_TXT: 'Blocked by robots.txt',
  NOT_FOUND: 'Not found (404)',
  ACCESS_DENIED: 'Unauthorized (401)',
  SERVER_ERROR: 'Server error (5xx)',
  REDIRECT_ERROR: 'Redirect error',
  ACCESS_FORBIDDEN: 'Forbidden (403)',
  BLOCKED_4XX: 'Other client error (4xx)',
  INTERNAL_CRAWL_ERROR: 'Google crawl error',
  INVALID_URL: 'Invalid URL',
} as const);
export type GscPageFetchState = keyof typeof GSC_PAGE_FETCH_STATES;

/** Which of Google's crawlers last fetched the page. */
export const GSC_CRAWLED_AS = Object.freeze({
  DESKTOP: 'Desktop crawler',
  MOBILE: 'Smartphone crawler',
} as const);
export type GscCrawledAs = keyof typeof GSC_CRAWLED_AS;

/** A rich result issue's severity. */
export const GSC_RICH_SEVERITIES = Object.freeze({
  WARNING: 'Warning',
  ERROR: 'Error',
} as const);
export type GscRichSeverity = keyof typeof GSC_RICH_SEVERITIES;

/** What a raw code Google sent must look like to be kept (for display) when frost does not know it. */
export const GSC_INSPECTION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * An enum value as frost answers it: a code of the table (`value`), or `unknown` with Google's raw code
 * (`code`, matching `GSC_INSPECTION_CODE_PATTERN`; `null` when absent or not code-shaped). A new code
 * Google adds reads as `unknown`, and the chrome shows the raw code as inert text.
 */
export type GscInspectionCode<K extends string> = { readonly value: K } | { readonly value: 'unknown'; readonly code: string | null };

/** `raw` read against `known` (one of the tables above). Never throws. */
export function readGscInspectionCode<K extends string>(known: Readonly<Record<K, string>>, raw: unknown): GscInspectionCode<K> {
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(known, raw)) return { value: raw as K };
  return { value: 'unknown', code: typeof raw === 'string' && GSC_INSPECTION_CODE_PATTERN.test(raw) ? raw : null };
}

// ---- Limits, rate, link -------------------------------------------------------------------------

export const GSC_INSPECTION_LIMITS = {
  /** At most this many detected rich result items in all (and this many types). */
  maxItems: 50,
  /** At most this many issues per item. */
  maxIssues: 20,
  /** Longest text kept from Google (coverage state, rich result type, item name, issue message); longer is cut. */
  maxTextChars: 500,
} as const;

/**
 * Inspection calls go through their own token bucket, separate from `GSC_RATE_LIMIT`: neither drains
 * the other. A call with no token left is not sent and answers `quota`. (Google's own limit, 2,000 a
 * day and 600 a minute per site, answers 429: also `quota`. frost keeps no daily counter.)
 */
export const GSC_INSPECTION_RATE = { perSecond: 1, burst: 3 } as const;

/** The only host "Open in Search Console" ever opens (`https:` only). */
export const GSC_INSPECTION_LINK_HOST = 'search.google.com';

/**
 * Whether `url` is a link frost may open for an inspection: `https:`, host exactly
 * `GSC_INSPECTION_LINK_HOST` (no other port, no credentials). Never throws.
 */
export function isGscInspectionLink(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname === GSC_INSPECTION_LINK_HOST && parsed.port === '' && parsed.username === '' && parsed.password === '';
}

// ---- Open link ----------------------------------------------------------------------------------

/**
 * `gsc.openInspectionLink({ url })` (the page, never the link):
 * - `opened`: main opened its cached answer's link in the system browser;
 * - `needs-gesture`: no live user gesture in the window that asked: nothing opened;
 * - `no-link`: no cached `ok` answer for that page, it has no link, its host is not
 *   `GSC_INSPECTION_LINK_HOST`, or the open was refused: nothing opened.
 */
export const GSC_OPEN_LINK_RESULTS = ['opened', 'needs-gesture', 'no-link'] as const;
export type GscOpenLinkResult = (typeof GSC_OPEN_LINK_RESULTS)[number];
