/**
 * The bounded fetcher (Phase 2.5 Global Constraints, "Fetching on the user's behalf"; Task 2
 * extracted it from Phase 2's robots.txt fetcher). Every request frost makes on the user's behalf
 * goes through it: robots.txt (`seo-indexability.spec.ts`), the served HTML of an audited page
 * (`seo-javascript.spec.ts`), and Task 7's link, sitemap and hreflang checks. Implemented by
 * `apps/desktop/src/main/seo/fetcher.ts` (`createBoundedFetcher`, `netHop`, `isPrivateHost`); main
 * only, never the chrome or the analysis worker.
 *
 * Plain values and types with no imports, so any module (the chrome too, for labels) can use them.
 *
 * ## Rules every request follows
 * - **Browse session.** The request goes through the browse partition's session (its proxy and
 *   certificate checks), with cookies and credentials omitted (`credentials: 'omit'`, no session
 *   cookies, so no login prompt either), no referrer, and not from or into the HTTP cache.
 * - **http(s) only.** A non-`http(s)` URL is never requested (`not-web`).
 * - **Redirects one hop at a time.** Each redirect is reported, not followed by the network stack;
 *   the fetcher checks its `Location` before requesting the next hop itself: at most
 *   `maxRedirects` (one more is `too-many-redirects`); a non-`http(s)` or unparsable `Location`
 *   is `bad-redirect`, a 3xx without one `no-location`; another origin is allowed.
 * - **Private addresses.** A private host (`private-address.spec.ts`, `isPrivateHost`: every
 *   reserved IPv4 and IPv6 range, IPv4-in-IPv6 forms judged by their IPv4 address, and local-only
 *   names such as `localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, `*.test`, single
 *   labels) is never requested, neither as the first URL (`private-address`) nor as a redirect hop
 *   (`private-redirect`), unless the page the request is made for (`BoundedFetchRequest.page`) is
 *   itself on a private host (a dev server: its URL's host, literally). A **name** is also resolved
 *   before each hop (main: `session.resolveHost` on the browse session, so its proxy-free resolver,
 *   host rules and cache): if **any** address it resolves to is private, the hop is refused the same
 *   way; a name that does not resolve is `unreachable`. Two gaps remain, by design of the network
 *   stack frost uses: `net.request` cannot be pinned to the address checked, so a name whose answer
 *   changes between the check and the connection (DNS rebinding, a TTL of zero) can still reach a
 *   private address in that window; and through a proxy the proxy resolves the name itself.
 *   The e2e suite's seam: `E2E_PUBLIC_HOSTS_SWITCH` (unpackaged builds only; a packaged build refuses
 *   to start with it, `PACKAGED_FORBIDDEN_SWITCHES`) names hosts whose resolution is not checked, so
 *   a loopback server under a public-looking name (`--host-resolver-rules`) can stand for a public
 *   site. Their literal check still applies.
 * - **Caps per call.** The body is read up to `maxBytes`, then reading stops and the request is
 *   cancelled (`truncated`; a body that exactly fills the cap is `truncated` only if more follows).
 *   One deadline, `timeoutMs`, counted from the call (time waiting for the origin's turn, every hop
 *   and the body included), ends it with `timeout`.
 * - **Per-origin rate limit and concurrency.** Requests are queued per origin (of the first URL):
 *   at most `perOriginConcurrency` run at once, a new one starts no sooner than
 *   `perOriginIntervalMs` after the previous one started there, and at most `maxQueuedPerOrigin`
 *   wait (one more is answered `busy` at once, never requested). The first request to an idle
 *   origin starts at once.
 * - **User agent.** The browse session's own (frost's) unless the request names one (`userAgent`,
 *   e.g. a tab's render profile user agent).
 *
 * ## Lanes (Phase 2.5 integration)
 * Main runs two instances of the fetcher, both on the same hop (`netHop` on the browse session), so
 * every rule above holds for both; only their per-origin queues are separate (`FETCHER_LANES`):
 * - **`audit`**: what every audit fetches by itself, robots.txt and the served HTML, with
 *   `FETCHER_LIMITS`.
 * - **`checks`**: what the user starts on request, Task 7's link, sitemap and hreflang checks, with
 *   `CHECKS_FETCHER_LIMITS`.
 *
 * A link check can queue up to 500 requests on one origin and keep both of a queue's slots busy for
 * minutes; on one shared queue an audit's robots.txt and served-HTML fetches would wait behind it
 * (and could time out waiting, since the deadline counts the wait). With separate lanes an audit
 * never waits for a check; a priority within one queue would not do, as it cannot take back a slot
 * a running check holds (up to 10 s a link). The cost: a site can see both lanes at once, at most
 * `perOriginConcurrency` of each (4 requests in flight) and each lane's rate. robots.txt itself stays
 * in the `audit` lane (cached per origin): the checks ask main's robots.txt fetcher for it.
 *
 * **The SERP lane (Phase 3).** A third instance, outside `FETCHER_LANES`, serves what the SERP
 * features fetch on the user's request: the visibility probes, "Check for selector updates" and the
 * intent model's download. It is created by `apps/desktop/src/main/serp/setup.ts` over the same hop
 * and resolver, with `SERP_FETCHER_LIMITS` (`serp-service.spec.ts`: the `checks` lane's limits) and
 * per-origin queues of its own, so a link check never makes a probe wait. A site can then see up to
 * three lanes' requests at once.
 *
 * **The crawl lane (Phase 12, Decision 6).** A fourth instance, outside `FETCHER_LANES` like the SERP
 * lane, serves the site crawler (`site-crawl.spec.ts`): created by `apps/desktop/src/main/crawl/` over
 * the same hop and resolver, with `CRAWL_FETCHER_LIMITS` and per-origin queues of its own. Its
 * `perOriginIntervalMs` is the **floor** (`CRAWL_INTERVAL_MS.min`), a second guarantee only: the
 * crawl's own pacing submits one fetch call per origin at a time and waits the effective interval
 * (the user's choice, `Crawl-delay`, back-off, `Retry-After`) before the next. Every crawl request is
 * made with `page` = the run's start URL, so the private-address rule above applies unchanged, and
 * passes `allowRedirect` (below), so every redirect hop passes the crawl's policy before it is
 * requested. A site can then see up to four lanes' requests at once.
 *
 * Sites can see these requests: every surface that makes them says so (`FETCH_DISCLOSURE`).
 */

