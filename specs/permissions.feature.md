# Feature: per-origin permission prompts

Spec: `specs/permissions.spec.ts` (`PROMPTABLE_PERMISSIONS`, `SILENTLY_ALLOWED_PERMISSIONS`,
`MEDIA_TYPES`, `SITE_PERMISSIONS`, `MEDIA_TYPE_PERMISSION`, `PERMISSION_DECISIONS`,
`PERMISSION_PROMPT_TIMEOUT_MS`, `MAX_PROMPT_IGNORES`, `MAX_COALESCED_REQUESTS`,
`PROMPT_ARMING_DELAY_MS`, `MAX_PENDING_PROMPTS_PER_TAB`,
`PERMISSION_PROMPT_ACTIONS`, `PERMISSION_PROMPT_LABELS`, `PERMISSION_PROMPT_EMBEDDED_IN`,
`FULLSCREEN_NOTICE_MS`, `FULLSCREEN_BANNER_HEIGHT`, `FULLSCREEN_NOTICE_TEXT`, `FULLSCREEN_EXIT_KEY`;
Zod-free so the chrome can import it) and `specs/browser.spec.ts` (`PermissionPromptSchema`,
`TabStateSchema.permissionPrompt` / `.fullscreen`, `AnswerPermissionInputSchema`). Design doc §3. Phase 1 Task 4; builds on `browser-chrome.feature.md`
(the browse session), `tabs.feature.md` and `browse-guard.feature.md`. Each scenario maps to one
named test.

## Behaviour
- **Which permissions.** On the browse session, a request for one of `PROMPTABLE_PERMISSIONS`
  (`geolocation`, `notifications`, `media`, `clipboard-read`) from a tab may prompt;
  `SILENTLY_ALLOWED_PERMISSIONS` (`fullscreen`, `clipboard-sanitized-write`) are granted without a
  prompt; **every other permission is denied silently** (no prompt, nothing remembered). Device
  permissions (`setDevicePermissionHandler`: HID, serial, USB) stay deny-all.
- **Requesting frame.** A request is attributed to the **frame that asked**, by its own origin
  (`WebFrameMain.origin`), not merely its URL's: for a main-frame request the tab's
  `mainFrame.origin` must equal the origin of `details.requestingUrl`; for a subframe request the
  frames of the tab whose URL is `details.requestingUrl` must exist and **all** have that URL's
  origin (several frames may share a URL). Anything else is denied silently: an opaque origin (a
  document sandboxed by a CSP `sandbox` header or `<iframe sandbox>`, `about:blank`, `data:`), a
  non-`http(s)` origin (`webOrigin`, `web-url.spec.ts`), a frame that is gone or has navigated, an
  opaque top-level page, an unparsable URL. A request whose WebContents is not an open tab's is
  denied.
- **Scope.** Decisions are keyed by (requesting origin, top-level origin) — the tab's
  `mainFrame.origin` — as Chrome keys embedded permissions: a third-party iframe's decision applies
  only under the same top-level site. A top-level request has scope (origin, origin). The prompt
  names the requester and, when it is embedded, the top-level site: "widget.example (embedded in
  site.example) wants to …".
- **Media.** A `media` request is split by `details.mediaTypes`: `video` → camera, `audio` →
  microphone (`MEDIA_TYPE_PERMISSION`). The prompt names exactly the devices asked for (and still
  undecided); a `media` request with no known media type is denied.
