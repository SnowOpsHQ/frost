# Feature: browsed-content navigation guards

Spec: `specs/browse-guard.spec.ts` (`SUBFRAME_ONLY_URLS`, `IGNORED_LOAD_ERROR_CODES`,
`CERT_ERROR_CODE_RANGE`, `LOAD_ERROR_TITLES`, `CRASH_TITLE`, `POPUP_TAB_DISPOSITION`),
`specs/browser.spec.ts` (`BROWSABLE_SCHEMES`, `BROWSE_BLANK_URL`, `TabStateSchema.error` /
`.crashed` / `.unresponsive`, `LoadErrorSchema`), `specs/tabs.spec.ts` (`NOTICE_KINDS`,
`NOTICE_MESSAGES`, `UNRESPONSIVE_STATUS`) and the
Phase 0 external-open policy in `specs/security-policy.spec.ts` (`ALLOWED_EXTERNAL_SCHEMES`,
`USER_ACTIVATION_*`). Design doc §3. Phase 1 Task 3; builds on `browser-chrome.feature.md`
(the session-classified guard) and `tabs.feature.md`. Each scenario maps to one named test.

## Behaviour
- **Navigation pin.** A tab's frames navigate, and are redirected, only to `BROWSABLE_SCHEMES`
  (`http:`, `https:`) or `about:blank` (any query or fragment: `about:blank#x` is `about:blank`,
  and Chromium commits it without asking the guard); a subframe may also be `about:srcdoc`
  (`SUBFRAME_ONLY_URLS`, whose document the embedding page wrote). Everything else is dropped
  (`preventDefault` on `will-frame-navigate` / `will-redirect`), in every frame.
  - **`data:` is denied in subframes too.** Chromium blocks top-level `data:` navigations itself
    and would allow `data:` iframes; frost denies both (simpler, and a `data:` frame is an opaque
    origin a page can use to smuggle markup past filters). `blob:` and `filesystem:` are denied the
    same way.
  - `javascript:` URLs never reach main: Chromium runs them in the page's own context (no
    privilege the page did not have). The tab's URL does not change.
  - `file:`, `chrome:` and `data:` top-level navigations from a web page are refused by Chromium
    before the guard sees them; the guard refuses them as well (defense in depth). Likewise a
    server **redirect** to `data:`, `file:` or `about:` is refused by Chromium itself with
    `ERR_UNSAFE_REDIRECT` (-311), which commits an error page: the chrome shows the generic error
    panel for it (better than a blank tab). Redirects to `app:`, `mailto:` and custom schemes do
    reach `will-redirect` and are dropped by the guard.
- **External protocols.** A renderer-initiated navigation (any frame) to a non-browsable scheme is
  dropped and, only if the tab's **main frame** initiated it (`will-frame-navigate`'s `initiator`
  is the main frame: not a subframe navigating itself or `_top`, and not a navigation with no
  initiator), offered to the Phase 0 external-open flow unchanged
  (`parseExternalUrl` / `resolveExternalOpen`, `security/gesture.ts`): it reaches
  `shell.openExternal` only if allowlisted (`mailto:` here, since `http(s)` stay in the tab) **and**
  backed by a live, unconsumed trusted activation input of that WebContents, which it consumes.
  `file:`, `app:`, custom schemes (`vscode:` …) and `mailto:` with attachment keys are never
  forwarded. A **redirect** to a non-browsable scheme is never opened externally (the server chose
  it, not the user). Electron's own external-protocol path stays closed too: the browse session
  denies the `openExternal` permission.
- **Popups** (`window.open`, `target=_blank`, any `disposition`) never create an Electron window:
  the handler always answers `{ action: 'deny' }`. Each open reads (and consumes) the
  WebContents' activation:
  - with a gesture and an `http(s)` URL, the controller opens a new **background** tab
    (`POPUP_TAB_DISPOSITION`) with its own view from `createTabView()`, placed right of the opener
    after the tabs that opener already opened **and their own popups** (all its descendants); the
    opener stays active. No opener link, no
    referrer, no POST body (`noopener` + `noreferrer` semantics). `MAX_TABS` applies (the
    `tab-limit` notice);
  - **a popup never opens an external handler:** a non-browsable URL (`mailto:` included, and every
    other scheme) is dropped and never handed to `openExternal`, with or without a gesture. Only a
    main-frame-initiated **navigation** reaches the external-open flow (above), where the initiating
    frame is known; a popup's is not;
  - otherwise (no gesture, `about:blank`, `javascript:` → `about:blank`, `file:`, custom schemes)
    nothing happens.
