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
  type NetworkHeadersAnswer,
  type NetworkLogAnswer,
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
// Memory is bounded in bytes as well (`tabBudgetBytes`, `globalBudgetBytes`, headers at most
// `maxHeaderShare` of a tab): what does not fit is left out and counted (`overBudget`). Rows go to the
// chrome without headers and only when changed since its cursor (`rows`); headers on demand (`headers`).
// A tab's log starts over when a document commits (`committed`, from `did-navigate`), not before.

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

/** `url` without its `#fragment`. */
function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

interface Entry {
  readonly key: number;
  readonly requestId: number;
  document: number;
  readonly method: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly type: NetworkResourceType;
  /** The document's main-frame request (kept by the closed drawer's ring). */
  pinned: boolean;
  /** It was the request a document committed with (never the next one's). */
  committed: boolean;
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
  headersDropped: boolean;
  /** The row's revision (bumped on every change). */
  rev: number;
  /** What it costs against the budgets: in all, and of that its headers. */
  bytes: number;
  headerBytes: number;
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
  /** Main-frame responses' key headers, by `url\nlocation` (`url\n` for a final answer), with their request. */
  readonly mainFrame: Map<string, { readonly requestId: number; readonly headers: NetworkHeader[] }>;
  /** Main-frame request id → the next entry key when its response started (later requests are its document's). */
  readonly mainResponded: Map<number, number>;
  bytes: number;
  headerBytes: number;
  overEntries: number;
  overBytes: number;
  /** A cursor below this gets a full answer (a reset, or removal records let go). */
  floorRev: number;
  removals: { readonly rev: number; readonly key: number }[];
}

/** One answer of `rows` (`devtools.network` without its tab id). */
export type NetworkRows = Omit<Extract<NetworkLogAnswer, { status: 'ready' }>, 'status' | 'tabId' | 'entries' | 'removed'> & {
  readonly entries: NetworkEntry[];
  readonly removed: number[];
};

export interface NetworkLog extends Required<Pick<RequestObserver, 'sent' | 'redirected' | 'responded' | 'completed' | 'failed'>> {
  /**
   * The tab committed a cross-document main-frame navigation to `url` (`did-navigate`): a new
   * document. The committing request (its newest main-frame entries for that URL, with their hops)
   * and what was sent after its response started move into it; the rest goes, unless preserved.
   */
  committed(contentsId: number, url: string): void;
  forget(contentsId: number): void;
  /** Full capture (some window has the drawer open) or the closed drawer's ring. */
  setFullCapture(on: boolean): void;
  fullCapture(): boolean;
  /** "Preserve log" for the tab (session-only). */
  setPreserve(contentsId: number, on: boolean): void;
  /** The rows changed since `since` (`NetworkLogAnswer`), `null` for a tab never recorded. */
  rows(contentsId: number, since?: number): NetworkRows | null;
  /** One row's headers (`NetworkHeadersAnswer`). */
  headers(contentsId: number, key: number): NetworkHeadersAnswer;
  /** The current document's requests still waiting for a robots.txt verdict (crawlable, the page's origin). */
  robotsPending(contentsId: number): { readonly key: number; readonly url: string }[];
  /** Records robots.txt verdicts by entry key. */
  setRobots(contentsId: number, verdicts: ReadonlyMap<number, 'allowed' | 'blocked' | 'unknown'>): void;
  /** The key headers of a main-frame response: a redirect hop (`location`) or the final answer (`null`). */
  mainFrameHeaders(contentsId: number, url: string, location: string | null): NetworkHeader[] | null;
  /** Bytes held against the budgets: the tab's, or (no id) every tab's. */
  bytes(contentsId?: number): number;
  /** Forgets every tab (Clear Browsing Data). */
  clear(): void;
}

export interface NetworkLogOptions {
  /** A tab's log changed (a request event, a commit, a verdict). */
  readonly changed?: (contentsId: number) => void;
}

