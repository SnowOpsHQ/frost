# Feature: browser polish (find, reopen tab, history, new-tab page, search engines)

Spec: `specs/browser-polish.spec.ts` (Zod-free: the engine table, find, closed tabs, History, "Jump
back in", menu ids) and `specs/browser-polish.schema.ts` (`FindStateSchema`, the `BrowserState`
fields, the `find.*` / `history.*` / `settings.*` inputs). Shortcuts: `RESERVED_TAB_SHORTCUTS` in
`specs/tabs.spec.ts`. Phase 2.5 Task 6. Each line maps to one named test.

## Find in page
- `Mod+F` is reserved (`find-in-page`): taken from every tab's and the chrome's `before-input-event`
  and consumed, so a page that swallows keys can neither see nor block it. It opens the active tab's
  find bar, or focuses it again (`focusSeq`), and moves keyboard focus to the chrome. A tab with no
  page (empty, error or crash panel) gets no bar. (`find-shortcut-opens-bar`, e2e
  `find-shortcuts-beat-a-greedy-page`)
- The bar is a chrome row above the workspace (the tab's view is laid out below it). It
  runs `webContents.findInPage` in main: a new session for each new text or case switch, a follow-up
  for next / previous; `''` stops the find. The count is the latest `found-in-page` answer's
  (`findCountLabel`: `n of m`, or `No results`). (`find-search-runs-find-in-page`,
  `find-results-follow-latest-request`, `find-count-label`)
- Next / previous: Enter / Shift+Enter in the bar, and `Mod+G` / `Mod+Shift+G`, reserved only while
  the active tab's bar is open. Esc in the bar (or its close button) closes it with
  `stopFindInPage('clearSelection')` and gives focus back to the page. (`find-step-shortcut-only-while-open`,
  `find-close-clears-selection`, e2e `find-counts-steps-and-clears`)
- Per tab: each tab keeps its own bar (text, case, counts); switching back shows it again. A new
  main-frame document in the tab closes its bar; an in-page (SPA) navigation does not.
  (`find-is-per-tab`, `find-closes-on-navigation`)
- The find text stays in the chrome and main: it is never written into the page, and the page's
  scripts get no event carrying it (Chromium's find runs below the page's script world). A page may
  still learn *where* a match is, never the text: it may notice that it was scrolled to a match, and
  Chromium fires `beforematch` on a `hidden=until-found` element whose content matched (revealing
  it), so a page can tell which element matched. The text is capped (`FIND_TEXT_MAX_CHARS`).
  (`find-input-is-validated`)

## Reopen closed tab
- `Mod+Shift+T` is reserved (`reopen-closed-tab`); File › Reopen Closed Tab and the palette run the
  same command. It reopens the most recently closed tab at its old strip position (clamped), active,
  with its URL and title, its back / forward entries restored with Electron's
  `navigationHistory.restore` (URL and title only, at most `CLOSED_TAB_HISTORY_MAX` around the
  current one; non-`http(s)` entries are dropped), and its own render profile, in effect before the
  first request. (`reopen-restores-url-history-and-profile`)
- The stack is session-local (memory only), holds tabs that showed a page (an empty tab is not
  kept), at most `CLOSED_TABS_MAX` (the oldest drops), and is emptied by Clear Browsing Data and
  "Clear all history". Closing the window does not fill it (the saved session covers that). At
  `MAX_TABS` nothing reopens, the `tab-limit` notice is raised and the entry stays.
  (`closed-tab-stack-caps-and-clears`, `clear-browsing-data-forgets-closed-tabs`,
  `reopen-respects-tab-limit`)
- Limits: page state (scroll position, form contents) is not restored; a tab closed by its own
  `window.close()` reopens at its URL only (its history is already gone). (`reopen-after-page-close`)

## History view
- History › Show All History, `Mod+Y` (a menu accelerator only: Ctrl+Y is redo in text fields on
  Linux / Windows, so it is not reserved) and the palette ask the chrome to open it
  (`historyViewSeq`). (`history-menu-and-palette`)
- It is a sheet filling the page column; the page area below shrinks to nothing (zero-high view),
  so nothing is drawn over the tab's view. Esc, Close, opening a visit here, showing another tab or a
  new document committing in this one closes it, unless the request to open it arrives with that
  change (the request came after it). (e2e `history-lists-searches-deletes-clears`,
  `history-sheet-opens-with-a-new-document`)
- It lists `recent_visits` newest first, grouped by local day, `HISTORY_PAGE_SIZE` per page with
  "Show more" (keyset pagination: `(last_visit_at, url)` after the last row). The search box filters
  by title or URL substring (case-insensitive for ASCII, `%` / `_` literal). Main flushes pending
  visit writes before it reads. Rows read back are checked (a tampered row is skipped).
  (`history-list-newest-first-paginates`, `history-search-escapes-like`, `history-skips-tampered-rows`)
- Rows render inert: React text, bidi-isolated, no links, no favicons. A row opens its page in the
  current tab (click / Enter) or a new background tab (its "New tab" button, or Mod/middle click).
  (e2e `history-lists-searches-deletes-clears`)
- "Delete" removes one URL's visit (stored and pending). "Clear all history" asks in main
  (`CLEAR_HISTORY`), then clears the history part of Clear Browsing Data: every visit, stored and
  pending, and the closed-tab stack. (`history-delete-drops-pending`, `history-clear-all-confirms`)

## History retention, ranges and projects (Phase 11 Task 10, Decision 13)
Spec: `HISTORY_RETENTIONS`, `DEFAULT_HISTORY_RETENTION`, `HISTORY_RETENTION_SETTING_KEY`,
`HISTORY_KEEP_PROJECT_PAGES_KEY`, `HISTORY_CLEAR_RANGES`, `CLEAR_HISTORY_RANGE`,
`HistoryRetentionSettingsSchema`, `HistoryClearRangeInputSchema`, `history.list`'s `projectId` and each
visit's `changeCount`. No migration: `app_settings` holds the two settings; project pages and versions
are read from `ci_project_pages` / `ci_versions` in the same database file.
- **Scenario: prune-keeps-project-pages** (`packages/db/src/__tests__/history.test.ts`) — pruning
  before a cut-off removes older visit rows only; with "Keep visits to project pages" a visit to a
  live page of a live project (fragment ignored) stays, one of a deleted page or project goes.
- **Scenario: clear-range-on-last-visit** — clearing since a time removes the rows whose
  `last_visit_at` is at or after it (one row per URL: its earlier visits go with it), nothing older.
- **Scenario: project-filter** — `projectId` lists only visits to that project's live pages (Unfiled
  included; fragment ignored), keeping the newest-first keyset; an unknown project lists nothing.
