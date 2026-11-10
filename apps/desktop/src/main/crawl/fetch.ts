import { crawlRobotsRules, decodeRobotsBytes, type CrawlRobotsRules } from '@app/seo-core';
import { CRAWL_FETCHER_LIMITS, type BoundedFetcher, type BoundedFetchResult, type FetchRedirect } from '@app/specs/fetcher.spec';
import { RESPONSE_LIMITS, ROBOTS_ALLOW_ALL_OUTCOMES, ROBOTS_FETCH_LIMITS, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS } from '@app/specs/seo-javascript.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CRAWL_KEEP_HEADERS, CRAWL_LIMITS, CRAWL_ROBOTS_HOOK_MARGIN_MS, CRAWL_ROBOTS_TOKEN, CRAWL_SEPARATE_HEADERS, CRAWL_USER_AGENT_TOKEN, type CrawlPageOutcome, type CrawlRobotsVerdict } from '@app/specs/site-crawl.spec';
import { createBoundedFetcher, type Hop, type Resolve } from '../seo/fetcher';
import type { RobotsLookupOptions } from '../seo/robots-fetch';
import { CrawlAbortedError, CrawlSlowDownError, createPacing, pacingKey, systemClock, type CrawlClock, type Politeness } from './politeness';
import { createCrawlScope, normaliseCrawlUrl, type CrawlScopeRule, type CrawlScopeSettings } from './scope';

// The crawl's fetching (spec `site-crawl.spec.ts`; `fetcher.spec.ts`, the crawl lane and
// `allowRedirect`; acceptance `site-crawl.feature.md`, Fetching, politeness and robots; plan Decision 6,
// Threat model crawl row, Task 6a). One page = one fetch call on the crawl lane, paced per host name by
// `politeness.ts` (the pacing is this fetcher's: shared by its runs, kept across pause and resume), made with `page` = the run's start URL (so the fetcher's private-address rule
// applies unchanged) and the browse user agent with ` frost-crawl/1` appended. Before a page is
// requested its origin's robots.txt is read (main's robots fetcher, `robots.get`; for a private start
// with the exact-origin rule) and matched for the bare `CRAWL_ROBOTS_TOKEN`, never the header sent.
// Every redirect hop passes the crawl's policy in the fetcher's hook: scope and the private /
// exact-origin rule first, with no request to the new origin; a hop to another host name is never
// followed (the call ends `redirected`; Task 6b queues the target as a page of its own, under its
// host's pacing: K-B1); only for a hop on the same host, that origin's robots.txt,
// bounded by `ROBOTS_FETCH_LIMITS.timeoutMs + CRAWL_ROBOTS_HOOK_MARGIN_MS` (`timeout`, or no answer by
// then, refuses the hop: `robots-timeout`; the other unknown answers allow it, flagged: the
// start-origin rule).
//
// Task 6a parses robots.txt through an injected `parseRobots` (default: seo-core's pure
// `crawlRobotsRules`, on main's thread); Task 6b moves that call into the crawl's worker.

/** The crawl lane (`fetcher.spec.ts`, Lanes): a bounded fetcher over main's hop and resolver with `CRAWL_FETCHER_LIMITS`, per-origin queues of its own. */
export function createCrawlLane(options: { readonly hop: Hop; readonly resolve: Resolve; readonly now?: () => number }): BoundedFetcher {
  return createBoundedFetcher({ hop: options.hop, resolve: options.resolve, ...(options.now ? { now: options.now } : {}), limits: CRAWL_FETCHER_LIMITS });
}

/** What the crawl asks of main's robots fetcher (`RobotsFetcher.get`; never rejects). */
export interface CrawlRobotsSource {
  get(pageUrl: string, options?: RobotsLookupOptions): Promise<RobotsFetch | null>;
}

