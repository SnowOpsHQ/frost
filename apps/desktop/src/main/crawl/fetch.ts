import { crawlRobotsRules, decodeRobotsBytes, type CrawlRobotsRules } from '@app/seo-core';
import { CRAWL_FETCHER_LIMITS, type BoundedFetcher, type BoundedFetchResult, type FetchRedirect } from '@app/specs/fetcher.spec';
import { RESPONSE_LIMITS, ROBOTS_ALLOW_ALL_OUTCOMES, ROBOTS_FETCH_LIMITS, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS } from '@app/specs/seo-javascript.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CRAWL_KEEP_HEADERS, CRAWL_LIMITS, CRAWL_ROBOTS_HOOK_MARGIN_MS, CRAWL_ROBOTS_PARSE_WAIT_MS, CRAWL_ROBOTS_TOKEN, CRAWL_SEPARATE_HEADERS, CRAWL_USER_AGENT_TOKEN, type CrawlPageOutcome, type CrawlRobotsVerdict } from '@app/specs/site-crawl.spec';
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
// bounded by `ROBOTS_FETCH_LIMITS.timeoutMs + CRAWL_ROBOTS_HOOK_MARGIN_MS`.
//
// robots.txt the crawl cannot read refuses (RFC 9309 §2.3.1.4; council review, item 2): an unknown
// outcome (`ROBOTS_UNKNOWN_OUTCOMES`, the redirect failures included) or no answer within that wait
// refuses the page, the start origin's included, or the hop, as `robots-unreachable`; nothing is
// requested. Only a parsed file that allows the URL, or no file at all (a 4xx), lets it through. The
// sidebar's rule (an "unknown" verdict, the `robots-txt-unreachable` finding) does not change.
//
// Task 6a parses robots.txt through an injected `parseRobots` (default: seo-core's pure
// `crawlRobotsRules`, on main's thread); Task 6b moves that call into the crawl's worker
// (`crawl/index.ts`). The lookup's wait covers the lookup only; the parse has its own
// (`CRAWL_ROBOTS_PARSE_WAIT_MS`), so a parse queued behind other worker jobs is never cut short into
// "unknown". A fetched robots.txt whose parse fails or runs out of that wait is read as blocked
// (`blocked-by-robots`), never unknown, and the failed parse is not cached. Task 6b also fetches sitemap files through
// `fetchPage` (per-call caps and `Accept`), so they pass the same scope, robots.txt, pacing and
// redirect policy as pages, and asks `beforeRequest` inside the paced slot. The pacing stamps a call's
// start only after `beforeRequest` has answered, right before the request (council review round 2, item
// A): a slow check never brings two requests to one host closer than the effective interval.

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
  /** robots.txt could not be read (an unknown outcome, or no answer in time): the page or hop is refused, `robots-unreachable` (RFC 9309 §2.3.1.4). */
  readonly unreachable: boolean;
  /** The site's `Crawl-delay` for the crawl (ms, capped); `null`: none. */
  readonly crawlDelayMs: number | null;
  /**
   * robots.txt was fetched (`ok`) but could not be parsed (the crawl worker failed, or no parse came within `CRAWL_ROBOTS_PARSE_WAIT_MS`): read
   * as **blocked** (`crawl: 'blocked'`, the page recorded `blocked-by-robots`), never as unknown; the
   * failed parse is not cached, so a later page asks again.
   */
  readonly unparsed?: true;
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

/**
 * Per-call options of `fetchPage` (Task 6b): the sitemap seeding's own caps and `Accept` (every other
 * rule, scope, robots.txt, pacing and the redirect hook, stays the page's), and `beforeRequest`, asked
 * inside the host's paced slot right before the request (after the robots.txt and pacing waits): `false`
 * ends the call `aborted` with nothing requested (the crawl: its project was deleted meanwhile).
 */
export interface CrawlFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly accept?: string;
  readonly maxRedirects?: number;
  readonly beforeRequest?: () => Promise<boolean>;
}

