/**
 * Link status, sitemap and hreflang reciprocity checks (Phase 2.5 Task 7; acceptance
 * `seo-checks.feature.md`; review focus `link-checks-are-bounded`). Every check is started by the
 * user (a panel button or the command palette), for the active tab's ready audit, and every request
 * goes through main's bounded fetcher: the browse session, no cookies, no referrer, `http(s)` only,
 * at most `maxRedirects` redirects each checked before it is followed, never to a private host unless
 * the page itself is on one, size and time caps, and a per-origin rate limit. What a server answers
 * (a sitemap, an alternate's HTML) is parsed in the analysis worker, never on main's thread.
 *
 * Clean-room: limits, outcomes, wording and rules are frost's own, from the sitemaps protocol
 * (sitemaps.org), RFC 9110 (HEAD and GET), RFC 9309 (robots.txt) and how search engines document
 * hreflang return links.
 *
 * Plain values (importing only other plain specs), so the chrome renderer and `@app/seo-core` can
 * use them without bundling Zod. The Zod schemas are in `seo-checks.schema.ts`.
 */
import type { SeoRuleSpec } from './seo-rules.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';

// ---- Link checks ------------------------------------------------------------------------------

/**
 * How a link check run is bounded (review focus `link-checks-are-bounded`):
 * - `maxLinks`: unique `http(s)` targets fetched per run (the rest are `skipped`, `over-cap`);
 * - `perOriginConcurrency`: requests in flight to one origin at a time (also the bounded fetcher's
 *   `checks` lane, `CHECKS_FETCHER_LIMITS` in `fetcher.spec.ts`);
 * - `perOriginIntervalMs`: at least this long between two request starts to one origin (the rate limit; the lane's too);
 * - `maxConcurrency`: requests in flight in all;
 * - `requestTimeoutMs`: one link's deadline, its HEAD, GET fallback and redirects together;
 * - `maxRedirects`: redirects followed per link (one more is `too-many-redirects`);
 * - `getBodyBytes`: a GET fallback reads at most this much of the body, then the connection is aborted;
 * - `cacheEntries`: results kept per URL for the session (oldest dropped first).
 */
export const LINK_CHECK_LIMITS = {
  maxLinks: 500,
  perOriginConcurrency: 2,
  perOriginIntervalMs: 250,
  maxConcurrency: 6,
  requestTimeoutMs: 10_000,
  maxRedirects: 5,
  getBodyBytes: 16_384,
  cacheEntries: 5_000,
} as const;

/**
 * How one bounded fetch ended (main's fetcher, `checks-fetch.ts`, mapped from `FETCH_OUTCOMES`): `response` (a final, non-redirect
 * answer: its status says the rest), no answer in time (`timeout`) or at all (`unreachable`), a
 * redirect not followed (`too-many-redirects`, `bad-redirect`: not `http(s)`, `no-location`,
 * `private-redirect`: to a private host the page is not on), or `aborted` (the run was cancelled).
 */
export const CHECK_FETCH_OUTCOMES = ['response', 'timeout', 'unreachable', 'too-many-redirects', 'bad-redirect', 'no-location', 'private-redirect', 'aborted'] as const;
export type CheckFetchOutcome = (typeof CHECK_FETCH_OUTCOMES)[number];

/** HEAD answers that mean "this server does not do HEAD": the link is asked again with GET, and so is every later link to that origin in the run. */
export const HEAD_FALLBACK_STATUSES = [405, 501] as const;

/**
 * A checked link's outcome:
 * - `ok`: a 2xx answer, with no redirect;
 * - `redirect`: a 2xx answer after one or more redirects (`finalUrl` is where it ended);
 * - `broken`: a 4xx or 5xx answer, or no answer (`LINK_BROKEN_REASONS`);
 * - `blocked`: a same-origin link the page origin's robots.txt disallows for Googlebot (not fetched);
 * - `skipped`: not fetched (`LINK_SKIP_REASONS`).
 */
export const LINK_STATUS_KINDS = ['ok', 'redirect', 'broken', 'blocked', 'skipped'] as const;
export type LinkStatusKind = (typeof LINK_STATUS_KINDS)[number];