export interface CrawlFetcherDeps {
  /** The crawl lane (`createCrawlLane`). */
  readonly fetcher: BoundedFetcher;
  /** Main's robots.txt fetcher. */
  readonly robots: CrawlRobotsSource;
  /** The browse session's user agent (main: `browseSession.getUserAgent()`); ` frost-crawl/1` is appended. */
  readonly userAgent: () => string;
  /** robots.txt text → the crawl's rules (default: `crawlRobotsRules` on this thread; Task 6b: the crawl worker). */
  readonly parseRobots?: (text: string) => CrawlRobotsRules | Promise<CrawlRobotsRules>;
  readonly clock?: CrawlClock;
}

/**
 * How one page's fetch ended: `response` (Task 6b decides `crawled` / `not-html` / `parse-failed`),
 * `redirected` (to another host: `redirectTarget` is queued as its own page), a refusal or failure of
 * `CRAWL_PAGE_OUTCOMES`, or nothing to record: `aborted`, or `deferred` (a new host while
 * `CRAWL_LIMITS.maxPacedHosts` are paced; not requested, `slowDown` set: the run pauses, the URL stays queued).
 */
export type CrawlFetchOutcome = 'response' | 'aborted' | 'deferred' | Exclude<CrawlPageOutcome, 'crawled' | 'not-html' | 'parse-failed'>;

/** The robots.txt that applies to a page's final URL, and the crawl's reading of it. */
export interface CrawlRobotsState {
  /** The origin's robots.txt as main's robots fetcher answered (`PageContext.robots` in Task 6b); `null`: none asked. */
  readonly fetch: RobotsFetch | null;
  /** The verdict for `CRAWL_ROBOTS_TOKEN`, and Googlebot's from the same file. */
  readonly crawl: CrawlRobotsVerdict;
  readonly googlebot: CrawlRobotsVerdict;
  /** robots.txt could not be read (an unknown outcome): crawled anyway at the default interval, with the `robots-txt-unreachable` finding. */
  readonly unreachable: boolean;
  /** The site's `Crawl-delay` for the crawl (ms, capped); `null`: none. */
  readonly crawlDelayMs: number | null;
}

/** One page's fetch, as Task 6b records it. */
export interface CrawlPageFetch {
  /** The URL asked for (normalised). */
  readonly url: string;
  readonly outcome: CrawlFetchOutcome;
  /** The status of the last answer (a refused redirect's own status); `null` without one. */
  readonly status: number | null;
  readonly finalUrl: string | null;
  readonly redirects: number;
  readonly chain: readonly FetchRedirect[];
  /** The redirect target the crawl's policy refused (never requested); `null` otherwise. */
  readonly refusedUrl: string | null;
  /** `redirected`: the other host's URL the page redirected to (in scope, never requested in this call; 6b queues it at depth + 1). */
  readonly redirectTarget: string | null;
  /** `CRAWL_KEEP_HEADERS` of the final answer (`x-robots-tag` values joined with `\n`). */
  readonly headers: Readonly<Record<string, string>>;
  /** The `X-Robots-Tag` values, kept apart. */
  readonly xRobotsTag: readonly string[];
  /** Body bytes read (at most `CRAWL_LIMITS.maxBodyBytes`), never decoded here. */
  readonly body: Uint8Array<ArrayBuffer>;
  readonly bytes: number;
  readonly truncated: boolean;
  /** When the fetch call started (`null`: no request was made) and how long it took (ms). */
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly robots: CrawlRobotsState;
  /** `CRAWL_LIMITS.backoffAfter` 429 / 503 answers in a row from this host, or a `deferred` new host: the run pauses (`slow-down`). */
  readonly slowDown: boolean;
}

/** One run's fetching. */
export interface CrawlRunFetcher {
  readonly scope: CrawlScopeRule;
  readonly politeness: Politeness;
  /** Fetches one page under the run's policy; never rejects. */
  fetchPage(url: string, signal?: AbortSignal): Promise<CrawlPageFetch>;
}

export interface CrawlFetcher {
  /** A run's fetcher: its scope (throws for settings the schema refuses) and its own pacing at `intervalMs`. */
  forRun(settings: CrawlScopeSettings & { readonly intervalMs: number }): CrawlRunFetcher;
}

