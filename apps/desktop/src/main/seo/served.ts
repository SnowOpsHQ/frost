import type { BoundedFetcher, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS, SERVED_HTML_TYPES, type ServedUnavailableReason } from '@app/specs/seo-javascript.spec';
import type { ServedParseInput, ServedParseResult, ServedState } from '@app/specs/seo-javascript.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { cutUrl } from './fetcher';

// The served HTML of an audited page (spec `seo-javascript.spec.ts`, `SERVED_FETCH_LIMITS`;
// acceptance `seo-javascript.feature.md`, Fetching). Main fetches the page's URL as served through
// the shared bounded fetcher (`fetcher.ts`: browse session, cookies omitted, no referrer, bounded),
// with the tab's render-profile user agent if it has one, and hands the bytes to the analysis worker
// to parse (`parse`, `served-parse.ts`); main never decodes or parses them. The state is kept per
// tab document, URL and user agent, so an audit and its re-analyses fetch once; a new document
// (`forget`) or Clear Browsing Data (`clear`) drops it.

export interface ServedHtmlOptions {
  readonly fetcher: BoundedFetcher;
  /** Parses fetched bytes in the analysis worker (`Analyzer.parseServed`). Never rejects. */
  readonly parse: (input: ServedParseInput) => Promise<ServedParseResult>;
  readonly limits?: Partial<typeof SERVED_FETCH_LIMITS>;
}

/** How the served HTML is read: `scripting` false for a tab whose render profile turns JavaScript off (default true). */
export interface ServedHow {
  readonly scripting?: boolean;
}

export interface ServedHtml {
  /** The served state of `pageUrl` (its fragment dropped) for tab document `contentsId`, fetched with `userAgent` (`null`: frost's own). Cached; never rejects. */
  get(contentsId: number, pageUrl: string, userAgent: string | null, how?: ServedHow): Promise<ServedState>;
  /** What `get` would answer at once: the settled answer, else `undefined`. */
  peek(contentsId: number, pageUrl: string, userAgent: string | null, how?: ServedHow): ServedState | undefined;
  /** Drops the tab's answers for `pageUrl` (every user agent): "Fetch again". */
  drop(contentsId: number, pageUrl: string): void;
  /** The tab's document changed, or the tab is gone: its answers go, and a fetch still in flight is aborted. */
  forget(contentsId: number): void;
  /** Clear Browsing Data: every answer goes (one in flight is not kept). */
  clear(): void;
  /** Answers kept for the tab (for tests). */
  size(contentsId: number): number;
}

/** What stands in for the served HTML while it is fetched and parsed. */
export const PENDING_SERVED: ServedState = { status: 'pending' };

const unavailable = (reason: ServedUnavailableReason, httpStatus: number | null = null, finalUrl: string | null = null): ServedState => ({ status: 'unavailable', reason, httpStatus, finalUrl });

/** `url` without its `#fragment`, if it is an `http(s)` URL. */
function pageKey(url: string): string | null {
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.hash = '';
  return parsed.href;
}

/** The media type of a `Content-Type` value (no parameters, lowercased); `null` without one. */
export function mediaType(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type === '' ? null : type;
}

/** Why a bounded fetch gave no page to parse (`null`: it did). */
export function servedFailure(fetched: BoundedFetchResult): ServedState | null {
  switch (fetched.outcome) {
    case 'response': {
      const status = fetched.status ?? 0;
      if (status < 200 || status >= 300) return unavailable('http-status', fetched.status, fetched.finalUrl);
      const type = mediaType(fetched.headers['content-type']);
      if (type !== null && !(SERVED_HTML_TYPES as readonly string[]).includes(type)) return unavailable('not-html', fetched.status, fetched.finalUrl);
      return null;
    }
    case 'not-web':
      return unavailable('not-fetched');
    case 'aborted':
      return unavailable('unreachable');
    default:
      return unavailable(fetched.outcome, fetched.status, fetched.finalUrl);
  }
}

