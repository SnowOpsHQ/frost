/**
 * The SEO devtools drawer (Phase 2.5 Task 5; acceptance `devtools.feature.md`). Zod-free: the chrome
 * renderer imports these constants and types at runtime (Zod in its bundle would trip the strict
 * Trusted Types CSP); the procedures' Zod inputs are in `devtools.schema.ts`, for main only.
 *
 * The drawer sits under the page area of the active tab. It is read-only by design: it never runs
 * script in a page and never edits a page's DOM; its one write is "Clear this site's data", which
 * main confirms in its own dialog. Data reaches the chrome only through the `devtools.*`
 * procedures (`enforceSender` first, Zod-validated), and every value that could be a secret is
 * masked by main before it is stored: request and response bodies are never captured, the
 * `SECRET_HEADERS` are only ever kept as `MASKED_VALUE`, and cookie values leave main only after a
 * per-cookie Reveal, which lasts until the tab's next navigation.
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
 * Electron exposes no cheap per-origin storage usage (it needs script in the page or the debugger,
 * both out of bounds for a read-only drawer), so the Storage tab says so instead of a number.
 */
export const STORAGE_USAGE_NOTE = 'Storage usage per site isn’t available: frost would have to run script in the page to measure it.' as const;

export type StorageAnswer =
  | { readonly status: 'ready'; readonly origin: string; readonly cookies: readonly CookieView[]; readonly cookieTotal: number; readonly usage: null }
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
