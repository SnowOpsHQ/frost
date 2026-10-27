import type { OnBeforeRedirectListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { hostOf, isThirdParty } from '@app/seo-core';
import {
  CRAWLABLE_TYPES,
  MASKED_VALUE,
  NETWORK_LIMITS,
  NETWORK_TYPE_OF,
  REDIRECT_KEY_HEADERS,
  REQUEST_HEADER_ALLOWLIST,
  RESPONSE_HEADER_KEEP,
  SECRET_HEADERS,
  type NetworkEntry,
  type NetworkHeader,
  type NetworkResourceType,
  type RobotsVerdict,
} from '@app/specs/devtools.spec';
import type { RequestObserver } from '../browser/web-request';

// The devtools drawer's network recorder (spec `devtools.spec.ts`, `NETWORK_LIMITS`; acceptance
// `devtools.feature.md`, Network log). A subscriber of the browse session's one `webRequest` owner
// (`observeRequests`): observers only, so no request ever waits for it. Each event is attributed to
// a tab by `webContentsId` and cut as it arrives:
// - headers are allowlisted (`REQUEST_HEADER_ALLOWLIST`, `RESPONSE_HEADER_KEEP`), the others only
//   counted; a `SECRET_HEADERS` value is never stored, only `MASKED_VALUE` (`devtools-masks-secrets`);
// - no body is ever read (`uploadData` and anything else of the events is ignored);
// - URLs, header values and failure texts are cut to their caps.
// Recording is always on but small while no window has the drawer open (the recording decision in
// `NETWORK_LIMITS`): full capture keeps a document's first `maxPerDocument` requests; otherwise a
// ring of the newest `closedRingSize` plus the document's main-frame request.

const REQUEST_KEEP: ReadonlySet<string> = new Set(REQUEST_HEADER_ALLOWLIST);
const RESPONSE_KEEP: ReadonlySet<string> = new Set(RESPONSE_HEADER_KEEP);
const REDIRECT_KEEP: ReadonlySet<string> = new Set(REDIRECT_KEY_HEADERS);
const SECRETS: ReadonlySet<string> = new Set(SECRET_HEADERS);
const CRAWLABLE: ReadonlySet<NetworkResourceType> = new Set(CRAWLABLE_TYPES);
/** Request ids whose events are ignored from now on (dropped, let go, or of an earlier document). */
const MAX_RETIRED = 4_096;
const MAX_METHOD_CHARS = 16;
/** Main-frame responses (redirect hops and final answers) whose key headers a tab keeps. */
const MAX_MAIN_FRAME_RESPONSES = 16;

/** `value` cut to `max` UTF-16 code units, never splitting a surrogate pair. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = value.charCodeAt(max - 1) >= 0xd800 && value.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

type RawHeaders = Record<string, string | string[]> | undefined;

/**
 * The headers of `raw` the drawer keeps (`keep`, lowercased names, in arrival order): each value cut
 * to `maxHeaderValueChars`, at most `maxHeadersPerMessage` in all. A `SECRET_HEADERS` name is kept
 * once, as `MASKED_VALUE`, whatever its values; every other name is only counted (`omitted`).
 */
export function captureHeaders(raw: RawHeaders, keep: ReadonlySet<string>): { headers: NetworkHeader[]; omitted: number } {
  const headers: NetworkHeader[] = [];
  let omitted = 0;
  if (!raw || typeof raw !== 'object') return { headers, omitted };
  for (const [rawName, rawValues] of Object.entries(raw)) {
    const name = rawName.toLowerCase();
    if (SECRETS.has(name)) {
      if (headers.length < NETWORK_LIMITS.maxHeadersPerMessage) headers.push({ name, value: MASKED_VALUE, masked: true, truncated: false });
      else omitted += 1;
      continue;
    }
    if (!keep.has(name)) {
      omitted += 1;
      continue;
    }
    for (const value of Array.isArray(rawValues) ? rawValues : [rawValues]) {
      if (typeof value !== 'string') continue;
      if (headers.length >= NETWORK_LIMITS.maxHeadersPerMessage) {
        omitted += 1;
        continue;
      }
      const cutValue = cut(value, NETWORK_LIMITS.maxHeaderValueChars);
      headers.push({ name, value: cutValue, masked: false, truncated: cutValue.length < value.length });
    }
  }
  return { headers, omitted };
}

/** The response's `Content-Length` (the first value, a non-negative integer), or `null`. */
export function contentLength(raw: RawHeaders): number | null {
  if (!raw) return null;
  for (const [name, values] of Object.entries(raw)) {
    if (name.toLowerCase() !== 'content-length') continue;
    const first = Array.isArray(values) ? values[0] : values;
    if (typeof first !== 'string' || !/^\d{1,15}$/.test(first.trim())) return null;
    return Number(first.trim());
  }
  return null;
}

/** The drawer's type for Electron's `resourceType` (`NETWORK_TYPE_OF`). */
export function networkTypeOf(resourceType: unknown): NetworkResourceType {
  return typeof resourceType === 'string' && Object.hasOwn(NETWORK_TYPE_OF, resourceType) ? NETWORK_TYPE_OF[resourceType]! : 'other';
}

/** Whether `a` and `b` are `http(s)` URLs of one origin. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (x.protocol === 'http:' || x.protocol === 'https:') && x.origin === y.origin;
  } catch {
    return false;
  }
}

interface Entry {
  readonly key: number;
  readonly requestId: number;
  readonly document: number;
  readonly method: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly type: NetworkResourceType;
  /** The document's main-frame request (kept by the closed drawer's ring). */
  readonly pinned: boolean;
  state: NetworkEntry['state'];
  status: number | null;
  error: string | null;
  redirectTo: string | null;
  size: number | null;
  readonly startedAt: number;
  endedAt: number | null;
  fromCache: boolean;
  robots: Exclude<RobotsVerdict, 'pending' | 'not-checked'> | null;
  requestHeaders: NetworkHeader[];
  omittedRequestHeaders: number;
  responseHeaders: NetworkHeader[];
  omittedResponseHeaders: number;
}