/** One run's fetching. */
export interface CrawlRunFetcher {
  readonly scope: CrawlScopeRule;
  readonly politeness: Politeness;
  /** Fetches one page (or, with `options`, a sitemap file) under the run's policy; never rejects. */
  fetchPage(url: string, signal?: AbortSignal, options?: CrawlFetchOptions): Promise<CrawlPageFetch>;
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
/** A fetched robots.txt the worker could not parse: blocked, never unknown (Task 6b review). */
const unparsedRobots = (fetch: RobotsFetch): CrawlRobotsState => ({ fetch, crawl: 'blocked', googlebot: 'unknown', unreachable: false, crawlDelayMs: null, unparsed: true });

/** Thrown inside a paced slot when `beforeRequest` says no: the call ends `aborted`, nothing requested. */
class RefusedBeforeRequest extends Error {}

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
      const parsing = Promise.resolve().then(() => parseRobots(decodeRobotsBytes(fetch.body)));
      // A failed parse is not kept: the next page's lookup asks the worker again.
      parsing.catch(() => {
        if (parsed.get(fetch) === parsing) parsed.delete(fetch);
      });
      parsed.set(fetch, parsing);
      rules = parsing;
    }
    return rules;
  };

  /**
   * `fetch`'s rules, waited for at most `CRAWL_ROBOTS_PARSE_WAIT_MS` (its own wait, apart from the
   * lookup's) or until `signal` aborts; `null`: the parse failed or did not answer in time.
   */
  const parseWithin = (fetch: RobotsFetch, signal: AbortSignal | undefined): Promise<CrawlRobotsRules | null> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (rules: CrawlRobotsRules | null) => {
        if (settled) return;
        settled = true;
        cancel();
        signal?.removeEventListener('abort', onAbort);
        resolve(rules);
      };
      const onAbort = () => finish(null);
      const cancel = clock.setTimeout(() => finish(null), CRAWL_ROBOTS_PARSE_WAIT_MS);
      if (signal?.aborted) {
        finish(null);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      rulesOf(fetch).then(finish, () => finish(null));
    });

  /** The crawl's reading of `fetch` for `url`: an `ok` file whose parse fails or runs out of time is blocked, never unknown. */
  async function readRobots(fetch: RobotsFetch | null, url: string, signal: AbortSignal | undefined): Promise<CrawlRobotsState> {
    if (fetch === null) return unknownRobots(null);
    if (fetch.outcome === 'ok') {
      const rules = await parseWithin(fetch, signal);
      if (rules === null) return unparsedRobots(fetch);
      // Always the bare product token (and Googlebot's for the second verdict), never the header sent.
      const verdict = (token: string): CrawlRobotsVerdict => (rules.allowed(url, token) ? 'allowed' : 'blocked');
      return { fetch, crawl: verdict(CRAWL_ROBOTS_TOKEN), googlebot: verdict('googlebot'), unreachable: false, crawlDelayMs: rules.crawlDelayMs };
    }
    if (ALLOW_ALL.has(fetch.outcome)) return { fetch, crawl: 'allowed', googlebot: 'allowed', unreachable: false, crawlDelayMs: null };
    // Unknown (`ROBOTS_UNKNOWN_OUTCOMES`; `pending` never comes from `get`): the caller refuses, `robots-unreachable`.
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
        if (outcome === undefined || robots.unreachable || robots.unparsed) return;
        if (outcome === 'ok' || ALLOW_ALL.has(outcome)) politeness.setCrawlDelay(host, robots.crawlDelayMs, origin);
      };
      const lookupOptions: RobotsLookupOptions | undefined = scope.privateStart ? { exactOrigin: true } : undefined;

      /**
       * `url`'s robots.txt as main's robots fetcher answered, or `no-answer` when the lookup gave none within
       * `ROBOTS_WAIT_MS` or `signal` aborted. The wait covers the lookup only: the parse has its own (`readRobots`).
       */
      const lookup = (url: string, signal: AbortSignal | undefined): Promise<RobotsFetch | null | 'no-answer'> =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (value: RobotsFetch | null | 'no-answer') => {
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
          void deps.robots.get(url, lookupOptions).then(finish, () => finish(synthesized(url, 'unreachable')));
        });

      /** `url`'s robots.txt read for the crawl (the lookup, then the parse, each within its own wait), or `no-answer` from the lookup. */
      const robotsFor = async (url: string, signal: AbortSignal | undefined): Promise<CrawlRobotsState | 'no-answer'> => {
        const fetch = await lookup(url, signal);
        return fetch === 'no-answer' ? fetch : readRobots(fetch, url, signal);
      };

      async function fetchPage(rawUrl: string, signal?: AbortSignal, options: CrawlFetchOptions = {}): Promise<CrawlPageFetch> {
        const url = normaliseCrawlUrl(rawUrl) ?? rawUrl.slice(0, CRAWL_LIMITS.maxUrlChars);
        const none = (outcome: CrawlFetchOutcome, robots: CrawlRobotsState): CrawlPageFetch => ({ url, outcome, status: null, finalUrl: null, redirects: 0, chain: [], refusedUrl: null, redirectTarget: null, headers: {}, xRobotsTag: [], body: EMPTY, bytes: 0, truncated: false, startedAt: null, durationMs: 0, robots, slowDown: outcome === 'deferred' });
        // Scope and the address rule first: an out-of-scope page is never requested, nor its robots.txt.
        if (scope.check(url) !== 'in') return none('out-of-scope', { fetch: null, crawl: 'unknown', googlebot: 'unknown', unreachable: false, crawlDelayMs: null });
        const origin = new URL(url).origin;
        const host = pacingKey(url)!;
        const own = await robotsFor(url, signal);
        if (signal?.aborted) return none('aborted', unknownRobots(null));
        // No answer in time for the page's own origin: unknown, refused as any unreadable robots.txt is.
        const robots = own === 'no-answer' ? unknownRobots(synthesized(url, 'timeout')) : own;
        learnCrawlDelay(host, origin, robots);
        // Only `allowed` lets the page through: `blocked` (a rule, or a file not parsed in time) and `unknown` refuse it.
        if (robots.crawl === 'blocked') return none('blocked-by-robots', robots);
        if (robots.crawl !== 'allowed') return none('robots-unreachable', robots);

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
          // 2. Only then robots.txt for the new URL, bounded: no answer, or an unknown one, refuses the hop
          // (`robots-unreachable`). Each wait names its refusal before it starts, so a hop the fetcher's own cap
          // ends is recorded for what it waited on.
          refusal = { outcome: 'robots-unreachable', url: next };
          const fetch = await lookup(next, options.signal);
          if (fetch === 'no-answer') return false;
          // 3. A fetched file is parsed within its own wait: no rules in time (or a failed parse) refuses the hop as blocked.
          if (fetch?.outcome === 'ok') refusal = { outcome: 'blocked-by-robots', url: next };
          const state = await readRobots(fetch, next, options.signal);
          if (state.crawl !== 'allowed') {
            refusal = { outcome: state.crawl === 'blocked' ? 'blocked-by-robots' : 'robots-unreachable', url: next };
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
              // The pacing stamped this call's start just now, after `before`: the request goes out with nothing awaited between.
              startedAt = clock.now();
              const result = await deps.fetcher.fetch({
                url,
                page: settings.startUrl,
                userAgent: crawlUserAgent(deps.userAgent()),
                accept: options.accept ?? SERVED_ACCEPT,
                maxRedirects: options.maxRedirects ?? SERVED_FETCH_LIMITS.maxRedirects,
                maxBytes: options.maxBytes ?? CRAWL_LIMITS.maxBodyBytes,
                timeoutMs: options.timeoutMs ?? SERVED_FETCH_LIMITS.timeoutMs,
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
            // Inside the host's slot, after every wait: the last checks before the request, before its start is stamped.
            async () => {
              if (options.beforeRequest && !(await options.beforeRequest())) throw new RefusedBeforeRequest();
            },
          );
        } catch (error) {
          if (error instanceof CrawlAbortedError || error instanceof RefusedBeforeRequest) return none('aborted', robots);
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