/** The `User-Agent` crawl requests send: the browse session's, printable ASCII, with ` frost-crawl/1` appended once. */
export function crawlUserAgent(browse: string): string {
  const clean = browse.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 512);
  if (clean === CRAWL_USER_AGENT_TOKEN || clean.endsWith(` ${CRAWL_USER_AGENT_TOKEN}`)) return clean;
  return clean === '' ? CRAWL_USER_AGENT_TOKEN : `${clean} ${CRAWL_USER_AGENT_TOKEN}`;
}

const ALLOW_ALL: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_ALLOW_ALL_OUTCOMES);
const EMPTY = new Uint8Array(0);
/** The hook's (and the page's own) robots.txt wait: the robots fetcher's own deadline plus a margin, so its `timeout` answer arrives inside it. */
const ROBOTS_WAIT_MS = ROBOTS_FETCH_LIMITS.timeoutMs + CRAWL_ROBOTS_HOOK_MARGIN_MS;
/** Characters kept of each kept header (repeated `X-Robots-Tag` / `Link` values joined): as many as the audit's response capture keeps. */
const MAX_HEADER_CHARS = RESPONSE_LIMITS.maxHeaderValueChars * RESPONSE_LIMITS.maxValuesPerHeader;

const unknownRobots = (fetch: RobotsFetch | null): CrawlRobotsState => ({ fetch, crawl: 'unknown', googlebot: 'unknown', unreachable: true, crawlDelayMs: null });

/** A robots.txt answer synthesized for a lookup that gave none in time (or failed): `timeout` / `unreachable`. */
const synthesized = (url: string, outcome: 'timeout' | 'unreachable'): RobotsFetch => ({ url: `${new URL(url).origin}/robots.txt`, outcome, status: null, finalUrl: null, redirects: 0, body: EMPTY, truncated: false });

