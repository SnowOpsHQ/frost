/**
 * Browser polish (Phase 2.5 Task 6; acceptance: `browser-polish.feature.md`): find in page, reopen
 * closed tab, the History view, "Jump back in" on the new-tab page, and the search engine choice.
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod (whose eval
 * probe the app's strict Trusted Types CSP blocks). The procedures' Zod inputs and the state schema
 * are in `browser-polish.schema.ts`.
 */

// ---- Search engines ------------------------------------------------------------------------------

/**
 * The search engines the address bar can search with: a fixed, reviewed table. `template` is an
 * `https:` URL whose only variable part is `{q}`, replaced by the query `encodeURIComponent`-encoded
 * (so it is only ever the value of the engine's query parameter, never its host or path). `prefix`
 * is the address-bar shortcut: `<prefix> <query>` searches that engine whatever the default is.
 */
export const SEARCH_ENGINES = [
  { id: 'google', label: 'Google', prefix: 'g', template: 'https://www.google.com/search?q={q}' },
  { id: 'bing', label: 'Bing', prefix: 'b', template: 'https://www.bing.com/search?q={q}' },
  { id: 'duckduckgo', label: 'DuckDuckGo', prefix: 'd', template: 'https://duckduckgo.com/?q={q}' },
] as const satisfies readonly SearchEngine[];
export interface SearchEngine {
  readonly id: string;
  readonly label: string;
  /** One lowercase letter. */
  readonly prefix: string;
  /** `https://<fixed host>/<fixed path>?…{q}`: `{q}` exactly once, in the query string. */
  readonly template: string;
}
export type SearchEngineId = (typeof SEARCH_ENGINES)[number]['id'];
export const SEARCH_ENGINE_IDS = SEARCH_ENGINES.map((engine) => engine.id) as [SearchEngineId, ...SearchEngineId[]];
/** The engine used until the user picks another (and whenever the stored choice is unreadable). */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'google';

/** Whether `value` names an engine of `SEARCH_ENGINES`. */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return typeof value === 'string' && (SEARCH_ENGINE_IDS as readonly string[]).includes(value);
}

/** The table row of `id` (the default engine's for anything else). */
export function searchEngine(id: unknown): (typeof SEARCH_ENGINES)[number] {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE)!;
}

/**
 * `text` with every lone surrogate replaced by U+FFFD (as `String.prototype.toWellFormed` does): a
 * lone surrogate in a typed query or a page selection would make `encodeURIComponent` throw. With the
 * `u` flag a surrogate pair is one code point, so only lone halves match.
 */
export function wellFormed(text: string): string {
  return text.replace(/\p{Cs}/gu, '\uFFFD');
}

/** The search URL for `query` on `engine`: its template with `{q}` replaced by the encoded (well-formed) query. */
export function searchEngineUrl(engine: SearchEngineId, query: string): string {
  return searchEngine(engine).template.replace('{q}', encodeURIComponent(wellFormed(query)));
}

/**
 * The engine choice is stored locally in the session database's `app_settings` table (migration
 * `0005_app_settings`) under this key, as the engine id. A missing or unknown value reads as
 * `DEFAULT_SEARCH_ENGINE`. It is a preference: Clear Browsing Data and "Clear all history" keep it.
 */
export const SEARCH_ENGINE_SETTING_KEY = 'search_engine' as const;

/** The status line after the palette changed the engine (`{engine}`: its label). */
export const SEARCH_ENGINE_SET_MESSAGE = 'Address bar searches now use {engine}' as const;

/**
 * The context menu's search item names the engine in use: `Search <label> for “<selection>”` (the
 * default engine's is `CONTEXT_MENU_SEARCH_LABEL` in `page-commands.spec.ts`).
 */
export function contextMenuSearchLabel(engine: SearchEngineId): string {
  return `Search ${searchEngine(engine).label} for “{selection}”`;
}

// ---- Find in page --------------------------------------------------------------------------------

/**
 * Find in page: `Mod+F` (`RESERVED_TAB_SHORTCUTS['find-in-page']` in `tabs.spec.ts`: taken from every
 * tab's and the chrome's `before-input-event` and consumed, so a page can neither see nor block it)
 * opens the active tab's find bar, or focuses it again. Next / previous match are Enter / Shift+Enter
 * in the bar and `FIND_STEP_SHORTCUTS` anywhere, reserved only while the active tab's bar is open (a
 * page keeps Mod+G otherwise). Esc in the bar closes it.
 */