/** The fetcher's defaults; each call may lower (or, within reason, raise) the per-call caps. */
export const FETCHER_LIMITS = {
  /** Redirects followed per call. */
  maxRedirects: 5,
  /** Body bytes read per call. */
  maxBytes: 512_000,
  /** One deadline per call (ms), counted from the call. */
  timeoutMs: 5_000,
  /** Requests running at once per origin. */
  perOriginConcurrency: 2,
  /** Least time (ms) between two request starts on one origin (at most 5 a second). */
  perOriginIntervalMs: 200,
  /** Requests waiting per origin; one more is `busy`. */
  maxQueuedPerOrigin: 1_000,
  /** Response headers kept per call (`BoundedFetchResult.headers`), each value cut to this (unless the call says otherwise). */
  maxHeaderValueChars: 1_024,
  /**
   * The longest one `allowRedirect` answer may take (ms, per hop; Phase 12 Task 6a review): a hook
   * still unanswered then refuses the hop (`redirect-refused`). At least the crawl hook's own robots.txt
   * wait (`ROBOTS_FETCH_LIMITS.timeoutMs` + `CRAWL_ROBOTS_HOOK_MARGIN_MS`, 6 s), so the crawl's answer
   * always arrives first.
   */
  maxRedirectHookMs: 8_000,
} as const;

/**
 * The `checks` lane's per-origin queue (see Lanes): `LINK_CHECK_LIMITS`' per-origin concurrency and
 * rate limit (`seo-checks.spec.ts`), and the same queue cap as the `audit` lane.
 */
export const CHECKS_FETCHER_LIMITS = {
  perOriginConcurrency: 2,
  perOriginIntervalMs: 250,
  maxQueuedPerOrigin: 1_000,
} as const;