- **Remembered decisions.** Allow and Block are remembered per (scope, `SitePermission`) for the
  app session, in memory (`createMemoryDecisionStore`); the app uses the persistent store behind
  the same `PermissionDecisionStore` interface (`createPersistentDecisionStore`, Task 5,
  `browser-session-db.feature.md`), which writes **only Blocks** (`PERSISTED_DECISIONS`): a Block
  survives a relaunch, an Allow lasts for the app session only and is asked for again after a
  relaunch. **Clear Browsing Data…** (the application menu, `browser-session-db.feature.md`)
  forgets every remembered Allow and Block, stored and in memory, and the back-off
  (`forgetDecisions`); nothing else revokes a decision in Phase 1 (no site-settings UI yet). A request is answered from what is remembered,
  with no prompt: any asked-for permission Blocked → denied; all Allowed → granted; otherwise the
  prompt asks for the undecided ones only. Each pending request keeps **everything it asked for**,
  not only what its prompt names: when the prompt is answered (or settled by another answer) a
  request is granted only if every permission it asked for is remembered Allowed **then**. So a
  prompt narrowed by a decision that has since gone (Clear Browsing Data while it is pending) or
  turned into a Block (another prompt's answer after the clear) still names only what it named,
  and its Allow grants only what that prompt asked about: a request that also wanted the
  forgotten or blocked permission is denied and must ask again.
- **Queue.** Each tab has its own queue; the chrome shows its head. Identical requests (same tab,
  scope, permission and devices) **coalesce** into the pending prompt and get the same answer, up
  to `MAX_COALESCED_REQUESTS` per prompt (more are denied at once). An Allow / Block also settles
  every other pending request it now decides, in any tab. At most `MAX_PENDING_PROMPTS_PER_TAB`
  distinct prompts wait per tab; one more is denied at once.
- **Back-off.** After `MAX_PROMPT_IGNORES` dismissals or timeouts of the same (scope,
  `SitePermission`) in the app session, requests for it are denied silently for the rest of the
  session (or until Clear Browsing Data).
- **Answers** (`browser.answerPermission({ promptId, decision })`): `allow` grants, `block` denies;
  both are remembered. `dismiss` (the × or Esc) denies this request only, remembering nothing, so
  the page may ask again. Only the prompt the **active** tab shows can be answered: another tab's
  prompt id, a queued (not yet shown) one, an answered one (ids are single-use), a timed-out one or
  an unknown one is a no-op answering `false`. When answered, each waiting request's frame is
  checked again: one whose frame has gone or navigated to another origin is denied (the decision
  itself is still remembered for the scope the prompt named). Prompt ids are opaque, unguessable UUIDs
  (`crypto.randomUUID`), validated by `AnswerPermissionInputSchema` (a malformed one is
  `BAD_REQUEST`).
- **Lifetime.** A tab's pending prompts are all **denied** (nothing remembered) when the tab
  closes, its WebContents is destroyed, its main frame commits another document (`did-navigate`,
  or a main-frame load failure that commits an error page), or its renderer crashes. A
  same-document navigation (`did-navigate-in-page`) keeps them. A prompt nobody answers is denied
  after `PERMISSION_PROMPT_TIMEOUT_MS` (5 minutes).
- **Check handler.** `setPermissionCheckHandler` on the browse session answers `true` only for
  `SILENTLY_ALLOWED_PERMISSIONS` and for a remembered Allow of (scope, permission). Electron
  passes the checking frame's origin as `requestingOrigin` (with a trailing `/`), and for `media`
  `details.securityOrigin` and `details.mediaType` (`video` / `audio`; `unknown` → `false`). The
  scope's top-level origin is `details.embeddingOrigin` (Electron 45 sets it to the **top-level**
  origin, also for nested frames), else the requesting origin for a main-frame check, else the
  tab's `mainFrame.origin` (media checks carry no `embeddingOrigin`). Chromium does not consult the
  check for opaque origins (they read `denied`). Known limit: Electron's check is two-state, so
  before any decision a page reads `denied` (not `default`) from `Notification.permission` and
  `navigator.permissions.query`, though a request still prompts.
- **Notifications (known limit).** An allowed site's notifications are shown by Electron as the
  app's own OS notifications: the OS shows frost as their source and nothing names the site.
  Electron 45 has no session-level hook to rewrite a web notification's title or body (no
  notification handler), so frost cannot add the origin cheaply; revisit with a notification
  manager.
- **App session.** The app UI's default session stays deny-all (Phase 0 `isPermissionGranted`,
  `GRANTED_PERMISSIONS = []`): no request from the chrome ever prompts.
