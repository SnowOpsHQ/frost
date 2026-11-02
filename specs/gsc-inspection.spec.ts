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

// ---- The card (Phase 9 Task 4; acceptance `gsc-inspection.feature.md`, Card) ----------------------

/**
 * What the inspection card shows (Indexability: "Google's view"; Schema: "Detected by Google"). It is
 * hidden (no state) until main answers the connection, and when this build has no Search Console
 * client (`unconfigured`, or the never-sent `not-entitled`).
 * - `not-connected`: no Google account connected (or a connect is waiting): Connect opens Settings;
 * - `no-property`: none of the user's verified properties covers the page;
 * - `idle`: nothing asked for this page yet: "Inspect in Search Console" asks (`{ url }`);
 * - `inspecting`: a request for this page is running (an earlier answer stays shown, dimmed);
 * - `ok`: Google's answer; "Inspect again" asks with `{ url, fresh: true }`;
 * - `quota`, `network`, `invalid`: Try again (`{ url }`);
 * - `auth-expired`: Google refused the connection: Reconnect opens Settings;
 * - `not-a-web-page`: the tab shows no `http(s)` page (nothing is sent).
 */
export const GSC_INSPECTION_STATES = ['not-connected', 'no-property', 'idle', 'inspecting', 'ok', 'quota', 'network', 'invalid', 'auth-expired', 'not-a-web-page'] as const;
export type GscInspectionState = (typeof GSC_INSPECTION_STATES)[number];

/**
 * A state's button: open Settings on Search Console, ask Google (`inspect` and `retry` send `{ url }`),
 * or ask again past main's cache (`inspect-again` sends `{ url, fresh: true }`).
 */
export const GSC_INSPECTION_ACTIONS = ['open-gsc-settings', 'inspect', 'inspect-again', 'retry'] as const;
export type GscInspectionAction = (typeof GSC_INSPECTION_ACTIONS)[number];

/** Where the card is shown: Indexability (Google's index status) or Schema (Google's rich results). */
export const GSC_INSPECTION_CARDS = ['index', 'rich'] as const;
export type GscInspectionCardKind = (typeof GSC_INSPECTION_CARDS)[number];

/** A state's words (`{host}` filled in by the chrome) and its button, if any. */
export interface GscInspectionStateCopy {
  readonly message: string;
  readonly action: GscInspectionAction | null;
  readonly actionLabel: string | null;
}

/**
 * The card's words (frost's own). "Google's view" is Google's **indexed** version from its last crawl,
 * never a live test of the page: the card says so and gives the time of that crawl. A code frost does
 * not know is shown as `unknown` with Google's raw code beside it, as inert text. Strings from Google
 * (coverage, rich result types, item names, issue messages) and canonical URLs are inert,
 * bidi-isolated text; the Search Console link is never shown or opened by the chrome
 * (`gsc.openInspectionLink` names the page).
 */
