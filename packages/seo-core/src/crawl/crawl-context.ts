import { headerValueCap, RESPONSE_HEADER_ALLOWLIST, RESPONSE_LIMITS, type ResponseHeaderName } from '@app/specs/seo-indexability.spec';
import type { PageContext, ResponseHeader, ResponseMeta, RobotsFetch } from '@app/specs/seo-snapshot.spec';

// The crawl's page context (spec `site-crawl.spec.ts`, `CRAWL_KEEP_HEADERS`; acceptance
// `site-crawl.feature.md`, The context; plan Decision 6 and Task 6b). What the sidebar's audit gets from
// main beside the snapshot (`PageContext`), built from the crawl's bounded fetch instead of the browse
// session's webRequest record: the response (`ResponseMeta`: the final URL, `source: 'network'`, the
// status, the kept headers the audit's allowlist names, the redirect hops followed, never internal),
// and the origin's robots.txt as main's robots fetcher answered. No accessibility and no checks (the
// crawl renders nothing and runs no link check). Pure.

/** What the crawl's fetch kept of one page (`CrawlPageFetch` in main): its final URL, status, kept headers and redirect hops. */
export interface CrawlFetchFacts {
  /** The URL that answered (the fetch's final URL). */
  readonly url: string;
  readonly status: number;
  /** Kept headers, lowercase names (`x-robots-tag` values joined with `\n`; read from `xRobotsTag` instead). */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The `X-Robots-Tag` values, kept apart. */
  readonly xRobotsTag: readonly string[];
  /** The redirect hops followed before the answer, oldest first. */
  readonly chain: readonly { readonly url: string; readonly status: number; readonly location: string }[];
}

const ALLOWED: ReadonlySet<string> = new Set(RESPONSE_HEADER_ALLOWLIST);

/** `value` cut to `max` UTF-16 code units, never inside a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** One header value as the response capture keeps it: cut to its cap, `truncated` when cut. */
function headerOf(name: ResponseHeaderName, value: string): ResponseHeader {
  const cap = headerValueCap(name);
  return value.length > cap ? { name, value: cut(value, cap), truncated: true } : { name, value };
}

/** The page's `ResponseMeta` from the crawl's fetch: the allowlisted kept headers (each name at most `maxValuesPerHeader` values), the hops (at most `maxRedirects`). */
export function crawlResponse(fetched: CrawlFetchFacts): ResponseMeta {
  const headers: ResponseHeader[] = [];
  const names = Object.keys(fetched.headers)
    .map((name) => name.toLowerCase())
    .filter((name) => ALLOWED.has(name) && name !== 'x-robots-tag')
    .sort();
  for (const name of names) {
    const value = fetched.headers[name];
    if (typeof value === 'string') headers.push(headerOf(name as ResponseHeaderName, value));
  }
  for (const value of fetched.xRobotsTag.slice(0, RESPONSE_LIMITS.maxValuesPerHeader)) headers.push(headerOf('x-robots-tag', value));
  return {
    url: fetched.url,
    source: 'network',
    status: fetched.status,
    headersAvailable: true,
    headers: headers.slice(0, RESPONSE_LIMITS.maxHeaders),
    redirects: fetched.chain.slice(0, RESPONSE_LIMITS.maxRedirects).map((hop) => ({ url: hop.url, status: hop.status, location: hop.location, internal: false })),
    redirectTotal: fetched.chain.length,
  };
}

/** The crawled page's context: its response from the fetch and its origin's robots.txt (`null`: none asked). */
export function crawlContext(fetched: CrawlFetchFacts, robots: RobotsFetch | null): PageContext {
  return { response: crawlResponse(fetched), robots };
}
