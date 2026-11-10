import { registrableDomain } from '@app/seo-core';
import { isPrivateHost } from '@app/specs/private-address.spec';
import { CRAWL_LIMITS, CRAWL_PRIVATE_START_SCOPES, CRAWL_TRACKING_PARAMS, type CrawlScope } from '@app/specs/site-crawl.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// What a crawl may follow (spec `site-crawl.spec.ts`, `CRAWL_SCOPES`, `CRAWL_TRACKING_PARAMS`;
// acceptance `site-crawl.feature.md`, crawl-scope-host-site-path, crawl-strips-tracking-params,
// crawl-caps-query-variants, crawl-private-start-is-origin-only; plan Decision 6). Pure: no request
// is made here, so the redirect hook can decide scope and the address rule before any request to a
// new origin.

/** A crawl URL's normal form: `http(s)`, no credentials, the fragment dropped, the host lowercased, a default port removed, tracking parameters stripped; `null` when it is no crawl URL. */
export function normaliseCrawlUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  // `parseWebUrl` keeps `http(s)` URLs with a host; the WHATWG parser already lowercases the host and drops a default port.
  if (parseWebUrl(url.href) === null || url.username !== '' || url.password !== '') return null;
  url.hash = '';
  url.search = stripTracking(url.search);
  const href = url.href.endsWith('?') ? url.href.slice(0, -1) : url.href;
  return href.length > CRAWL_LIMITS.maxUrlChars ? null : href;
}

const TRACKING: ReadonlySet<string> = new Set(CRAWL_TRACKING_PARAMS);

/** `search` without the tracking parameters (names compared decoded and lowercased); the rest kept byte for byte, in order. */
function stripTracking(search: string): string {
  if (search.length <= 1) return '';
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => {
      if (pair === '') return false;
      const rawName = pair.split('=', 1)[0]!.replace(/\+/g, ' ');
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      return !TRACKING.has(name.toLowerCase());
    });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/**
 * Where a URL stands for a run: `in` scope; `out-of-scope` (another host, domain or directory, an
 * include / exclude prefix, or no crawl URL at all); `private` (the address rule: a private host from a
 * public start, or anything off a private start's exact origin). Links answered other than `in` are
 * never queued; a redirect hop answered so is refused (`out-of-scope`, `private-redirect`).
 */
export type CrawlScopeVerdict = 'in' | 'out-of-scope' | 'private';

export interface CrawlScopeSettings {
  readonly startUrl: string;
  readonly scope: CrawlScope;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface CrawlScopeRule {
  /** The normalised start URL. */
  readonly start: string;
  /** The start is on a private host: the run is limited to its exact origin (scheme, host and port). */
  readonly privateStart: boolean;
  check(url: string): CrawlScopeVerdict;
}

/** The run's scope. Throws when the start URL is no crawl URL, or a private start asks for another scope than `host` (the settings schema refuses both first). */
export function createCrawlScope(settings: CrawlScopeSettings): CrawlScopeRule {
  const startHref = normaliseCrawlUrl(settings.startUrl);
  if (startHref === null) throw new Error('the start URL is not a crawl URL');
  const start = new URL(startHref);
  const privateStart = isPrivateHost(start.hostname);
  if (privateStart && !(CRAWL_PRIVATE_START_SCOPES as readonly CrawlScope[]).includes(settings.scope)) throw new Error('a private start stays on its exact origin (scope host)');
  const domain = registrableDomain(start.hostname);
  const directory = start.pathname.slice(0, start.pathname.lastIndexOf('/') + 1) || '/';
  const include = [...settings.include];
  const exclude = [...settings.exclude];

  /** A public start's port rule: either scheme, on the start URL's own port or a default one (80, 443; `''` once normalised). */
  const portAllowed = (url: URL): boolean => url.port === '' || url.port === start.port;
  const inHostScope = (url: URL): boolean => {
    if (!portAllowed(url)) return false;
    switch (settings.scope) {
      case 'host':
        return url.hostname === start.hostname;
      case 'site':
        return registrableDomain(url.hostname) === domain;
      case 'path':
        return url.hostname === start.hostname && url.pathname.startsWith(directory);
    }
  };

  return {
    start: startHref,
    privateStart,
    check(raw) {
      const href = normaliseCrawlUrl(raw);
      if (href === null) return 'out-of-scope';
      const url = new URL(href);
      if (privateStart) {
        if (url.origin !== start.origin) return 'private';
      } else if (isPrivateHost(url.hostname)) return 'private';
      // The start URL itself is always in scope: the crawl begins there.
      if (href === startHref) return 'in';
      if (!inHostScope(url)) return 'out-of-scope';
      const target = `${url.pathname}${url.search}`;
      if (include.length > 0 && !include.some((prefix) => target.startsWith(prefix))) return 'out-of-scope';
      if (exclude.some((prefix) => target.startsWith(prefix))) return 'out-of-scope';
      return 'in';
    },
  };
}

export interface QueryVariantCap {
  /**
   * Whether `url` (normalised) may be queued: always without a query; with one, while its path (origin
   * and path) has had fewer than `maxPerPath` query variants admitted. Offer each URL once (the
   * frontier is the seen-set): every admitted query counts.
   */
  admit(url: string): boolean;
  /** Paths counted (bounded by `maxPaths`; K-B3 counts it). */
  size(): number;
}

/**
 * The per-path query-variant cap (`CRAWL_LIMITS.maxQueryVariantsPerPath`), in a bounded in-memory map:
 * at most `maxPaths` paths are counted, the longest-unused one forgotten first (a forgotten path counts
 * from zero again, so a very wide site can see a few more variants of an old path, never an unbounded
 * number at once). Task 6b may back it with the frontier instead.
 */
export function createQueryVariantCap(options: { readonly maxPerPath?: number; readonly maxPaths?: number } = {}): QueryVariantCap {
  const maxPerPath = options.maxPerPath ?? CRAWL_LIMITS.maxQueryVariantsPerPath;
  const maxPaths = options.maxPaths ?? Math.floor(CRAWL_LIMITS.maxInMemoryEntries / 4);
  const counts = new Map<string, number>();
  return {
    admit(raw) {
      const href = normaliseCrawlUrl(raw);
      if (href === null) return false;
      const url = new URL(href);
      if (url.search === '') return true;
      const key = `${url.origin}${url.pathname}`;
      const count = counts.get(key) ?? 0;
      const admitted = count < maxPerPath;
      // Most recently used last (a refused offer keeps a full path counted too).
      counts.delete(key);
      counts.set(key, admitted ? count + 1 : count);
      while (counts.size > maxPaths) counts.delete(counts.keys().next().value!);
      return admitted;
    },
    size: () => counts.size,
  };
}