- **Scenario: change-count-from-versions** — each listed visit's `changeCount` is its page's versions
  less one per capture lane (`0` when never captured); the settings read back as stored, tampered
  values as their defaults.
- **Scenario: retention-applied-at-start-and-daily** (`main/browser/__tests__/browser-polish.test.ts`)
  — main prunes at start with the stored retention and keep-project-pages choice, then once a day
  (injected scheduler, no real time), and at once when the retention changes; `forever` never prunes.
- **Scenario: set-retention-shorter-confirms-in-main** (`main/browser/__tests__/browser-polish.test.ts`)
  — a change that would delete visits (a shorter retention than stored, or keep-project-pages turned
  off while the retention is not `forever`) asks in main's own message box (`CONFIRM_HISTORY_RETENTION`)
  before anything is stored or pruned, so a chrome that skips its own UI cannot delete history; a
  longer retention or turning keep-project-pages on stores at once without asking. Answers `stored`.
- **Scenario: set-retention-cancel-keeps-setting** — Cancel stores nothing and prunes nothing; the
  answer is `cancelled` and the Settings section shows the stored setting again with a note.
- **Scenario: clear-range-confirms-in-main** — `history.clearRange` asks in main's own message box
  (`CLEAR_HISTORY_RANGE`, naming the range); Cancel clears nothing; confirmed, pending visits are
  written first, then the range is cleared and, only once that succeeds, the closed-tab stack
  forgotten (a failed clear answers `false` and keeps the stack; council round 1,
  `clear-range-failure-keeps-closed-tabs`). Two requests for the same range at once ask once; a
  request for another range while one runs answers `false` (council round 1,
  `clear-range-other-range-while-clearing-refused`).
- **Scenario: history view project filter and change counts** (`renderer/__tests__/use-history-view.test.ts`)
  — the view lists with the chosen project and shows a row's change count.
- **Scenario: settings-history** (`renderer/__tests__/settings-history.test.ts`) — the Settings view's
  History section shows main's retention and keep-project-pages choice and sends a change; the
  checked choice is main's answer (a cancelled change reverts, with a note); a failed first read
  shows an error with "Try again", never "Loading…" for ever.
- **Scenario: history-project-filter-and-clear-hour** (e2e `browser-polish.e2e.ts`) — with a project
  holding one visited page, the project filter lists only it; "Last hour" asks in main, Cancel keeps
  the rows, Clear removes them.

## New-tab page
- An empty tab's start view shows "Jump back in": up to `JUMP_BACK_IN_MOST_VISITED` most-visited
  pages, then up to `JUMP_BACK_IN_RECENT` other recent ones, from `recent_visits` only. Each tile is
  a frost-drawn monogram of the host, the title and the host (no favicon, nothing remote) and opens
  its page in the tab. (`jump-back-in-dedupes`, e2e `new-tab-page-jump-back-in`)

## Search engines
- `SEARCH_ENGINES` is a typed table of `https:` templates; `{q}` is only ever the encoded query.
  Google is the default; Bing and DuckDuckGo can be chosen. A lone surrogate in the query (typed, or
  a page selection in the context menu) becomes U+FFFD first (`wellFormed`), so encoding never throws.
  (`engine-table-is-https-only`, `engine-url-encodes-query`, `search-url-tolerates-lone-surrogates`)
- The choice is made in the command palette ("Search with …", one action per other engine) and
  stored in `app_settings` (migration `0005_app_settings`); an unknown stored value reads as the
  default. It persists across launches and is a preference (Clear Browsing Data keeps it).
  (`settings-store-search-engine`, e2e `search-engine-persists-across-relaunch`)
- Address-bar prefixes: `g `, `b `, `d ` (lowercase, then whitespace) followed by a non-empty query
  search that engine, whatever the query looks like (`d example.com` is a search). Everything else is
  resolved as before with the chosen engine; non-web input (`javascript:`, `file:`, `data:` …) is
  still a search, never a navigation, with or without a prefix. (`prefix-picks-engine`,
  `prefix-never-navigates`, e2e `d-prefix-searches-duckduckgo`)
- The page context menu's search item names and uses the chosen engine. (`context-menu-uses-engine`)

## Palette
- Registered with `registerPaletteActions` (`browser-polish-palette.ts`): "Find in page" (a tab
  showing a page), "Reopen closed tab" (when the stack is not empty), "Show history" and one
  "Search with <engine>" per engine not in use. (`polish-palette-availability`)

## Router
- `find.search` / `step` / `close`, `history.list` / `jumpBackIn` / `remove` / `clearAll` /
  `reopenClosedTab` / `show` / `retention` / `setRetention` / `clearRange` (Phase 11) and `settings.setSearchEngine` / `searchEngine` start with
  `enforceSender`, validate their input strictly and fail closed without their service.
  (`polish-router-guards-and-validates`)