export function createCrawlFetcher(deps: CrawlFetcherDeps): CrawlFetcher {
  const clock = deps.clock ?? systemClock;
  // Per-host pacing outlives a run: a pause, a resume or a new run never resets a host's last start, back-off or Retry-After.
  const pacing = createPacing({ clock });
  const parseRobots = deps.parseRobots ?? crawlRobotsRules;
  // One parse per robots.txt answer (the robots fetcher caches answers per origin, so the same object comes back).
  const parsed = new WeakMap<RobotsFetch, Promise<CrawlRobotsRules>>();
  const rulesOf = (fetch: RobotsFetch): Promise<CrawlRobotsRules> => {
    let rules = parsed.get(fetch);
    if (!rules) {
      rules = Promise.resolve().then(() => parseRobots(decodeRobotsBytes(fetch.body)));
      parsed.set(fetch, rules);
    }
    return rules;
  };

  /** The crawl's reading of `fetch` for `url`. */
  async function readRobots(fetch: RobotsFetch | null, url: string): Promise<CrawlRobotsState> {
    if (fetch === null) return unknownRobots(null);
    if (fetch.outcome === 'ok') {
      let rules: CrawlRobotsRules;
      try {
        rules = await rulesOf(fetch);
      } catch {
        return unknownRobots(fetch);
      }
      // Always the bare product token (and Googlebot's for the second verdict), never the header sent.
      const verdict = (token: string): CrawlRobotsVerdict => (rules.allowed(url, token) ? 'allowed' : 'blocked');
      return { fetch, crawl: verdict(CRAWL_ROBOTS_TOKEN), googlebot: verdict('googlebot'), unreachable: false, crawlDelayMs: rules.crawlDelayMs };
    }
    if (ALLOW_ALL.has(fetch.outcome)) return { fetch, crawl: 'allowed', googlebot: 'allowed', unreachable: false, crawlDelayMs: null };
    // Unknown (`ROBOTS_UNKNOWN_OUTCOMES`; `pending` never comes from `get`): the start-origin rule.
    return unknownRobots(fetch);
  }

  return {
    forRun(settings) {
      const scope = createCrawlScope(settings);
      const politeness = pacing.forRun(settings.intervalMs);

      /**
       * Keeps what a robots.txt answer says about `host`'s `Crawl-delay` (per origin; the host keeps the
       * largest). Only a known answer changes it (a file, or no file at all); a lookup with no answer or an
       * unknown outcome keeps what an earlier one taught.
       */
      const learnCrawlDelay = (host: string, origin: string, robots: CrawlRobotsState): void => {
        const outcome = robots.fetch?.outcome;
        if (outcome === undefined || robots.unreachable) return;
        if (outcome === 'ok' || ALLOW_ALL.has(outcome)) politeness.setCrawlDelay(host, robots.crawlDelayMs, origin);
      };
      const lookupOptions: RobotsLookupOptions | undefined = scope.privateStart ? { exactOrigin: true } : undefined;

      /** `url`'s robots.txt read for the crawl, or `no-answer` when nothing (lookup and parse) came within `ROBOTS_WAIT_MS` or `signal` aborted. */
      const robotsFor = (url: string, signal: AbortSignal | undefined): Promise<CrawlRobotsState | 'no-answer'> =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (value: CrawlRobotsState | 'no-answer') => {
            if (settled) return;
            settled = true;
            cancel();
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          };
          const onAbort = () => finish('no-answer');
          const cancel = clock.setTimeout(() => finish('no-answer'), ROBOTS_WAIT_MS);
          if (signal?.aborted) {
            finish('no-answer');
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          void deps.robots
            .get(url, lookupOptions)
            .catch(() => synthesized(url, 'unreachable'))
            .then((fetch) => readRobots(fetch, url))
            .then(finish, () => finish(unknownRobots(synthesized(url, 'unreachable'))));
        });

      async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<CrawlPageFetch> {
        const url = normaliseCrawlUrl(rawUrl) ?? rawUrl.slice(0, CRAWL_LIMITS.maxUrlChars);
        const none = (outcome: CrawlFetchOutcome, robots: CrawlRobotsState): CrawlPageFetch => ({ url, outcome, status: null, finalUrl: null, redirects: 0, chain: [], refusedUrl: null, redirectTarget: null, headers: {}, xRobotsTag: [], body: EMPTY, bytes: 0, truncated: false, startedAt: null, durationMs: 0, robots, slowDown: outcome === 'deferred' });
        // Scope and the address rule first: an out-of-scope page is never requested, nor its robots.txt.
        if (scope.check(url) !== 'in') return none('out-of-scope', { fetch: null, crawl: 'unknown', googlebot: 'unknown', unreachable: false, crawlDelayMs: null });
        const origin = new URL(url).origin;
        const host = pacingKey(url)!;
        const own = await robotsFor(url, signal);
        if (signal?.aborted) return none('aborted', unknownRobots(null));
        // No answer in time for the page's own origin: unknown, so the start-origin rule (crawled, flagged).
        const robots = own === 'no-answer' ? unknownRobots(synthesized(url, 'timeout')) : own;
        learnCrawlDelay(host, origin, robots);
        if (robots.crawl === 'blocked') return none('blocked-by-robots', robots);

        let refusal: { readonly outcome: CrawlFetchOutcome; readonly url: string } | null = null;
        let finalRobots = robots;
        const allowRedirect = async (next: string, options: { readonly signal: AbortSignal }): Promise<boolean> => {
          // 1. Scope and the private / exact-origin rule, with no request to the new origin.
          const where = scope.check(next);
          if (where !== 'in') {
            refusal = { outcome: where === 'private' ? 'private-redirect' : 'out-of-scope', url: next };
            return false;
          }
          // Another host name: never followed inside this call (its own pacing, K-B1); queued by Task 6b instead.
          if (pacingKey(next) !== host) {
            refusal = { outcome: 'redirected', url: next };
            return false;
          }
          // 2. Only then robots.txt for the new URL, bounded: `timeout` or no answer refuses the hop.
          const state = await robotsFor(next, options.signal);
          if (state === 'no-answer' || state.fetch?.outcome === 'timeout') {
            refusal = { outcome: 'robots-timeout', url: next };
            return false;
          }
          if (state.crawl === 'blocked') {
            refusal = { outcome: 'blocked-by-robots', url: next };
            return false;
          }
          learnCrawlDelay(host, new URL(next).origin, state);
          finalRobots = state;
          return true;
        };

        let startedAt: number | null = null;
        let slowDown = false;
        let fetched: BoundedFetchResult;
        try {
          fetched = await politeness.schedule(
            host,
            async () => {
              startedAt = clock.now();
              const result = await deps.fetcher.fetch({
                url,
                page: settings.startUrl,
                userAgent: crawlUserAgent(deps.userAgent()),
                accept: SERVED_ACCEPT,
                maxRedirects: SERVED_FETCH_LIMITS.maxRedirects,
                maxBytes: CRAWL_LIMITS.maxBodyBytes,
                timeoutMs: SERVED_FETCH_LIMITS.timeoutMs,
                keepHeaders: CRAWL_KEEP_HEADERS,
                separateHeaders: CRAWL_SEPARATE_HEADERS,
                maxHeaderChars: MAX_HEADER_CHARS,
                ...(signal ? { signal } : {}),
                allowRedirect,
              });
              slowDown = politeness.report(host, { status: result.outcome === 'response' ? result.status : null, retryAfter: result.headers['retry-after'] }).slowDown;
              return result;
            },
            signal,
          );
        } catch (error) {
          if (error instanceof CrawlAbortedError) return none('aborted', robots);
          if (error instanceof CrawlSlowDownError) return none('deferred', robots);
          return none('unreachable', robots);
        }
        const refused = refusal as { readonly outcome: CrawlFetchOutcome; readonly url: string } | null;
        const outcome = outcomeOf(fetched, refused);
        const xRobots = fetched.headers['x-robots-tag'];
        const target = fetched.outcome === 'redirect-refused' && refused ? refused.url.slice(0, CRAWL_LIMITS.maxUrlChars) : null;
        // `redirected`: the row records where the page went (the hop in its chain, `finalUrl` the target).
        const redirected = outcome === 'redirected' && target !== null && fetched.finalUrl !== null && fetched.status !== null;
        const chain: readonly FetchRedirect[] = redirected ? [...fetched.chain, { url: fetched.finalUrl!, status: fetched.status!, location: target }] : fetched.chain;
        return {
          url,
          outcome,
          status: fetched.status,
          finalUrl: redirected ? target : fetched.finalUrl,
          redirects: chain.length,
          chain,
          refusedUrl: outcome === 'redirected' ? null : target,
          redirectTarget: redirected ? target : null,
          headers: fetched.headers,
          xRobotsTag: xRobots === undefined ? [] : xRobots.split('\n').filter((value) => value.trim() !== ''),
          body: fetched.body,
          bytes: fetched.body.byteLength,
          truncated: fetched.truncated,
          startedAt,
          durationMs: fetched.durationMs,
          // A refused hop leaves the page at its own URL: its own origin's robots.txt.
          robots: fetched.outcome === 'redirect-refused' ? robots : finalRobots,
          slowDown,
        };
      }

      return { scope, politeness, fetchPage };
    },
  };
}

/** A crawl outcome of a bounded fetch's outcome (the hook's refusal names a `redirect-refused` one). */
function outcomeOf(fetched: BoundedFetchResult, refusal: { readonly outcome: CrawlFetchOutcome } | null): CrawlFetchOutcome {
  switch (fetched.outcome) {
    case 'response':
    case 'private-address':
    case 'private-redirect':
    case 'too-many-redirects':
    case 'bad-redirect':
    case 'no-location':
    case 'unreachable':
    case 'timeout':
    case 'aborted':
      return fetched.outcome;
    case 'redirect-refused':
      return refusal?.outcome ?? 'out-of-scope';
    // The crawl checked the URL first; a full lane queue cannot happen with one call per origin at a time.
    case 'not-web':
      return 'out-of-scope';
    case 'busy':
      return 'unreachable';
  }
}