/** Why a link is `broken`: an error status, or no usable answer. */
export const LINK_BROKEN_REASONS = ['http-error', 'unreachable', 'timeout', 'too-many-redirects', 'bad-redirect', 'no-location', 'other-status'] as const;
export type LinkBrokenReason = (typeof LINK_BROKEN_REASONS)[number];

/** Why a link is `skipped`: not `http(s)`, a private host the page is not on (or a redirect to one), or past `maxLinks`. */
export const LINK_SKIP_REASONS = ['not-http', 'private', 'over-cap'] as const;
export type LinkSkipReason = (typeof LINK_SKIP_REASONS)[number];

export type LinkCheckReason = LinkBrokenReason | LinkSkipReason;

/** The robots.txt crawler whose verdict makes a same-origin link `blocked`. */
export const LINK_ROBOTS_AGENT = 'Googlebot' as const;

/** The labels the Links panel shows (frost's own words). */
export const LINK_STATUS_LABELS: Readonly<Record<LinkStatusKind, string>> = { ok: 'OK', redirect: 'Redirect', broken: 'Broken', blocked: 'Blocked by robots.txt', skipped: 'Skipped' };
export const LINK_REASON_LABELS: Readonly<Record<LinkCheckReason, string>> = {
  'http-error': 'Error status',
  unreachable: 'No answer',
  timeout: 'Timed out',
  'too-many-redirects': 'Too many redirects',
  'bad-redirect': 'Redirect to a non-web address',
  'no-location': 'Redirect without a Location',
  'other-status': 'Unexpected status',
  'not-http': 'Not an http(s) link',
  private: 'Private address',
  'over-cap': `Past the first ${LINK_CHECK_LIMITS.maxLinks} links`,
};

/** One unique link target's result. `url` is the link's `href` without its `#fragment`. */
export interface LinkCheckResult {
  readonly url: string;
  readonly kind: LinkStatusKind;
  /** The final HTTP status (`null`: none, or not fetched). */
  readonly status: number | null;
  /** Where the redirects ended (`null`: not fetched, or no redirect). */
  readonly finalUrl: string | null;
  readonly redirects: number;
  readonly reason: LinkCheckReason | null;
  /** The method of the answer kept (`null`: not fetched). */
  readonly method: 'HEAD' | 'GET' | null;
  /** From the session cache, not fetched in this run. */
  readonly cached: boolean;
}

// ---- Runs ---------------------------------------------------------------------------------------

/**
 * A check's run on the tab's current document and URL (fragment aside):
 * - `idle`: none (or it belonged to another URL or document);
 * - `running`: under way, results arriving;
 * - `done`: every request answered;
 * - `stopped`: the user pressed Stop (the results so far are kept);
 * - `cancelled`: the page navigated or the tab closed (nothing is kept);
 * - `failed`: it could not run (no ready audit, nothing to check, the worker failed).
 */
export const CHECK_RUN_STATUSES = ['idle', 'running', 'done', 'stopped', 'cancelled', 'failed'] as const;
export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];

/** Which check: the Links panel's, or one of the Indexability panel's. */
export const CHECK_KINDS = ['links', 'sitemaps', 'hreflang'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface LinkRunState {
  readonly status: CheckRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Unique targets in the run (fetched or not). */
  readonly total: number;
  /** How many have a result. */
  readonly settled: number;
  /** In the links' order (unique targets only). */
  readonly results: readonly LinkCheckResult[];
}

export const IDLE_LINK_RUN: LinkRunState = { status: 'idle', startedAt: null, finishedAt: null, total: 0, settled: 0, results: [] };

/** How long main waits between two pushes of a running check's progress (`checks.watch` wakes at most this often). */
export const CHECKS_PUSH_INTERVAL_MS = 200;

/** How many `checks.watch` long-polls may wait at once; one more answers the oldest early. */
export const MAX_PENDING_CHECK_WATCHES = 8;

// ---- Sitemaps -----------------------------------------------------------------------------------

/** The sitemaps protocol's namespace: a `<urlset>` or `<sitemapindex>` root in any other is `wrong-namespace`. */
export const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

/**
 * How sitemap reading is bounded:
 * - `maxBytes`: per file, uncompressed (the protocol's own limit): a download is read up to this,
 *   and a gzip file is inflated up to this, then stopped (`too-large`);
 * - `maxFiles`: files read per run, indexes included;
 * - `maxDepth`: index levels followed (robots.txt's files are depth 0, an index's children depth 1 …);
 * - `maxUrls`: `<url>` entries counted per run (the protocol's per-file limit);
 * - `timeoutMs`: one file's deadline (its redirects and download);
 * - `maxLocChars`: a `<loc>` longer than this is not a URL frost reads;
 * - `maxSources`: robots.txt `Sitemap:` lines taken;
 * - `maxErrors`, `maxSamples`: errors and `lastmod` samples kept.
 */
export const SITEMAP_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  maxDepth: 2,
  maxUrls: 50_000,
  timeoutMs: 60_000,
  maxLocChars: SNAPSHOT_LIMITS.maxUrlChars,
  maxSources: 10,
  maxErrors: 20,
  maxSamples: 5,
} as const;

