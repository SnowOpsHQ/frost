import type { OnBeforeRedirectListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails } from 'electron';
import { headerValueCap, RESPONSE_HEADER_ALLOWLIST, RESPONSE_LIMITS, type ResponseHeaderName } from '@app/specs/seo-indexability.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RedirectHop, ResponseHeader, ResponseMeta } from '@app/specs/seo-snapshot.spec';
import type { MainFrameObserver } from '../browser/web-request';
import { withoutFragment } from './auditor';

// What main records about each tab's main-frame document (spec `seo-indexability.spec.ts`,
// `RESPONSE_HEADER_ALLOWLIST`, `RESPONSE_LIMITS`, `RESPONSE_SOURCES`; acceptance
// `seo-indexability.feature.md`, Response metadata). The browse session's main-frame events
// (`browser/web-request.ts`) feed it, attributed to a tab by `webContentsId`: redirects as hops,
// the response's status and allowlisted headers (each cut as it arrives, so a response never puts
// more than the caps into main's memory; nothing else is read or parsed here). A tab's
// `did-navigate` commits the newest response for the URL it committed; without one (a page from
// the back/forward cache, or one main never saw) the record is `navigation`: did-navigate's
// status, no headers. The analysis worker validates and reads the record (`PageContextSchema`).

const ALLOWED: ReadonlySet<string> = new Set(RESPONSE_HEADER_ALLOWLIST);

/** `value` cut to `max` UTF-16 code units, never splitting a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = value.charCodeAt(max - 1) >= 0xd800 && value.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

const url = (value: string): string => cut(value, SNAPSHOT_LIMITS.maxUrlChars);
const httpStatus = (code: unknown): number | null => (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 999 ? code : null);

/**
 * The allowlisted headers of `responseHeaders` (names lowercased, in arrival order): at most
 * `maxValuesPerHeader` values per name and `maxHeaders` in all, each cut to `headerValueCap(name)`
 * (`maxHeaderValueChars`; `maxLongHeaderValueChars` for the CSP headers) and marked `truncated` if cut.
 */
export function captureHeaders(responseHeaders: Record<string, string[] | string> | undefined): ResponseHeader[] {
  const out: ResponseHeader[] = [];
  if (!responseHeaders) return out;
  const perName = new Map<string, number>();
  for (const [rawName, rawValues] of Object.entries(responseHeaders)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED.has(name)) continue;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    for (const value of values) {
      if (out.length >= RESPONSE_LIMITS.maxHeaders) return out;
      const seen = perName.get(name) ?? 0;
      if (seen >= RESPONSE_LIMITS.maxValuesPerHeader) break;
      if (typeof value !== 'string') continue;
      perName.set(name, seen + 1);
      const cap = headerValueCap(name);
      out.push(value.length > cap ? { name: name as ResponseHeaderName, value: cut(value, cap), truncated: true } : { name: name as ResponseHeaderName, value });
    }
  }
  return out;
}

interface Pending {
  hops: RedirectHop[];
  hopTotal: number;
  final: { url: string; status: number | null; fromCache: boolean; headers: ResponseHeader[] } | null;
}

interface TabRecord {
  /** Main-frame requests in flight (or answered, not yet committed), oldest first. */
  readonly pending: Map<number, Pending>;
  committed: ResponseMeta | null;
}