- **Gesture attribution** stays per WebContents (Phase 0 known limit): Electron 45 reports neither
  `input-event` nor `setWindowOpenHandler` per frame. **Navigations** carry their initiating frame,
  so an external open (above) needs the main frame to have started it: a subframe can no longer
  spend a click in the top frame on a `mailto:` navigation (it is dropped, and the click stays
  unspent). **Popups** carry no frame (`HandlerDetails` has only the URL, frame name, features,
  disposition, referrer and POST body; the referrer is the opener's to choose or strip, so it is no
  frame signal), which is why they never open an external handler (above); a gesture-backed popup
  only ever becomes a background `http(s)` tab. Each activation backs at most one open, and **ends with its
  document**: a main-frame cross-document commit (`did-navigate`) clears it, so the page a click
  navigated to (directly or through a redirect chain) cannot spend that click on a popup or an
  external open. It is not cleared when a navigation merely starts (a click on a `mailto:` link
  must still back it) nor on a same-document navigation (`did-navigate-in-page`). The app window's
  gesture tracking (Phase 0) is the same code (`security/gesture.ts`).
- **`<webview>`** stays refused (`will-attach-webview` prevented; tab views have no `webviewTag`).
- **JavaScript dialogs (deliberate Phase 1 limit).** Tab views are created with
  `disableDialogs: true` (`TAB_VIEW_WEB_PREFERENCES`), so a page gets the dialog-less behaviour:
  `alert()` returns at once, `confirm()` returns `false`, and nothing is shown. `prompt()` throws
  (`Error: prompt() is not supported.`): Electron never implements it, in any renderer. Electron would otherwise show them as native dialogs owned by frost with no origin on
  them, which a page could use to pass its text off as frost's own. Chrome-rendered dialogs that
  name the asking origin come in a later phase.
- **Unload cannot be blocked.** A page's `beforeunload` handler never keeps the user on it, and no
  "leave site?" dialog is shown: the browse guard `preventDefault`s every `will-prevent-unload`
  (without that, Electron cancels the unload, so a page with a recent activation could block
  navigating away from it, including from the address bar, and reloading). Closing a tab closes
  its WebContents without running `beforeunload` (`webContents.close()`), and closing the window
  closes every tab that way, so neither waits on a page.
- **No `file:` on the browse session** (backstop): the browse partition's own `file:` protocol
  handler fails every `file:` request with a network error, so even a load main starts itself
  (`loadURL`, which no navigation guard sees) never commits a local file in a tab. The app UI's
  default session is unaffected.
- **Downloads.** Phase 1 has no download manager: every `will-download` on the browse session is
  cancelled (`preventDefault` + `item.cancel()`) and raises the `download-blocked` notice
  ("Downloads aren't supported yet"). A **popup tab** whose page has not committed anything (a
  gesture-backed `target=_blank` link to a file) is closed then, rather than left empty; a tab the
  user opened keeps its page (or stays an empty tab). The app UI's default session cancels every download too,
  silently (the chrome never downloads anything). A link that turns into a download shows no
  error panel (`ERR_ABORTED` is ignored).
