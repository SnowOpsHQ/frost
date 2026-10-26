# Feature: browser chrome and a hardened page view

Spec: `specs/browser.spec.ts` (`BROWSE_PARTITION`, `BROWSABLE_SCHEMES`, `BROWSE_BLANK_URL`,
`TAB_VIEW_WEB_PREFERENCES`, `BrowserStateSchema`, `PageBoundsSchema`, `WATCH_TIMEOUT_MS`,
`APP_WINDOW_TITLE`) + `ipc-sender.spec.ts`. Design doc §3 and §4 Phase 1. Each line maps to one
named test.

## Layout
The app window shows the chrome (`app://app`): the tab strip (`tabs.feature.md`), a toolbar (back,
forward, reload ⇄ stop, the address bar), the **page area**, and a slim status bar holding the IPC connection indicator
(`data-testid="ping"`, Phase 0). The active tab's `WebContentsView` is attached to the window's
`contentView` exactly over the page area. An empty tab has no visible view: the page area shows
frost's start view (wordmark + "Search or enter address") and the address bar is focused.

## Tab view factory — `createTabView()` (`apps/desktop/src/main/browser/__tests__/tab-view.test.ts`)
`window.ts` is on the Semgrep `webcontents-factory` allowlist; prefs are literals there so
Electronegativity sees them.
- **Scenario: tab-view-prefs-equal-spec** — the `WebContentsView` options' `webPreferences`
  `toEqual(TAB_VIEW_WEB_PREFERENCES)`.
- **Scenario: tab-view-uses-browse-partition** — `partition` is `BROWSE_PARTITION`.
- **Scenario: tab-view-has-no-preload** — no `preload` key at all.

## Session-classified guard (`apps/desktop/src/main/browser/__tests__/guard.test.ts`)
The app-wide `web-contents-created` guard classifies each WebContents **at creation** by session:
browse-session contents get the browse guard; everything else — the default session, any other
partition, a missing/throwing `session` — keeps the Phase 0 app pin (fail closed).
- **Scenario: browse-contents-get-browse-guard** — a WebContents on `BROWSE_PARTITION`'s session
  may navigate (any frame) and be redirected to `http:`/`https:`/`about:blank`.
- **Scenario: browse-guard-drops-non-web-navigation** — `file:`, `app://app/`, `javascript:`,
  `data:`, `chrome:`, `mailto:` navigations and redirects are prevented (main frame and subframes);
  nothing is opened externally.
- **Scenario: browse-guard-denies-window-open** — `window.open` is denied for every URL (Task 3
  adds background tabs), nothing is opened externally.
- **Scenario: browse-guard-refuses-webview** — `will-attach-webview` is prevented.
- **Scenario: other-sessions-keep-app-pin** — default-session contents, another partition's, and
  contents whose `session` is missing or throws are pinned to `app://` as in Phase 0.
- **Scenario: browse-session-denies-permissions** — the browse session's permission request,
  permission check and device-permission handlers deny everything (until Task 4).

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`)
- **Scenario: starts-with-one-empty-tab** — state version 1, one tab with `url: ''`, it is active;
  no view is created or attached; window title `APP_WINDOW_TITLE`.
- **Scenario: navigate-loads-resolved-url** — `navigate('example.com')` creates the tab's view
  (once), attaches it to the window's `contentView`, shows it, and loads `https://example.com/`;
  `navigate('  ')` does nothing; `navigate('javascript:alert(1)')` loads a search URL.
- **Scenario: tracks-webcontents-state** — navigation, title and loading events update `url`,
  `title`, `loading`, `canGoBack`, `canGoForward`; each change bumps `version` by one; an event
  that changes nothing does not.
- **Scenario: sets-window-title** — `<page title> — frost`; the app page's own title updates are
  prevented from overriding it; a page title longer than `WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH` is
  cut to that length, ending in `…`.
- **Scenario: state-url-hides-userinfo** — a committed `https://user:pw@example.com/` is reported
  (state and window title) as `https://example.com/`.
- **Scenario: attach-same-window-twice-is-a-no-op** — attaching the same window again registers no
  second listener and resets nothing.
- **Scenario: page-close-closes-tab** — when the only tab's WebContents is destroyed (the page
  called `window.close()`), its view is removed from the window and the tab is closed: one fresh
  empty tab (a new id) takes its place (the version bumps; `tabs.feature.md` "Last tab"), and the
  next `navigate` creates a fresh view; a destroyed WebContents is never used (and inside its
  `destroyed` listeners Electron has already cleared `view.webContents`, which the test fake
  mirrors, so it is never read bare). (With several tabs,
  `tabs.feature.md` `background-page-close-closes-its-tab`.)
- **Scenario: renderer-crash-stops-loading** — after `render-process-gone` the tab reports
  `loading: false` (even if the WebContents still claims to load) until the next load starts; the
  crash UI is Task 3.