/** Where the run's first sitemaps came from: robots.txt's `Sitemap:` lines, or `/sitemap.xml` of the page's origin when there were none. */
export const SITEMAP_SOURCES = ['robots', 'fallback'] as const;
export type SitemapSource = (typeof SITEMAP_SOURCES)[number];

/**
 * What went wrong with one file (or the run):
 * - `unreachable`, `timeout`, `http-error` (a non-2xx answer), `redirect` (too many, private, not http(s));
 * - `malformed`: not well-formed XML; `dtd-refused`: it has a `<!DOCTYPE>` (refused before any entity
 *   is read: no DTDs, no entity expansion); `not-sitemap`: the root is neither `<urlset>` nor
 *   `<sitemapindex>`; `wrong-namespace`: the root is not in `SITEMAP_NAMESPACE`;
 * - `too-large`: over `maxBytes` (downloaded or inflated); `too-many-urls`: past `maxUrls`;
 * - `too-many-files`, `too-deep`: an index pointed past `maxFiles` or `maxDepth` (those files are not read).
 */
export const SITEMAP_ERROR_KINDS = ['unreachable', 'timeout', 'http-error', 'redirect', 'malformed', 'dtd-refused', 'not-sitemap', 'wrong-namespace', 'too-large', 'too-many-urls', 'too-many-files', 'too-deep'] as const;
export type SitemapErrorKind = (typeof SITEMAP_ERROR_KINDS)[number];

export const SITEMAP_ERROR_LABELS: Readonly<Record<SitemapErrorKind, string>> = {
  unreachable: 'Could not be reached',
  timeout: 'Timed out',
  'http-error': 'Error status',
  redirect: 'Redirect not followed',
  malformed: 'Not well-formed XML',
  'dtd-refused': 'Has a DOCTYPE (refused)',
  'not-sitemap': 'Not a sitemap',
  'wrong-namespace': 'Wrong namespace',
  'too-large': `Over ${SITEMAP_LIMITS.maxBytes / 1024 / 1024} MB uncompressed`,
  'too-many-urls': `Past ${SITEMAP_LIMITS.maxUrls.toLocaleString('en-US')} URLs`,
  'too-many-files': `Past ${SITEMAP_LIMITS.maxFiles} files`,
  'too-deep': `Index nested past ${SITEMAP_LIMITS.maxDepth} levels`,
};

/** The errors that make a sitemap "unreachable or invalid" (`sitemap-unreachable`); the caps frost applies are not the site's fault. */
export const SITEMAP_INVALID_ERRORS = ['unreachable', 'timeout', 'http-error', 'redirect', 'malformed', 'dtd-refused', 'not-sitemap', 'wrong-namespace', 'too-large'] as const satisfies readonly SitemapErrorKind[];

/** One file read (or tried). */
export interface SitemapFileReport {
  readonly url: string;
  readonly depth: number;
  /** `null`: not read far enough to know. */
  readonly type: 'urlset' | 'index' | null;
  readonly status: number | null;
  readonly gzip: boolean;
  /** `<url>` entries (a `urlset`) or `<sitemap>` entries (an index). */
  readonly entries: number;
  readonly error: SitemapErrorKind | null;
}

