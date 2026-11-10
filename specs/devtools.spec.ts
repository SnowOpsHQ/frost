/**
 * The SEO devtools drawer (Phase 2.5 Task 5; acceptance `devtools.feature.md`). Zod-free: the chrome
 * renderer imports these constants and types at runtime (Zod in its bundle would trip the strict
 * Trusted Types CSP); the procedures' Zod inputs are in `devtools.schema.ts`, for main only.
 *
 * The drawer sits under the page area of the active tab. It never edits a page's DOM, and it runs one
 * script only (Phase 11 Task 4, Decision 6): the read-only web storage reader, in its own isolated
 * world `DEVTOOLS_STORAGE_WORLD_ID`, in the top frame, only when the Storage tab is opened or
 * refreshed and for a Reveal, and, while a key is revealed, for each Storage answer (to read that key
 * alone); one script at a time per tab (`WEB_STORAGE_LIMITS`). Its one write to the page's data is "Clear this
 * site's data", which main confirms in its own dialog; its one file is the network export, written by
 * main where the user chose in main's own save dialog. Data reaches the chrome only through the
 * `devtools.*` procedures (`enforceSender` first, Zod-validated), and every value that could be a
 * secret is masked by main before it is stored: request and response bodies are never captured, the
 * `SECRET_HEADERS` are only ever kept as `MASKED_VALUE`, and cookie and web storage values leave main
 * only after a per-item Reveal, which lasts until the tab's next navigation.
 */
import type { SeoPanelId } from './seo-sidebar.spec';

// ---- Toggle, menu, persistence, size -----------------------------------------------------------

/**
 * The drawer's toggle: `Mod+Shift+D` (Cmd on macOS, Ctrl elsewhere), with neither Alt nor the other
 * modifier; `D` by its physical key. Like `SIDEBAR_TOGGLE_SHORTCUT` it is reserved: taken from every
 * tab's and the chrome's `before-input-event` and consumed, so a page can neither see nor block it.
 * Main bumps `BrowserState.devtoolsToggleSeq` and the chrome, which owns open / closed, toggles.
 */
export const DEVTOOLS_TOGGLE_SHORTCUT = 'Mod+Shift+D' as const;
export const DEVTOOLS_MENU_ID = 'toggle-devtools-drawer' as const;
export const DEVTOOLS_MENU_LABEL = 'SEO Devtools' as const;
export const DEVTOOLS_MENU_ACCELERATOR = 'CmdOrCtrl+Shift+D' as const;

/**
 * Per window, in the chrome's own `localStorage` (`app://app`, never the browse partition): open
 * (`'1'` / `'0'`; none: `DEVTOOLS_DEFAULT_OPEN`), the height in CSS px, and the last tab shown.
 */
export const DEVTOOLS_STORAGE_KEYS = {
  open: 'frost.devtools.open',
  height: 'frost.devtools.height',
  tab: 'frost.devtools.tab',
} as const;
export const DEVTOOLS_DEFAULT_OPEN = false;

/**
 * The drawer's height (CSS px). It is a band under the workspace (the page column and the SEO
 * sidebar; `column` is the two together), so the page area above it shrinks and the tab's view is laid out above it through `browser.setPageBounds` (as the
 * palette's sheet does at the top). Dragging its top edge, or Arrow Up / Down on the edge
 * (`keyboardStep`; Page Up / Down: four steps), resizes it, clamped to `[min, column − pageMinVisible]`
 * (never below `min`). The CSS clamps it too (`max-height`), so a short window never hides the page.
 */
export const DEVTOOLS_HEIGHT = {
  default: 280,
  min: 140,
  pageMinVisible: 160,
  keyboardStep: 24,
} as const;

export const DEVTOOLS_TABS = [
  { id: 'network', label: 'Network' },
  { id: 'redirects', label: 'Redirects' },
  { id: 'console', label: 'Console' },
  { id: 'storage', label: 'Storage' },
  { id: 'issues', label: 'Issues' },
] as const satisfies readonly { id: string; label: string }[];
export type DevtoolsTabId = (typeof DEVTOOLS_TABS)[number]['id'];
export const DEFAULT_DEVTOOLS_TAB: DevtoolsTabId = 'network';

