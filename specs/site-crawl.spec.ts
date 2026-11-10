/**
 * The site crawler (Phase 12, bet B, Tasks 5–7; plan `docs/plans/phase-12-big-bets.md`, Decision 6;
 * acceptance `site-crawl.feature.md`; shapes `site-crawl.schema.ts`; the crawl lane and the
 * redirect-policy hook `fetcher.spec.ts`).
 *
 * The crawler fetches **served HTML**, never rendered pages: one bounded-fetcher lane of its own
 * (`CRAWL_FETCHER_LIMITS`), one request per origin at a time, at the effective interval (the user's
 * choice in `CRAWL_INTERVAL_MS`, raised to the site's `Crawl-delay` capped at `MAX_CRAWL_DELAY_MS`,
 * raised again by back-off and `Retry-After` capped at `CRAWL_LIMITS.maxRetryAfterMs`). robots.txt is
 * always honoured (no override in v1), matched for the bare product token `CRAWL_ROBOTS_TOKEN`, never
 * for the user agent header sent. Pages are parsed in a worker of their own and audited with only the
 * served-HTML rules (`CRAWL_RULE_IDS`); the result is the crawl's own score (`CRAWL_SCORE_LABEL`),
 * never the sidebar's health score.
 *
 * Storage (`SITE_CRAWL_TABLES`, migrations `0240_site_crawl` and `0241_site_crawl_guards` in
 * `packages/db/src/site-crawl/`, and `0246_crawl_run_pacing` for a run's pacing): a run, its
 * pages, its links (capped per page) and its frontier.
 * Crawl data is the user's working data, deleted per run (Delete run, or deleting the project it
 * belongs to); it is not part of Clear Browsing Data or project retention.
 *
 * Plain values and types with no Zod, so seo-core (the crawl's pure modules) and the chrome can
 * import them.
 */
import { SERVED_FETCH_LIMITS } from './seo-javascript.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import type { SeoCategory, SeoRuleId } from './seo-rules.spec';

// ---- The legal gate ---------------------------------------------------------------------------

/**
 * Whether a crawl may be **started or resumed** in this build: the legal gate L6 (plan Decision 2,
 * and the lead's ruling in the plan's "As built" section). `false` until the owner's written L6 note
 * exists; flipped to `true` only by the change that adds that note under `docs/research/`.
 *
 * While it is `false`, main refuses `start` and `resume` with the outcome `unavailable` and
 * `LEGAL_GATE_NOTE` (Tasks 6b and 7 wire it, through `legalGates.isOpen('crawl')`), whatever the
 * renderer sends; the renderer reads `available` from main's crawl view (`CrawlStatusViewSchema`) and
 * hides or disables Start and Resume with that note. Viewing, exporting and deleting existing runs
 * are never gated.
 *
 * Unit tests open it by injection (the `isOpen` / `legalGates` dependency), never by editing it. The
 * e2e suite and the lead's UI pass open it with the unpackaged-only switch
 * `--frost-e2e-open-gates=crawl` (`LEGAL_GATES_E2E_SWITCH`; a packaged build refuses to start with it).
 */
export const CRAWL_AVAILABLE = false as boolean;

// ---- Limits -------------------------------------------------------------------------------------

/**
 * The crawl's bounds:
 * - `defaultMaxPages`: pages a run records unless the user asks for fewer or more;
 * - `maxPagesCap`: the hard cap on `maxPages` (K-B3: lowered if main's heap grows past 150 MB over a
 *   real 10 000-page crawl);
 * - `maxDepth`: clicks from the start URL (the start is depth 0; sitemap seeds are depth 1);
 * - `maxQueryVariantsPerPath`: distinct query strings queued per path (after tracking parameters are
 *   stripped), so an infinite URL space (a calendar, faceted search) stays bounded;
 * - `maxBodyBytes`: body bytes read per page, the served-HTML fetch's own cap
 *   (`SERVED_FETCH_LIMITS.maxBytes`, about 5 MB), so the crawl parses exactly what the sidebar's
 *   served audit would; a longer page is parsed on what was read (`partial`);
 * - `maxLinksStoredPerPage`: rows of `crawl_links` kept per page. The served parse already caps the
 *   links it sees at `SNAPSHOT_LIMITS.maxLinks` (1 000; `linkTotal` keeps the real count), but 10 000
 *   pages × 1 000 links would be ten million rows; 200 keeps every navigation and in-content link of a
 *   typical page while bounding the table at two million rows for the largest run. Discovery still
 *   uses every link the snapshot holds; only storage is capped;
 * - `backoffAfter`: 429 or 503 answers in a row that pause the run ("The site asked frost to slow
 *   down"); each one doubles the interval first;
 * - `maxRetryAfterMs`: the longest `Retry-After` honoured (seconds or a date); a longer one waits this;
 * - `maxPacedHosts`: hosts whose pacing state (last start, back-off, `Retry-After`, `Crawl-delay`) the
 *   crawl holds at once (Task 6a review). An entry is forgotten only once no start could be early
 *   without it (its longest possible wait has passed); a new host past the cap is not fetched (the run
 *   pauses with `slow-down`, the URL stays queued). Counted in `maxInMemoryEntries`;
 * - `maxInMemoryEntries`: the most per-page entries the crawler holds in memory at once, all its
 *   structures counted (the frontier window read from SQLite, pending rows, per-origin state; K-B3).
 *   Everything else is in SQLite. 2 000 entries of a few hundred bytes each stay well under a
 *   megabyte, while a frontier window of that size keeps SQLite reads infrequent;
 * - `maxPrefixes`, `maxPrefixChars`: include and exclude **prefix** lists (no regular expressions:
 *   nothing user-typed can backtrack);
 * - `maxUrlChars`: the longest URL the crawl queues or stores (the fetcher cuts at the same length);
 * - `maxListedRuns`: runs one crawl view lists (newest first);
 * - `deleteChunkRows`: rows one statement deletes when a run is deleted (links, then pages and the
 *   frontier, chunk by chunk, yielding between chunks, so a 10 000-page run never holds main's thread);
 * - `frontierWindow` (Task 6b): queued frontier entries the crawler reads from SQLite at once, oldest
 *   first; it reads the next window only when this one is used up (counted in `maxInMemoryEntries`);
 * - `sitemapUrlsPerJob` (Task 6b): sitemap `<loc>` URLs one worker answer carries when a sitemap seeds
 *   the frontier; a longer file is read again for the next ones (counted in `maxInMemoryEntries`).
 */
