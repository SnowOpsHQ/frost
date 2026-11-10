import type { BoundedFetcher, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS, SERVED_HTML_TYPES, SERVED_SOURCE_KEEP, type ServedUnavailableReason } from '@app/specs/seo-javascript.spec';
import { ServedSourceTextSchema, type ServedParseInput, type ServedParseResult, type ServedState } from '@app/specs/seo-javascript.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { cutUrl } from './fetcher';

// The served HTML of an audited page (spec `seo-javascript.spec.ts`, `SERVED_FETCH_LIMITS`;
// acceptance `seo-javascript.feature.md`, Fetching). Main fetches the page's URL as served through
// the shared bounded fetcher (`fetcher.ts`: browse session, cookies omitted, no referrer, bounded),
// with the tab's render-profile user agent if it has one, and hands the bytes to the analysis worker
// to parse (`parse`, `served-parse.ts`); main never decodes or parses them. The state is kept per
// tab document, URL and user agent, so an audit and its re-analyses fetch once; a new document
// (`forget`) or Clear Browsing Data (`clear`) drops it.
//
// The served source (Phase 11 Task 5, `SERVED_SOURCE_KEEP`): the text the worker decoded, answered
// with its parse, is checked (`ServedSourceTextSchema`) and kept beside the state, never in it (the
// state goes to the audit's worker and the agent; the source only to the Inspector), for the
// `SERVED_SOURCE_KEEP` most recently parsed documents over all tabs; it goes with its answer. Each
// answer has a serial (`ref`), unique for the life of the cache, and each tab document a generation
// that `forget` bumps: the Inspector copies only the entry it showed, for the document it showed.

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

/** The served source of one page as the Inspector reads it (`ServedHtml.source`). */
export type ServedSourceState =
  | { readonly status: 'ready'; readonly ref: number; readonly text: string; readonly truncated: boolean }
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable'; readonly reason: ServedUnavailableReason; readonly httpStatus: number | null };