- **Scenario: history-and-reload-act-on-active-tab** — `back`/`forward` call
  `navigationHistory.goBack/goForward` only when possible; `reload`/`stop` act on the view; all
  are no-ops on an empty tab.
- **Scenario: page-bounds-are-clamped** — `setPageBounds` rounds to integers and clamps the rect
  to the window content size (no negative origin, no overflow); bounds given before the view exists
  are applied when it is created.
- **Scenario: watch-resolves-on-change** — `watch(v)` resolves at once if `version > v`, otherwise
  on the next change; an aborted watch is released (no pending waiter remains).
- **Scenario: watch-caps-pending-waiters** — with `MAX_PENDING_WATCHES` waiting, one more resolves
  the oldest at once with the current state; never more than `MAX_PENDING_WATCHES` wait.
- **Scenario: watch-clamps-future-version** — `watch(v)` with `v` above the current version waits
  only for the next change.
- **Scenario: window-close-closes-tab-contents** — when the window closes, every tab's
  `webContents.close()` is called and the controller returns to one empty tab.

## Router (`packages/ipc-contract/src/__tests__/browser-router.test.ts`)
- **Scenario: browser-procedures-reject-foreign-sender-first** — every `browser.*` procedure
  called by a foreign sender fails `FORBIDDEN` before input parsing, and the `BrowserService` is
  never called.
- **Scenario: browser-procedures-validate-input** — malformed input (wrong types, extra keys,
  `NaN`/`Infinity` bounds, a negative or fractional `sinceVersion`, an over-long address) fails
  `BAD_REQUEST` and the service is never called.
- **Scenario: browser-procedures-call-service** — a valid app sender's calls reach the matching
  `BrowserService` method with the parsed input.
- **Scenario: missing-browser-service-is-internal-error** — without a service in the IPC context a
  valid call fails `INTERNAL_SERVER_ERROR` (masked).
- **Scenario: watch-returns-immediately-when-newer** — `sinceVersion` below the current version
  resolves the current state without waiting.
- **Scenario: watch-resolves-on-version-change** — resolves when the service's watch resolves.
- **Scenario: watch-times-out-with-current-state** — with no change it resolves after exactly
  `WATCH_TIMEOUT_MS` (fake timers) with the state current *then* (not the one at call time), and
  releases the service's watcher.
- **Scenario: watch-clamps-future-version-in-router** — a `sinceVersion` above the current version
  is passed to the service clamped to the current version.
- **Scenario: navigate-reports-whether-it-navigated** — `browser.navigate` answers the service's
  boolean (`false` for a no-op).

## Address field (`apps/desktop/src/renderer/__tests__/address-field.test.ts`)
The address bar's text is a pure reducer (`renderer/address-field.ts`): what the user is typing
(`draft`), else the text just submitted (`submitted`), else the tab's URL.
- **Scenario: address-field-shows-typed-text-while-pending** — after Enter the submitted text stays
  until the URL changes or the load ends; Escape and blur drop the draft.
- **Scenario: address-field-reverts-when-navigate-fails** — a `navigate` that rejects or answers
  `false` (a no-op) clears the submitted text, so the field shows the tab's URL again.

## End to end (`apps/desktop/e2e/browser.e2e.ts`, real Electron, loopback server)
- **Scenario: empty-tab-shows-start-view** — at launch the start view is visible, the address bar
  is focused, no browse-session WebContents is shown, and the window title is `frost`.
- **Scenario: typing-url-loads-page** — typing `127.0.0.1:<port>/a` + Enter loads
  `http://127.0.0.1:<port>/a` in a tab view on `BROWSE_PARTITION`; the address bar shows the
  committed URL and the window title is `<page title> — frost`.
- **Scenario: back-forward-reload-stop** — after two loads, back is enabled and returns to the
  first page, forward returns to the second; reload re-requests the page; while a slow page loads
  the reload button is a stop button that stops it.
- **Scenario: page-view-tracks-page-area** — after a window resize the view's bounds equal the
  page area's rectangle (±1 px).
- **Scenario: tab-has-no-ipc** (Review Focus) — in the tab's WebContents `window.frostIpc` is
  `undefined` (and `require`/`process` too), its effective webPreferences match
  `TAB_VIEW_WEB_PREFERENCES` without a preload, and it is hosted in the app window but is not the
  window's own WebContents — the facts for which `enforceSender` rejects it
  (`not-window-contents`).
- **Scenario: tab-cannot-load-app-scheme** — `loadURL('app://app/')` in the tab fails, and the
  app's script cannot be loaded as a subresource from a page in the tab.
- **Scenario: page-close-closes-tab** — a page calling `window.close()` destroys the tab's
  WebContents: the view is gone from the window and the tab is closed; as it was the only tab, one
  fresh empty `New Tab` remains, with the start view and the `frost` title, and typing an address
  loads it in a new view.
- **Scenario: non-web-input-becomes-search-e2e** — typing `app://app/` or `javascript:alert(1)`
  loads the search URL (the test stubs `https:` in the browse session, so nothing leaves the host).