export function createServedHtml(options: ServedHtmlOptions): ServedHtml {
  const limits = { ...SERVED_FETCH_LIMITS, ...options.limits };
  interface Entry {
    readonly value: Promise<ServedState>;
    readonly controller: AbortController;
    settled?: ServedState;
  }
  const tabs = new Map<number, Map<string, Entry>>();

  async function load(url: string, userAgent: string | null, scripting: boolean, signal: AbortSignal): Promise<ServedState> {
    const fetched = await options.fetcher.fetch({
      url,
      page: url,
      userAgent,
      accept: SERVED_ACCEPT,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      readBody: (status) => status >= 200 && status < 300,
      keepHeaders: ['content-type'],
      signal,
    });
    const failed = servedFailure(fetched);
    if (failed) return failed;
    const finalUrl = fetched.finalUrl ?? url;
    // Redirected elsewhere (a login page, another locale): not the page that was rendered.
    if (pageKey(finalUrl) !== url) return unavailable('redirected', fetched.status, cutUrl(finalUrl));
    const contentType = fetched.headers['content-type'] ?? null;
    const parsed = await options.parse({ url: finalUrl, contentType, body: fetched.body, scriptingEnabled: scripting }).catch((): ServedParseResult => ({ ok: false, reason: 'parse-failed' }));
    if (!parsed.ok) return unavailable(parsed.reason, fetched.status, cutUrl(finalUrl));
    return {
      status: 'ready',
      fetch: {
        url: cutUrl(url),
        finalUrl: cutUrl(finalUrl),
        status: fetched.status ?? 200,
        redirects: fetched.redirects,
        bytes: fetched.body.byteLength,
        truncated: fetched.truncated,
        contentType: contentType === null ? null : contentType.slice(0, 256),
        userAgent: userAgent === null ? null : userAgent.slice(0, 512),
        durationMs: fetched.durationMs,
      },
      snapshot: parsed.snapshot,
    };
  }

  const keyOf = (url: string, userAgent: string | null, scripting: boolean): string => [url, userAgent ?? '', scripting ? 'js' : 'no-js'].join('\n');
  /** Drops `entries`' `keys`, aborting a fetch still in flight. */
  const remove = (entries: Map<string, Entry>, keys: readonly string[]): void => {
    for (const key of keys) {
      entries.get(key)?.controller.abort();
      entries.delete(key);
    }
  };

  return {
    get(contentsId, pageUrl, userAgent, how = {}) {
      const url = pageKey(pageUrl);
      if (url === null) return Promise.resolve(unavailable('not-fetched'));
      const scripting = how.scripting ?? true;
      let entries = tabs.get(contentsId);
      if (!entries) {
        entries = new Map();
        tabs.set(contentsId, entries);
      }
      const key = keyOf(url, userAgent, scripting);
      const cached = entries.get(key);
      if (cached) return cached.value;
      const controller = new AbortController();
      const value = load(url, userAgent, scripting, controller.signal).catch(() => unavailable('unreachable'));
      const entry: Entry = { value, controller };
      entries.set(key, entry);
      while (entries.size > limits.maxCachedPerTab) remove(entries, [entries.keys().next().value!]);
      void value.then((state) => (entry.settled = state));
      return value;
    },
    peek(contentsId, pageUrl, userAgent, how = {}) {
      const url = pageKey(pageUrl);
      return url === null ? undefined : tabs.get(contentsId)?.get(keyOf(url, userAgent, how.scripting ?? true))?.settled;
    },
    drop(contentsId, pageUrl) {
      const url = pageKey(pageUrl);
      const entries = tabs.get(contentsId);
      if (url === null || !entries) return;
      remove(entries, [...entries.keys()].filter((key) => key.split('\n')[0] === url));
    },
    forget(contentsId) {
      const entries = tabs.get(contentsId);
      if (entries) remove(entries, [...entries.keys()]);
      tabs.delete(contentsId);
    },
    clear() {
      for (const entries of tabs.values()) remove(entries, [...entries.keys()]);
      tabs.clear();
    },
    size: (contentsId) => tabs.get(contentsId)?.size ?? 0,
  };
}
