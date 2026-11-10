import type { BoundedFetcher, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { ROBOTS_FETCH_LIMITS, ROBOTS_TRANSIENT_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { createBoundedFetcher, cutUrl, type Hop } from './fetcher';

// The hop, the private-host check and the net hop moved to the shared bounded fetcher (Phase 2.5
// Task 2, `fetcher.spec.ts`); they are re-exported here for robots.txt's callers.
export { isPrivateHost, netHop, type Hop, type HopResult, type NetRequester } from './fetcher';

// Main's robots.txt fetch (spec `seo-indexability.spec.ts`, `ROBOTS_FETCH_LIMITS`,
// `ROBOTS_FETCH_OUTCOMES`; acceptance `seo-indexability.feature.md`, robots.txt fetch; review focus
// `robots-fetch-is-bounded`). For a page it asks for `<page origin>/robots.txt` only, through the
// bounded fetcher (`fetcher.ts`, `fetcher.spec.ts`): one hop at a time, each redirect checked before
// it is followed (at most `maxRedirects`, `http(s)` only, never to a private host unless the page is
// on one), the body read up to `maxBytes` (only for a 2xx), everything under one `timeoutMs`
// deadline. Answers are cached per origin (and apart for exact-origin lookups; `cacheTtlMs`,
// `failureTtlMs` for transient failures, at most `maxCacheEntries`), and concurrent requests for an
// origin share one fetch. The body is kept as bytes, never decoded or parsed here: the analysis
// worker does (`@app/seo-core`, `decodeRobotsBytes`, `parseRobotsTxt`).

export interface RobotsFetcherOptions {
  /** How each request is made (`netHop` in main); used when no shared `fetcher` is given. */
  readonly hop: Hop;
  /**
   * The app's shared bounded fetcher (its per-origin queues are shared with every surface). Without
   * one, the robots fetcher has its own, with no interval between starts: its cache already asks
   * each origin at most once per `cacheTtlMs`.
   */
  readonly fetcher?: BoundedFetcher;
  /** Wall clock in ms, for the cache (injectable for tests). */
  readonly now?: () => number;
  readonly limits?: Partial<typeof ROBOTS_FETCH_LIMITS>;
}

/**
 * How one lookup is made. `exactOrigin` (the site crawl's lookups for a private start, Phase 12
 * Decision 6): the fetch never follows a redirect off the robots.txt URL's own origin (scheme, host
 * and port); such a redirect is answered `private-redirect` (no robots.txt), never `unreachable`.
 * Lookups with the rule are cached apart from lookups without it, so an answer that followed such a
 * redirect for another caller (the sidebar) is never reused by the crawl, and the reverse.
 */
export interface RobotsLookupOptions {
  readonly exactOrigin?: boolean;
}

export interface RobotsFetcher {
  /** The robots.txt of `pageUrl`'s origin (cached), or `null` for a non-`http(s)` page. Never rejects. */
  get(pageUrl: string, options?: RobotsLookupOptions): Promise<RobotsFetch | null>;
  /** What `get` would answer at once: the cached, settled answer; `undefined` when there is none yet (or it is still being fetched); `null` for a non-`http(s)` page. */
  peek(pageUrl: string, options?: RobotsLookupOptions): RobotsFetch | null | undefined;
  /** Forgets every origin (Clear Browsing Data); a fetch in flight is not cached when it settles. */
  clear(): void;
  /** How many origins are cached (for tests). */
  size(): number;
}

const TRANSIENT: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_TRANSIENT_OUTCOMES);
const EMPTY = new Uint8Array(0);

/** The outcome of a final HTTP status (`ROBOTS_FETCH_OUTCOMES`). */
export function outcomeOf(status: number): RobotsFetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'server-error';
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 400) return 'unavailable';
  // A 3xx answered as a response has no Location.
  if (status >= 300) return 'no-location';
  // 1xx (never final) and anything odd: unknown.
  return 'server-error';
}

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** The robots.txt outcome of a bounded fetch's outcome (`private-address` cannot happen: the file is on the page's own origin). */
function robotsOutcome(fetched: BoundedFetchResult): RobotsFetchOutcome {
  switch (fetched.outcome) {
    case 'response':
      return outcomeOf(fetched.status ?? 0);
    case 'too-many-redirects':
    case 'private-redirect':
    case 'bad-redirect':
    case 'no-location':
    case 'timeout':
    case 'unreachable':
      return fetched.outcome;
    // The page's own host resolves to a private address (Phase 2.5 Task 2 review: names are resolved
    // before each hop) while the page itself is not on a private host: refused like a private
    // redirect, so no robots.txt (never an "unreachable" warning for it).
    case 'private-address':
      return 'private-redirect';
    // An exact-origin lookup refused a redirect off its origin (the crawl's private start): no
    // robots.txt, as a private redirect is, never an "unreachable" one.
    case 'redirect-refused':
      return 'private-redirect';
    default:
      return 'unreachable';
  }
}