/**
 * The crawl lane's per-origin queue (see Lanes): one fetch call in flight per origin, starts at least
 * 500 ms apart (the floor; `CRAWL_INTERVAL_MS.min` in `site-crawl.spec.ts`), and a short queue (the
 * crawl submits one call per origin at a time; robots.txt lookups go through main's robots fetcher).
 */
export const CRAWL_FETCHER_LIMITS = {
  perOriginConcurrency: 1,
  perOriginIntervalMs: 500,
  maxQueuedPerOrigin: 4,
} as const;

/** The fetcher instances main runs, and each one's per-origin queue limits (see Lanes). */
export const FETCHER_LANES = {
  audit: { perOriginConcurrency: FETCHER_LIMITS.perOriginConcurrency, perOriginIntervalMs: FETCHER_LIMITS.perOriginIntervalMs, maxQueuedPerOrigin: FETCHER_LIMITS.maxQueuedPerOrigin },
  checks: CHECKS_FETCHER_LIMITS,
} as const;
export type FetcherLane = keyof typeof FETCHER_LANES;

export const FETCH_METHODS = ['GET', 'HEAD'] as const;
export type FetchMethod = (typeof FETCH_METHODS)[number];

/**
 * How a call ended:
 * - `response`: a final (non-redirect) HTTP response; `status` is its status, whatever it is;
 * - `not-web`: the URL is not `http(s)` (nothing requested);
 * - `private-address`: the first URL is on a private host and the page is not (nothing requested);
 * - `too-many-redirects`, `bad-redirect`, `no-location`, `private-redirect`: see the rules above;
 * - `unreachable`: a network error; `timeout`: the deadline passed;
 * - `aborted`: the caller's `signal` aborted; `busy`: the origin's queue was full (nothing requested);
 * - `redirect-refused` (Phase 12 Task 6a): the call's `allowRedirect` hook refused a redirect hop (the
 *   next URL was never requested; `status` and `finalUrl` are the redirect's, and the refused hop is
 *   not in `chain`). Only a call that passes the hook (the crawl lane, and the crawl's exact-origin
 *   robots.txt lookups) can end so.
 */
export const FETCH_OUTCOMES = ['response', 'not-web', 'private-address', 'too-many-redirects', 'bad-redirect', 'no-location', 'private-redirect', 'redirect-refused', 'unreachable', 'timeout', 'aborted', 'busy'] as const;
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number];

/**
 * The e2e seam (see Private addresses): `--frost-e2e-public-hosts=a.example,b.example` exempts those
 * host names from the DNS check. Read only by unpackaged builds; packaged builds refuse to start
 * with it.
 */
export const E2E_PUBLIC_HOSTS_SWITCH = 'frost-e2e-public-hosts' as const;

/** What a surface that fetches on the user's behalf says about it. */
export const FETCH_DISCLOSURE = 'frost requests this from the site itself, without cookies. The site can see these requests.' as const;