export const CRAWL_LIMITS = {
  defaultMaxPages: 500,
  maxPagesCap: 10_000,
  maxDepth: 10,
  maxQueryVariantsPerPath: 20,
  maxBodyBytes: SERVED_FETCH_LIMITS.maxBytes,
  maxLinksStoredPerPage: 200,
  backoffAfter: 5,
  maxRetryAfterMs: 60_000,
  maxPacedHosts: 256,
  maxInMemoryEntries: 2_000,
  maxPrefixes: 20,
  maxPrefixChars: 256,
  maxUrlChars: 2_048,
  maxListedRuns: 100,
  deleteChunkRows: 5_000,
  frontierWindow: 100,
  sitemapUrlsPerJob: 1_000,
} as const;

/**
 * The crawl worker's deadline per job (ms; Task 6b): a page's parse and audit, a robots.txt parse, or
 * one sitemap file's read (a sitemap may be `SITEMAP_LIMITS.maxBytes`, so the checks' own deadline,
 * `CHECKS_ANALYSIS_TIMEOUT_MS`). A job past it ends the worker (the next job starts a new one); a page
 * whose parse ran out is recorded `parse-failed`.
 */
export const CRAWL_ANALYSIS_TIMEOUT_MS = 20_000;

/**
 * The user's interval between two fetch calls to one origin (ms): `default` 1 s, at least `min`
 * (the crawl lane's floor, `CRAWL_FETCHER_LIMITS.perOriginIntervalMs`), at most `max`. The effective
 * interval is this, raised to `Crawl-delay`, back-off and `Retry-After`; never lower. It is measured
 * between **network starts**: a call's start is stamped right before its request, after every async
 * check in the host's slot (the project lookup), so a slow check never brings two requests closer
 * (council review round 2, item A).
 */
export const CRAWL_INTERVAL_MS = { default: 1_000, min: 500, max: 4_000 } as const;

/** The longest `Crawl-delay` honoured (ms); a site asking for more is crawled at this interval. */
export const MAX_CRAWL_DELAY_MS = 10_000;

/**
 * A run's pacing, kept across a restart and a crash (Phase 12 whole-branch review and council review,
 * item 5; acceptance `site-crawl.feature.md`, `crawl-pacing-survives-a-restart`,
 * `crawl-pacing-survives-a-crash`). Each host the crawl fetcher paces is stored on the run
 * (`crawl_runs.pacing`, `CrawlPacingSnapshotSchema`) with the time its next request may start
 * (`waitUntil`: the later of its `Retry-After` and its last start plus its effective interval at the
 * run's interval, so a learned `Crawl-delay` is in it) and its back-off (429 / 503 answers in a row, at
 * most `CRAWL_LIMITS.backoffAfter`). It is stored as the run starts, after every fetch call that changed
 * it (a back-off set or cleared, a `Retry-After`, a `Crawl-delay` learned or changed), **before** every
 * request that starts under a raised interval or follows such a change (that request's own start
 * counted, the write awaited inside the host's slot before the start is stamped: council review round
 * 2, item B; a write that fails sends nothing and fails the run), never for a call at the run's own
 * interval, and as the run pauses (any reason: the user, a quit, a slow-down); a finished run clears
 * it. The stored start is read as the write begins, so it can precede the request's own start by that
 * one local write. A resume, in this session or after
 * a restart or a crash (start-up pauses the run left `running`), seeds the crawl fetcher's pacing from
 * it, so a run resumes backed off and not before the stored time. A stored time is never
 * honoured further ahead than this (the longest wait any host state can ask for: the largest interval
 * or `Crawl-delay` at full back-off, or the longest `Retry-After`), so a clock set back cannot hold a
 * host for longer.
 *
 * - `maxHostChars`: the longest host name kept (a DNS name's limit; a longer one is not stored);
 * - `maxWaitMs`: the furthest ahead a stored `waitUntil` is honoured on resume (ms).
 */
export const CRAWL_PACING_LIMITS = {
  maxHostChars: 253,
  maxWaitMs: Math.max(CRAWL_LIMITS.maxRetryAfterMs, Math.max(CRAWL_INTERVAL_MS.max, MAX_CRAWL_DELAY_MS) * 2 ** CRAWL_LIMITS.backoffAfter),
} as const;

/**
 * The margin (ms) added to `ROBOTS_FETCH_LIMITS.timeoutMs` (`seo-indexability.spec.ts`) for the
 * crawl's robots lookups, a page's own and the redirect hook's (Decision 6): the robots fetcher's own
 * `timeout` answer arrives inside it, and a lookup still unanswered at that limit counts as `timeout`
 * (the page or the hop is refused, `robots-unreachable`).
 */