/**
 * The chrome waits for changes with the `devtools.watch` long-poll (a tab's devtools version:
 * network, console, storage reveals), at most `DEVTOOLS_WATCH_TIMEOUT_MS`; main keeps at most
 * `MAX_PENDING_DEVTOOLS_WATCHES` waiting: one more answers the oldest early with
 * `DEVTOOLS_WATCH_EVICTED` (never a version). After a change the shown tab's data is fetched again,
 * no sooner than `DEVTOOLS_REFRESH_MIN_MS` after the last fetch. When a watch answers no news (the
 * same version, or evicted) or fails, the chrome waits `DEVTOOLS_WATCH_BACKOFF_MS` before it asks
 * again, so two pollers can never evict each other in a busy loop.
 */
export const DEVTOOLS_WATCH_TIMEOUT_MS = 25_000;
export const MAX_PENDING_DEVTOOLS_WATCHES = 8;
export const DEVTOOLS_REFRESH_MIN_MS = 300;
export const DEVTOOLS_WATCH_EVICTED = -1;
export const DEVTOOLS_WATCH_BACKOFF_MS = 1_000;

/**
 * Which tab the `devtools.*` procedures serve (decision): only the active tab of the app's window
 * (frost shows one window; the drawer only ever shows the active tab). Any other id answers as
 * `no-tab` (`watch`: its version stays 0), so the chrome can never read another tab's log, console
 * or cookies.
 */
export const DEVTOOLS_TAB_SCOPE = 'active-tab' as const;

// ---- Network -----------------------------------------------------------------------------------

/**
 * Recording (decision): main records every tab's requests all the time, from the browse session's
 * `webRequest` observers (`browser/web-request.ts`, `observeRequests`: `onSendHeaders`,
 * `onBeforeRedirect`, `onResponseStarted`, `onCompleted`, `onErrorOccurred`; never a blocking
 * listener), but keeps little while no window has the drawer open:
 * - drawer open (in any window): a tab's log keeps the first `maxPerDocument` requests of each
 *   document; later ones are counted (`dropped`), not kept;
 * - drawer closed everywhere: a small ring of the newest `closedRingSize` requests of the current
 *   document, plus its main-frame request (always kept); the ones it lets go are counted (`notKept`),
 *   and the Network tab says that a reload records them all.
 * A main-frame navigation that commits another document (`did-navigate`) starts a new log, unless
 * "Preserve log" is on for that tab (session-only): then earlier documents' requests stay, at most
 * `maxPreserved` in all (the oldest go first). The committing request (and its redirect hops) and
 * the requests sent after its response started move into the new document; a navigation that never
 * commits (a `204`, a download, one cancelled) leaves the log as it was. At most `maxTrackedTabs` tabs
 * are recorded (the one recorded least recently is forgotten). Requests answered from Chromium's
 * memory cache never reach `webRequest`, so they are not listed.
 *
 * Memory is bounded in bytes too: each kept string costs 2 bytes per UTF-16
 * code unit, each entry `entryOverheadBytes` and each header `headerOverheadBytes` more. A tab keeps
 * at most `tabBudgetBytes` (headers at most `maxHeaderShare` of it), all tabs together
 * `globalBudgetBytes`. A request that does not fit is not
 * kept; headers that do not fit are left off their entry (`headersDropped`); both are counted
 * (`overBudget`: entries and bytes) and the Network tab says so.
 *
 * The list is light: `devtools.network` answers rows **without headers**, only the rows changed
 * since the chrome's cursor (`since`, a revision), at most `maxRowsPerAnswer` at a time (`more`: ask
 * again at once), with the keys of rows removed since. Headers come on demand, for the row the user
 * opens (`devtools.requestHeaders`), masked as ever.
 */
export const NETWORK_LIMITS = {
  maxPerDocument: 2_000,
  closedRingSize: 100,
  maxPreserved: 2_000,
  maxUrlChars: 2_048,
  maxHeaderValueChars: 1_024,
  maxHeadersPerMessage: 16,
  maxErrorChars: 120,
  maxTrackedTabs: 16,
  tabBudgetBytes: 4_000_000,
  globalBudgetBytes: 32_000_000,
  entryOverheadBytes: 400,
  headerOverheadBytes: 64,
  /** Headers may take at most this share of a tab's budget, so rows always keep the rest. */
  maxHeaderShare: 0.5,
  maxRowsPerAnswer: 500,
  /** Removed-row records a tab keeps for incremental answers (an older cursor gets a full answer). */
  maxRemovalRecords: 2_048,
} as const;