export function createRobotsFetcher(options: RobotsFetcherOptions): RobotsFetcher {
  const limits = { ...ROBOTS_FETCH_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { expires: number; value: Promise<RobotsFetch>; settled?: RobotsFetch }>();
  const fetcher = options.fetcher ?? createBoundedFetcher({ hop: options.hop, now, limits: { perOriginIntervalMs: 0 } });

  async function fetchRobots(robotsUrl: string, pageUrl: string, exactOrigin: boolean): Promise<RobotsFetch> {
    const origin = new URL(robotsUrl).origin;
    // The exact-origin rule: a hop to any other scheme, host or port is refused before it is requested.
    const allowRedirect = async (next: string): Promise<boolean> => parseWebUrl(next)?.origin === origin;
    const fetched = await fetcher.fetch({ url: robotsUrl, page: pageUrl, maxRedirects: limits.maxRedirects, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs, readBody: isOk, ...(exactOrigin ? { allowRedirect } : {}) });
    const outcome = robotsOutcome(fetched);
    return {
      url: fetched.url,
      outcome,
      status: fetched.status,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects,
      body: outcome === 'ok' ? fetched.body : EMPTY,
      truncated: outcome === 'ok' && fetched.truncated,
    };
  }

  /** The live cache entry for `key` (an expired one is dropped). */
  const fresh = (key: string) => {
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached;
    cache.delete(key);
    return undefined;
  };

  /** The cache key of a lookup: the origin, marked when the lookup has the exact-origin rule (cached apart). */
  const keyOf = (origin: string, options: RobotsLookupOptions | undefined): string => (options?.exactOrigin === true ? `exact ${origin}` : origin);

  return {
    get(pageUrl, options) {
      const page = parseWebUrl(pageUrl);
      if (!page) return Promise.resolve(null);
      const origin = page.origin;
      const key = keyOf(origin, options);
      const cached = fresh(key);
      if (cached) return cached.value;
      const value = fetchRobots(`${origin}/robots.txt`, page.href, options?.exactOrigin === true);
      // In flight: shared until it settles, then kept for its TTL.
      const entry: { expires: number; value: Promise<RobotsFetch>; settled?: RobotsFetch } = { expires: Number.POSITIVE_INFINITY, value };
      cache.set(key, entry);
      while (cache.size > limits.maxCacheEntries) cache.delete(cache.keys().next().value!);
      void value.then((fetched) => {
        entry.settled = fetched;
        entry.expires = now() + (TRANSIENT.has(fetched.outcome) ? limits.failureTtlMs : limits.cacheTtlMs);
      });
      return value;
    },
    peek(pageUrl, options) {
      const page = parseWebUrl(pageUrl);
      if (!page) return null;
      return fresh(keyOf(page.origin, options))?.settled;
    },
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}

/** What the audit sees while `pageUrl`'s robots.txt is still being fetched (`pending`); `null` for a non-`http(s)` page. */
export function pendingRobots(pageUrl: string): RobotsFetch | null {
  const page = parseWebUrl(pageUrl);
  if (!page) return null;
  return { url: cutUrl(`${page.origin}/robots.txt`), outcome: 'pending', status: null, finalUrl: null, redirects: 0, body: EMPTY, truncated: false };
}