export const CRAWL_ROBOTS_HOOK_MARGIN_MS = 1_000;

/**
 * The longest the crawl waits for a fetched robots.txt's parse in the crawl worker (ms; council review,
 * item 1): the worker's own deadline per job plus the margin. It is a wait of its own, never part of the
 * robots lookup's (`ROBOTS_FETCH_LIMITS.timeoutMs` + `CRAWL_ROBOTS_HOOK_MARGIN_MS`), which covers the
 * lookup only: a parse queued behind other worker jobs is not cut by the lookup's clock. A robots.txt
 * fetched `ok` whose parse fails, or has not answered by then, **refuses** the page (`blocked-by-robots`,
 * its verdict `blocked`), never reads as unknown and never allows it. Inside the redirect hook the
 * fetcher's own cap (`FETCHER_LIMITS.maxRedirectHookMs`) may end the wait first, with the same refusal.
 */
export const CRAWL_ROBOTS_PARSE_WAIT_MS = CRAWL_ANALYSIS_TIMEOUT_MS + CRAWL_ROBOTS_HOOK_MARGIN_MS;

/** Response headers every crawl fetch keeps (`BoundedFetchRequest.keepHeaders`): the audit context's and the back-off's. */
export const CRAWL_KEEP_HEADERS = ['content-type', 'x-robots-tag', 'link', 'retry-after'] as const;

/** Kept headers whose repeated values are kept apart (`BoundedFetchRequest.separateHeaders`). */
export const CRAWL_SEPARATE_HEADERS = ['x-robots-tag'] as const satisfies readonly (typeof CRAWL_KEEP_HEADERS)[number][];

// ---- Scope --------------------------------------------------------------------------------------

/**
 * What a run may follow from its start URL:
 * - `host` (default): the start URL's host name, either scheme (`http` / `https`), on the start URL's
 *   own port or a scheme's default port (80, 443) only; for a **private** start, its exact origin
 *   (scheme, host **and** port), so a dev-server crawl never reaches another LAN host or another port
 *   of its own host (`127.0.0.1:3000` never reaches `127.0.0.1:9229`);
 * - `site`: any host under the start URL's registrable domain (the same port rule);
 * - `path`: the start URL's host (the same port rule), under the start URL's directory (its path up to
 *   the last `/`).
 *
 * Include and exclude prefixes then narrow it: a URL's path (and query) must start with one include
 * prefix, when any is given, and with no exclude prefix. Prefixes are literal text, never patterns,
 * compared **case-sensitively** (paths are case-sensitive) against the URL's normal form: its path and
 * query percent-normalised (RFC 3986 §6.2.2; council review, item 6), an escape of an unreserved
 * character (ALPHA, DIGIT, `-`, `.`, `_`, `~`) decoded and every escape left in upper-case hex, so
 * exclude `/admin` refuses `/%61dmin/` while `/%2Fadmin` (a reserved escape) is never decoded. A prefix
 * is normalised the same way. The request and the frontier key use the same normal form.
 */
export const CRAWL_SCOPES = ['host', 'site', 'path'] as const;
export type CrawlScope = (typeof CRAWL_SCOPES)[number];

/** The scopes a crawl whose start URL is on a private host may use (`isPrivateHost`): `host`, narrowed to the exact origin. */
export const CRAWL_PRIVATE_START_SCOPES = ['host'] as const satisfies readonly CrawlScope[];

/**
 * Query parameters stripped from every discovered URL before it is queued (exact names, compared
 * lowercase): campaign tags and click identifiers that name the same page many times over.
 */
export const CRAWL_TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
] as const;

// ---- Identity -----------------------------------------------------------------------------------

/**
 * Appended to the browse session's own user agent on every crawl request (` frost-crawl/1`):
 * identifying, never a crawler's, and the browse user agent is kept for site compatibility.
 */
export const CRAWL_USER_AGENT_TOKEN = 'frost-crawl/1' as const;

/**
 * The robots.txt product token: `productToken(CRAWL_USER_AGENT_TOKEN)` (`@app/seo-core`), so the group
 * a site writes for frost (`User-agent: frost-crawl`) is the group the crawl obeys, then `*`. Robots
 * matching (`groupsFor`, `matchRobots`) and `crawlDelayFor` are always given this bare constant, never
 * the user agent header sent: `productToken` reads a string's leading letters, so the full header
 * (`Mozilla/5.0 … frost-crawl/1`) would match a `mozilla` group.
 */
export const CRAWL_ROBOTS_TOKEN = 'frost-crawl' as const;

/** The Pages view's score column and the CSV's: the served-HTML rule subset's score, never the sidebar's health score. */
export const CRAWL_SCORE_LABEL = 'Served-HTML score' as const;

// ---- Runs and pages -----------------------------------------------------------------------------

/**
 * A run's state:
 * - `queued`: created, not started yet; found at start-up, it becomes `paused` (`interrupted`) too;
 * - `running`: fetching (at most one run app-wide); found at start-up (a crash or kill), it becomes
 *   `paused` (`interrupted`), never resumed by itself;
 * - `paused`: by the user, by quitting, by start-up recovery, or by back-off; continues only on the
 *   user's Resume (gated by `CRAWL_AVAILABLE`);
 * - `done`: the frontier is empty or `maxPages` were recorded;
 * - `cancelled`: by the user, or because its project was deleted;
 * - `failed`: it could not go on (its start URL refused, the worker gone).
 */
export const CRAWL_RUN_STATES = ['queued', 'running', 'paused', 'done', 'cancelled', 'failed'] as const;
export type CrawlRunState = (typeof CRAWL_RUN_STATES)[number];