- **HTML fullscreen.** Granted without a prompt (gesture-gated by Chromium). On
  `enter-html-full-screen` the tab's `fullscreen` is `notice`: the chrome shows a frost-owned
  banner across the top ("<host> `FULLSCREEN_NOTICE_TEXT`", `FULLSCREEN_BANNER_HEIGHT` high) and
  the view covers the rest of the window below it; after `FULLSCREEN_NOTICE_MS` it is `full` and
  the view covers the whole window. `FULLSCREEN_EXIT_KEY` (Esc) on a fullscreen tab is taken in
  `before-input-event` (the page never sees it) and **always** leaves fullscreen (anti-spoofing),
  from main, at once, whatever the page does: the tab's `fullscreen` is cleared (the notice goes),
  the window leaves OS fullscreen (`setFullScreen(false)`), and the view goes back into the page
  area under the visible chrome. frost's state is authoritative: the chrome stays visible even if
  the page never leaves its own fullscreen (it hangs, or Chromium ignores the request). Only then
  is the page asked to leave, by running `document.exitFullscreen()` in an isolated world (a page
  cannot override it there). Electron may leave HTML fullscreen on its own first (it handles Esc
  itself and reports `leave-html-full-screen`), so that event, too, asks the page to leave: on
  macOS Electron can report it while the renderer is still entering (Esc during the native
  fullscreen animation), and the document then holds its fullscreen element with nothing to end
  it. The page is asked only once the window is out of OS fullscreen and has had no fullscreen
  event (the window's `enter-full-screen` / `leave-full-screen`, a tab's `enter-html-full-screen`
  / `leave-html-full-screen`) for `FULLSCREEN_EXIT_SETTLE_MS`: on macOS a request made while the
  native animation runs, or is queued to run, is never completed and blocks every later one. It is
  asked again whenever the tab's view is shown again (Chromium completes a hidden page's exit only
  then; after the same settle wait), until the page enters fullscreen again or a new document
  commits; it does nothing on a page that is not fullscreen (`document.fullscreenElement` is
  checked first). Switching to another tab, or a tab showing
  its error/crash panel, leaves fullscreen the same way; closing the tab (its WebContents gone)
  takes the window out of OS fullscreen. A cross-document commit or `leave-html-full-screen` ends it. While a tab is
  fullscreen its new permission requests are denied at once (a prompt would be hidden). Bounds are
  re-applied on the window's `resize`, `enter-full-screen` and `leave-full-screen`, not only when
  the chrome reports its page area. No new WebContents is involved.
- **Prompt bar.** For the active tab's prompt the chrome shows a bar under the toolbar (the page
  area, and so the tab's view, moves down to make room): a frost-drawn icon per permission,
  "<origin's host> wants to <`PERMISSION_PROMPT_ACTIONS`>", or for an embedded requester "<host>
  (`PERMISSION_PROMPT_EMBEDDED_IN` <top-level host>) wants to …" (the full origins as its tooltip),
  then **Allow**, **Block** and a dismiss **×** (`PERMISSION_PROMPT_LABELS`). Allow and Block stay
  disabled for `PROMPT_ARMING_DELAY_MS` after the bar appears, after the shown prompt or tab
  changes, after the chrome's window regains focus or becomes visible, and after the active tab
  leaves HTML fullscreen (clickjacking). While the active tab is fullscreen its page covers the
  bar: the bar is marked covered (`data-covered`) and stays disarmed, so it never comes back from
  under the page already armed. It is a labelled
  `role="dialog"` (non-modal) that does not take focus from the page; Tab reaches its buttons and
  Esc inside it dismisses. A background tab with a pending prompt shows a small indicator dot in the
  strip (and says so to assistive technology). Light and dark follow `styles.css`; no `style=`
  attribute, no `innerHTML`.

## Decisions (`apps/desktop/src/main/browser/__tests__/permissions.test.ts`, "decisions")
- **Scenario: promptable-permissions-prompt** — `classifyPermissionRequest(permission, details)`
  for `geolocation`, `notifications`, `clipboard-read` and `media` (with media types) → `prompt`
  with that permission.
- **Scenario: silently-allowed-permissions** — `fullscreen` and `clipboard-sanitized-write` →
  `allow`, from any origin.
