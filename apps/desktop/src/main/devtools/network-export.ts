import { csvCell } from '@app/seo-core';
import {
  EXPORT_URLS_REDACTED_NOTE,
  HAR_CREATOR,
  HAR_NO_BODY_COMMENT,
  HAR_VERSION,
  harLogComment,
  NETWORK_CSV_COLUMNS,
  networkExportFileName,
  type NetworkExportFormat,
  type NetworkExportResult,
  type NetworkHeader,
} from '@app/specs/devtools.spec';
import type { HarEntry, HarLog } from '@app/specs/devtools.schema';
import type { NetworkExportEntry, NetworkExportSnapshot } from './network-log';
import { queryStringOf, redactExportUrl, redactLinkHeader } from './url-redact';

// The network export (Phase 11 Task 4, Decision 5; spec `devtools.spec.ts`, `NETWORK_EXPORT_*`,
// `EXPORT_URL_PLACES`; acceptance `devtools.feature.md`, Network export). Main builds the file from
// the active tab's log as kept (`NetworkLog.exportSnapshot`): rows and headers exactly as stored
// (allowlisted, `SECRET_HEADERS` already `MASKED_VALUE`), never a body (none is ever read), and every
// URL the file carries through `redactExportUrl` (best effort; the file says so). The chrome only
// names the tab and the format; main asks where in its own save dialog and writes the file there.
// Cancel writes nothing.