const L = NETWORK_LIMITS;
const stringBytes = (value: string | null): number => (value === null ? 0 : value.length * 2);
const headerBytesOf = (headers: readonly NetworkHeader[]): number => headers.reduce((sum, h) => sum + L.headerOverheadBytes + stringBytes(h.name) + stringBytes(h.value), 0);
const baseBytesOf = (e: Pick<Entry, 'url' | 'method' | 'error' | 'redirectTo'>): number => L.entryOverheadBytes + stringBytes(e.url) + stringBytes(e.method) + stringBytes(e.error) + stringBytes(e.redirectTo);

export function createNetworkLog(options: NetworkLogOptions = {}): NetworkLog {
  const tabs = new Map<number, TabLog>();
  let nextKey = 1;
  let rev = 0;
  let total = 0;
  let full = false;
  const changed = (id: number): void => options.changed?.(id);

  const newTab = (): TabLog => ({
    entries: [],
    byRequest: new Map(),
    retired: new Set(),
    // 0 until the tab's first commit.
    document: 0,
    docCount: 0,
    dropped: 0,
    notKept: 0,
    preserve: false,
    pageUrls: new Map(),
    mainFrame: new Map(),
    mainResponded: new Map(),
    bytes: 0,
    headerBytes: 0,
    overEntries: 0,
    overBytes: 0,
    floorRev: 0,
    removals: [],
  });

  const drop = (id: number): void => {
    const tab = tabs.get(id);
    if (!tab) return;
    total -= tab.bytes;
    tabs.delete(id);
  };

  /** The tab's log, now the most recently recorded (the least recent goes past `maxTrackedTabs`). */
  const tabOf = (id: number): TabLog => {
    let tab = tabs.get(id);
    if (tab) tabs.delete(id);
    else tab = newTab();
    tabs.set(id, tab);
    while (tabs.size > L.maxTrackedTabs) drop(tabs.keys().next().value!);
    return tab;
  };

  /** Whether `delta` more bytes fit the tab's and the global budget (and, for headers, their share). */
  const fits = (tab: TabLog, delta: number, header: boolean): boolean =>
    delta <= 0 || (tab.bytes + delta <= L.tabBudgetBytes && total + delta <= L.globalBudgetBytes && (!header || tab.headerBytes + delta <= L.tabBudgetBytes * L.maxHeaderShare));

  const charge = (tab: TabLog, entry: Entry, delta: number, header: boolean): void => {
    entry.bytes += delta;
    tab.bytes += delta;
    total += delta;
    if (header) {
      entry.headerBytes += delta;
      tab.headerBytes += delta;
    }
  };

  const touch = (entry: Entry): void => {
    entry.rev = ++rev;
  };

  const retire = (tab: TabLog, requestId: number): void => {
    tab.byRequest.delete(requestId);
    tab.retired.add(requestId);
    while (tab.retired.size > MAX_RETIRED) tab.retired.delete(tab.retired.values().next().value!);
  };

  /** Removes the entry at `at` (its request's later events are ignored); `record`: named in incremental answers. */
  const remove = (tab: TabLog, at: number, record: boolean): void => {
    const [gone] = tab.entries.splice(at, 1);
    if (!gone) return;
    if (tab.byRequest.get(gone.requestId) === gone) retire(tab, gone.requestId);
    tab.bytes -= gone.bytes;
    tab.headerBytes -= gone.headerBytes;
    total -= gone.bytes;
    if (!record) return;
    tab.removals.push({ rev: ++rev, key: gone.key });
    while (tab.removals.length > L.maxRemovalRecords) tab.floorRev = tab.removals.shift()!.rev;
  };

  /** The closed drawer's ring: the newest `closedRingSize` of the current document, plus its main-frame request. */
  const trimRing = (tab: TabLog): void => {
    for (;;) {
      const unpinned = tab.entries.filter((e) => e.document === tab.document && !e.pinned);
      if (unpinned.length <= L.closedRingSize) return;
      remove(tab, tab.entries.indexOf(unpinned[0]!), true);
      tab.docCount -= 1;
      tab.notKept += 1;
    }
  };

  /** "Preserve log": at most `maxPreserved` in all, earlier documents' oldest first. */
  const trimPreserved = (tab: TabLog): void => {
    while (tab.entries.length > L.maxPreserved && tab.entries[0]!.document !== tab.document) remove(tab, 0, true);
    for (const doc of tab.pageUrls.keys()) if (doc !== tab.document && !tab.entries.some((e) => e.document === doc)) tab.pageUrls.delete(doc);
  };

  type Details = { id: number; url: string; method: string; webContentsId?: number; resourceType?: string; timestamp: number };

  /** A new entry for the request (`null` past the document's cap or the budgets, or for a retired request). */
  const create = (tab: TabLog, details: Details): Entry | null => {
    if (tab.retired.has(details.id)) return null;
    if (full && tab.docCount >= L.maxPerDocument) {
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
      url: cut(url, L.maxUrlChars),
      urlTruncated: url.length > L.maxUrlChars,
      type,
      pinned,
      committed: false,
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
      headersDropped: false,
      rev: 0,
      bytes: 0,
      headerBytes: 0,
    };
    const cost = baseBytesOf(entry);
    if (!fits(tab, cost, false)) {
      tab.overEntries += 1;
      tab.overBytes += cost;
      retire(tab, details.id);
      return null;
    }
    charge(tab, entry, cost, false);
    touch(entry);
    tab.entries.push(entry);
    tab.byRequest.set(details.id, entry);
    tab.docCount += 1;
    if (!full) trimRing(tab);
    if (tab.preserve) trimPreserved(tab);
    return entry;
  };

  /** The request's tab and entry (created if it was never seen); `null` for a request of no tab, or one past the caps. */
  const entryFor = (details: Details): { tab: TabLog; entry: Entry } | null => {
    if (typeof details.webContentsId !== 'number') return null;
    const tab = tabOf(details.webContentsId);
    const known = tab.byRequest.get(details.id);
    if (known) return { tab, entry: known };
    const entry = create(tab, details);
    return entry ? { tab, entry } : null;
  };

  const finish = (entry: Entry, timestamp: number): void => {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) entry.endedAt = Math.max(entry.startedAt, timestamp);
  };

  const status = (code: unknown): number | null => (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 999 ? code : null);

  /** Sets one side's headers, if they fit the budgets; otherwise leaves them off and counts them. */
  const setHeaders = (tab: TabLog, entry: Entry, side: 'request' | 'response', captured: { headers: NetworkHeader[]; omitted: number }): void => {
    const old = side === 'request' ? entry.requestHeaders : entry.responseHeaders;
    const delta = headerBytesOf(captured.headers) - headerBytesOf(old);
    let headers = captured.headers;
    if (!fits(tab, delta, true)) {
      tab.overBytes += headerBytesOf(captured.headers);
      entry.headersDropped = true;
      headers = [];
    }
    charge(tab, entry, headerBytesOf(headers) - headerBytesOf(old), true);
    if (side === 'request') {
      entry.requestHeaders = headers;
      entry.omittedRequestHeaders = captured.omitted;
    } else {
      entry.responseHeaders = headers;
      entry.omittedResponseHeaders = captured.omitted;
    }
  };

  /** Sets a text field, if it fits the budgets; otherwise leaves it out (`null`) and counts it. */
  const setText = (tab: TabLog, entry: Entry, field: 'error' | 'redirectTo', value: string | null): void => {
    const delta = stringBytes(value) - stringBytes(entry[field]);
    if (!fits(tab, delta, false)) {
      tab.overBytes += stringBytes(value);
      value = null;
    }
    charge(tab, entry, stringBytes(value) - stringBytes(entry[field]), false);
    entry[field] = value;
  };

  const respond = (tab: TabLog, entry: Entry, raw: RawHeaders): void => {
    if (!raw) return;
    setHeaders(tab, entry, 'response', captureHeaders(raw, RESPONSE_KEEP));
    entry.size = contentLength(raw);
  };

  /** Keeps a main-frame response's key headers for the redirect trace (`REDIRECT_KEY_HEADERS`). */
  const keepMainFrame = (tab: TabLog, requestId: number, url: string, location: string | null, raw: RawHeaders): void => {
    const key = `${cut(url, L.maxUrlChars)}\n${location === null ? '' : cut(location, L.maxUrlChars)}`;
    tab.mainFrame.delete(key);
    tab.mainFrame.set(key, { requestId, headers: captureHeaders(raw, REDIRECT_KEEP).headers });
    while (tab.mainFrame.size > MAX_MAIN_FRAME_RESPONSES) tab.mainFrame.delete(tab.mainFrame.keys().next().value!);
  };

  const row = (tab: TabLog, e: Entry): NetworkEntry => {
    const page = tab.pageUrls.get(e.document) ?? tab.pageUrls.get(tab.document) ?? '';
    const checked = CRAWLABLE.has(e.type) && sameOrigin(e.url, page);
    return {
      key: e.key,
      rev: e.rev,
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
      requestHeaderCount: e.requestHeaders.length,
      responseHeaderCount: e.responseHeaders.length,
      headersDropped: e.headersDropped,
    };
  };

  const log: NetworkLog = {
    sent(details: OnSendHeadersListenerDetails) {
      const found = entryFor(details);
      if (!found) return;
      setHeaders(found.tab, found.entry, 'request', captureHeaders(details.requestHeaders, REQUEST_KEEP));
      touch(found.entry);
      changed(details.webContentsId!);
    },

    redirected(details: OnBeforeRedirectListenerDetails) {
      const found = entryFor(details);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'redirected';
      entry.status = status(details.statusCode);
      setText(tab, entry, 'redirectTo', typeof details.redirectURL === 'string' ? cut(details.redirectURL, L.maxUrlChars) : null);
      entry.fromCache = details.fromCache === true;
      respond(tab, entry, details.responseHeaders);
      finish(entry, details.timestamp);
      if (details.resourceType === 'mainFrame' && typeof details.redirectURL === 'string') keepMainFrame(tab, details.id, details.url, details.redirectURL, details.responseHeaders);
      touch(entry);
      // The next hop is its own entry.
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    responded(details: OnResponseStartedListenerDetails) {
      const found = entryFor(details);
      if (!found) return;
      const { tab, entry } = found;
      entry.status = status(details.statusCode);
      entry.fromCache = details.fromCache === true;
      respond(tab, entry, details.responseHeaders);
      if (details.resourceType === 'mainFrame') {
        keepMainFrame(tab, details.id, details.url, null, details.responseHeaders);
        // What is sent from now on belongs to this request's document, if it commits.
        tab.mainResponded.set(details.id, nextKey);
        while (tab.mainResponded.size > 8) tab.mainResponded.delete(tab.mainResponded.keys().next().value!);
      }
      touch(entry);
      changed(details.webContentsId!);
    },

    completed(details: OnCompletedListenerDetails) {
      const found = entryFor(details);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'done';
      entry.status ??= status(details.statusCode);
      entry.fromCache = entry.fromCache || details.fromCache === true;
      if (entry.responseHeaders.length === 0 && entry.omittedResponseHeaders === 0 && !entry.headersDropped) respond(tab, entry, details.responseHeaders);
      finish(entry, details.timestamp);
      touch(entry);
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    failed(details: OnErrorOccurredListenerDetails) {
      const found = entryFor(details);
      if (!found) return;
      const { tab, entry } = found;
      entry.state = 'failed';
      setText(tab, entry, 'error', typeof details.error === 'string' ? cut(details.error, L.maxErrorChars) : 'failed');
      entry.fromCache = entry.fromCache || details.fromCache === true;
      finish(entry, details.timestamp);
      touch(entry);
      tab.byRequest.delete(details.id);
      changed(details.webContentsId!);
    },

    committed(contentsId, url) {
      const tab = tabOf(contentsId);
      const target = withoutFragment(cut(typeof url === 'string' ? url : '', L.maxUrlChars));
      // The committing request: the newest main-frame entry for that URL no document committed with yet.
      let requestId: number | null = null;
      for (let i = tab.entries.length - 1; i >= 0; i--) {
        const e = tab.entries[i]!;
        if (e.type === 'document' && !e.committed && withoutFragment(e.url) === target) {
          requestId = e.requestId;
          break;
        }
      }
      const mark = requestId === null ? Number.POSITIVE_INFINITY : (tab.mainResponded.get(requestId) ?? Number.POSITIVE_INFINITY);
      const moves = (e: Entry): boolean => (e.type === 'document' ? e.requestId === requestId && !e.committed : e.key >= mark);
      const document = tab.document + 1;
      if (!tab.preserve) {
        // A reset: every cursor from before it gets a full answer.
        tab.floorRev = ++rev;
        tab.removals = [];
        for (let i = tab.entries.length - 1; i >= 0; i--) if (!moves(tab.entries[i]!)) remove(tab, i, false);
        tab.pageUrls.clear();
      }
      tab.docCount = 0;
      for (const e of tab.entries) {
        if (!moves(e)) continue;
        e.document = document;
        if (e.type === 'document') {
          e.committed = true;
          e.pinned = true;
        }
        tab.docCount += 1;
        touch(e);
      }
      for (const [key, response] of tab.mainFrame) if (response.requestId !== requestId) tab.mainFrame.delete(key);
      tab.mainResponded.clear();
      tab.document = document;
      tab.dropped = 0;
      tab.notKept = 0;
      tab.pageUrls.set(document, cut(typeof url === 'string' ? url : '', L.maxUrlChars));
      if (tab.preserve) trimPreserved(tab);
      changed(contentsId);
    },

    forget(contentsId) {
      drop(contentsId);
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

    rows(contentsId, since = 0) {
      const tab = tabs.get(contentsId);
      if (!tab) return null;
      // A cursor of 0, from before a reset or the removal records, or from elsewhere: everything, at once.
      const whole = since <= 0 || since < tab.floorRev || since > rev;
      const changedRows = whole ? tab.entries : tab.entries.filter((e) => e.rev > since).sort((a, b) => a.rev - b.rev);
      const page = whole ? changedRows : changedRows.slice(0, L.maxRowsPerAnswer);
      const more = page.length < changedRows.length;
      const cursor = more ? page.at(-1)!.rev : rev;
      return {
        pageUrl: tab.pageUrls.get(tab.document) ?? '',
        rev: cursor,
        full: whole,
        more,
        entries: page.map((e) => row(tab, e)),
        removed: whole ? [] : tab.removals.filter((r) => r.rev > since && r.rev <= cursor).map((r) => r.key),
        dropped: tab.dropped,
        notKept: tab.notKept,
        overBudget: { entries: tab.overEntries, bytes: tab.overBytes },
        preserve: tab.preserve,
      };
    },

    headers(contentsId, key) {
      const entry = tabs.get(contentsId)?.entries.find((e) => e.key === key);
      if (!entry) return { status: 'gone' };
      return {
        status: 'ready',
        key,
        requestHeaders: entry.requestHeaders.map((h) => ({ ...h })),
        omittedRequestHeaders: entry.omittedRequestHeaders,
        responseHeaders: entry.responseHeaders.map((h) => ({ ...h })),
        omittedResponseHeaders: entry.omittedResponseHeaders,
        headersDropped: entry.headersDropped,
      };
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
          touch(entry);
          any = true;
        }
      }
      if (any) changed(contentsId);
    },

    mainFrameHeaders(contentsId, url, location) {
      const tab = tabs.get(contentsId);
      const response = tab?.mainFrame.get(`${cut(url, L.maxUrlChars)}\n${location === null ? '' : cut(location, L.maxUrlChars)}`);
      return response ? response.headers.map((h) => ({ ...h })) : null;
    },

    bytes(contentsId) {
      return contentsId === undefined ? total : (tabs.get(contentsId)?.bytes ?? 0);
    },

    clear() {
      tabs.clear();
      total = 0;
    },
  };
  return log;
}