- **Scenario: other-permissions-denied-silently** — `midi`, `midiSysex`, `hid`, `serial`, `usb`,
  `pointerLock`, `keyboardLock`, `openExternal`, `display-capture`, `idle-detection`,
  `window-management`, `persistent-storage`, `automatic-fullscreen`, `storage-access`,
  `mediaKeySystem`, `unknown`, `''` and a made-up name → `deny`.
- **Scenario: media-split-into-camera-and-microphone** — `mediaTypes: ['audio', 'video']` →
  permissions `camera`, `microphone` and prompt media types `['video', 'audio']`; `['video']` →
  camera only; `['audio']` → microphone only; missing or empty media types → `deny`.
- **Scenario: requesting-frame-decides-scope** — `requestScope(contents, details)` with a fake
  frame tree: a main-frame request whose `mainFrame.origin` matches `requestingUrl`'s origin →
  (origin, origin); a subframe request whose matching frames all have the URL's origin →
  (frame origin, top-level origin). `null` for: an opaque (`'null'`) main frame (CSP sandbox), a
  main frame whose origin differs from the URL's (it navigated), a subframe URL with no frame, or
  with one opaque (`<iframe sandbox>`) among same-URL frames, an opaque top-level page, `about:`,
  `data:`, `file:`, `app:`, unparsable or missing URLs, a missing or throwing `mainFrame`.

## Broker (`permissions.test.ts`, "broker")
- **Scenario: prompt-queues-per-tab** — two different requests in a tab: the first is its prompt,
  the second shows after the first is answered; another tab's queue is independent.
- **Scenario: duplicate-requests-coalesce** — the same (origin, permission) asked twice in a tab
  makes one prompt; answering it calls both callbacks with the same answer.
- **Scenario: allow-is-remembered** — Allow grants, the next identical request is granted at once
  with no prompt, and a pending identical request in another tab is granted too.
- **Scenario: block-is-remembered** — Block denies, the next identical request is denied at once
  with no prompt.
- **Scenario: dismiss-denies-once** — dismiss denies; the next identical request prompts again.
- **Scenario: remembered-per-origin-and-permission** — an Allow for (A, notifications) does not
  answer (B, notifications) or (A, geolocation).
- **Scenario: media-remembers-each-device** — Allow for camera + microphone, then a camera-only
  request is granted at once; after Block for an origin's microphone, a camera + microphone request
  is denied at once; with only the camera allowed, a camera + microphone request prompts for the
  microphone only.
- **Scenario: clearing-decisions-reevaluates-narrowed-prompts** (review finding) — with the camera
  allowed, a camera + microphone request prompts for the microphone only (a microphone-only request
  coalesces into it); `forgetDecisions()` while it is pending, then Allow: the camera +
  microphone request is denied, the microphone-only one granted, only the microphone is remembered
  and the camera prompts again. Likewise when, after the clear, another tab's prompt Blocks the
  camera before the narrowed prompt is allowed.
- **Scenario: check-reflects-remembered-allow** — `check(origin, permission)` is `true` only after
  an Allow of that pair (not after Block, dismiss or for another origin).
- **Scenario: prompt-times-out** — (fake timers) an unanswered prompt is denied after
  `PERMISSION_PROMPT_TIMEOUT_MS`, not before; nothing is remembered and the next prompt shows.
- **Scenario: prompt-ids-are-opaque-and-single-use** — ids are UUIDs, distinct per prompt;
  answering an id a second time, or an unknown id, answers `false` and calls nothing.
- **Scenario: answer-needs-the-tabs-shown-prompt** — answering with another tab's id, or with the
  id of a queued (not head) prompt, answers `false` and changes nothing.
- **Scenario: deny-tab-denies-pending** — `denyTab(tabId)` denies every pending request of that
  tab (nothing remembered), leaving other tabs' prompts.
- **Scenario: pending-prompts-capped-per-tab** — beyond `MAX_PENDING_PROMPTS_PER_TAB` distinct
  prompts a request is denied at once.