export interface ServedHtml {
  /** The served state of `pageUrl` (its fragment dropped) for tab document `contentsId`, fetched with `userAgent` (`null`: frost's own). Cached; never rejects. */
  get(contentsId: number, pageUrl: string, userAgent: string | null, how?: ServedHow): Promise<ServedState>;
  /** What `get` would answer at once: the settled answer, else `undefined`. */
  peek(contentsId: number, pageUrl: string, userAgent: string | null, how?: ServedHow): ServedState | undefined;
  /**
   * The served source of `pageUrl` for tab document `contentsId` (as `peek`'s key): `pending` while
   * fetched or parsed, its unavailable reason, the text kept, or `not-fetched` when nothing was
   * fetched for that key or its source is no longer kept. Never fetches.
   */
  source(contentsId: number, pageUrl: string, userAgent: string | null, how?: ServedHow): ServedSourceState;
  /** The tab document's navigation generation: bumped by each `forget` (a new document), so a reader can tell its document went meanwhile. */
  generation(contentsId: number): number;
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
const NOT_FETCHED: ServedSourceState = { status: 'unavailable', reason: 'not-fetched', httpStatus: null };

/** A loaded answer: the state, and the source text the worker decoded (`null`: none to keep). */
interface Loaded {
  readonly state: ServedState;
  readonly source: { readonly text: string; readonly truncated: boolean } | null;
}

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
    readonly serial: number;
    readonly value: Promise<ServedState>;
    readonly controller: AbortController;
    settled?: ServedState;
  }
  const tabs = new Map<number, Map<string, Entry>>();
  let serials = 0;
  const generations = new Map<number, number>();

  /** The kept sources, oldest first (`SERVED_SOURCE_KEEP` at most), by the entry they belong to. */
  const sources = new Map<Entry, { readonly text: string; readonly truncated: boolean }>();
  const keepSource = (entry: Entry, source: Loaded['source']): void => {
    if (source === null) return;
    sources.delete(entry);
    sources.set(entry, source);
    while (sources.size > SERVED_SOURCE_KEEP) sources.delete(sources.keys().next().value!);
  };

  async function load(url: string, userAgent: string | null, scripting: boolean, signal: AbortSignal): Promise<Loaded> {
    const only = (state: ServedState): Loaded => ({ state, source: null });
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
    if (failed) return only(failed);
    const finalUrl = fetched.finalUrl ?? url;
    // Redirected elsewhere (a login page, another locale): not the page that was rendered. Without a
    // redirect it is the same page whatever `finalUrl` says: the fetcher cuts that to the stored length.
    if (fetched.redirects > 0 && pageKey(finalUrl) !== url) return only(unavailable('redirected', fetched.status, cutUrl(finalUrl)));
    const contentType = fetched.headers['content-type'] ?? null;
    const parsed = await options.parse({ url: finalUrl, contentType, body: fetched.body, scriptingEnabled: scripting }).catch((): ServedParseResult => ({ ok: false, reason: 'parse-failed' }));
    if (!parsed.ok) return only(unavailable(parsed.reason, fetched.status, cutUrl(finalUrl)));
    // The worker's decoded text, checked: anything but a capped string is not kept.
    const text = ServedSourceTextSchema.safeParse(parsed.sourceText);
    const source = text.success ? { text: text.data, truncated: parsed.sourceTruncated === true || fetched.truncated } : null;
    const state: ServedState = {
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
    return { state, source };
  }

  const keyOf = (url: string, userAgent: string | null, scripting: boolean): string => [url, userAgent ?? '', scripting ? 'js' : 'no-js'].join('\n');
  /** Drops `entries`' `keys`, aborting a fetch still in flight. */
  const remove = (entries: Map<string, Entry>, keys: readonly string[]): void => {
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry) {
        entry.controller.abort();
        sources.delete(entry);
      }
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
      const loaded = load(url, userAgent, scripting, controller.signal).catch((): Loaded => ({ state: unavailable('unreachable'), source: null }));
      const value = loaded.then((done) => done.state);
      const entry: Entry = { serial: ++serials, value, controller };
      entries.set(key, entry);
      while (entries.size > limits.maxCachedPerTab) remove(entries, [entries.keys().next().value!]);
      void loaded.then((done) => {
        entry.settled = done.state;
        // Kept only while its answer is (not dropped, forgotten or cleared meanwhile).
        if (tabs.get(contentsId)?.get(key) === entry) keepSource(entry, done.source);
      });
      return value;
    },
    peek(contentsId, pageUrl, userAgent, how = {}) {
      const url = pageKey(pageUrl);
      return url === null ? undefined : tabs.get(contentsId)?.get(keyOf(url, userAgent, how.scripting ?? true))?.settled;
    },
    source(contentsId, pageUrl, userAgent, how = {}) {
      const url = pageKey(pageUrl);
      const entry = url === null ? undefined : tabs.get(contentsId)?.get(keyOf(url, userAgent, how.scripting ?? true));
      if (!entry) return NOT_FETCHED;
      const state = entry.settled;
      if (state === undefined || state.status === 'pending') return { status: 'pending' };
      if (state.status === 'unavailable') return { status: 'unavailable', reason: state.reason, httpStatus: state.httpStatus };
      const source = sources.get(entry);
      return source ? { status: 'ready', ref: entry.serial, text: source.text, truncated: source.truncated } : NOT_FETCHED;
    },
    generation: (contentsId) => generations.get(contentsId) ?? 0,
    drop(contentsId, pageUrl) {
      const url = pageKey(pageUrl);
      const entries = tabs.get(contentsId);
      if (url === null || !entries) return;
      remove(entries, [...entries.keys()].filter((key) => key.split('\n')[0] === url));
    },
    forget(contentsId) {
      generations.set(contentsId, (generations.get(contentsId) ?? 0) + 1);
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
