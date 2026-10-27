# Feature: tabs

Spec: `specs/tabs.spec.ts` (`MAX_TABS`, `NEW_TAB_LABEL`, `NOTICE_MESSAGES`, `NOTICE_DISPLAY_MS`,
`TAB_SHORTCUT_COUNT`, `RESERVED_TAB_SHORTCUTS`; Zod-free so the chrome can import it) and `specs/browser.spec.ts`
(`TabIdInputSchema`, `BrowserStateSchema.focusAddressBarSeq` / `.notice`, `NoticeSchema`).
Builds on `browser-chrome.feature.md` (one tab, its view, the controller).
Phase 1 Task 2. Each scenario maps to one named test.

## Behaviour
- The **tab strip** is a row above the toolbar: one tab per open tab, in order, then a "+" (new
  tab) button. Each tab shows a glyph or the loading indicator, its label and a × (close) button.
- **Accessible structure:** a `tablist` of `tab` elements (roving tabindex: only the active tab is
  in the Tab order). Each tab's × is a sibling of the `tab` element, never inside it (a `tab`'s
  children are presentational), and is a mouse affordance only (`aria-hidden`, never focused); the
  keyboard closes a tab with Delete on the focused tab or Cmd/Ctrl+W. In the tablist,
  Left/Right move focus to the previous/next tab (wrapping), Home/End to the first/last; Enter or
  Space activates the focused tab.
- **Middle-click** on a tab closes it.
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
- **A page closing itself** (`window.close()`, its WebContents destroyed) closes its tab by the same
  rules: a background tab disappears and the active tab stays; the only tab is replaced by a fresh
  empty one.
- **Switching** (click a tab, Cmd/Ctrl+1…8 = that tab, Cmd/Ctrl+9 = the last tab, Ctrl+Tab /
  Ctrl+Shift+Tab = next/previous tab, wrapping, also Cmd+Shift+] / Cmd+Shift+[ on macOS): exactly one
  view is shown — only the active tab's view is attached to the window's `contentView` (an empty
  tab has none). Every tab keeps its own URL, title, back/forward history and loading state.
  Switching to a page focuses the page; switching to an empty tab focuses the address bar.
- **Cmd/Ctrl+L** focuses (and selects) the address bar.
- Main focuses chrome inputs only through state: `focusAddressBarSeq` increases by one per focus
  request and the chrome focuses the address bar when the value it last saw changes. There is no
  push channel.
- **Keyboard shortcuts** (`RESERVED_TAB_SHORTCUTS`) are handled in main, never by renderer key
  hooks: application-menu accelerators, plus a `before-input-event` handler on every tab's
  WebContents and on the chrome's, which takes a reserved shortcut before the page sees it (a page
  that `preventDefault`s every keydown cannot block it), runs the command once and consumes the key
  (`preventDefault`, which also suppresses the menu accelerator, so one press never runs twice).
  Other keys pass through untouched. Page commands (reload, back / forward, zoom, stop) are
  reserved the same way (`page-commands.feature.md`). The menu keeps the standard Edit roles (undo, redo, cut,
  copy, paste, select all) so the address bar's clipboard works on macOS, and nothing else claims
  Cmd/Ctrl+W. Close Window is Cmd/Ctrl+Shift+W; Quit is Cmd+Q on macOS and Ctrl+Shift+Q elsewhere.
  On Linux/Windows the menu bar auto-hides (Alt reveals it).
- **No window** (macOS, after the last window closed): tab commands do not touch hidden tabs. New
  Tab opens the window (which starts with one empty tab); the other tab commands are no-ops.
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
  crash / `destroyed` / input events from the closed tab's WebContents change no tab's state and do
  not bump the version; none of the controller's listeners (`did-start-loading`, `did-navigate`,
  `did-navigate-in-page`, `did-fail-load`, `page-title-updated`, `did-stop-loading`,
  `render-process-gone`, `destroyed`, `before-input-event`) remain on it.
- **Scenario: background-page-close-closes-its-tab** — a background tab whose WebContents is
  destroyed (the page called `window.close()`) is removed; the active tab and its attached view
  stay.
- **Scenario: next-previous-tab-wraps** — `activateNextTab()` / `activatePreviousTab()` move to the
  neighbour, wrapping at the ends; with one tab they change nothing.
- **Scenario: page-cannot-block-tab-shortcuts-unit** — a reserved shortcut arriving as
  `before-input-event` on a tab's WebContents or the chrome's runs its command once and is
  `preventDefault`ed (its key-up is consumed too, without running again); other keys are not
  touched; a closed tab's WebContents no longer triggers anything.
- **Scenario: no-window-tab-commands** — after the window closed, `newTab()` asks the app to open
  a window (the injected `openWindow`) instead of adding a hidden tab, and answers the new window's
  empty tab; `closeTab` / `activateTab` / `closeActiveTab` / `activateTabAt` / `activateLastTab` /
  next / previous / `focusAddressBar` change nothing.