/**
 * Why a run is in its state, when a reason matters (`null` otherwise):
 * - `user`: the user paused or cancelled it;
 * - `quit`: frost quit while it ran (paused);
 * - `interrupted`: start-up found it `running` or `queued` (paused);
 * - `slow-down`: `CRAWL_LIMITS.backoffAfter` 429 / 503 answers in a row (paused; "The site asked frost
 *   to slow down");
 * - `max-pages`: done with `maxPages` recorded and URLs still queued;
 * - `project-deleted`: cancelled because its project was deleted or tombstoned;
 * - `error`: failed.
 */
export const CRAWL_RUN_REASONS = ['user', 'quit', 'interrupted', 'slow-down', 'max-pages', 'project-deleted', 'error'] as const;
export type CrawlRunReason = (typeof CRAWL_RUN_REASONS)[number];

/** What the paused message says for `slow-down`. */
export const CRAWL_SLOW_DOWN_MESSAGE = 'The site asked frost to slow down.' as const;

/**
 * Notes main keeps about a run for this session (Task 6b review; not stored: the crawl view carries
 * the latest as `note`, and the log has a line of its own):
 * - `sitemapTimeout`: a sitemap window did not answer within `CRAWL_ANALYSIS_TIMEOUT_MS`; seeding stopped
 *   there and the crawl went on from what was seeded and linked.
 */
export const CRAWL_RUN_NOTES = {
  sitemapTimeout: 'A sitemap took too long to read, so the crawl went on without the rest of it.',
} as const;

/**
 * The `Accept` header of a sitemap request (Task 6b): sitemaps are fetched through the crawl's own page
 * fetch (scope, robots.txt, pacing and the redirect hook all apply), with `SITEMAP_LIMITS`' caps.
 */
export const CRAWL_SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,*/*;q=0.8' as const;

// ---- The crawl service (Task 6b; its IPC is Task 7's) -------------------------------------------

/**
 * Why main's crawl service did not do what it was asked (each answered as data, never thrown):
 * - `unavailable`: the L6 gate (`CRAWL_AVAILABLE`, through `legalGates.isOpen('crawl')`) is closed:
 *   only `start` and `resume` answer it, with `LEGAL_GATE_NOTE`; nothing is stored or fetched;
 * - `invalid-settings`: `CrawlSettingsSchema` refuses them;
 * - `not-found`: no such run, or its project is not a live project;
 * - `busy`: a crawl is already running (one at a time, app-wide);
 * - `not-resumable`: the run is not `paused`, or its stored settings no longer parse (`settings: null`);
 * - `not-running`: pause or cancel of a run that is not running (cancel also takes a `paused` run);
 * - `store-failed`: the database failed (one log line, its code only).
 */
export const CRAWL_REFUSALS = ['unavailable', 'invalid-settings', 'not-found', 'busy', 'not-resumable', 'not-running', 'store-failed'] as const;
export type CrawlRefusal = (typeof CRAWL_REFUSALS)[number];

/**
 * A crawl service answer: done (`started` / `resumed` carry the run), or refused with why. An
 * `unavailable` refusal carries `note`: `LEGAL_GATE_NOTE` (`data-sources.spec.ts`), the text the
 * renderer shows beside the disabled control.
 */
export type CrawlServiceAnswer =
  | { readonly status: 'started' | 'resumed'; readonly runId: string }
  | { readonly status: 'ok' }
  | { readonly status: 'refused'; readonly reason: CrawlRefusal; readonly note?: string };

/**
 * How a page's fetch ended, as its row records it:
 * - `crawled`: an HTML response (any status), parsed and audited;
 * - `not-html`: a response of another media type: recorded, not parsed;
 * - `parse-failed`: an HTML response the worker could not parse in time;
 * - `redirected`: the page redirected to **another host name** (in scope): that hop is never followed
 *   inside the fetch call (each host is paced on its own, K-B1); the row keeps the redirect (`status`,
 *   `finalUrl` = the target) and the target is queued as a page of its own (depth + 1, Task 6b), fetched
 *   under its host's pacing. Hops on the same host name are followed at once;
 * - `blocked-by-robots`: robots.txt disallows it for `CRAWL_ROBOTS_TOKEN` (never fetched), or a redirect
 *   hop to a URL it disallows was refused;
 * - `out-of-scope`: a redirect hop left the run's scope and was refused (links out of scope are
 *   recorded as links only, never as pages);
 * - `private-redirect`: a redirect hop to a private host (or, for a private start, off its exact
 *   origin) was refused;
 * - `robots-unreachable` (council review, item 2; RFC 9309 §2.3.1.4): the robots.txt that applies (the
 *   page's own origin's, the start origin's included, or a redirect target's) could not be read, so the
 *   crawl assumes everything is disallowed: the page was never requested, or the hop was refused. Its
 *   answer was an unknown outcome (`ROBOTS_UNKNOWN_OUTCOMES`: `server-error`, `unreachable`,
 *   `timeout`, and the redirect failures `bad-redirect` and `no-location`, which RFC 9309 treats as
 *   unreachable), or no answer came within `ROBOTS_FETCH_LIMITS.timeoutMs` +
 *   `CRAWL_ROBOTS_HOOK_MARGIN_MS`. A 4xx or a missing file (`ROBOTS_ALLOW_ALL_OUTCOMES`) allows
 *   everything. This is the crawl's rule only: the sidebar's verdict ("unknown", the
 *   `robots-txt-unreachable` finding) does not change. It replaces the hook's earlier `robots-timeout`
 *   (one rule, one outcome);
 * - `private-address`, `too-many-redirects`, `bad-redirect`, `no-location`, `unreachable`, `timeout`:
 *   the fetcher's own outcomes (`fetcher.spec.ts`).
 */