interface TabLog {
  entries: Entry[];
  /** In-flight request id → its entry (a redirect's next hop is a new entry). */
  readonly byRequest: Map<number, Entry>;
  readonly retired: Set<number>;
  document: number;
  /** Entries of the current document kept. */
  docCount: number;
  dropped: number;
  notKept: number;
  preserve: boolean;
  /** Each document's page URL (the third-party flag's reference). */
  readonly pageUrls: Map<number, string>;
  /** The current document's main-frame responses' key headers, by `url\nlocation` (`url\n` for a final answer). */
  readonly mainFrame: Map<string, NetworkHeader[]>;
}

/** What `snapshot` answers for one tab. */
export interface NetworkSnapshot {
  readonly pageUrl: string;
  readonly entries: NetworkEntry[];
  readonly dropped: number;
  readonly notKept: number;
  readonly preserve: boolean;
}

export interface NetworkLog extends Required<Pick<RequestObserver, 'sent' | 'redirected' | 'responded' | 'completed' | 'failed'>> {
  /** A cross-document main-frame navigation to `url` started in the tab: a new document (and log, unless preserved). */
  navigated(contentsId: number, url: string): void;
  forget(contentsId: number): void;
  /** Full capture (some window has the drawer open) or the closed drawer's ring. */
  setFullCapture(on: boolean): void;
  fullCapture(): boolean;
  /** "Preserve log" for the tab (session-only); `false` for a tab never recorded. */
  setPreserve(contentsId: number, on: boolean): void;
  /** The tab's log as the drawer shows it, `null` for a tab never recorded. */
  snapshot(contentsId: number): NetworkSnapshot | null;
  /** The current document's requests still waiting for a robots.txt verdict (crawlable, the page's origin). */
  robotsPending(contentsId: number): { readonly key: number; readonly url: string }[];
  /** Records robots.txt verdicts by entry key. */
  setRobots(contentsId: number, verdicts: ReadonlyMap<number, 'allowed' | 'blocked' | 'unknown'>): void;
  /** The key headers of a main-frame response of the current document: a redirect hop (`location`) or the final answer (`null`). */
  mainFrameHeaders(contentsId: number, url: string, location: string | null): NetworkHeader[] | null;
  /** Forgets every tab (Clear Browsing Data). */
  clear(): void;
}