/** The parts of a tab's WebContents the recorder listens to. */
export interface RecordedContents {
  readonly id: number;
  on(event: 'did-navigate', listener: (event: unknown, url: string, httpResponseCode: number) => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface ResponseRecorder extends Required<MainFrameObserver> {
  /** Listens to a tab's WebContents: `did-navigate` commits, `destroyed` forgets. */
  watch(contents: RecordedContents): void;
  /** The tab committed a document at `url` with `httpResponseCode` (`did-navigate`). */
  committed(contentsId: number, url: string, httpResponseCode: number): void;
  /** The tab's response for `url` (the URL it shows now): its committed one, `in-page` when the URL changed in place, `null` without any. */
  responseFor(contentsId: number, url: string): ResponseMeta | null;
  forget(contentsId: number): void;
  /** Forgets every tab's record and pending request (Clear Browsing Data). */
  clear(): void;
}

export function createResponseRecorder(): ResponseRecorder {
  const tabs = new Map<number, TabRecord>();

  /** The tab's record, now the most recently used (the least recent goes past `maxTrackedTabs`). */
  const recordOf = (id: number): TabRecord => {
    let record = tabs.get(id);
    if (record) tabs.delete(id);
    else record = { pending: new Map(), committed: null };
    tabs.set(id, record);
    while (tabs.size > RESPONSE_LIMITS.maxTrackedTabs) tabs.delete(tabs.keys().next().value!);
    return record;
  };

  /** The request's pending entry (a new one is the newest; the oldest goes past `maxPendingPerTab`). */
  const pendingOf = (details: { id: number; webContentsId?: number }): Pending | null => {
    if (typeof details.webContentsId !== 'number') return null;
    const record = recordOf(details.webContentsId);
    let pending = record.pending.get(details.id);
    if (!pending) {
      pending = { hops: [], hopTotal: 0, final: null };
      record.pending.set(details.id, pending);
      while (record.pending.size > RESPONSE_LIMITS.maxPendingPerTab) record.pending.delete(record.pending.keys().next().value!);
    }
    return pending;
  };

  const isMainFrame = (details: { resourceType?: string }): boolean => details.resourceType === 'mainFrame';

  const recorder: ResponseRecorder = {
    redirected(details: OnBeforeRedirectListenerDetails) {
      if (!isMainFrame(details)) return;
      const pending = pendingOf(details);
      const status = httpStatus(details.statusCode);
      if (!pending || status === null) return;
      pending.hopTotal += 1;
      if (pending.hops.length < RESPONSE_LIMITS.maxRedirects) {
        pending.hops.push({ url: url(details.url), status, location: url(details.redirectURL), internal: /internal redirect/i.test(details.statusLine ?? '') });
      }
    },

    responded(details: OnResponseStartedListenerDetails) {
      if (!isMainFrame(details)) return;
      const pending = pendingOf(details);
      if (!pending) return;
      pending.final = { url: url(details.url), status: httpStatus(details.statusCode), fromCache: details.fromCache === true, headers: captureHeaders(details.responseHeaders) };
    },

    failed(details: OnErrorOccurredListenerDetails) {
      if (typeof details.webContentsId !== 'number') return;
      tabs.get(details.webContentsId)?.pending.delete(details.id);
    },

    watch(contents) {
      const id = contents.id;
      contents.on('did-navigate', (_event, committedUrl, code) => recorder.committed(id, committedUrl, code));
      contents.once('destroyed', () => recorder.forget(id));
    },

    committed(contentsId, committedUrl, httpResponseCode) {
      const record = recordOf(contentsId);
      const key = withoutFragment(committedUrl);
      const entries = [...record.pending.entries()];
      let match = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const final = entries[i]![1].final;
        if (final && withoutFragment(final.url) === key) {
          match = i;
          break;
        }
      }
      if (match < 0) {
        record.committed = { url: url(committedUrl), source: 'navigation', status: httpStatus(httpResponseCode), headersAvailable: false, headers: [], redirects: [], redirectTotal: 0 };
        return;
      }
      const [, pending] = entries[match]!;
      const final = pending.final!;
      record.committed = {
        url: url(committedUrl),
        source: final.fromCache ? 'cache' : 'network',
        status: final.status ?? httpStatus(httpResponseCode),
        headersAvailable: true,
        headers: final.headers,
        redirects: pending.hops,
        redirectTotal: pending.hopTotal,
      };
      // It and everything older are settled.
      for (let i = 0; i <= match; i++) record.pending.delete(entries[i]![0]);
    },

    responseFor(contentsId, current) {
      const committed = tabs.get(contentsId)?.committed ?? null;
      if (!committed) return null;
      if (withoutFragment(committed.url) === withoutFragment(current)) return committed;
      return { url: url(current), source: 'in-page', status: null, headersAvailable: false, headers: [], redirects: [], redirectTotal: 0 };
    },

    forget(contentsId) {
      tabs.delete(contentsId);
    },

    clear() {
      tabs.clear();
    },
  };
  return recorder;
}