/** Where the file is written: main's own save dialog and file write (Electron in `index.ts`, fakes in tests). */
export interface NetworkExportIo {
  /** Main's save dialog, offering `defaultName`; `null` when the user cancelled. */
  readonly chooseSavePath: (defaultName: string, format: NetworkExportFormat) => Promise<string | null>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  /** The app's version (`log.creator.version`). */
  readonly appVersion: string;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

const iso = (ms: number): string => {
  const date = new Date(Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

/** A kept header as the file writes it: URL values redacted (`referer`, `location`, each `<…>` of `link`). */
function exportHeader(header: NetworkHeader, requestUrl: string): { name: string; value: string } {
  if (header.masked) return { name: header.name, value: header.value };
  switch (header.name) {
    case 'referer':
    case 'location':
      return { name: header.name, value: redactExportUrl(header.value, requestUrl) };
    case 'link':
      return { name: header.name, value: redactLinkHeader(header.value, requestUrl) };
    default:
      return { name: header.name, value: header.value };
  }
}

/** What the entry's `comment` says beside the HAR fields (state, failure, cache, cuts). */
function entryComment(entry: NetworkExportEntry): string | undefined {
  const notes: string[] = [];
  if (entry.state === 'pending') notes.push('No answer yet.');
  if (entry.state === 'failed') notes.push(`Failed: ${entry.error ?? 'failed'}.`);
  if (entry.fromCache) notes.push('Answered from the HTTP cache.');
  if (entry.urlTruncated) notes.push('URL cut at the log’s cap.');
  if (entry.headersDropped) notes.push('Headers not kept: the log’s memory budget was full.');
  return notes.length > 0 ? notes.join(' ') : undefined;
}

const pageId = (document: number): string => `page_${document}`;

/** The HAR 1.2 log of `snapshot` (`HarLogSchema`). */
export function buildHar(snapshot: NetworkExportSnapshot, appVersion: string): HarLog {
  const firstStart = new Map<number, number>();
  for (const entry of snapshot.entries) {
    const at = firstStart.get(entry.document);
    if (at === undefined || entry.startedAt < at) firstStart.set(entry.document, entry.startedAt);
  }
  const withPage = new Set(snapshot.pages.map((p) => p.document));
  const pages = snapshot.pages.map((page) => ({
    startedDateTime: iso(firstStart.get(page.document) ?? 0),
    id: pageId(page.document),
    title: redactExportUrl(page.url),
    pageTimings: {},
  }));
  const entries = snapshot.entries.map((entry): HarEntry => {
    const url = redactExportUrl(entry.url);
    const wait = entry.durationMs !== null && Number.isFinite(entry.durationMs) && entry.durationMs > 0 ? entry.durationMs : 0;
    const mimeType = entry.responseHeaders.find((h) => h.name === 'content-type' && !h.masked)?.value ?? '';
    const comment = entryComment(entry);
    return {
      ...(withPage.has(entry.document) ? { pageref: pageId(entry.document) } : {}),
      startedDateTime: iso(entry.startedAt),
      time: wait,
      request: {
        method: entry.method || 'GET',
        url,
        httpVersion: '',
        cookies: [],
        headers: entry.requestHeaders.map((h) => exportHeader(h, entry.url)),
        // Rebuilt from the redacted URL: it restates only redacted values.
        queryString: queryStringOf(url),
        headersSize: -1,
        bodySize: -1,
        comment: HAR_NO_BODY_COMMENT,
      },
      response: {
        status: entry.status !== null && Number.isInteger(entry.status) && entry.status >= 0 ? entry.status : 0,
        statusText: '',
        httpVersion: '',
        cookies: [],
        headers: entry.responseHeaders.map((h) => exportHeader(h, entry.url)),
        content: { size: -1, mimeType, comment: HAR_NO_BODY_COMMENT },
        redirectURL: entry.redirectTo === null ? '' : redactExportUrl(entry.redirectTo, entry.url),
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait, receive: 0 },
      _resourceType: entry.type,
      ...(comment === undefined ? {} : { comment }),
    };
  });
  return {
    log: {
      version: HAR_VERSION,
      creator: { name: HAR_CREATOR.name, version: appVersion },
      pages,
      entries,
      comment: harLogComment(snapshot),
    },
  };
}

/** The CSV of `snapshot`: `EXPORT_URLS_REDACTED_NOTE`, the `NETWORK_CSV_COLUMNS` header, one line per request; every cell through `csvCell`, CRLF. */
export function buildCsv(snapshot: NetworkExportSnapshot): string {
  const yes = (on: boolean) => (on ? 'yes' : 'no');
  const lines = [csvCell(EXPORT_URLS_REDACTED_NOTE), NETWORK_CSV_COLUMNS.map(csvCell).join(',')];
  for (const e of snapshot.entries) {
    lines.push(
      [
        String(e.document),
        e.method,
        redactExportUrl(e.url),
        e.type,
        e.state,
        e.status === null ? '' : String(e.status),
        e.error ?? '',
        e.redirectTo === null ? '' : redactExportUrl(e.redirectTo, e.url),
        e.size === null ? '' : String(e.size),
        iso(e.startedAt),
        e.durationMs === null ? '' : String(e.durationMs),
        yes(e.fromCache),
        yes(e.thirdParty),
        e.robots,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Exports `snapshot` (the active tab's log; `null`: not the active tab or never recorded) as `format`:
 * `empty` without a request (no dialog), `cancelled` when the user closes main's dialog (nothing
 * written), `saved`, or `failed` (the dialog or the write failed). Never rejects.
 */
export async function exportNetworkLog(snapshot: NetworkExportSnapshot | null, format: NetworkExportFormat, io: NetworkExportIo): Promise<NetworkExportResult> {
  if (!snapshot || snapshot.entries.length === 0) return 'empty';
  try {
    const path = await io.chooseSavePath(networkExportFileName(snapshot.pageUrl, format, (io.now ?? (() => new Date()))()), format);
    if (path === null) return 'cancelled';
    const data = format === 'har' ? `${JSON.stringify(buildHar(snapshot, io.appVersion), null, 2)}\n` : buildCsv(snapshot);
    await io.writeFile(path, data);
    return 'saved';
  } catch (error) {
    io.log?.(`devtools: the network export failed (${error instanceof Error ? error.message : String(error)})`);
    return 'failed';
  }
}