/** The drawer's request types (from Electron's `resourceType`, `NETWORK_TYPE_OF`). */
export const NETWORK_RESOURCE_TYPES = ['document', 'frame', 'stylesheet', 'script', 'image', 'font', 'media', 'fetch', 'websocket', 'other'] as const;
export type NetworkResourceType = (typeof NETWORK_RESOURCE_TYPES)[number];

/** Electron's `webRequest` `resourceType` → the drawer's type (anything else: `other`). */
export const NETWORK_TYPE_OF: Readonly<Record<string, NetworkResourceType>> = {
  mainFrame: 'document',
  subFrame: 'frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  media: 'media',
  xhr: 'fetch',
  webSocket: 'websocket',
  object: 'other',
  ping: 'other',
  cspReport: 'other',
  other: 'other',
};

export const NETWORK_TYPE_LABELS: Readonly<Record<NetworkResourceType, string>> = {
  document: 'Document',
  frame: 'Frame',
  stylesheet: 'CSS',
  script: 'JS',
  image: 'Image',
  font: 'Font',
  media: 'Media',
  fetch: 'Fetch/XHR',
  websocket: 'WebSocket',
  other: 'Other',
};

/**
 * The types a crawler fetches to index and render a page: only these get a robots.txt verdict, and
 * only for the page's own origin (from the robots.txt fetcher's cache, the file the audit read;
 * matched for Googlebot in the analysis worker, never on main's thread).
 */
export const CRAWLABLE_TYPES = ['document', 'script', 'stylesheet', 'image'] as const satisfies readonly NetworkResourceType[];
/** The crawler whose robots.txt rules the verdicts follow. */
export const ROBOTS_VERDICT_AGENT = 'Googlebot' as const;
/** URLs sent to the worker in one robots.txt verdict job. */
export const ROBOTS_VERDICT_BATCH = 500;

/**
 * `allowed` / `blocked` by robots.txt for `ROBOTS_VERDICT_AGENT`; `unknown`: robots.txt could not be
 * read (or crawlers must assume nothing is allowed); `pending`: not decided yet; `not-checked`: not a
 * crawlable type, or another origin.
 */
export const ROBOTS_VERDICTS = ['allowed', 'blocked', 'unknown', 'pending', 'not-checked'] as const;
export type RobotsVerdict = (typeof ROBOTS_VERDICTS)[number];

/**
 * Header values that are always secrets: never stored in clear, shown as `MASKED_VALUE` with no
 * Reveal (`devtools-masks-secrets`).
 */
export const SECRET_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'] as const;
export const MASKED_VALUE = '•••' as const;

/** Request headers kept with their value (lowercased names); others are counted, not kept. */
export const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'origin',
  'pragma',
  'purpose',
  'range',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-purpose',
  'upgrade-insecure-requests',
  'user-agent',
] as const;

/** Response headers kept with their value (lowercased names); others are counted, not kept. */
export const RESPONSE_HEADER_KEEP = [
  'age',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'link',
  'location',
  'server',
  'vary',
  'x-robots-tag',
] as const;

/** The longest text search the Network tab applies (longer input is cut in the chrome). */
export const NETWORK_SEARCH_MAX_CHARS = 200;
/** The Network tab's type filter: every request, or one type. */
export const NETWORK_TYPE_FILTERS = ['all', ...NETWORK_RESOURCE_TYPES] as const;
export type NetworkTypeFilter = (typeof NETWORK_TYPE_FILTERS)[number];

/** A request or response header as the drawer shows it. `masked`: a `SECRET_HEADERS` value, never kept. */
export interface NetworkHeader {
  readonly name: string;
  readonly value: string;
  readonly masked: boolean;
  readonly truncated: boolean;
}

/**
 * One request (a row: no headers; `devtools.requestHeaders` has them). `state`: `pending` (no answer yet), `done` (answered), `redirected` (answered with a
 * redirect: `redirectTo`; the next hop is its own entry), `failed` (`error`, Chromium's net error
 * text). `size`: the response's `Content-Length` when it sent one (Electron's `webRequest` reports
 * no transfer size). `startedAt` is ms since the epoch; `durationMs` from the request's first event to
 * its last. `fromCache`: answered from the HTTP cache. `thirdParty`: another registrable domain than
 * the page's (`isThirdParty`, `seo-core`). Never a body: none is ever read.
 */