export interface NetworkLogOptions {
  /** A tab's log changed (a request event, a navigation, a verdict). */
  readonly changed?: (contentsId: number) => void;
}

export function createNetworkLog(options: NetworkLogOptions = {}): NetworkLog {
  const tabs = new Map<number, TabLog>();
  let nextKey = 1;
  let full = false;
  const changed = (id: number): void => options.changed?.(id);

  const newTab = (): TabLog => ({ entries: [], byRequest: new Map(), retired: new Set(), document: 0, docCount: 0, dropped: 0, notKept: 0, preserve: false, pageUrls: new Map(), mainFrame: new Map() });

  /** The tab's log, now the most recently recorded (the least recent goes past `maxTrackedTabs`). */
  const tabOf = (id: number): TabLog => {
    let tab = tabs.get(id);
    if (tab) tabs.delete(id);
    else tab = newTab();
    tabs.set(id, tab);
    while (tabs.size > NETWORK_LIMITS.maxTrackedTabs) tabs.delete(tabs.keys().next().value!);
    return tab;
  };

  const retire = (tab: TabLog, requestId: number): void => {
    tab.byRequest.delete(requestId);
    tab.retired.add(requestId);
    while (tab.retired.size > MAX_RETIRED) tab.retired.delete(tab.retired.values().next().value!);
  };

  /** Removes `entry` from the log (its request's later events are ignored). */
  const remove = (tab: TabLog, at: number): void => {
    const [gone] = tab.entries.splice(at, 1);
    if (gone && tab.byRequest.get(gone.requestId) === gone) retire(tab, gone.requestId);
  };

  /** The closed drawer's ring: the newest `closedRingSize` of the current document, plus its main-frame request. */
  const trimRing = (tab: TabLog): void => {
    for (;;) {
      const current = tab.entries.filter((e) => e.document === tab.document);
      const unpinned = current.filter((e) => !e.pinned);
      if (unpinned.length <= NETWORK_LIMITS.closedRingSize) return;
      remove(tab, tab.entries.indexOf(unpinned[0]!));
      tab.docCount -= 1;
      tab.notKept += 1;
    }
  };

  /** "Preserve log": at most `maxPreserved` in all, earlier documents' oldest first. */
  const trimPreserved = (tab: TabLog): void => {
    while (tab.entries.length > NETWORK_LIMITS.maxPreserved && tab.entries[0]!.document !== tab.document) remove(tab, 0);
    for (const doc of tab.pageUrls.keys()) if (doc !== tab.document && !tab.entries.some((e) => e.document === doc)) tab.pageUrls.delete(doc);
  };

  type Details = { id: number; url: string; method: string; webContentsId?: number; resourceType?: string; timestamp: number };

  /** A new entry for the request (`null` past the document's cap, or for a retired request). */
  const create = (tab: TabLog, details: Details): Entry | null => {
    if (tab.retired.has(details.id)) return null;
    if (full && tab.docCount >= NETWORK_LIMITS.maxPerDocument) {
      tab.dropped += 1;
      retire(tab, details.id);
      return null;
    }
    const url = typeof details.url === 'string' ? details.url : '';
    const type = networkTypeOf(details.resourceType);
    const pinned = type === 'document' && !tab.entries.some((e) => e.document === tab.document && e.pinned);
    const entry: Entry = {
      key: nextKey++,
      requestId: details.id,
      document: tab.document,
      method: cut(typeof details.method === 'string' ? details.method.toUpperCase() : 'GET', MAX_METHOD_CHARS),
      url: cut(url, NETWORK_LIMITS.maxUrlChars),
      urlTruncated: url.length > NETWORK_LIMITS.maxUrlChars,
      type,
      pinned,
      state: 'pending',
      status: null,
      error: null,
      redirectTo: null,
      size: null,
      startedAt: typeof details.timestamp === 'number' && Number.isFinite(details.timestamp) ? details.timestamp : Date.now(),
      endedAt: null,
      fromCache: false,
      robots: null,
      requestHeaders: [],
      omittedRequestHeaders: 0,
      responseHeaders: [],
      omittedResponseHeaders: 0,
    };
    if (pinned && !tab.pageUrls.has(tab.document)) tab.pageUrls.set(tab.document, entry.url);
    tab.entries.push(entry);
    tab.byRequest.set(details.id, entry);
    tab.docCount += 1;
    if (!full) trimRing(tab);
    if (tab.preserve) trimPreserved(tab);
    return entry;
  };

  /** The request's tab and entry (created if it was never seen); `null` for a request of no tab, or one past the caps. */
  const entryFor = (details: Details, createIfMissing: boolean): { tab: TabLog; entry: Entry } | null => {
    if (typeof details.webContentsId !== 'number') return null;
    const tab = tabOf(details.webContentsId);
    const known = tab.byRequest.get(details.id);
    if (known) return { tab, entry: known };
    if (!createIfMissing) return null;
    const entry = create(tab, details);
    return entry ? { tab, entry } : null;
  };

  const finish = (entry: Entry, timestamp: number): void => {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) entry.endedAt = Math.max(entry.startedAt, timestamp);
  };

  const status = (code: unknown): number | null => (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 999 ? code : null);

  const respond = (entry: Entry, raw: RawHeaders): void => {
    if (!raw) return;
    const response = captureHeaders(raw, RESPONSE_KEEP);
    entry.responseHeaders = response.headers;
    entry.omittedResponseHeaders = response.omitted;
    entry.size = contentLength(raw);
  };

  /** Keeps a main-frame response's key headers for the redirect trace (`REDIRECT_KEY_HEADERS`). */
  const keepMainFrame = (tab: TabLog, url: string, location: string | null, raw: RawHeaders): void => {
    const key = `${cut(url, NETWORK_LIMITS.maxUrlChars)}\n${location === null ? '' : cut(location, NETWORK_LIMITS.maxUrlChars)}`;
    tab.mainFrame.delete(key);
    tab.mainFrame.set(key, captureHeaders(raw, REDIRECT_KEEP).headers);
    while (tab.mainFrame.size > MAX_MAIN_FRAME_RESPONSES) tab.mainFrame.delete(tab.mainFrame.keys().next().value!);
  };

  const log: NetworkLog = {
    sent(details: OnSendHeadersListenerDetails) {
      if (typeof details.webContentsId !== 'number') return;
      const tab = tabOf(details.webContentsId);
      let entry = tab.byRequest.get(details.id);
      if (!entry) entry = create(tab, details) ?? undefined;
      if (!entry) return;
      const request = captureHeaders(details.requestHeaders, REQUEST_KEEP);
      entry.requestHeaders = request.headers;
      entry.omittedRequestHeaders = request.omitted;
      changed(details.webContentsId);
    },

    redirected(details: OnBeforeRedirectListenerDetails) {
      const found = entryFor(details, true);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'redirected';
      entry.status = status(details.statusCode);
      entry.redirectTo = typeof details.redirectURL === 'string' ? cut(details.redirectURL, NETWORK_LIMITS.maxUrlChars) : null;
      entry.fromCache = details.fromCache === true;
      respond(entry, details.responseHeaders);
      finish(entry, details.timestamp);
      if (details.resourceType === 'mainFrame' && typeof details.redirectURL === 'string') keepMainFrame(tab, details.url, details.redirectURL, details.responseHeaders);
      // The next hop is its own entry.
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    responded(details: OnResponseStartedListenerDetails) {
      const found = entryFor(details, true);
      if (!found) return;
      const { tab, entry } = found;
      entry.status = status(details.statusCode);
      entry.fromCache = details.fromCache === true;
      respond(entry, details.responseHeaders);
      if (details.resourceType === 'mainFrame') {
        keepMainFrame(tab, details.url, null, details.responseHeaders);
        tab.pageUrls.set(entry.document, entry.url);
      }
      changed(details.webContentsId!);
    },

    completed(details: OnCompletedListenerDetails) {
      const found = entryFor(details, true);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'done';
      entry.status ??= status(details.statusCode);
      entry.fromCache = entry.fromCache || details.fromCache === true;
      if (entry.responseHeaders.length === 0 && entry.omittedResponseHeaders === 0) respond(entry, details.responseHeaders);
      finish(entry, details.timestamp);
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    failed(details: OnErrorOccurredListenerDetails) {
      const found = entryFor(details, true);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'failed';
      entry.error = typeof details.error === 'string' ? cut(details.error, NETWORK_LIMITS.maxErrorChars) : 'failed';
      entry.fromCache = entry.fromCache || details.fromCache === true;
      finish(entry, details.timestamp);
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    navigated(contentsId, url) {
      const tab = tabOf(contentsId);
      if (!tab.preserve) {
        for (const requestId of [...tab.byRequest.keys()]) retire(tab, requestId);
        tab.entries = [];
        tab.pageUrls.clear();
      }
      tab.document += 1;
      tab.docCount = 0;
      tab.dropped = 0;
      tab.notKept = 0;
      tab.mainFrame.clear();
      tab.pageUrls.set(tab.document, cut(typeof url === 'string' ? url : '', NETWORK_LIMITS.maxUrlChars));
      if (tab.preserve) trimPreserved(tab);
      changed(contentsId);
    },

    forget(contentsId) {
      tabs.delete(contentsId);
    },

    setFullCapture(on) {
      full = on;
    },

    fullCapture: () => full,

    setPreserve(contentsId, on) {
      const tab = tabOf(contentsId);
      if (tab.preserve === on) return;
      tab.preserve = on;
      if (on) trimPreserved(tab);
      changed(contentsId);
    },

    snapshot(contentsId) {
      const tab = tabs.get(contentsId);
      if (!tab) return null;
      const pageUrl = tab.pageUrls.get(tab.document) ?? '';
      const entries = tab.entries.map((e): NetworkEntry => {
        const page = tab.pageUrls.get(e.document) ?? pageUrl;
        const checked = CRAWLABLE.has(e.type) && sameOrigin(e.url, page);
        return {
          key: e.key,
          document: e.document,
          method: e.method,
          url: e.url,
          urlTruncated: e.urlTruncated,
          type: e.type,
          state: e.state,
          status: e.status,
          error: e.error,
          redirectTo: e.redirectTo,
          size: e.size,
          startedAt: e.startedAt,
          durationMs: e.endedAt === null ? null : e.endedAt - e.startedAt,
          fromCache: e.fromCache,
          thirdParty: isThirdParty(hostOf(e.url), hostOf(page)),
          robots: checked ? (e.robots ?? 'pending') : 'not-checked',
          requestHeaders: e.requestHeaders.map((h) => ({ ...h })),
          omittedRequestHeaders: e.omittedRequestHeaders,
          responseHeaders: e.responseHeaders.map((h) => ({ ...h })),
          omittedResponseHeaders: e.omittedResponseHeaders,
        };
      });
      return { pageUrl, entries, dropped: tab.dropped, notKept: tab.notKept, preserve: tab.preserve };
    },

    robotsPending(contentsId) {
      const tab = tabs.get(contentsId);
      if (!tab) return [];
      const page = tab.pageUrls.get(tab.document) ?? '';
      return tab.entries.filter((e) => e.document === tab.document && e.robots === null && CRAWLABLE.has(e.type) && sameOrigin(e.url, page)).map((e) => ({ key: e.key, url: e.url }));
    },

    setRobots(contentsId, verdicts) {
      const tab = tabs.get(contentsId);
      if (!tab) return;
      let any = false;
      for (const entry of tab.entries) {
        const verdict = verdicts.get(entry.key);
        if (verdict !== undefined && entry.robots === null) {
          entry.robots = verdict;
          any = true;
        }
      }
      if (any) changed(contentsId);
    },

    mainFrameHeaders(contentsId, url, location) {
      const tab = tabs.get(contentsId);
      const headers = tab?.mainFrame.get(`${cut(url, NETWORK_LIMITS.maxUrlChars)}\n${location === null ? '' : cut(location, NETWORK_LIMITS.maxUrlChars)}`);
      return headers ? headers.map((h) => ({ ...h })) : null;
    },

    clear() {
      tabs.clear();
    },
  };
  return log;
}