- **Scenario: decision-store-is-swappable** — a broker given another `PermissionDecisionStore`
  reads and writes decisions (scope, permission) through it only.
- **Scenario: decisions-keyed-by-top-level-origin** — an Allow for (W embedded in S) answers W's
  requests under S only: (W under T) and W as a top-level page prompt; the prompt reports
  `topLevelOrigin` S for an embedded requester and `null` for a top-level one.
- **Scenario: coalesced-requests-capped** — beyond `MAX_COALESCED_REQUESTS` identical requests,
  each further one is denied at once; the coalesced ones get the answer.
- **Scenario: repeated-dismissals-back-off** — after `MAX_PROMPT_IGNORES` dismissals / timeouts
  of a (scope, permission), its requests are denied silently; other scopes and permissions still
  prompt; Allow / Block answers do not count.
- **Scenario: answer-rechecks-requesting-frame** — a request whose frame check fails by the time
  the prompt is allowed is denied, while a coalesced request whose frame is still there is granted.

## Session wiring (`permissions.test.ts`, "browse session", via the Electron fake)
- **Scenario: browse-session-prompts-for-tabs** — with the handlers installed by
  `hardenBrowseSession`, a `notifications` request from a tab's WebContents creates that tab's
  prompt; one from a WebContents that is no tab's is denied; `fullscreen` is granted and `midi`
  denied with no prompt.
- **Scenario: prompt-names-requesting-origin** (Review Focus) — a subframe request
  (`isMainFrame: false`, `requestingUrl` on another origin) prompts for the subframe's origin,
  embedded in the top-level page's; after Allow, a check for that origin embedded in that page is
  `true`, for the top-level page's own origin `false`, and for the same origin under another
  top-level page (or as a top-level page) `false`.
- **Scenario: sandboxed-document-denied** — with the URL's origin already allowed, a request from
  a CSP-sandboxed main frame (`mainFrame.origin === 'null'`) and from an `<iframe sandbox>` (opaque
  frame at an allowed URL) is denied with no prompt.
- **Scenario: answered-prompt-rechecks-frame** — a subframe's pending prompt whose frame has
  navigated away by the time it is allowed: that request is denied.
- **Scenario: fullscreen-tab-denies-new-prompts** — while `isFullscreen(tabId)` holds, a promptable
  request from that tab is denied at once, with no prompt.
- **Scenario: check-handler-uses-requesting-origin** — `requestingOrigin` with a trailing `/` is
  normalized; the scope's top-level origin is `embeddingOrigin`, else the requesting origin for a
  main-frame check, else the tab's `mainFrame.origin`; `media` checks use `securityOrigin` and
  `mediaType` (`unknown` → `false`); silently allowed permissions check `true`; everything else
  `false`.
- **Scenario: device-permissions-stay-denied** — the device permission handler answers `false`
  for HID, serial and USB, with or without permission handlers.