export interface NetworkEntry {
  readonly key: number;
  /** The row's revision: it changes whenever the row does (the cursor `devtools.network` counts from). */
  readonly rev: number;
  /** Which document of the tab it belongs to (counts up; differs only with "Preserve log"). */
  readonly document: number;
  readonly method: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly type: NetworkResourceType;
  readonly state: 'pending' | 'done' | 'redirected' | 'failed';
  readonly status: number | null;
  readonly error: string | null;
  readonly redirectTo: string | null;
  readonly size: number | null;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly fromCache: boolean;
  readonly thirdParty: boolean;
  readonly robots: RobotsVerdict;
  readonly requestHeaderCount: number;
  readonly responseHeaderCount: number;
  /** Its headers were not kept: the byte budget was full. */
  readonly headersDropped: boolean;
}

/**
 * `devtools.network`: the rows of the tab's log changed since `since` (`no-tab`: not the active
 * tab). `full`: the answer replaces everything the chrome holds (a cursor of 0, one from before a
 * reset or before the tab's log started over, or one too old for the removal records); otherwise
 * merge `entries` by key and drop `removed`. `rev` is the cursor for the next call; `more`: rows
 * are left, ask again at once.
 */
export type NetworkLogAnswer =
  | {
      readonly status: 'ready';
      readonly tabId: number;
      /** The current document's URL (the third-party flag's reference). */
      readonly pageUrl: string;
      readonly rev: number;
      readonly full: boolean;
      readonly more: boolean;
      readonly entries: readonly NetworkEntry[];
      readonly removed: readonly number[];
      /** Requests of the current document past `maxPerDocument`, not kept. */
      readonly dropped: number;
      /** Requests the closed drawer's ring let go (`closedRingSize`). */
      readonly notKept: number;
      /** What the byte budgets left out: whole requests, and bytes (theirs and dropped headers'). */
      readonly overBudget: { readonly entries: number; readonly bytes: number };
      readonly preserve: boolean;
    }
  | { readonly status: 'no-tab'; readonly tabId: number };

/** `devtools.requestHeaders`: one row's headers, masked (`gone`: no such row in the active tab's log). */
export type NetworkHeadersAnswer =
  | {
      readonly status: 'ready';
      readonly key: number;
      readonly requestHeaders: readonly NetworkHeader[];
      readonly omittedRequestHeaders: number;
      readonly responseHeaders: readonly NetworkHeader[];
      readonly omittedResponseHeaders: number;
      readonly headersDropped: boolean;
    }
  | { readonly status: 'gone' };

// ---- Network export (Phase 11 Task 4, Decision 5) ----------------------------------------------

/**
 * "Export" on the Network tab: the active tab's log (`DEVTOOLS_TAB_SCOPE`) as HAR 1.2 or CSV. The
 * chrome names only the tab and the format; main builds the file from the log as kept (rows and
 * headers exactly as stored: allowlisted, `SECRET_HEADERS` as `MASKED_VALUE`), never a body (none is
 * ever read), and writes it where the user chose in main's own save dialog. Every URL the file
 * carries (`EXPORT_URL_PLACES`) goes through one redaction (`redactExportUrl`, best effort).
 */
export const NETWORK_EXPORT_FORMATS = ['har', 'csv'] as const;
export type NetworkExportFormat = (typeof NETWORK_EXPORT_FORMATS)[number];

/**
 * `saved`: written; `cancelled`: the user closed the save dialog, or another export's dialog is still
 * open (no second dialog; nothing written); `empty`: no request to export, or not the active tab (no
 * dialog); `failed`: the file could not be written.
 */
export const NETWORK_EXPORT_RESULTS = ['saved', 'cancelled', 'empty', 'failed'] as const;
export type NetworkExportResult = (typeof NETWORK_EXPORT_RESULTS)[number];