export const FIND_SHORTCUT = 'Mod+F' as const;
export const FIND_STEP_SHORTCUTS = { next: 'Mod+G', previous: 'Mod+Shift+G' } as const;
/** The longest find text main takes (longer input is cut in the bar and refused by the procedure). */
export const FIND_TEXT_MAX_CHARS = 500;
/** The bar's count: `{active} of {matches}`; with text and no match, `FIND_NO_MATCHES`. */
export const FIND_COUNT_LABEL = '{active} of {matches}' as const;
export const FIND_NO_MATCHES = 'No results' as const;
export const FIND_PLACEHOLDER = 'Find in page' as const;

/** The bar's count text for a find state (`''` while there is no text). */
export function findCountLabel(state: { readonly text: string; readonly matches: number; readonly active: number }): string {
  if (state.text === '') return '';
  if (state.matches === 0) return FIND_NO_MATCHES;
  return FIND_COUNT_LABEL.replace('{active}', String(state.active)).replace('{matches}', String(state.matches));
}

// ---- Reopen closed tab ---------------------------------------------------------------------------

/**
 * Reopen closed tab: `Mod+Shift+T` (`RESERVED_TAB_SHORTCUTS['reopen-closed-tab']`), File › Reopen
 * Closed Tab and the palette. Main keeps a session-local stack (memory only, never stored) of the
 * last `CLOSED_TABS_MAX` closed tabs that showed a page; Clear Browsing Data and "Clear all history"
 * empty it. Each entry keeps the tab's URL, title, strip position, its own render profile and at most
 * `CLOSED_TAB_HISTORY_MAX` back / forward entries (URL and title only: no page state, so scroll
 * positions and form contents are not restored).
 */
export const CLOSED_TABS_MAX = 20;
export const CLOSED_TAB_HISTORY_MAX = 50;
export const REOPEN_TAB_SHORTCUT = 'Mod+Shift+T' as const;

// ---- History view --------------------------------------------------------------------------------

/**
 * The History view: History › Show All History, `Mod+Y` (an application-menu accelerator only, not
 * reserved: on Linux and Windows Ctrl+Y is redo in a page's text field, which keeps it) and the
 * palette. It is a sheet that fills the page column while open (the page area below it shrinks to
 * nothing, so the tab's view, drawn above the chrome's DOM, is laid out zero-high), and closes on
 * Esc, its close button, or opening a visit. Main asks the chrome to open it by bumping
 * `BrowserState.historyViewSeq`.
 */
export const HISTORY_SHORTCUT = 'Mod+Y' as const;
export const HISTORY_MENU_ID = 'show-history' as const;
export const HISTORY_MENU_LABEL = 'Show All History' as const;
/** Visits listed per page, newest first; "Show more" loads the next page (keyset, never an offset). */
export const HISTORY_PAGE_SIZE = 100;
/** The longest search text (title / URL substring, case-insensitive for ASCII). */
export const HISTORY_QUERY_MAX_CHARS = 200;
export const HISTORY_TITLE = 'History' as const;
export const HISTORY_EMPTY_MESSAGE = 'No history yet' as const;
export const HISTORY_NO_MATCHES = 'No visits match your search' as const;

/**
 * "Clear all history" asks first, in a native message box main shows, then clears the history part
 * of Clear Browsing Data: every stored and pending visit and the closed-tab stack. Site data,
 * permissions, pins, notes and the engine choice stay.
 */