/** One call. */
export interface BoundedFetchRequest {
  /** What to fetch (`http(s)` only). */
  readonly url: string;
  /**
   * The page the request is made for (the audited page): its origin decides whether private hosts
   * may be requested (only when it is on one). For a page's own resources, the page's URL.
   */
  readonly page: string;
  /** `GET` (default) or `HEAD` (never a body). */
  readonly method?: FetchMethod;
  /** The `User-Agent` to send (`null` / absent: the browse session's own). */
  readonly userAgent?: string | null;
  /** The `Accept` header to send (absent: the network stack's default). */
  readonly accept?: string;
  /** Per-call caps (defaults: `FETCHER_LIMITS`). */
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Whether to read the body of a final response with this status (default: always; `HEAD`: never). */
  readonly readBody?: (status: number) => boolean;
  /** Response headers to keep (lowercase names; default `content-type` only). */
  readonly keepHeaders?: readonly string[];
  /** Characters kept of each kept header's value (default `FETCHER_LIMITS.maxHeaderValueChars`; a `Link` header listing alternates needs more). */
  readonly maxHeaderChars?: number;
  /**
   * Kept headers (lowercase names, also in `keepHeaders`) whose repeated values are kept apart,
   * joined with `\n` (which no header value can hold), instead of `, `: a header whose values carry
   * their own commas and scopes (`X-Robots-Tag: googlebot: nofollow` and `X-Robots-Tag: noindex`)
   * cannot be split again once joined with `, `. Read from the hop's raw header list when it reports
   * one (Electron's `headers` already joins duplicates with `, ` and drops some), else from an array
   * value. Default: none (every value joined with `, `, as before).
   */
  readonly separateHeaders?: readonly string[];
  /** Aborts the call (queued or running): `aborted`. */
  readonly signal?: AbortSignal;
  /**
   * The redirect-policy hook (Phase 12 Decision 6; the crawl lane's, absent elsewhere: other lanes
   * behave as without it). Consulted in the redirect branch for every hop, after the fetcher's own
   * checks of its `Location` (`maxRedirects`, `bad-redirect`, the private-address rule) and before the
   * hop is requested, with the resolved next URL. It answers whether the hop may be followed; `false`
   * (or a rejection) ends the call with the outcome `redirect-refused`, and the next URL is never
   * requested. The caller records why (the crawl: `blocked-by-robots`, `out-of-scope`,
   * `private-redirect` or `robots-timeout`).
   *
   * The hook decides scope and the private-address / exact-origin rule **before any request to the new
   * origin** (the fetcher's own DNS resolution excepted), and only when both allow the hop may it look
   * up that origin's robots.txt. The time it spends is not counted in the page fetch's own `timeoutMs`
   * (the deadline is paused while it runs); the hook bounds its own wait, and a hook past its time
   * refuses the hop. The fetcher also caps it (`FETCHER_LIMITS.maxRedirectHookMs`: unanswered then, a
   * refusal), and once the hook allows a hop to a name it resolves the name again before requesting it
   * (an answer that turned private while the hook ran refuses the hop, `private-redirect`).
   *
   * `signal` aborts when the call's own `signal` does (the hook passes it to its robots lookup). The
   * fetcher races the hook against the call's signal: an abort while the hook runs ends the call at
   * once with `aborted` (never `redirect-refused`), and the hook's later answer is ignored.
   */
  readonly allowRedirect?: (nextUrl: string, options: { readonly signal: AbortSignal }) => Promise<boolean>;
}

/** A redirect the call followed. */
export interface FetchRedirect {
  /** The URL that answered with the redirect. */
  readonly url: string;
  readonly status: number;
  /** Where it sent the request (resolved). */
  readonly location: string;
}

/** How a call ended. Never a rejection. */
export interface BoundedFetchResult {
  /** The URL asked for (cut to 2,048 characters). */
  readonly url: string;
  readonly outcome: FetchOutcome;
  /** The status of the last answer received (a redirect's, for a refused redirect); `null` without one. */
  readonly status: number | null;
  /** The URL that gave that answer; `null` without one. */
  readonly finalUrl: string | null;
  /** Redirects followed (the hops in `chain`). */
  readonly redirects: number;
  readonly chain: readonly FetchRedirect[];
  /** The final response's kept headers (`keepHeaders`), lowercase names, values joined with `, ` (`\n` for `separateHeaders`) and cut. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body exactly as read (at most `maxBytes`; empty unless read). Never decoded by the fetcher. */
  readonly body: Uint8Array<ArrayBuffer>;
  /** The body was longer than `maxBytes` (the rest was never read). */
  readonly truncated: boolean;
  /** How long the call took (ms), queue wait included. */
  readonly durationMs: number;
}

/** A fetcher main shares (one per lane, `FETCHER_LANES`: a lane's per-origin queues are shared by every surface in it). */
export interface BoundedFetcher {
  /** Fetches `request`; never rejects. */
  fetch(request: BoundedFetchRequest): Promise<BoundedFetchResult>;
  /** Requests running and waiting on `origin` (for tests and surfaces that show progress). */
  load(origin: string): { readonly running: number; readonly queued: number };
}
