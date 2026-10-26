# Feature: tabs

Spec: `specs/tabs.spec.ts` (`MAX_TABS`, `NEW_TAB_LABEL`, `NOTICE_MESSAGES`, `NOTICE_DISPLAY_MS`,
`TAB_SHORTCUT_COUNT`; Zod-free so the chrome can import it) and `specs/browser.spec.ts`
(`TabIdInputSchema`, `BrowserStateSchema.focusAddressBarSeq` / `.notice`, `NoticeSchema`).
Builds on `browser-chrome.feature.md` (one tab, its view, the controller).
Phase 1 Task 2. Each scenario maps to one named test.

## Behaviour
- The **tab strip** is a row above the toolbar: one tab per open tab, in order, then a "+" (new
  tab) button. Each tab shows a glyph or the loading indicator, its label and a × (close) button.
- **Labels:** `tabLabel(tab)` (`renderer/tab-label.ts`): the page title, else the URL's host,
  else `NEW_TAB_LABEL`. Long labels are truncated by CSS (ellipsis); the full label is the tab's
  tooltip (`title`).
  **No favicons:** the chrome never fetches page-supplied images (a favicon is attacker-chosen
  content rendered in the trusted chrome); a frost-drawn glyph stands in for it.
- **New tab** ("+", Cmd/Ctrl+T): appends an empty tab at the end of the strip, activates it and
  focuses the address bar.