/** The save dialog: its title, filter names and extensions (`showOverwriteConfirmation`, in the Downloads folder). */
export const NETWORK_EXPORT_DIALOG = {
  title: 'Export network log',
  filterNames: { har: 'HTTP Archive (HAR)', csv: 'CSV' },
  extensions: { har: 'har', csv: 'csv' },
} as const satisfies { title: string; filterNames: Record<NetworkExportFormat, string>; extensions: Record<NetworkExportFormat, string> };

/** The menu's labels. */
export const NETWORK_EXPORT_LABELS: Readonly<Record<NetworkExportFormat, string>> = { har: 'Export HAR…', csv: 'Export CSV…' };

/**
 * The file name offered: `frost-network-<host>-<YYYYMMDD-HHMMSS>.<ext>` (local time), the host
 * lower-cased with anything but `a-z`, `0-9`, `.` and `-` made `-` (`page` without one).
 */
export function networkExportFileName(pageUrl: string, format: NetworkExportFormat, at: Date): string {
  let host = '';
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = '';
  }
  const safe = host.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 100) || 'page';
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `frost-network-${safe}-${stamp}.${NETWORK_EXPORT_DIALOG.extensions[format]}`;
}

/**
 * Said in the HAR's `log.comment`, as the CSV's first line and in the Export menu. Best effort:
 * frost never claims an export holds no secret (a token under an unknown name or in a path is kept).
 */
export const EXPORT_URLS_REDACTED_NOTE = 'Known sensitive URL parameters were redacted, best effort. Review the file before you share it.' as const;
/** The Export menu's hint beside `EXPORT_URLS_REDACTED_NOTE` (the name fragments catch some ordinary parameters). */
export const EXPORT_REDACTION_HINT = 'Some harmless values may be redacted too.' as const;

/** Each HAR entry's `request.comment` and `response.content.comment` (with `bodySize: -1`, `content.size: -1` and no `text`). */
export const HAR_NO_BODY_COMMENT = 'Body not recorded: frost never reads request or response bodies.' as const;

/** The HAR's `log.creator` (`version`: the app's). */
export const HAR_CREATOR = { name: 'frost' } as const;
export const HAR_VERSION = '1.2' as const;

/** What the log left out, as the Network tab says it (`NetworkLogAnswer`). */
export interface NetworkExportCounts {
  readonly dropped: number;
  readonly notKept: number;
  readonly overBudget: { readonly entries: number; readonly bytes: number };
}

/** The HAR's `log.comment`: the redaction note, no bodies, and what the log did not keep. */
export function harLogComment(counts: NetworkExportCounts): string {
  return [
    EXPORT_URLS_REDACTED_NOTE,
    'Bodies are never recorded, so no entry has one (bodySize -1).',
    `Not in this file: ${counts.dropped} requests past the log's cap (dropped), ${counts.notKept} let go while the drawer was closed (notKept), ${counts.overBudget.entries} requests and ${counts.overBudget.bytes} bytes over the log's memory budget (overBudget).`,
  ].join(' ');
}

/**
 * The CSV: `EXPORT_URLS_REDACTED_NOTE` as its first line, then this header and one line per request
 * (no headers, no bodies), every cell through `csvCell` (`CSV_FORMULA_PREFIXES`, RFC 4180), CRLF.
 * `Started` is ISO 8601; `Size` the response's `Content-Length`; the URLs redacted.
 */
export const NETWORK_CSV_COLUMNS = ['Document', 'Method', 'URL', 'Type', 'State', 'Status', 'Error', 'Redirect to', 'Size', 'Started', 'Duration (ms)', 'From cache', 'Third-party', 'robots.txt'] as const;

/**
 * Every place an export carries a URL; `redactExportUrl` runs over each:
 * - `request.url`: HAR `request.url`, the CSV's URL;
 * - `request.queryString`: HAR `request.queryString[]`, rebuilt from the redacted URL (it restates
 *   only redacted values);
 * - `response.redirectURL`: the entry's `redirectTo` (HAR `response.redirectURL`, the CSV's
 *   Redirect to);
 * - `page`: the document's page URL (HAR `pages[].title`);
 * - `header:referer`, `header:location`: those header values (resolved against the request URL);
 * - `header:link`: each `<…>` URL of a `link` value (an unclosed one, cut at `maxHeaderValueChars`,
 *   and the text after a stray `>`, to the end of the value; a value with no `<` that reads as an
 *   absolute URL, as one).
 */
