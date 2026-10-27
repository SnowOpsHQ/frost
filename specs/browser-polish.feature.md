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
  notice that it was scrolled to a match. The text is capped (`FIND_TEXT_MAX_CHARS`).
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
  (`closed-tab-stack-caps-and-clears`, `reopen-respects-tab-limit`)
- Limits: page state (scroll position, form contents) is not restored; a tab closed by its own
  `window.close()` reopens at its URL only (its history is already gone). (`reopen-after-page-close`)

## History view
- History › Show All History, `Mod+Y` (a menu accelerator only: Ctrl+Y is redo in text fields on
  Linux / Windows, so it is not reserved) and the palette ask the chrome to open it
  (`historyViewSeq`). (`history-menu-and-palette`)
- It is a sheet filling the page column; the page area below shrinks to nothing (zero-high view),
  so nothing is drawn over the tab's view. Esc, Close, opening a visit here, showing another tab or a
  new document committing in this one closes it. (e2e `history-lists-searches-deletes-clears`)
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

## New-tab page
- An empty tab's start view shows "Jump back in": up to `JUMP_BACK_IN_MOST_VISITED` most-visited
  pages, then up to `JUMP_BACK_IN_RECENT` other recent ones, from `recent_visits` only. Each tile is
  a frost-drawn monogram of the host, the title and the host (no favicon, nothing remote) and opens
  its page in the tab. (`jump-back-in-dedupes`, e2e `new-tab-page-jump-back-in`)

## Search engines
- `SEARCH_ENGINES` is a typed table of `https:` templates; `{q}` is only ever the encoded query.
  Google is the default; Bing and DuckDuckGo can be chosen. (`engine-table-is-https-only`,
  `engine-url-encodes-query`)
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
  `reopenClosedTab` / `show` and `settings.setSearchEngine` / `searchEngine` start with
  `enforceSender`, validate their input strictly and fail closed without their service.
  (`polish-router-guards-and-validates`)