- **Scenario: app-session-stays-deny-all** — `registerSecurity`'s (default) session denies
  `notifications`, `geolocation`, `media`, `clipboard-read`, `fullscreen` requests and checks, and
  never reaches the broker.

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`, "permissions")
- **Scenario: prompt-in-tab-state** — a broker prompt for a tab appears as that tab's
  `permissionPrompt` (others `null`), bumps the version, and the state parses with
  `BrowserStateSchema`.
- **Scenario: answer-applies-to-active-tab-only** — `answerPermission` answers the active tab's
  prompt; a background tab's prompt id answers `false` and stays pending.
- **Scenario: tab-id-of-contents** — `tabIdOf(contents)` names the tab of a live view's
  WebContents, `null` for anything else.
- **Scenario: prompts-denied-when-tab-goes** — closing the tab, its WebContents being destroyed,
  a main-frame `did-navigate`, a main-frame load failure and `render-process-gone` each deny the
  tab's pending prompts; `did-navigate-in-page` does not.
- **Scenario: html-fullscreen-fills-window** — after `enter-html-full-screen` the tab is
  `notice` and its view covers the content area below `FULLSCREEN_BANNER_HEIGHT` (also on later
  bounds reports); after `FULLSCREEN_NOTICE_MS` it is `full` and covers the whole content area;
  after `leave-html-full-screen` the page area again (`fullscreen: null`).
- **Scenario: esc-always-leaves-fullscreen** — on a fullscreen tab, an Escape `before-input-event`
  is `preventDefault`ed (key-down and key-up); the key-down at once clears the tab's `fullscreen`
  (a state change), calls `setFullScreen(false)` and lays the view over the page area; then,
  `FULLSCREEN_EXIT_SETTLE_MS` later, `document.exitFullscreen()` runs in an isolated world. This
  holds when that script never settles (a hung page) and when the page never reports
  `leave-html-full-screen`. On a tab that is not fullscreen, Escape passes through untouched.
- **Scenario: page-exit-waits-for-window-to-settle** — after frost left a tab's fullscreen, or
  after `leave-html-full-screen`, the isolated-world exit runs only once the window is out of OS
  fullscreen and `FULLSCREEN_EXIT_SETTLE_MS` passed with no window or tab fullscreen event (each
  one restarts the wait; a window still fullscreen waits for its `leave-full-screen`). It runs
  again each time the tab's view is shown again (after the same wait); once the page enters
  fullscreen again, or a new document commits, it does not run.
- **Scenario: leaving-fullscreen-tab-restores-window** — switching away from a fullscreen tab
  clears its `fullscreen`, takes the window out of OS fullscreen and (after the settle wait) runs
  the isolated-world exit;
  closing a fullscreen tab takes the window out of OS fullscreen.
- **Scenario: window-events-reapply-bounds** — the window's `resize`, `enter-full-screen` and
  `leave-full-screen` re-apply the active view's bounds (fullscreen or page area) from the
  window's current content size.
- **Scenario: tab-fullscreen-state** — `isFullscreen(tabId)` is `true` only for a tab between
  `enter-html-full-screen` and leaving it.

## Router (`packages/ipc-contract/src/__tests__/browser-router.test.ts`)
- **Scenario: answer-permission-enforces-sender** — a rejected sender is refused before the
  service is called.
- **Scenario: answer-permission-validates-input** — a non-UUID id, an unknown decision, or extra
  keys are `BAD_REQUEST`; the service is not called.
- **Scenario: answer-permission-calls-service** — a valid input reaches
  `answerPermission(promptId, decision)` and answers its boolean.

## Renderer (`apps/desktop/src/renderer/__tests__/permission-prompt.test.ts`)
- **Scenario: prompt-copy-per-permission** — `promptView(prompt)`: the host (with port) of the
  origin, the top-level host for an embedded requester (else `null`), and
  `PERMISSION_PROMPT_ACTIONS` by kind (`media` → camera, microphone, or both).
- **Scenario: prompt-buttons-arm-after-delay** (`prompt-arming.test.ts`, fake timers) — a fresh
  arming is disarmed, armed after `PROMPT_ARMING_DELAY_MS` (not before); `disarm()` (focus,
  visibility) restarts the delay; `dispose()` leaves no timer.
- **Scenario: prompt-disarms-while-covered** (`prompt-arming.test.ts`, fake timers) —
  `setCovered(true)` disarms at once and keeps it disarmed however long it lasts (no timer);
  `setCovered(false)` after that arms only `PROMPT_ARMING_DELAY_MS` later; `setCovered(false)`
  when not covered changes nothing.

## End to end (`apps/desktop/e2e/permissions.e2e.ts`, real Electron, loopback pages)
Each scenario uses fresh loopback origins (decisions are remembered for the app session).
- **Scenario: allow-grants-and-is-remembered-e2e** — `Notification.requestPermission()` shows the
  prompt bar naming the page's origin (a labelled `dialog`), with the tab's view laid out below it;
  Allow resolves it `granted` in the page; a second request resolves `granted` with no prompt, and
  `Notification.permission` reads `granted`.
- **Scenario: block-denies-and-is-remembered-e2e** — Block resolves `denied`; a second request
  resolves `denied` with no prompt.
- **Scenario: dismiss-denies-and-asks-again-e2e** — × resolves `denied`; a second request prompts
  again.
- **Scenario: prompt-names-requesting-origin-e2e** (Review Focus) — a cross-origin iframe (second
  loopback port, `allow="geolocation"`) asking for geolocation: the prompt names the iframe's
  origin embedded in the page's ("<frame host> (embedded in <page host>) wants to use your
  location"); Block fails the iframe's request with `PERMISSION_DENIED` and a second iframe request
  is denied with no prompt; the page's own request, and the iframe's origin loaded as a top-level
  page, still prompt (the decision was scoped to the pair).
- **Scenario: sandboxed-document-denied** — with the site's origin allowed notifications and
  geolocation, a same-origin page served with CSP `sandbox allow-scripts` gets `denied` from
  `Notification.requestPermission()`, and an `<iframe sandbox="allow-scripts" allow="geolocation">`
  of a same-origin URL gets `PERMISSION_DENIED`, with no prompt.
- **Scenario: prompt-buttons-arm-after-delay-e2e** — a click on Allow right after the bar appears
  does nothing (the request stays pending); a click after `PROMPT_ARMING_DELAY_MS` grants. The
  delay is measured in the chrome's renderer (`performance.now()` when the bar mounts and when
  `data-armed` turns `true`, recorded by a test-only `MutationObserver`), never from the test
  process.
- **Scenario: prompt-disarms-after-fullscreen-e2e** — with an armed prompt showing, the page goes
  fullscreen (a real click): the bar is covered and disarmed; after Esc it is uncovered and armed
  again only `PROMPT_ARMING_DELAY_MS` after that (measured in the renderer), and Allow then
  grants.
- **Scenario: navigate-away-denies-pending-e2e** — with a prompt showing, the page navigates
  elsewhere: the prompt bar goes away, and the new page's request prompts afresh (a new id).
- **Scenario: non-promptable-denied-without-prompt-e2e** — `navigator.requestMIDIAccess()` rejects
  and `navigator.storage.persist()` resolves `false`, with no prompt bar ever shown.
- **Scenario: clearing-decisions-reevaluates-narrowed-prompts-e2e** — (Chromium's fake media
  devices, `--use-fake-device-for-media-stream`) `getUserMedia({ video })` allowed; then
  `getUserMedia({ video, audio })` prompts for the microphone only; Clear Browsing Data… from the
  menu (main's message box stubbed to confirm) while it is pending: the page's camera permission
  reads `denied` and the prompt still names the microphone; Allow rejects that request
  `NotAllowedError` (no camera); a microphone-only request is then granted with no prompt, and a
  camera request prompts again.
- **Scenario: background-tab-prompt-shows-dot-e2e** — a prompt in a background tab shows its strip
  dot, not the bar; activating the tab shows the bar.
- **Scenario: app-session-stays-deny-all-e2e** — the chrome page's own
  `Notification.requestPermission()` resolves `denied`, its notifications permission queries
  `denied`, and no prompt bar appears.
- **Scenario: html-fullscreen-fills-window-e2e** — a real click calling `requestFullscreen()` is
  granted with no prompt; the notice banner names the host while the view sits below it; after
  `FULLSCREEN_NOTICE_MS` the view covers the whole content area and the banner is gone; after
  `exitFullscreen()` it is back under the toolbar and the window is no longer fullscreen.
- **Scenario: esc-leaves-fullscreen-e2e** — on a page that swallows every Escape keydown, Esc
  leaves fullscreen (the page never sees it) and the window leaves OS fullscreen; a notification
  request made while fullscreen resolves `denied` with no prompt.
- **Scenario: esc-leaves-fullscreen-on-hung-page-e2e** — a fullscreen page that then hangs (a
  busy loop) cannot hold the window: Esc takes the window out of OS fullscreen and puts the view
  back in the page area under the chrome, with no notice.
- **Scenario: leaving-fullscreen-tab-restores-window-e2e** — switching to another tab, and
  closing a fullscreen tab, each take the window out of OS fullscreen; switching back shows the
  page out of fullscreen, in the page area, with no notice.
