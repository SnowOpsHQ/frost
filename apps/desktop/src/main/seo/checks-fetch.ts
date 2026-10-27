import type { BoundedFetcher, BoundedFetchResult, FetchOutcome } from '@app/specs/fetcher.spec';
import { HREFLANG_CHECK_LIMITS, type CheckFetchOutcome } from '@app/specs/seo-checks.spec';

// The checks' one door to the network (spec `seo-checks.spec.ts`, `CHECK_FETCH_OUTCOMES`; Global
// Constraints, fetching on the user's behalf; review focus `link-checks-are-bounded`). The link,
// sitemap and hreflang checks only ever see `CheckFetch`: one URL, one method, its caps, answered
// with how it ended, the final status and URL, the redirects followed, the body as bytes (at most
// `maxBytes`) and the few headers the checks read. It never rejects.
//
// Every request goes through the shared bounded fetcher (`fetcher.ts`, spec `fetcher.spec.ts`), in
// its `checks` lane (Lanes: per-origin queues of its own, so an audit's robots.txt and served HTML
// never wait behind a link check): the browse session, cookies and credentials off, no referrer, the
// HTTP cache bypassed, `http(s)` only, each redirect checked before it is followed (at most
// `maxRedirects`, never to a private host unless the page the check is for is on one), the body read
// up to `maxBytes`, everything under one `timeoutMs` deadline.

/** The response headers the checks read (lowercased names; `null`: not sent). */
export interface CheckFetchHeaders {
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly link: string | null;
}

export interface CheckFetchOptions {
  readonly method: 'HEAD' | 'GET';
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /** The page the check is for (the audited page): private hosts may be requested only when it is on one. */
  readonly page: string;
  /** The `User-Agent` to send (the tab's render profile's), `null` for frost's own. */
  readonly userAgent: string | null;
  /** Aborts the request (the run was stopped or cancelled): answered `aborted`. */
  readonly signal: AbortSignal;
}

export interface CheckFetchResult {
  readonly outcome: CheckFetchOutcome;
  /** The final HTTP status (`null`: no response). */
  readonly status: number | null;
  /** The URL that answered (or the last one tried). */
  readonly finalUrl: string;
  readonly redirects: number;
  readonly body: Uint8Array;
  /** The body was longer than `maxBytes` (the rest was never read). */
  readonly truncated: boolean;
  readonly headers: CheckFetchHeaders;
}

/** Fetches `url` once, bounded by `options`; never rejects. */
export type CheckFetch = (url: string, options: CheckFetchOptions) => Promise<CheckFetchResult>;

/** Characters kept of each header the checks read. */
const HEADER_CHARS = { contentType: 256, contentEncoding: 64, link: HREFLANG_CHECK_LIMITS.maxHeaderChars } as const;

/**
 * The fetcher's outcomes as the checks name them (`CHECK_FETCH_OUTCOMES`). The checks never ask for
 * a private or non-`http(s)` URL themselves (they skip those first), so `private-address` and
 * `not-web` only stand for a target refused before any request, named as the redirect rules name
 * it. `busy` (the lane's queue for that origin is full: nothing was requested) is `unreachable`: no
 * answer, never cached.
 */
const OUTCOMES: Readonly<Record<FetchOutcome, CheckFetchOutcome>> = {
  response: 'response',
  'not-web': 'bad-redirect',
  'private-address': 'private-redirect',
  'too-many-redirects': 'too-many-redirects',
  'bad-redirect': 'bad-redirect',
  'no-location': 'no-location',
  'private-redirect': 'private-redirect',
  unreachable: 'unreachable',
  timeout: 'timeout',
  aborted: 'aborted',
  busy: 'unreachable',
};

/** A `User-Agent` safe to send: printable ASCII only, at most 512 characters (anything else: frost's own). */
function safeUserAgent(value: string | null): string | null {
  return value !== null && value !== '' && value.length <= 512 && /^[\x20-\x7e]+$/.test(value) ? value : null;
}

const header = (headers: BoundedFetchResult['headers'], name: string, max: number): string | null => headers[name]?.slice(0, max) ?? null;

/** The checks' `CheckFetch` over `fetcher` (main's `checks` lane, `createFetcherLanes`). */
export function createCheckFetch(fetcher: BoundedFetcher): CheckFetch {
  return async (url, options) => {
    const fetched = await fetcher.fetch({
      url,
      page: options.page,
      method: options.method,
      userAgent: safeUserAgent(options.userAgent),
      maxRedirects: options.maxRedirects,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      // A HEAD never has a body; a GET with no byte budget reads none.
      readBody: () => options.maxBytes > 0,
      keepHeaders: ['content-type', 'content-encoding', 'link'],
      maxHeaderChars: HEADER_CHARS.link,
      signal: options.signal,
    });
    return {
      outcome: OUTCOMES[fetched.outcome],
      status: fetched.status,
      // The URL that answered; without an answer, the last one tried (a redirect's target, or the URL asked for).
      finalUrl: fetched.finalUrl ?? fetched.chain.at(-1)?.location ?? fetched.url,
      redirects: fetched.redirects,
      body: fetched.body,
      truncated: fetched.truncated,
      headers: {
        contentType: header(fetched.headers, 'content-type', HEADER_CHARS.contentType),
        contentEncoding: header(fetched.headers, 'content-encoding', HEADER_CHARS.contentEncoding),
        link: header(fetched.headers, 'link', HEADER_CHARS.link),
      },
    };
  };
}