export const CRAWL_PAGE_OUTCOMES = [
  'crawled',
  'not-html',
  'parse-failed',
  'redirected',
  'blocked-by-robots',
  'out-of-scope',
  'private-redirect',
  'robots-unreachable',
  'private-address',
  'too-many-redirects',
  'bad-redirect',
  'no-location',
  'unreachable',
  'timeout',
] as const;
export type CrawlPageOutcome = (typeof CRAWL_PAGE_OUTCOMES)[number];

/**
 * How a run counts its pages (`CrawlRunCounts`): each outcome is in exactly one of these lists.
 * - fetched (`pages` counts every row; these are the ones with an answer to show);
 * - refused: the crawl's own policy said no, nothing (more) was requested: robots.txt, scope, the
 *   private-address rule (`refused`);
 * - failed: the fetch itself went wrong (`failed`).
 */
export const CRAWL_FETCHED_OUTCOMES = ['crawled', 'not-html', 'parse-failed', 'redirected'] as const satisfies readonly CrawlPageOutcome[];
export const CRAWL_REFUSED_OUTCOMES = ['blocked-by-robots', 'out-of-scope', 'private-redirect', 'robots-unreachable', 'private-address'] as const satisfies readonly CrawlPageOutcome[];
export const CRAWL_FAILED_OUTCOMES = ['too-many-redirects', 'bad-redirect', 'no-location', 'unreachable', 'timeout'] as const satisfies readonly CrawlPageOutcome[];

/** A page's robots.txt verdict for one agent (`CRAWL_ROBOTS_TOKEN`, and Googlebot's, computed from the same file). */
export const CRAWL_ROBOTS_VERDICTS = ['allowed', 'blocked', 'unknown'] as const;
export type CrawlRobotsVerdict = (typeof CRAWL_ROBOTS_VERDICTS)[number];

/**
 * A frontier entry's state: `queued` (to fetch) or `done` (fetched, refused or skipped).
 *
 * The frontier is also the run's seen-set and **the authority for inlinks and orphans**: every URL
 * the run met has one entry, which counts the links pointing at it (`inlinks`: one per discovering
 * page) and whether a sitemap listed it (`from_sitemap`). A sitemap seed is not an inlink. A URL met
 * again while still `queued` keeps the lower depth. An orphan is a URL a sitemap listed that no
 * crawled page links to (`from_sitemap = 1 AND inlinks = 0`). Pages join their entry on `(run_id, url)`.
 */
export const CRAWL_FRONTIER_STATES = ['queued', 'done'] as const;

/** How a URL reached the frontier: the run's start URL, a link on a crawled page (an inlink), or a sitemap seed (not an inlink). */
export const CRAWL_DISCOVERY_SOURCES = ['start', 'link', 'sitemap'] as const;
export type CrawlDiscoverySource = (typeof CRAWL_DISCOVERY_SOURCES)[number];
export type CrawlFrontierState = (typeof CRAWL_FRONTIER_STATES)[number];

/** The tables migrations `0240_site_crawl` / `0241_site_crawl_guards` create, in creation order. Device-local, never synced. */
export const SITE_CRAWL_TABLES = ['crawl_runs', 'crawl_pages', 'crawl_links', 'crawl_frontier'] as const;
export type SiteCrawlTable = (typeof SITE_CRAWL_TABLES)[number];

/** The migration ids of the crawl's storage (Phase 12 owns `0240`–`0249`). */
export const SITE_CRAWL_MIGRATION_IDS = ['0240_site_crawl', '0241_site_crawl_guards'] as const;

/**
 * The migration that adds `crawl_runs.pacing` (`CRAWL_PACING_LIMITS`; Phase 12 whole-branch review): its
 * own id after the SERP-API readings' `0245`, spread in `MIGRATIONS` in id order (`0240` is never edited).
 */
export const CRAWL_PACING_MIGRATION_IDS = ['0246_crawl_run_pacing'] as const;

// ---- The served-HTML rule set -------------------------------------------------------------------

/**
 * The rules a crawled page is audited with (`CRAWL_RULES` in `packages/seo-core/src/crawl/`): real
 * catalogue ids (`SEO_RULE_SPECS`) whose inputs the served HTML and the crawl's fetch context carry.
 * K-B2 removes any rule whose served audit disagrees with the sidebar's rendered audit on static
 * fixture pages. Every other catalogue rule is excluded, by category (`CRAWL_EXCLUDED_CATEGORIES`) or
 * by id (`CRAWL_EXCLUDED_RULES`), with the reason the crawl sheet shows.
 *
 * K-B2 (Task 6b, `crawl-audit-matches-sidebar-on-static-pages`): on static pages that use neither CSS
 * hiding nor microdata / RDFa, every rule here agrees with the sidebar. Served HTML has no layout, so a
 * heading hidden by CSS counts for the crawl and not for the sidebar: `h1-multiple`, `h1-empty` and
 * `heading-level-skipped` then report what the sidebar does not, and are removed. What stays may only
 * miss there, never add: `h1-missing` and `content-thin` (hidden headings and words count for the
 * crawl), and the structured-data rules, which read JSON-LD only (the served parse reads no
 * microdata or RDFa).
 *
 * `robots-txt-unreachable` stays in the list (the plan's list is kept exactly) but no longer fires in a
 * crawl: a page whose robots.txt the crawl cannot read is refused (`robots-unreachable`), never audited.
 */