## Shortcut matching (`apps/desktop/src/main/browser/__tests__/shortcuts.test.ts`)
- **Scenario: shortcut-matcher-follows-spec** — `matchTabShortcut(input, platform)` maps every
  `RESERVED_TAB_SHORTCUTS` entry to its command on macOS (Mod = Meta) and Linux/Windows (Mod =
  Control), and nothing else: other keys, extra modifiers (Alt, the other platform's Mod, Shift on
  Mod+T), and `mac:` entries off macOS answer `null`.
- **Scenario: reserved-shortcuts-never-collide** — on macOS, Linux and Windows each reserved chrome
  shortcut (Mod+K, Mod+F, Mod+Shift+T, Mod+L, Mod+T, Mod+Shift+S, Mod+Shift+D, Mod+G and
  Mod+Shift+G with the find bar open, Mod+R, Mod+Shift+R) is taken by exactly one matcher (tab, page,
  sidebar, devtools or find step), so none runs twice or shadows another.
- **Scenario: untitled-page-has-empty-title** (`page-title.test.ts`) — for a page without a
  <title>, Chromium's `getTitle()` is a display form of the URL (no scheme, no `www.`, no bare
  root `/`, unescaped, Unicode host); `pageTitle` reports it as `''`, so the strip shows the host.
  Real titles are kept.
- **Scenario: unknown-tab-id-is-a-no-op** — `closeTab` / `activateTab` with an id that names no
  open tab (never used, or already closed) answer `false` and change nothing.
- **Scenario: document-seq-counts-new-documents** — a tab's `documentSeq` is `0` before its first
  commit and goes up by one with each main-frame `did-navigate` (another URL, or a reload of the same
  one), bumping the state version; an in-page navigation and another tab's commits leave it as it is.

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
  `CmdOrCtrl+1`…`8` → `activateTabAt(0…7)`, `CmdOrCtrl+9` → `activateLastTab()`, Next / Previous
  Tab `Ctrl+Tab` / `Ctrl+Shift+Tab` → `activateNextTab()` / `activatePreviousTab()` (on macOS
  also `Cmd+Shift+]` / `Cmd+Shift+[`, the Ctrl+Tab items hidden but working).
- **Scenario: menu-window-and-quit-items** — Close Window is the `close` role on
  `CmdOrCtrl+Shift+W` on every platform; Quit is the `quit` role, on `Ctrl+Shift+Q` on
  Linux/Windows; on macOS it is the app menu's `quit` role with its own Cmd+Q (the app menu is
  written out, About · Clear Browsing Data… · Services · Hide · Hide Others · Show All · Quit, to
  hold Clear Browsing Data…, `browser-session-db.feature.md`).
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
- **Scenario: notice-shows-then-clears** (`notice.test.ts`, fake timers) — the notice tracker
  ignores the notice present when it starts (history), shows a notice with a new `seq` and clears
  it after exactly `NOTICE_DISPLAY_MS`; a newer notice restarts the timer.
- **Scenario: tablist-keys-move-focus** (`tablist-keys.test.ts`) — Left/Right move to the
  previous/next index (wrapping), Home/End to the first/last; other keys answer `null`.

## Window (`apps/desktop/src/main/__tests__/boot.test.ts`)
- **Scenario: menu-bar-auto-hides-off-macos** — `createMainWindow()` sets `autoHideMenuBar: true`
  on Linux/Windows and `false` on macOS; the webPreferences are unchanged.

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
  open, switch (1, 2, 8 past the end = no-op, 9 = last, next/previous) and close tabs and focus the
  address bar.
- **Scenario: page-cannot-block-tab-shortcuts** — a page that `preventDefault`s every keydown (in
  the capture phase) has focus; real key input sent to its WebContents (`sendInputEvent`, which
  passes through `before-input-event`) still runs Mod+T (exactly one new tab), Ctrl+Tab and Mod+W;
  the same keys sent to the chrome's WebContents work too; an ordinary key still reaches the page.
- **Scenario: middle-click-closes-tab** — a middle click on an inactive tab closes it (its
  WebContents released); the active tab stays.
- **Scenario: tablist-keyboard-navigation** — with a tab focused, ArrowRight / ArrowLeft / End /
  Home move focus between tabs (only the active tab is in the Tab order), Enter activates the
  focused tab and Delete closes it; no `button` is inside any `role="tab"` element.
- **Scenario: background-page-close-closes-tab-e2e** — a background tab whose page calls
  `window.close()` disappears from the strip; the active tab and its view stay.
- **Scenario: max-tabs-shows-notice** — at `MAX_TABS` tabs one more new tab is refused and the
  status bar shows the `tab-limit` message.