/** A `lastmod` problem: not a W3C Datetime, or later than `LASTMOD_FUTURE_SLACK_MS` from now. */
export const LASTMOD_ISSUES = ['invalid', 'future'] as const;
export type LastmodIssue = (typeof LASTMOD_ISSUES)[number];

/** A `lastmod` this far past the check's clock is in the future (time zones and clock skew aside). */
export const LASTMOD_FUTURE_SLACK_MS = 24 * 60 * 60 * 1_000;

export interface SitemapRunState {
  readonly status: CheckRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly source: SitemapSource | null;
  readonly files: readonly SitemapFileReport[];
  /** `<url>` entries counted across every file (at most `maxUrls`). */
  readonly urlCount: number;
  /** Whether the page's URL (fragment aside) is a `<loc>` of one of them; `null` when no `urlset` was read. */
  readonly listed: boolean | null;
  readonly lastmod: { readonly invalid: number; readonly future: number; readonly samples: readonly string[] };
  readonly errors: readonly { readonly url: string; readonly kind: SitemapErrorKind }[];
}

export const IDLE_SITEMAP_RUN: SitemapRunState = { status: 'idle', startedAt: null, finishedAt: null, source: null, files: [], urlCount: 0, listed: null, lastmod: { invalid: 0, future: 0, samples: [] }, errors: [] };

// ---- hreflang reciprocity -----------------------------------------------------------------------

/**
 * How the reciprocity check is bounded: at most `maxAlternates` alternates (other than the page
 * itself and `x-default` duplicates) are fetched, each up to `maxBytes` and `timeoutMs`; the parse in
 * the worker reads `<link rel="alternate" hreflang>` in `<head>` only (stopping at `</head>` or
 * `<body>`), at most `maxLinks` of them, and the `Link` header's.
 */
export const HREFLANG_CHECK_LIMITS = {
  maxAlternates: 20,
  maxBytes: 1024 * 1024,
  timeoutMs: 10_000,
  maxLinks: SNAPSHOT_LIMITS.maxHreflang,
  maxHeaderChars: 8_192,
} as const;

/**
 * One alternate's outcome:
 * - `reciprocal`: it lists this page back, with the language this page declares for itself
 *   (or, when this page does not list itself, any language);
 * - `wrong-language`: it lists this page back, but only with another language;
 * - `missing-return`: it does not list this page;
 * - `unreachable`: no 2xx HTML answer (`status` says what came back);
 * - `skipped`: not fetched (a private host the page is not on, not http(s), or past the cap).
 */
export const RECIPROCITY_STATUSES = ['reciprocal', 'wrong-language', 'missing-return', 'unreachable', 'skipped'] as const;
export type ReciprocityStatus = (typeof RECIPROCITY_STATUSES)[number];

export const RECIPROCITY_LABELS: Readonly<Record<ReciprocityStatus, string>> = {
  reciprocal: 'Links back',
  'wrong-language': 'Links back with another language',
  'missing-return': 'Does not link back',
  unreachable: 'Could not be read',
  skipped: 'Not checked',
};

/** The outcomes `hreflang-no-return-link` reports. */
export const NO_RETURN_STATUSES = ['wrong-language', 'missing-return'] as const satisfies readonly ReciprocityStatus[];

export interface HreflangAlternateResult {
  /** The hreflang value this page gives it. */
  readonly lang: string;
  readonly url: string;
  readonly status: ReciprocityStatus;
  readonly httpStatus: number | null;
  /** The languages it lists this page under (`[]`: none). */
  readonly returnLangs: readonly string[];
}

export interface HreflangRunState {
  readonly status: CheckRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly alternates: readonly HreflangAlternateResult[];
  /** Alternates past `maxAlternates` (not checked). */
  readonly over: number;
}

export const IDLE_HREFLANG_RUN: HreflangRunState = { status: 'idle', startedAt: null, finishedAt: null, alternates: [], over: 0 };

// ---- What the chrome reads ------------------------------------------------------------------------