export const EXPORT_URL_PLACES = ['request.url', 'request.queryString', 'response.redirectURL', 'page', 'header:referer', 'header:location', 'header:link'] as const;
export type ExportUrlPlace = (typeof EXPORT_URL_PLACES)[number];

/** What a redacted value (or a URL that cannot be read) is written as. */
export const REDACTED_VALUE = 'REDACTED' as const;

/**
 * Query parameters whose value is always `REDACTED_VALUE`, whatever its length (names compared
 * lower-cased, after percent-decoding).
 */
export const EXPORT_REDACTED_QUERY_PARAMS = [
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'key',
  'api_key',
  'apikey',
  'access_key',
  'client_key',
  'x-api-key',
  'x-amz-credential',
  'x-amz-signature',
  'code',
  'state',
  'session',
  'sessionid',
  'sessid',
  'phpsessid',
  'jsessionid',
  'sid',
  'auth',
  'password',
  'passwd',
  'pwd',
  'pw',
  'secret',
  'signature',
  'sig',
  'csrf',
  'xsrf',
  'nonce',
  'otp',
  'ticket',
  'credential',
  'email',
] as const;

/**
 * A parameter whose lower-cased name contains one of these is redacted too (`keyword`, `author`,
 * `passage` included). Names are compared without trailing `[…]` brackets and by each bracket's
 * content too (`token[]`, `data[sid]`).
 */
export const EXPORT_REDACT_NAME_FRAGMENTS = ['token', 'secret', 'session', 'sess', 'auth', 'pass', 'key', 'csrf', 'xsrf', 'nonce', 'credential', 'signature'] as const;

/**
 * Any parameter value (or bare query part) that, after percent-decoding (and `+` as a space, up to
 * five times), matches one of these is redacted whatever its name: an email-shaped part, a run of at
 * least 32 base64 / base64url / hex characters, or a JWT-shaped token. A value that holds nested
 * parameters once decoded (`next=/cb?token=…`) is redacted whole when any nested `name=value` piece
 * is sensitive by these rules. Path segments are never redacted (a secret in a path is a known gap,
 * `path-secrets-not-claimed`); path matrix parameters (`;jsessionid=…`) follow the parameter rules.
 */