export const CLEAR_HISTORY = {
  dialog: {
    type: 'warning',
    message: 'Clear all history?',
    detail: 'This removes every page in your history and the list of recently closed tabs. Site data, permissions and open tabs are kept.',
    buttons: ['Clear History', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

// ---- History retention, ranges, project filter (Phase 11 Task 10, Decision 13) -------------------

/**
 * How long visits are kept. `recent_visits` keeps **one row per URL** (its visit count and last visit
 * time), so a visit row is removed once its `last_visit_at` is older than the retention; earlier
 * visits to a URL are never kept apart. `forever` (the default: nothing is deleted by surprise) never
 * prunes. Stored in `app_settings` under `HISTORY_RETENTION_SETTING_KEY` (the id); a missing or
 * unknown value reads as `DEFAULT_HISTORY_RETENTION`. Main applies it at start and then once every
 * `HISTORY_RETENTION_INTERVAL_MS` while it runs, and at once when it is changed (a change that would
 * delete visits only after main's confirmation: `CONFIRM_HISTORY_RETENTION`).
 */
export const HISTORY_RETENTIONS = [
  { id: 'forever', label: 'Forever', days: null },
  { id: '90d', label: '90 days', days: 90 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '7d', label: '7 days', days: 7 },
] as const satisfies readonly { id: string; label: string; days: number | null }[];
export type HistoryRetention = (typeof HISTORY_RETENTIONS)[number]['id'];
export const HISTORY_RETENTION_IDS = HISTORY_RETENTIONS.map((entry) => entry.id) as [HistoryRetention, ...HistoryRetention[]];
export const DEFAULT_HISTORY_RETENTION: HistoryRetention = 'forever';
export const HISTORY_RETENTION_SETTING_KEY = 'history_retention' as const;
export const HISTORY_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Whether `value` names a `HISTORY_RETENTIONS` entry. */
export function isHistoryRetention(value: unknown): value is HistoryRetention {
  return typeof value === 'string' && (HISTORY_RETENTION_IDS as readonly string[]).includes(value);
}

/** The retention's cut-off for `now`: visits last seen before it are pruned (`null`: keep all). */
export function historyRetentionCutoff(retention: HistoryRetention, now: number): number | null {
  const days = HISTORY_RETENTIONS.find((entry) => entry.id === retention)?.days ?? null;
  return days === null ? null : now - days * 24 * 60 * 60 * 1_000;
}

/**
 * A retention change that would delete visits asks first, in main's own message box
 * (`CONFIRM_HISTORY_RETENTION`), before anything is stored or pruned: a shorter retention than the
 * stored one, or "Keep visits to project pages" turned off while the retention is not `forever`
 * (`historyRetentionDeletes`). A longer retention, or keeping project pages, stores at once.
 * `history.setRetention` answers one of `HISTORY_RETENTION_RESULTS`: `stored`, `cancelled` (the user
 * said no: nothing stored, the setting stays as it was) or `failed`.
 */
export const HISTORY_RETENTION_RESULTS = ['stored', 'cancelled', 'failed'] as const;
export type HistoryRetentionResult = (typeof HISTORY_RETENTION_RESULTS)[number];

/** Whether changing the settings from `stored` to `next` can delete visits (so main asks first). */
export function historyRetentionDeletes(stored: { readonly retention: HistoryRetention; readonly keepProjectPages: boolean }, next: { readonly retention: HistoryRetention; readonly keepProjectPages: boolean }): boolean {
  const days = (id: HistoryRetention) => HISTORY_RETENTIONS.find((entry) => entry.id === id)?.days ?? Number.POSITIVE_INFINITY;
  if (days(next.retention) < days(stored.retention)) return true;
  return stored.keepProjectPages && !next.keepProjectPages && next.retention !== 'forever';
}

/** The question (`{retention}`: the new retention's label, lower-cased). */
export const CONFIRM_HISTORY_RETENTION = {
  dialog: {
    type: 'warning',
    message: 'Keep history for {retention} only?',
    detail:
      'frost keeps one entry per page, with the time of its last visit. Pages last visited before then are removed now, with their earlier visits, and from now on once a day.',
    detailProjectPages: 'frost keeps one entry per page, with the time of its last visit. Pages in your projects last visited before then are removed now too, and from now on once a day.',
    buttons: ['Remove Older History', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/** `CONFIRM_HISTORY_RETENTION`'s message and detail for a change to `next` from `stored`. */
export function confirmHistoryRetentionText(stored: { readonly retention: HistoryRetention }, next: { readonly retention: HistoryRetention }): { message: string; detail: string } {
  const label = (HISTORY_RETENTIONS.find((entry) => entry.id === next.retention)?.label ?? '').toLowerCase();
  const shorter = historyRetentionDeletes({ retention: stored.retention, keepProjectPages: false }, { retention: next.retention, keepProjectPages: false });
  return { message: CONFIRM_HISTORY_RETENTION.dialog.message.replace('{retention}', label), detail: shorter ? CONFIRM_HISTORY_RETENTION.dialog.detail : CONFIRM_HISTORY_RETENTION.dialog.detailProjectPages };
}

/**
 * "Keep visits to project pages" (on by default): pruning skips a visit whose URL, without its
 * fragment, is a live page of a live project (`ci_project_pages`, same database file). Stored in
 * `app_settings` under `HISTORY_KEEP_PROJECT_PAGES_KEY` as `'1'` / `'0'`; anything else reads as the
 * default. Clearing a range or all history ignores it (the user asked for those visits to go).
 */
export const HISTORY_KEEP_PROJECT_PAGES_KEY = 'history_keep_project_pages' as const;
export const DEFAULT_HISTORY_KEEP_PROJECT_PAGES = true;

/**
 * Clear by range: every visit row whose `last_visit_at` is within the last `ms` (one row per URL, so
 * a URL visited in the range loses its earlier visits too), stored and pending, and the closed-tab
 * stack. Main asks first in its own message box (`CLEAR_HISTORY_RANGE`). "Last day" is the last 24
 * hours, "last month" the last 30 days.
 */
export const HISTORY_CLEAR_RANGES = [
  { id: 'hour', label: 'Last hour', ms: 60 * 60 * 1_000 },
  { id: 'day', label: 'Last day', ms: 24 * 60 * 60 * 1_000 },
  { id: 'week', label: 'Last week', ms: 7 * 24 * 60 * 60 * 1_000 },
  { id: 'month', label: 'Last month', ms: 30 * 24 * 60 * 60 * 1_000 },
] as const satisfies readonly { id: string; label: string; ms: number }[];
export type HistoryClearRange = (typeof HISTORY_CLEAR_RANGES)[number]['id'];
export const HISTORY_CLEAR_RANGE_IDS = HISTORY_CLEAR_RANGES.map((entry) => entry.id) as [HistoryClearRange, ...HistoryClearRange[]];

/** The earliest `last_visit_at` a range clears at `now`. */
export function historyClearSince(range: HistoryClearRange, now: number): number {
  return now - (HISTORY_CLEAR_RANGES.find((entry) => entry.id === range)?.ms ?? 0);
}

/** The range question (`{range}`: the range's label, lower-cased). It states that history keeps one row per URL. */
export const CLEAR_HISTORY_RANGE = {
  dialog: {
    type: 'warning',
    message: 'Clear history from the {range}?',
    detail:
      'frost keeps one entry per page, with the time of its last visit. This removes every page last visited in this time, with its earlier visits too, and the list of recently closed tabs. Site data, permissions and open tabs are kept.',
    buttons: ['Clear History', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/** `CLEAR_HISTORY_RANGE.dialog.message` for `range`. */
export function clearHistoryRangeMessage(range: HistoryClearRange): string {
  const label = HISTORY_CLEAR_RANGES.find((entry) => entry.id === range)?.label ?? '';
  return CLEAR_HISTORY_RANGE.dialog.message.replace('{range}', label.toLowerCase());
}

/**
 * The History view's project filter: every visit, or only visits whose URL (without its fragment) is
 * a live page of that live project (Unfiled included: it can hold pages) (`history.list`'s `projectId`). Each listed visit carries
 * `changeCount`: how many times frost recorded the page changing, summed over its capture lanes
 * (`ci_versions` stored at that URL, less one per lane); `0` when never captured or never changed.
 */
export const HISTORY_ALL_PAGES_LABEL = 'All pages' as const;
export const HISTORY_PROJECT_FILTER_LABEL = 'Show pages from' as const;
export const HISTORY_CLEAR_RANGE_LABEL = 'Clear history from' as const;

/** A visit's change count as the row shows it (`null` for none). */
export function historyChangeLabel(count: number | undefined): string | null {
  if (count === undefined || count <= 0) return null;
  return count === 1 ? '1 change' : `${count.toLocaleString('en-US')} changes`;
}

/** The Settings view's History section (`SETTINGS_SECTIONS`: `history`). */
export const HISTORY_SETTINGS_TEXT = {
  intro: 'History stays on this device. frost keeps one entry per page, with the time of its last visit.',
  retentionLabel: 'Keep history for',
  keepProjectPages: 'Keep visits to project pages',
  keepProjectPagesHint: 'Pages in your projects stay in history whatever the setting above.',
  loading: 'Loading…',
  failed: 'Couldn’t save the setting. Try again.',
  cancelled: 'Nothing changed: your history is kept as before.',
  readFailed: 'Couldn’t read the history settings.',
  retry: 'Try again',
} as const;

// ---- New-tab page --------------------------------------------------------------------------------

/**
 * "Jump back in" on an empty tab's start view: up to `JUMP_BACK_IN_MOST_VISITED` most-visited pages,
 * then up to `JUMP_BACK_IN_RECENT` other recent ones, from `recent_visits` only (local, no remote
 * content, no favicons: each tile shows a frost-drawn monogram of its host). A tile opens its page in
 * the tab.
 */
export const JUMP_BACK_IN_TITLE = 'Jump back in' as const;
export const JUMP_BACK_IN_MOST_VISITED = 4;
export const JUMP_BACK_IN_RECENT = 4;

// ---- Menu ----------------------------------------------------------------------------------------

/** Application-menu items this task adds (`menu.ts`). */
export const POLISH_MENU_IDS = {
  find: 'find-in-page',
  findNext: 'find-next',
  findPrevious: 'find-previous',
  reopen: 'reopen-closed-tab',
  history: HISTORY_MENU_ID,
} as const;