/** `checks.watch` answers this: the tab's three runs for the URL it shows now, and the service's version. */
export interface ChecksState {
  readonly version: number;
  readonly tabId: number;
  /** The URL the runs are for (fragment aside); `''`: the tab shows no web page. */
  readonly url: string;
  readonly links: LinkRunState;
  readonly sitemaps: SitemapRunState;
  readonly hreflang: HreflangRunState;
}

/**
 * Every check surface says this (Global Constraints: fetching on the user's behalf). frost's own
 * words: the requests are not hidden from the sites.
 */
export const CHECKS_VISIBILITY_NOTICE = 'frost requests these URLs itself, without cookies: the sites being checked can see the requests in their logs.';

// ---- Analysis ------------------------------------------------------------------------------------

/**
 * One check analysis in the worker (a sitemap file, an alternate's head, a robots.txt match) has
 * this long; past it the checks' worker is terminated and the job is `analysis-timeout`. Longer
 * than the audit's (`ANALYSIS_TIMEOUT_MS`): a sitemap can be 50 MB. Checks have a worker of their own,
 * so a long parse never holds an audit back.
 */
export const CHECKS_ANALYSIS_TIMEOUT_MS = 20_000;

// ---- Rules ---------------------------------------------------------------------------------------

/**
 * The checks' rules (spread into `SEO_RULE_SPECS`). Each passes until its check has run on the page
 * shown: an unchecked page has no finding.
 */
export const CHECKS_RULE_SPECS = [
  {
    id: 'links-broken',
    category: 'links',
    severity: 'warning',
    title: 'Broken links',
    condition: 'A link check ran on the page, and one or more checked links answered a 4xx or 5xx status or could not be reached (no answer, a timeout, too many redirects).',
    why: 'Broken links send people to dead ends and waste crawl time; links to missing pages pass no value.',
    fix: 'Update each link to the target’s current URL, or remove it. If a page of yours is gone, redirect it to its replacement.',
  },
  {
    id: 'links-internal-redirect',
    category: 'links',
    severity: 'info',
    title: 'Internal links that redirect',
    condition: 'A link check ran on the page, and one or more links to the same site reached their target only through a redirect.',
    why: 'Every redirect costs people a round trip and crawlers a little time, and the final URL is the one search engines index.',
    fix: 'Point internal links straight at the final URL.',
  },
  {
    id: 'sitemap-page-not-listed',
    category: 'indexability',
    severity: 'info',
    title: 'Page is not in any sitemap',
    condition: 'A sitemap check read at least one <urlset>, and none of the files read lists the page’s URL (its #fragment aside) as a <loc>.',
    why: 'A sitemap tells search engines which URLs the site wants found. A page left out may be discovered later, or not at all if few pages link to it.',
    fix: 'Add the page’s canonical URL to the sitemap, or check whether it should be indexed at all.',
  },
  {
    id: 'sitemap-unreachable',
    category: 'indexability',
    severity: 'warning',
    title: 'Sitemap unreachable or invalid',
    condition: 'A sitemap check ran, and a sitemap could not be fetched (no answer, an error status, a redirect frost does not follow), is not well-formed XML, has a DOCTYPE, is not a <urlset> or <sitemapindex> in the sitemaps namespace, or is over 50 MB uncompressed.',
    why: 'Search engines read sitemaps the same way. One they cannot fetch or parse tells them nothing, so the URLs in it are found only through links.',
    fix: 'Serve each sitemap with a 200 status as well-formed XML in the sitemaps.org namespace, under 50 MB (split it and add a sitemap index if needed), and list it in robots.txt.',
  },
  {
    id: 'hreflang-no-return-link',
    category: 'hreflang',
    severity: 'warning',
    title: 'hreflang alternate does not link back',
    condition: 'A reciprocity check ran, and one or more alternates the page lists (other than itself) do not list this page back, or list it only with another language than the page gives itself.',
    why: 'Search engines use an hreflang pair only when both pages point to each other. A one-way annotation is ignored, so the wrong language version may be shown.',
    fix: 'Give every language version the same complete hreflang set, each page listing itself and all the others with the same codes.',
  },
] as const satisfies readonly SeoRuleSpec[];