- **Certificates.** `app.on('certificate-error')` always refuses (`preventDefault` +
  `callback(false)`; never `true`), for every WebContents. No certificate-verify proc is installed
  on any session, so Chromium's verifier decides. `select-client-certificate` answers with no
  certificate (Electron's default would pick the first one). A refused certificate fails the load
  with a `-2xx` net error, shown by the error panel without a way to proceed.
- **Load errors.** A main-frame `did-fail-load` (not `IGNORED_LOAD_ERROR_CODES`) sets the tab's
  `error` (`{ code, description, url }`); subframe failures are ignored. The next main-frame
  commit (`did-navigate`) clears it. While set the tab's view is detached and the chrome's page
  area shows frost's **error panel**: an icon, a headline by failure class
  (`LOAD_ERROR_TITLES`), a sentence naming the host, the short error code, **Try again**
  (reload) and **Go back** (only when the tab can go back). The address bar keeps the failed URL;
  a certificate error shows the not-secure badge, never the lock.
- **Crashes.** `render-process-gone` sets `crashed`; the view is detached and the page area shows
  the **crash panel** (`CRASH_TITLE`, Reload). Reload reloads the same WebContents (Chromium
  restarts its renderer); if that WebContents is gone, a fresh view from `createTabView()` loads
  the tab's URL. The next load start clears `crashed` and shows the view again.
- **Unresponsive pages.** `unresponsive` sets the tab's `unresponsive` flag; `responsive`, a
  renderer crash or a new view clears it. While the **active** tab is unresponsive the status bar
  shows `UNRESPONSIVE_STATUS` (a background tab's hang says nothing until it is shown).
- The panels follow `styles.css` (light and dark), use frost-drawn inline SVG, and no `style=`
  attribute or `innerHTML`.

## Decisions (`apps/desktop/src/main/browser/__tests__/guard.test.ts`, "decisions")
- **Scenario: browse-navigation-allows-web-and-blank** — `isAllowedBrowseNavigation(url,
  { isMainFrame })`: `http:` / `https:` (any letter case) and `about:blank` (also with a query or
  fragment) in any frame; `about:srcdoc` in subframes only.
- **Scenario: browse-navigation-denies-non-web-schemes** — `file:`, `app://app/`, `chrome://gpu`,
  `devtools://…`, `javascript:`, `data:text/html,…`, `blob:…`, `filesystem:…`, `mailto:`,
  `vscode:`, `about:config`, `about:srcdoc` in the main frame, `''` and unparseable strings →
  `false` (both frames, except srcdoc as above).
- **Scenario: data-urls-denied-in-subframes** — `data:` (HTML, image, any media type) is denied
  for subframes as well as the main frame.
- **Scenario: judge-navigation-routes-non-web-to-external** — `judgeBrowseNavigation(url, ctx)`:
  browsable → `allow` (the gesture is not read); a non-browsable navigation the main frame
  initiated → `open-externally` only when `resolveExternalOpen(url, { userGesture })` allows it
  (so `mailto:` with a gesture), else `drop`; a non-browsable **redirect**, or a navigation the
  main frame did not initiate, → `drop` without reading the gesture.
- **Scenario: judge-popup** — `judgeBrowsePopup(url, userGesture)`: no gesture → `drop` (any
  URL); gesture + `http(s)` → `tab`; gesture + anything else (`mailto:` and every other external
  scheme, `about:blank`, `file:`, `vscode:`, `javascript:`) → `drop`. It has no `open-externally`
  verdict.

## Wiring (`guard.test.ts`, "browse guard", via the Electron fake)
- **Scenario: page-cannot-navigate-to-non-web-scheme** (Review Focus) — main-frame
  `will-frame-navigate` to `file:///etc/passwd`, `app://app/`, `chrome://gpu`, `javascript:…`,
  `data:text/html,…` is prevented, even after an activation input; nothing is opened externally.
- **Scenario: subframe-and-redirect-pinned** — subframe navigations and main/subframe redirects to
  the same URLs (and `data:`) are prevented; `http(s)` / `about:blank` are not.
- **Scenario: external-scheme-on-gesture-opens-externally** — after an activation input a
  `mailto:` navigation is prevented and `shell.openExternal` is called once with the parsed
  `href`; the gesture is consumed, so a second one opens nothing.
- **Scenario: external-open-needs-main-frame-initiator** — after an activation input, a `mailto:`
  navigation whose `initiator` is a subframe (a subframe navigating itself, or the main frame via
  `_top`) or `null` is prevented and opens nothing, and leaves the activation unspent: a
  main-frame-initiated `mailto:` right after opens once. A main-frame initiator is recognised by
  its `frameTreeNodeId` being the main frame's (`parent === null`).
- **Scenario: external-scheme-without-gesture-is-dropped** — with no activation input, or one older
  than `USER_ACTIVATION_WINDOW_MS`, a `mailto:` navigation is prevented and nothing is opened.
- **Scenario: never-forwards-non-allowlisted-schemes** — `file:`, `app:`, `vscode:`, a custom
  `frost-test:` scheme and `mailto:…?attach=…` after an activation input: prevented, never opened.
- **Scenario: redirect-never-opens-externally** — a `will-redirect` to `mailto:` after an
  activation input is prevented and opens nothing.
- **Scenario: popup-with-gesture-opens-background-tab** — after an activation input,
  `window.open('https://…')` answers `{ action: 'deny' }` and calls the injected `openTab(opener,
  url)` once with the opener's WebContents and the URL; nothing is opened externally.
- **Scenario: popup-without-gesture-is-blocked** (Review Focus) — with no activation input (or a
  non-activation input such as `mouseMove`), `window.open` of any URL answers deny and neither
  opens a tab nor anything external.
- **Scenario: popup-never-opens-externally** — after an activation input, `window.open` of
  `mailto:…` (also with only allowed keys) and of other external schemes answers deny and opens
  nothing externally and no tab; a main-frame `mailto:` navigation on a fresh activation still opens
  externally.
- **Scenario: popup-consumes-gesture** — one activation input backs one open: a second
  `window.open` right after opens nothing.
- **Scenario: gesture-ends-with-navigation** — an activation input followed by a main-frame
  `did-navigate` backs neither a `window.open` nor a `mailto:` navigation; one followed only by
  `did-navigate-in-page` still backs a popup.
- **Scenario: webview-stays-refused** — `will-attach-webview` is prevented, also for a request that
  asks for `nodeIntegration` or a preload.
- **Scenario: page-cannot-block-unload** — every `will-prevent-unload` of a tab's WebContents is
  prevented (the page unloads).
- **Scenario: browse-session-refuses-file-scheme** — `hardenBrowseSession` registers the browse
  session's own `file:` protocol handler, which answers every request with a network error
  (`Response.error()`): a backstop for loads no navigation guard sees (started by main).
- **Scenario: browse-session-cancels-downloads** — `hardenBrowseSession`'s `will-download`
  listener prevents the event, calls `item.cancel()` and reports the initiating WebContents to the
  injected `onDownloadBlocked`.

## App-wide (`apps/desktop/src/main/security/__tests__/register.test.ts`)
- **Scenario: certificate-errors-are-refused** — `certificate-error` (for any WebContents, any
  error) is `preventDefault`ed and its callback called exactly once with `false`.
- **Scenario: client-certificates-are-not-sent** — `select-client-certificate` is
  `preventDefault`ed and its callback called with no certificate.
- **Scenario: app-gesture-ends-with-navigation** — in an app window, an activation input followed
  by a main-frame `did-navigate` no longer backs an external open (same tracking as tabs).
- **Scenario: app-session-cancels-downloads** — `registerSecurity`'s session cancels every
  `will-download` (`preventDefault` + `item.cancel()`); registering the same session again adds no
  second listener.

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`, "guards")
- **Scenario: load-failure-shows-error** — a main-frame `did-fail-load` (`-102
  ERR_CONNECTION_REFUSED`) sets the tab's `error` (URL without userinfo) and detaches its view;
  subframe failures and `-3` change nothing; a main-frame `did-navigate` clears `error` and
  attaches the view again. The state parses with `BrowserStateSchema`.
- **Scenario: error-retry-reloads** — `reload()` on an errored tab reloads its WebContents.
- **Scenario: crash-shows-crash-state** — `render-process-gone` sets `crashed` and detaches the
  view; the next `did-start-loading` clears it and attaches the view.
- **Scenario: crash-reload-recovers** — `reload()` on a crashed tab reloads its live WebContents;
  if that WebContents was destroyed, a fresh view is created and loads the tab's URL.
- **Scenario: popup-opens-background-tab-in-controller** — `openTabFromPage(opener, url)` inserts
  a tab right of the opener (after the opener's earlier popups), creates its view without
  attaching it, loads the URL and answers its id; the opener stays active and attached.
- **Scenario: popup-placement-skips-descendants** — A opens P1, P1 opens N, then A opens P2: the
  strip is A, P1, N, P2.
- **Scenario: popup-download-closes-blank-popup-tab** — `downloadBlocked(contents)` raises the
  `download-blocked` notice and closes the tab of `contents` if it is a popup tab with nothing
  committed; a popup tab with a page, a user-opened empty tab and an unknown WebContents stay.
- **Scenario: popup-respects-max-tabs** — at `MAX_TABS` `openTabFromPage` answers `null`, opens
  nothing and raises the `tab-limit` notice.
- **Scenario: popup-needs-a-known-opener-and-web-url** — an opener that is no tab's WebContents,
  a non-`http(s)` URL, or no window → `null`, nothing opens.
- **Scenario: notify-raises-notice** — `notify('download-blocked')` sets `notice` with a new `seq`.
- **Scenario: unresponsive-is-per-tab** — a tab's `unresponsive` sets only that tab's
  `unresponsive` (no notice); `responsive` clears it, and so does `render-process-gone`.

## Renderer (`apps/desktop/src/renderer/__tests__/page-error.test.ts`)
- **Scenario: load-error-copy-by-class** — `loadErrorView(error)`: codes in `CERT_ERROR_CODE_RANGE`
  and `-501` → `certificate`; DNS / refused / reset / timed out / unreachable / empty response →
  `unreachable`; `ERR_INTERNET_DISCONNECTED` → `offline`; anything else → `generic`. The title is
  `LOAD_ERROR_TITLES[class]`, the message names the failed URL's host.
- **Scenario: cert-error-offers-no-proceed** — `loadErrorView(...).actions` is `['retry']`, plus
  `back` first when the tab can go back; never anything else, for every class.

## End to end (`apps/desktop/e2e/browse-guard.e2e.ts`, real Electron, loopback pages)
The e2e records every `will-frame-navigate` / `will-redirect` of a tab with whether it was
`defaultPrevented` (a listener added after the guard's), so a "dropped" case asserts **the guard**
dropped it, not Chromium; targets Chromium refuses before the guard sees them are asserted as never
allowed.
- **Scenario: page-cannot-navigate-to-non-web-scheme-e2e** (Review Focus) — a tab page setting
  `location` to `app://app/`, `vscode://x`, a `blob:` URL of its own, `file:///…`, `chrome://gpu`,
  `javascript:void 0`, `data:text/html,…` stays on its URL; the first three are dropped by the
  guard, none is ever allowed; no WebContents is created and nothing is opened externally.
  `about:blank#x` commits (allowed as `about:blank`).
- **Scenario: subframe-and-redirect-dropped-e2e** — iframes pointing at `data:`, `app://app/` and a
  `blob:` URL are dropped by the guard and never commit; server redirects to `app://app/` and (on a
  real click) `mailto:` are dropped by the guard, leaving the tab where it was, nothing opened
  externally; a redirect to `data:` is refused by Chromium (`ERR_UNSAFE_REDIRECT` panel, generic).
- **Scenario: gesture-does-not-survive-navigation-e2e** — a real click on a link that goes through
  a two-hop, cross-origin redirect chain to a landing page: 500 ms after load (no input) the
  landing page's `window.open` opens no tab, and (from another click) its `location = 'mailto:…'`
  opens nothing externally.
- **Scenario: popup-download-leaves-no-blank-tab-e2e** — a real click on a `target=_blank` link to
  an attachment: the download is cancelled with the notice and no extra tab remains.
- **Scenario: popup-with-gesture-opens-background-tab-e2e** — a real click (`sendInputEvent`) on a
  `window.open` button and on a `target=_blank` link opens two background tabs right of the
  opener, in order, loading their pages; the opener stays active and is the only attached view.
- **Scenario: popup-without-gesture-is-blocked-e2e** (Review Focus) — `window.open` from a timer and
  from a script-dispatched click opens no tab and creates no WebContents.
- **Scenario: mailto-on-gesture-opens-externally-e2e** — a real click on a `mailto:` link reaches
  the (stubbed) `shell.openExternal` once; a script-set `location = 'mailto:…'` does not.
- **Scenario: popup-to-external-scheme-is-dropped-e2e** — a real click on a `target=_blank`
  `mailto:` link and on a button calling `window.open('mailto:…')` opens nothing externally and
  no tab.
- **Scenario: subframe-cannot-open-externally-e2e** — right after a real click in the top frame,
  a same-origin iframe setting its own `location`, and then `top.location`, to `mailto:…` is
  dropped by the guard and opens nothing; the click is still unspent, so the top frame's own
  `location = 'mailto:…'` then opens it once.
- **Scenario: download-is-cancelled-with-notice-e2e** — a link to an attachment: the download item
  ends `cancelled`, the status bar shows `NOTICE_MESSAGES['download-blocked']`, no error panel.
- **Scenario: connection-refused-shows-error-panel-e2e** — loading a closed loopback port shows the
  error panel (unreachable title, the host, no view attached); after the server starts, Try again
  loads the page and the panel is gone.
- **Scenario: certificate-error-shows-error-panel-e2e** — a loopback HTTPS server with a
  self-signed certificate generated in the test: `certificate-error` fires, the panel shows the
  certificate title with Try again only (no proceed), and the page never loads.
- **Scenario: crash-shows-panel-and-reload-recovers-e2e** — main kills the tab's renderer process
  (`process.kill(contents.getOSProcessId(), 'SIGKILL')`: it dies at once and writes no core dump,
  whatever the host's core-dump handler, and `render-process-gone` still fires) and the crash panel
  shows (view detached); Reload brings the page back in the same WebContents.
- **Scenario: browse-session-refuses-file-scheme-e2e** — main calling `loadURL` with a readable
  temporary file's `file:` URL directly on a tab's WebContents fails with `ERR_FAILED`, commits
  nothing (`did-navigate` never fires) and the tab's document never contains the file's content.
- **Scenario: webview-tag-creates-nothing-e2e** — a page with `<webview src=…>` creates no
  WebContents.
- **Scenario: page-dialogs-are-disabled-e2e** — from page script and from a real click,
  `alert()` returns `undefined` and `confirm()` `false` at once, and `prompt()` throws; the page
  keeps running.
- **Scenario: page-cannot-block-unload-e2e** — a page whose `beforeunload` asks to stay, after a
  real click (activation): typing another URL navigates away, Reload reloads, Close Tab closes its
  WebContents, and closing the window (a second app) closes it.