export const CRAWL_RULE_IDS = [
  // title
  'title-missing',
  'title-empty',
  'title-multiple',
  'title-too-short',
  // meta description
  'meta-description-missing',
  'meta-description-too-short',
  'meta-description-multiple',
  // headings (K-B2 removed `h1-multiple`, `h1-empty` and `heading-level-skipped`: `CRAWL_EXCLUDED_RULES`)
  'h1-missing',
  // canonical
  'canonical-missing',
  'canonical-multiple',
  'canonical-relative',
  'canonical-off-host',
  'canonical-og-url-mismatch',
  'canonical-has-query',
  // indexing
  'robots-noindex',
  'robots-noindex-other-bot',
  'robots-nofollow',
  // indexability (from the crawl's context: the fetch and the origin's robots.txt)
  'http-status-redirect',
  'http-status-client-error',
  'http-status-server-error',
  'http-redirect-chain',
  'x-robots-noindex',
  'x-robots-noindex-other-bot',
  'x-robots-nofollow',
  'robots-txt-blocks-googlebot',
  'robots-txt-blocks-all',
  'robots-txt-unreachable',
  'robots-txt-no-sitemap',
  'canonical-elsewhere',
  'canonical-header-conflict',
  // hreflang
  'hreflang-invalid-code',
  'hreflang-missing-self',
  'hreflang-no-x-default',
  'hreflang-duplicate',
  'hreflang-relative-url',
  // other
  'lang-missing',
  'viewport-missing',
  'content-thin',
  'images-missing-alt',
  'image-alt-too-long',
  'links-empty-anchor',
  'links-javascript-href',
  'links-nofollow',
  'url-too-long',
  'url-uppercase',
  'url-underscores',
  // JSON-LD only
  'schema-json-invalid',
  'schema-over-limit',
  'schema-context-missing',
  'schema-context-not-schema-org',
  'schema-type-missing',
  'schema-type-unknown',
  'schema-required-missing',
  'schema-recommended-missing',
  'schema-url-not-absolute',
  'schema-date-invalid',
  'schema-breadcrumb-positions',
  'schema-price-invalid',
] as const satisfies readonly SeoRuleId[];
export type CrawlRuleId = (typeof CRAWL_RULE_IDS)[number];

/** Catalogue categories no crawl rule comes from, and why (the crawl sheet names them). */
export const CRAWL_EXCLUDED_CATEGORIES = {
  social: 'The served snapshot does not read social tags.',
  performance: 'Needs a rendered page and its timings.',
  security: 'Needs the browser’s view of the connection and its resources.',
  accessibility: 'Needs the rendered page’s layout and accessibility tree.',
  javascript: 'Compares the served page with the rendered one; the crawl renders nothing.',
} as const satisfies Partial<Record<SeoCategory, string>>;

/**
 * Catalogue rules excluded by id from a category the crawl otherwise audits, and why. With
 * `CRAWL_EXCLUDED_CATEGORIES` and `CRAWL_RULE_IDS` this covers the whole catalogue, each rule once.
 */
export const CRAWL_EXCLUDED_RULES = {
  'schema-none': 'Served HTML is read for JSON-LD only; microdata and RDFa are not parsed, so "no structured data" could be wrong.',
  'schema-entity-conflict': 'Compares JSON-LD with microdata and RDFa, which served HTML parsing does not read.',
  'images-missing-dimensions': 'Needs the rendered layout.',
  'images-oversized': 'Needs rendered and natural image sizes.',
  'images-lazy-in-first-viewport': 'Needs the rendered first viewport.',
  'h1-multiple': 'Served HTML has no layout: a heading hidden by CSS counts for the crawl and not for the sidebar, so the crawl could report a second H1 the sidebar does not (K-B2).',
  'h1-empty': 'Served HTML has no layout: an empty H1 hidden by CSS counts for the crawl and not for the sidebar, so the crawl could report one the sidebar does not (K-B2).',
  'heading-level-skipped': 'Served HTML has no layout: headings hidden by CSS count for the crawl and not for the sidebar, so the crawl could report a skipped level the sidebar does not (K-B2).',
  'title-too-wide': 'Not in the crawl’s first rule set; the sidebar’s result preview measures it.',
  'meta-description-too-wide': 'Not in the crawl’s first rule set; the sidebar’s result preview measures it.',
  'links-broken': 'Comes from the sidebar’s link check, which requests every link; a crawl does not run it per page.',
  'links-internal-redirect': 'Comes from the sidebar’s link check, which requests every link; a crawl does not run it per page.',
  'sitemap-page-not-listed': 'Comes from the sidebar’s sitemap check; a crawl does not run it per page.',
  'sitemap-unreachable': 'Comes from the sidebar’s sitemap check; a crawl does not run it per page.',
  'hreflang-no-return-link': 'Comes from the sidebar’s hreflang check, which requests each alternate; a crawl does not run it per page.',
} as const satisfies Partial<Record<SeoRuleId, string>>;


// ---- Pages and Site structure (Task 7) ----------------------------------------------------------

/**
 * How long one `crawl.watch` long-poll waits for a change before it answers the current view anyway
 * (ms), and how many may wait at once **per sender window** (one more answers that window's oldest
 * early; another window's polls are never evicted), as `browser.watch` (`WATCH_TIMEOUT_MS`,
 * `MAX_PENDING_WATCHES`). Main counts one change per crawled page (the run's counts written after it),
 * per run created, updated or deleted, and whenever the running crawl starts or ends. An answer with an
 * unchanged version (a timeout, an eviction) makes the sheet rest `retryMs` before it asks again.
 */