export const EXPORT_REDACT_VALUE_PATTERNS = {
  email: /[^\s@/?#&=]+@[^\s@/?#&=]+\.[a-z]{2,}/i,
  opaque: /[A-Za-z0-9+/=_-]{32,}/,
  jwt: /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/,
} as const satisfies Record<string, RegExp>;

// ---- Redirects ---------------------------------------------------------------------------------

/** The headers each redirect hop and the final answer show (when the recorder saw them). */
export const REDIRECT_KEY_HEADERS = ['location', 'cache-control', 'expires', 'age', 'x-robots-tag'] as const;

export interface RedirectHopView {
  readonly url: string;
  readonly status: number;
  readonly location: string;
  /** Chromium's own redirect (HSTS, an upgrade), not the server's. */
  readonly internal: boolean;
  /** The hop's `REDIRECT_KEY_HEADERS`; `headersRecorded: false` when the drawer's recorder never saw it. */
  readonly headers: readonly NetworkHeader[];
  readonly headersRecorded: boolean;
}

/**
 * `devtools.redirects`: the main-frame redirect trace of the tab's current document, from Phase 2's
 * response recorder (`seo/responses.ts`), each hop with its key headers. `none`: no response recorded
 * (an empty tab, a page from the back/forward cache).
 */
export type RedirectTraceAnswer =
  | {
      readonly status: 'ready';
      readonly url: string;
      readonly source: 'network' | 'cache' | 'navigation' | 'in-page';
      readonly hops: readonly RedirectHopView[];
      /** Every hop, also the ones past the recorder's cap. */
      readonly hopTotal: number;
      readonly finalStatus: number | null;
      readonly finalHeaders: readonly NetworkHeader[];
    }
  | { readonly status: 'none' | 'no-tab' };

// ---- Console -----------------------------------------------------------------------------------

/**
 * The tab's `console-message` events for the current document (a cross-document navigation starts
 * over). Identical messages (same level, text, source and line) are one entry with a `count`. At most
 * `maxEntries` distinct entries; later new ones are counted (`dropped`). Text is cut to its caps and
 * always rendered as inert text.
 */
export const CONSOLE_LIMITS = {
  maxEntries: 500,
  maxMessageChars: 2_000,
  maxSourceChars: 512,
} as const;
export const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface ConsoleEntry {
  readonly key: number;
  readonly level: ConsoleLevel;
  readonly message: string;
  readonly truncated: boolean;
  readonly source: string;
  readonly line: number;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

export type ConsoleLogAnswer =
  | { readonly status: 'ready'; readonly entries: readonly ConsoleEntry[]; readonly total: number; readonly dropped: number }
  | { readonly status: 'no-tab' };

// ---- Storage -----------------------------------------------------------------------------------

/**
 * Cookies for the tab's URL (`session.fromPartition(BROWSE_PARTITION).cookies.get({ url })`), at most
 * `maxCookies`; names, domain, path, expiry and flags are shown, values masked (`value: null`) until
 * the user reveals one. A Reveal lasts for the tab's current document only (the next main-frame
 * navigation that commits, Clear this site's data or closing the tab masks it again) and is never
 * stored. Each Reveal is stamped with the tab's committed document at the moment it was asked for, and
 * `storage` shows a value only while that stamp is the tab's current one: a Reveal asked during a
 * navigation that then commits never shows in the new document.
 */
export const COOKIE_LIMITS = {
  maxCookies: 200,
  maxNameChars: 256,
  maxValueChars: 4_096,
  maxDomainChars: 255,
  maxPathChars: 1_024,
} as const;

export const COOKIE_SAME_SITE = ['unspecified', 'no_restriction', 'lax', 'strict'] as const;
export type CookieSameSite = (typeof COOKIE_SAME_SITE)[number];

export interface CookieView {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  /** ms since the epoch; `null`: a session cookie. */
  readonly expires: number | null;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: CookieSameSite;
  /** `null` while masked; the (capped) value once revealed. */
  readonly value: string | null;
  readonly valueTruncated: boolean;
}

/**
 * The site's storage usage and quota come from the storage reader (`navigator.storage.estimate()`,
 * read with the keys; `WEB_STORAGE_LIMITS`), so they are as fresh as the last Refresh. The browser
 * estimates them (padded for cross-site privacy) and may not offer them at all, e.g. on a page that is
 * not a secure context; the Storage tab then shows no number.
 */
export const STORAGE_USAGE_NOTE = 'Usage is the browser’s own estimate for this site, read with the keys; it can be padded and isn’t offered on every page.' as const;

// ---- Web storage (Phase 11 Task 4, Decision 6) --------------------------------------------------

/**
 * The isolated world of the drawer's one script, the web storage reader (Decision 17: Phase 11 owns
 * `1_700`–`1_709`). It is in `NON_AGENT_WORLD_IDS` (`agent-page-tools.spec.ts`).
 */
export const DEVTOOLS_STORAGE_WORLD_ID = 1_700;

/** The page's two web storage areas: `localStorage` and `sessionStorage`. */
export const WEB_STORAGE_AREAS = ['local', 'session'] as const;
export type WebStorageArea = (typeof WEB_STORAGE_AREAS)[number];

/**
 * The web storage reader (Decision 6): one self-contained, read-only function run by main with
 * `executeJavaScriptInIsolatedWorld` in `DEVTOOLS_STORAGE_WORLD_ID`, top frame only. It runs only
 * when the chrome asks: the Storage tab opened or its Refresh (`readWebStorage`), and, while one key
 * is revealed, to read that key alone for each Storage answer. One script at a time per tab: a read
 * in flight is shared by the requests made meanwhile (with or without `readWebStorage`), and a clear
 * (Clear Browsing Data, Clear this site's data) or a commit while it runs discards what it read. It runs with JavaScript off too
 * (isolated worlds do, as the extractor's), never edits storage and keeps nothing in the page.
 * - **Keys** (`op: 'keys'`): per area, at most `maxKeys` keys (each cut to `maxKeyChars`) with their
 *   value's size (UTF-16 code units) and the area's total; never a value. Also
 *   `navigator.storage.estimate()` (`usage`, `quota`; `null` where the browser offers none).
 * - **Value** (`op: 'value'`): one key's value, cut to `maxValueChars`, for the one revealed key.
 * Main waits at most `scriptTimeoutMs` (`timeout`), validates every answer with
 * `WebStorageKeysAnswerSchema` / `WebStorageValueAnswerSchema` (`invalid`: the page can answer
 * anything) and drops one whose origin is not the tab's (the page moved on). An opaque origin (a
 * sandboxed document) answers `opaque-origin`, a storage the browser refuses `denied`.
 * Main keeps the keys and sizes of the last read for the tab's current document (never a value); a
 * revealed value is read again for each answer and never kept. Reveals are stamped with the tab's
 * committed document as cookie reveals are (`COOKIE_LIMITS`): a commit, Clear this site's data, Clear
 * Browsing Data or closing the tab forgets the keys and the reveal.
 */
export const WEB_STORAGE_LIMITS = {
  maxKeys: 500,
  maxKeyChars: 256,
  maxValueChars: 4_096,
  scriptTimeoutMs: 2_000,
} as const;

export const WEB_STORAGE_UNAVAILABLE_REASONS = ['opaque-origin', 'denied', 'timeout', 'invalid', 'failed'] as const;
export type WebStorageUnavailableReason = (typeof WEB_STORAGE_UNAVAILABLE_REASONS)[number];

/**
 * One key of an area. `size`: its value's length in UTF-16 code units. `value`: `null` while masked;
 * the (capped) value only for the one revealed key. A key cut to `maxKeyChars` (`keyTruncated`)
 * cannot be revealed.
 */
export interface WebStorageItem {
  readonly key: string;
  readonly keyTruncated: boolean;
  readonly size: number;
  readonly value: string | null;
  readonly valueTruncated: boolean;
}

export type WebStorageAreaView =
  | { readonly status: 'ready'; readonly items: readonly WebStorageItem[]; readonly total: number }
  | { readonly status: 'unavailable'; readonly reason: WebStorageUnavailableReason };

export type WebStorageView = { readonly [area in WebStorageArea]: WebStorageAreaView };

/**
 * `devtools.storage`. `webStorage`: `null` until the reader ran for the tab's current document (the
 * Storage tab opened, or Refresh); `usage` / `quota` in bytes from the same read (`null`: not read
 * or not offered).
 */
export type StorageAnswer =
  | {
      readonly status: 'ready';
      readonly origin: string;
      readonly cookies: readonly CookieView[];
      readonly cookieTotal: number;
      readonly usage: number | null;
      readonly quota: number | null;
      readonly webStorage: WebStorageView | null;
    }
  | { readonly status: 'no-page' | 'no-tab' };

/**
 * "Clear this site's data": main asks first in a native message box (Cancel is the default), then
 * clears the origin's cookies (Chromium clears cookies for the whole registrable domain), storage
 * and cache from the browse partition (`session.clearData`). Nothing else; no tab is reloaded. One
 * dialog at a time: a second request for the same origin shares the first one's answer; one for
 * another origin while a dialog is up answers `busy` (nothing asked, nothing cleared).
 */
export const CLEAR_SITE_DATA = {
  dialog: {
    type: 'warning',
    message: 'Clear this site’s data?',
    buttons: ['Cancel', 'Clear site data'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  },
  /** The detail line: the origin, then what goes. */
  detail: (origin: string) =>
    `frost deletes the cookies, local storage, IndexedDB, service workers and cached files of ${origin}. Cookies go for the whole site, its subdomains included. You may be signed out.`,
  confirmIndex: 1,
  dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'cache', 'backgroundFetch'],
} as const;
export const CLEAR_SITE_DATA_RESULTS = ['cleared', 'cancelled', 'refused', 'busy'] as const;
export type ClearSiteDataResult = (typeof CLEAR_SITE_DATA_RESULTS)[number];

// ---- Issues ------------------------------------------------------------------------------------

/** The Issues tab's sort columns (severity: errors first; then rule id, category). */
export const ISSUE_SORT_KEYS = ['severity', 'rule', 'category'] as const;
export type IssueSortKey = (typeof ISSUE_SORT_KEYS)[number];
/** Clicking an issue opens the SEO sidebar on the most specific panel (after Overview) covering its category, else this one. */
export const ISSUE_FALLBACK_PANEL: SeoPanelId = 'on-page';