export const GSC_INSPECTION_COPY = Object.freeze({
  titles: Object.freeze({ index: "Google's view", rich: 'Detected by Google' } satisfies Record<GscInspectionCardKind, string>),
  states: Object.freeze({
    'not-connected': {
      message: 'Connect a Google account in Settings to see how Google indexed this page. frost only asks for read-only access.',
      action: 'open-gsc-settings',
      actionLabel: 'Connect in Settings',
    },
    'no-property': { message: 'None of your Search Console properties covers {host}.', action: null, actionLabel: null },
    idle: {
      message: "Ask Google how it indexed this page: coverage, last crawl, canonical and rich results. It runs only when you click, and counts toward Search Console's inspection quota.",
      action: 'inspect',
      actionLabel: 'Inspect in Search Console',
    },
    inspecting: { message: 'Asking Google…', action: null, actionLabel: null },
    ok: { message: "Google's indexed version of this page, from its last crawl. It is not a live test of the page.", action: 'inspect-again', actionLabel: 'Inspect again' },
    quota: { message: "Search Console's inspection limit was reached. Try again in a minute.", action: 'retry', actionLabel: 'Try again' },
    network: { message: "frost couldn't reach Google. Check your connection and try again.", action: 'retry', actionLabel: 'Try again' },
    invalid: { message: "Search Console answered something frost couldn't read.", action: 'retry', actionLabel: 'Try again' },
    'auth-expired': { message: 'Google no longer accepts this connection. Reconnect in Settings.', action: 'open-gsc-settings', actionLabel: 'Reconnect in Settings' },
    'not-a-web-page': { message: 'Google inspects web pages (http and https) only.', action: null, actionLabel: null },
  } satisfies Record<GscInspectionState, GscInspectionStateCopy>),
  labels: Object.freeze({
    verdict: 'Verdict',
    coverage: 'Coverage',
    indexing: 'Indexing',
    robotsTxt: 'robots.txt',
    pageFetch: 'Page fetch',
    lastCrawl: 'Last crawl',
    crawledAs: 'Crawled as',
    googleCanonical: "Google's canonical",
    userCanonical: 'Your canonical (as Google read it)',
    auditCanonical: 'Canonical frost read',
    richVerdict: 'Rich results',
  }),
  text: Object.freeze({
    /** A value Google did not report. */
    notReported: 'Not reported',
    /** No last crawl time: Google has not crawled the page. */
    notCrawled: 'Not crawled yet',
    /** A code frost does not know (Google's raw code, if any, is shown beside it as inert text). */
    unknown: 'Not recognised',
    /** `{relative}` and `{absolute}` filled in by the chrome. */
    lastCrawl: '{relative} ({absolute})',
    inspectedAt: 'Inspected {relative}',
    justNow: 'just now',
    openInSearchConsole: 'Open in Search Console',
    noRichResults: 'Google reported no rich results for this page.',
    noIssues: 'No issues',
    /** A rich result item without a name. */
    unnamedItem: 'Unnamed item',
    /** The fact under a canonical mismatch: no rule or score reads it. */
    canonicalFact: 'Shown as a fact: it changes no check or score.',
  }),
  /** What `gsc.openInspectionLink` answered, as a short status line. */
  openResults: Object.freeze({
    opened: 'Opened in your browser',
    'needs-gesture': 'Click Open in Search Console again to open it.',
    'no-link': 'Search Console has no page for this inspection. Inspect again, then open it.',
  } satisfies Record<GscOpenLinkResult, string>),
});

/**
 * How another canonical compares with Google's, both resolved against the page and without their
 * fragments: the same URL, a different one (`google-differs`: Google chose another), or none to compare
 * (`user-missing`). A mismatch is a fact shown on the card; no rule or score reads it.
 */
export const GSC_CANONICAL_MATCH = Object.freeze({
  same: "Same as Google's",
  'google-differs': 'Google chose another URL',
  'user-missing': 'None declared',
} as const);
export type GscCanonicalMatch = keyof typeof GSC_CANONICAL_MATCH;

/** `url` resolved against `base`, without its fragment; `null` when it does not parse. */
function canonicalKey(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * How `other` (the canonical the page declares, as Google read it or as frost read it) compares with
 * Google's (`google`), both resolved against `base` (the page) and without fragments. `null` when
 * Google reported none (nothing to compare with). Never throws.
 */
export function gscCanonicalMatch(google: string | null, other: string | null, base: string): GscCanonicalMatch | null {
  if (google === null || google === '') return null;
  if (other === null || other === '') return 'user-missing';
  // A URL that does not parse is compared as written.
  const a = canonicalKey(google, base) ?? google;
  const b = canonicalKey(other, base) ?? other;
  return a === b ? 'same' : 'google-differs';
}

/** Rich result issues are listed by severity: errors, then warnings, then codes frost does not know. */
export const GSC_RICH_SEVERITY_ORDER: readonly (GscRichSeverity | 'unknown')[] = Object.freeze(['ERROR', 'WARNING', 'unknown']);

/**
 * The chrome keeps the answers (and running requests) of at most this many pages, one shared entry
 * per page (URL without fragment) for every tab and both cards; the oldest goes first. A new Search
 * Console connection (`gsc.watch`'s version) drops them all.
 */
export const GSC_INSPECTION_HELD_PAGES = 20;