export const CRAWL_WATCH = { timeoutMs: 25_000, maxPending: 4, retryMs: 1_000 } as const;

/**
 * While a run is running, the sheet reads its pages and structure again at most this often (ms); a
 * change of the run shown or of its state reads them at once.
 */
export const CRAWL_REFRESH_MS = 5_000;

/**
 * A page's HTTP status as the Pages view filters it: its class (`2xx` … `5xx`), or `none` (no answer:
 * refused by the crawl's policy, or the fetch failed).
 */
export const CRAWL_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'none'] as const;
export type CrawlStatusClass = (typeof CRAWL_STATUS_CLASSES)[number];

/** A page's indexable verdict as the Pages view filters it (`unknown`: not crawled, nothing to judge). */
export const CRAWL_INDEXABLE_FILTERS = ['yes', 'no', 'unknown'] as const;
export type CrawlIndexableFilter = (typeof CRAWL_INDEXABLE_FILTERS)[number];

/**
 * What the Pages view filters on, each optional and combined with AND (`CrawlPageFilterSchema`):
 * - `status`: one of `CRAWL_STATUS_CLASSES`;
 * - `indexable`: one of `CRAWL_INDEXABLE_FILTERS`;
 * - `finding`: a crawl rule (`CRAWL_RULE_IDS`) the page fails;
 * - `depth`: exactly this many clicks from the start URL (0 to `CRAWL_LIMITS.maxDepth`);
 * - `linksCut`: only pages whose links were cut at `SNAPSHOT_LIMITS.maxLinks`.
 * Every filter runs in SQL (main's repository), never over a list in the renderer.
 */
export const CRAWL_PAGE_FILTERS = ['status', 'indexable', 'finding', 'depth', 'linksCut'] as const;
export type CrawlPageFilterKey = (typeof CRAWL_PAGE_FILTERS)[number];

export const CRAWL_PAGE_FILTER_LABELS: Readonly<Record<CrawlPageFilterKey, string>> = {
  status: 'Status',
  indexable: 'Indexable',
  finding: 'Finding',
  depth: 'Depth',
  linksCut: 'Links cut',
};

/**
 * How the Pages view sorts (`CrawlPagesInputSchema.sort`, ascending or descending), in SQL; pages
 * without the value (no status, no score, no word count) sort last either way, and ties keep the order
 * the pages were recorded in:
 * - `order`: the order the crawl recorded them (breadth first);
 * - `url`, `status`, `depth`, `score` (`CRAWL_SCORE_LABEL`), `words` (served word count);
 * - `inlinks`: links to it from crawled pages (the frontier's count).
 */
export const CRAWL_PAGE_SORTS = ['order', 'url', 'status', 'depth', 'inlinks', 'score', 'words'] as const;
export type CrawlPageSort = (typeof CRAWL_PAGE_SORTS)[number];

export const CRAWL_PAGE_SORT_LABELS: Readonly<Record<CrawlPageSort, string>> = {
  order: 'Crawl order',
  url: 'URL',
  status: 'Status',
  depth: 'Depth',
  inlinks: 'In-links',
  score: CRAWL_SCORE_LABEL,
  words: 'Words',
};

export const CRAWL_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type CrawlSortDirection = (typeof CRAWL_SORT_DIRECTIONS)[number];

/** Rows one `crawl.pages` answer carries: at most `maxPageSize` (the renderer asks `defaultPageSize`). */
export const CRAWL_PAGES_LIMITS = { defaultPageSize: 50, maxPageSize: 200 } as const;

/**
 * The Site structure view's bounds (`crawl.structure`): a path tree read one level at a time, in SQL.
 * - `maxChildren`: nodes one level answers, most pages first; the rest are counted (`more`), never sent;
 * - `maxOrphansShown`: sitemap orphans listed (their total is counted);
 * The click-depth histogram has one bar per depth (0 to `CRAWL_LIMITS.maxDepth`).
 */
export const CRAWL_TREE_LIMITS = { maxChildren: 100, maxOrphansShown: 100 } as const;

/**
 * Why a Pages, Site structure or CSV request was not answered (each as data):
 * - `not-found`: no such run (deleted meanwhile);
 * - `store-failed`: the database failed (one log line, its code only);
 * - `write-failed`: the CSV file could not be written (or the dialog failed);
 * - `exporting`: another CSV export is under way (one at a time, app-wide).
 */
export const CRAWL_READ_REFUSALS = ['not-found', 'store-failed', 'write-failed', 'exporting'] as const;
export type CrawlReadRefusal = (typeof CRAWL_READ_REFUSALS)[number];

/** A served word count below this, on an HTML page answered 2xx, is flagged "looks client-rendered" (Decision 6). */
export const CRAWL_CLIENT_RENDERED_MAX_WORDS = 50;

/**
 * The marks a page row carries in the Pages view and the CSV's `Notes` column:
 * - `linksCut`: the served HTML held more links than the parse keeps (`SNAPSHOT_LIMITS.maxLinks`); links
 *   past the cap were not followed;
 * - `clientRendered`: crawled, answered 2xx, with fewer than `CRAWL_CLIENT_RENDERED_MAX_WORDS` served
 *   words: the page is likely built by scripts, which the crawl never runs (open it in a tab to see it
 *   rendered). The row keeps no script count (Task 6b), so the word count alone decides.
 */
export const CRAWL_PAGE_FLAGS = {
  linksCut: 'links cut at 1 000',
  clientRendered: 'looks client-rendered',
} as const;
export type CrawlPageFlag = keyof typeof CRAWL_PAGE_FLAGS;