- **Close tab** (the tab's ×, Cmd/Ctrl+W for the active tab): the tab's view is detached from the
  window and its WebContents closed (`webContents.close()`), so nothing leaks. Closing the active
  tab activates its right neighbour, else its left one; closing another tab keeps the active one.
- **Last tab:** closing the only tab leaves one fresh empty tab (a new id); the window stays open.
- **Switching** (click a tab, Cmd/Ctrl+1…8 = that tab, Cmd/Ctrl+9 = the last tab): exactly one
  view is shown — only the active tab's view is attached to the window's `contentView` (an empty
  tab has none). Every tab keeps its own URL, title, back/forward history and loading state.
  Switching to a page focuses the page; switching to an empty tab focuses the address bar.
- **Cmd/Ctrl+L** focuses (and selects) the address bar.
- Main focuses chrome inputs only through state: `focusAddressBarSeq` increases by one per focus
  request and the chrome focuses the address bar when the value it last saw changes. There is no
  push channel.
- **Keyboard shortcuts** are application-menu accelerators handled in main (a focused page view
  would swallow renderer key handlers). The menu keeps the standard Edit roles (undo, redo, cut,
  copy, paste, select all) so the address bar's clipboard works on macOS, and nothing else claims
  Cmd/Ctrl+W.
- **`MAX_TABS`:** with `MAX_TABS` tabs open a new-tab request is refused (no tab opens) and raises
  the `tab-limit` notice; the status bar shows `NOTICE_MESSAGES['tab-limit']` for
  `NOTICE_DISPLAY_MS`.
- **Closed tabs stay closed:** late or pending events from a closed tab's WebContents never change
  any tab's state (nor bump the version).
- **Malformed input:** `browser.closeTab` / `browser.activateTab` take `{ tabId }` validated by
  `TabIdInputSchema`; a malformed id is rejected `BAD_REQUEST`, an id naming no open tab is a no-op
  answering `false`. Nothing crashes.
- `browser.navigate`, `back`, `forward`, `reload`, `stop` keep acting on the **active** tab.

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`, "tabs")
- **Scenario: new-tab-opens-empty-tab-at-end** — `newTab()` appends an empty tab, makes it active
  and answers its id; no view is created for it and the previous tab's view is detached.
- **Scenario: new-tab-focuses-address-bar** — `newTab()` focuses the chrome's WebContents and
  increases `focusAddressBarSeq` by one.
- **Scenario: close-tab-closes-its-contents** — `closeTab(id)` removes the tab, detaches its view
  (`removeChildView`) and calls its `webContents.close()` exactly once.
- **Scenario: close-activates-right-neighbour-else-left** — closing the active middle tab
  activates the one to its right; closing the active rightmost tab activates the one to its left;
  the newly active tab's view is attached.
- **Scenario: close-inactive-tab-keeps-active** — closing a tab that is not active keeps
  `activeTabId` and the attached view.
- **Scenario: close-last-tab-leaves-fresh-empty-tab** — closing the only tab leaves exactly one
  empty tab with a new id, active, and requests address-bar focus; no view is attached.
- **Scenario: only-active-view-is-attached** — across new tab / navigate / activate / close, the
  window's `contentView` holds exactly the active tab's view (none for an empty tab).
- **Scenario: tabs-keep-their-own-state** — each tab's URL, title, history flags and loading state
  follow only its own WebContents; navigate/back/forward/reload/stop act on the active tab only.
- **Scenario: tab-shortcuts-select-by-position** — `activateTabAt(i)` activates the i-th tab (an
  index past the end is a no-op answering `false`); `activateLastTab()` the last one;
  `closeActiveTab()` closes the active tab.
- **Scenario: activate-focuses-page-or-address-bar** — activating a tab with a page focuses that
  page's WebContents; activating an empty tab requests address-bar focus.
- **Scenario: focus-address-bar-request** — `focusAddressBar()` focuses the chrome's WebContents
  and increases `focusAddressBarSeq` (bumping the version).
- **Scenario: max-tabs-enforced** — with `MAX_TABS` tabs, `newTab()` answers `null`, opens nothing
  and sets `notice` to `{ kind: 'tab-limit' }` with a new `seq` (each refusal a new `seq`); after a
  close, `newTab()` works again. The state always parses with `BrowserStateSchema`.
- **Scenario: closed-tab-events-are-ignored** — after `closeTab`, navigation / title / loading /
  crash / `destroyed` events from the closed tab's WebContents change no tab's state and do not
  bump the version.
- **Scenario: untitled-page-has-empty-title** (`page-title.test.ts`) — for a page without a
  <title>, Chromium's `getTitle()` is a display form of the URL (no scheme, no `www.`, no bare
  root `/`, unescaped, Unicode host); `pageTitle` reports it as `''`, so the strip shows the host.
  Real titles are kept.
- **Scenario: unknown-tab-id-is-a-no-op** — `closeTab` / `activateTab` with an id that names no
  open tab (never used, or already closed) answer `false` and change nothing.

## Router (`packages/ipc-contract/src/__tests__/browser-router.test.ts`)
- **Scenario: tab-procedures-validate-tab-id** — `browser.closeTab` / `browser.activateTab` reject
  a missing, zero, negative, fractional, string, unsafe-integer id or an extra key with
  `BAD_REQUEST`; the service is never called. (They are also covered by
  `browser-procedures-reject-foreign-sender-first`.)
- **Scenario: tab-procedures-call-service** — `browser.newTab` answers the new tab's id (or `null`
  at the limit), `browser.closeTab` / `browser.activateTab` call the service with the id and
  answer its boolean.

## Menu (`apps/desktop/src/main/__tests__/menu.test.ts`)
- **Scenario: menu-accelerators-call-controller** — New Tab `CmdOrCtrl+T` → `newTab()`, Close Tab
  `CmdOrCtrl+W` → `closeActiveTab()`, Open Location `CmdOrCtrl+L` → `focusAddressBar()`,
  `CmdOrCtrl+1`…`8` → `activateTabAt(0…7)`, `CmdOrCtrl+9` → `activateLastTab()`.
- **Scenario: menu-keeps-edit-roles** — an Edit menu with the undo, redo, cut, copy, paste and
  selectAll roles, on every platform.
- **Scenario: menu-accelerators-are-unique** — no two items share an accelerator; no default role
  menu (`fileMenu`, `windowMenu` …, which bring their own) is used and a window-close item never
  takes Cmd/Ctrl+W; nothing reloads or opens DevTools on the chrome page.
- **Scenario: install-app-menu-sets-application-menu** — `installAppMenu` builds the template and
  sets it as the application menu.

## Renderer (`apps/desktop/src/renderer/__tests__/`)
- **Scenario: tab-label-falls-back** — `tabLabel`: title (trimmed), else host, else
  `NEW_TAB_LABEL`.
- **Scenario: address-field-resets-on-tab-switch** — switching tabs drops the draft and the
  submitted text, so the field shows the new tab's URL.

## End to end (`apps/desktop/e2e/tabs.e2e.ts`, real Electron, loopback pages)
- **Scenario: new-tab-button-opens-empty-tab** — "+" adds a tab at the end labelled `New Tab`,
  active, with the start view shown, the address bar focused and empty, and no view attached.
- **Scenario: tabs-keep-own-url-and-history** — two tabs loaded with different pages and
  histories: switching shows each tab's own URL in the address bar and its own back/forward
  state; going back in one does not change the other.
- **Scenario: switching-shows-exactly-one-view** — after every switch exactly one view is attached
  and it is the active tab's WebContents.
- **Scenario: tab-labels-and-tooltip** — a titled page's tab shows its title, an untitled page's
  its host, an empty tab `New Tab`; the tooltip is the full label; a loading tab shows the
  loading indicator.
- **Scenario: close-tab-releases-webcontents** — closing a tab with ×: its WebContents is gone from
  `webContents.getAllWebContents()`, the right (else left) neighbour is active.
- **Scenario: close-last-tab-leaves-empty-tab** — closing the only tab leaves one `New Tab`, the
  window stays open.
- **Scenario: keyboard-shortcuts-drive-tabs** — with a page view focused, the application menu's
  items (clicked in main via `Menu.getApplicationMenu()`, which is what their accelerators do)
  open, switch (1, 2, 8 past the end = no-op, 9 = last) and close tabs and focus the address bar.
  Synthetic key events (Playwright, `sendInputEvent`) do not reach native menu accelerators, so a
  real key press is checked by hand, not here.
- **Scenario: max-tabs-shows-notice** — at `MAX_TABS` tabs one more new tab is refused and the
  status bar shows the `tab-limit` message.