/** The facts the flags read (a page row's). */
export interface CrawlFlagFacts {
  readonly outcome: CrawlPageOutcome;
  readonly status: number | null;
  readonly wordCount: number | null;
  readonly linksCut: boolean;
}

/** The flags a page row carries, in `CRAWL_PAGE_FLAGS` order. */
export function crawlPageFlags(row: CrawlFlagFacts): CrawlPageFlag[] {
  const flags: CrawlPageFlag[] = [];
  if (row.linksCut) flags.push('linksCut');
  if (row.outcome === 'crawled' && row.status !== null && row.status >= 200 && row.status < 300 && row.wordCount !== null && row.wordCount < CRAWL_CLIENT_RENDERED_MAX_WORDS) flags.push('clientRendered');
  return flags;
}

/** `CRAWL_PAGE_FLAGS.linksCut` names the parse's link cap. */
export const CRAWL_LINKS_CUT_AT = SNAPSHOT_LIMITS.maxLinks;

/**
 * The CSV export's columns, in order (main writes it: `crawl.exportCsv`; every cell through
 * `csvCell` from `@app/seo-core`, which neutralises a formula-leading cell; CRLF). The score column is
 * headed `CRAWL_SCORE_LABEL`, never "health score"; `Findings` lists the failing crawl rules' ids,
 * space-separated; `Notes` the page's flags (`CRAWL_PAGE_FLAGS`), `; `-separated; `Fetched at` is ISO
 * 8601 (UTC). The export holds the run's pages the Pages view's filter selects, in its sort.
 */
export const CRAWL_CSV_COLUMNS = [
  'URL',
  'Final URL',
  'Outcome',
  'Status',
  'Indexable',
  'Title',
  'Canonical',
  'Depth',
  'In-links',
  'Out-links',
  'Words',
  'robots.txt (frost-crawl)',
  'robots.txt (Googlebot)',
  CRAWL_SCORE_LABEL,
  'Findings',
  'Notes',
  'Bytes',
  'Fetched at',
] as const;

/**
 * Rows main reads per statement while it writes a CSV (`CRAWL_PAGES_LIMITS.maxPageSize`). The export
 * first fixes its rows and their order in one statement (the ids the filter selects, sorted, at most
 * `CRAWL_LIMITS.maxPagesCap` integers), then reads and appends them this many at a time, so a running
 * crawl can neither duplicate nor skip a row; pages written after the export began are not in it.
 */
export const CRAWL_CSV_READ_ROWS = CRAWL_PAGES_LIMITS.maxPageSize;

/** The file name the CSV export offers (`{date}`: the day, `YYYY-MM-DD`, UTC), in the Downloads folder. */
export const CRAWL_CSV_FILE_NAME = 'frost-site-crawl-{date}.csv' as const;

/** `CRAWL_CSV_FILE_NAME` for the time `at` (Unix ms; not a valid date: `undated`). */
export function crawlCsvFileName(at: number): string {
  const date = typeof at === 'number' && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString().slice(0, 10) : 'undated';
  return CRAWL_CSV_FILE_NAME.replace('{date}', date);
}

/** Main's save dialog for the crawl CSV (its own words; a CSV filter only). The renderer never names a path. */
export const CRAWL_CSV_SAVE_DIALOG = {
  title: 'Save site crawl as CSV',
  buttonLabel: 'Save',
  filterName: 'CSV file',
  extensions: ['csv'],
} as const;

/**
 * The crawl sheet's words (frost's own). The score is always `CRAWL_SCORE_LABEL`; nothing here says
 * "health score".
 */
export const CRAWL_VIEW_TEXT = {
  title: 'Site crawl',
  close: 'Close site crawl',
  startTitle: 'Crawl a site',
  start: 'Start crawl',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  delete: 'Delete run',
  deleteConfirm: 'Delete this run and its pages? This cannot be undone.',
  exportCsv: 'Export CSV…',
  openInTab: 'Open in tab',
  pagesTab: 'Pages',
  structureTab: 'Site structure',
  noRuns: 'No crawls yet.',
  retentionNote: 'Crawl data is deleted per run: Delete run removes a run and its pages, and deleting a project deletes its runs. Clear Browsing Data and project retention leave it alone.',
  ruleSetTitle: 'What the crawl checks',
  ruleSetIntro: `Each page’s served HTML is checked with the crawl’s own rule set, so its ${CRAWL_SCORE_LABEL} is not the sidebar’s score. It uses these categories:`,
  ruleSetExcluded: 'Left out, and why:',
  orphansTitle: 'Orphans',
  orphansNote: 'Listed in a sitemap, never linked from a crawled page.',
  depthTitle: 'Click depth',
  treeTitle: 'Paths',
  treeMore: (more: number) => `${more} more not shown`,
} as const;

/** What a refused crawl request says (frost's own words); `unavailable` shows `LEGAL_GATE_NOTE` instead. */
export const CRAWL_REFUSAL_TEXT: Readonly<Record<Exclude<CrawlRefusal, 'unavailable'> | CrawlReadRefusal, string>> = {
  'invalid-settings': 'Those settings cannot be used. Check the start URL, the scope and the prefixes.',
  'not-found': 'That crawl or its project no longer exists.',
  busy: 'A crawl is already running. Pause or cancel it first.',
  'not-resumable': 'This run cannot be resumed.',
  'not-running': 'This run is not running.',
  'store-failed': 'The crawl data could not be read or written. Try again.',
  'write-failed': 'The file could not be written. Try another place.',
  exporting: 'An export is already under way. Try again when it is done.',
};
