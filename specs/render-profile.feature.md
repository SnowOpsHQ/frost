# Feature: per-tab render profiles

Spec: `specs/render-profile.spec.ts` (presets, user agents, network conditions, `RENDER_PROFILE_CDP_METHODS`,
`fitRenderViewport`, `RENDER_FRAME`, wording) and `specs/render-profile.schema.spec.ts` (`RenderProfileSchema`,
the procedures' inputs, `TabRenderProfileSchema`). Phase 2.5 Task 1. Each line maps to one named test.

## What a profile is
- A profile is one device preset (`none`, `desktop`, `phone`, `tablet`), one user agent (frost's own,
  a mobile browser, Googlebot smartphone, Googlebot desktop, Bingbot, or custom text), one network
  condition (none, offline, slow 3G, fast 3G, 4G) and two switches (JavaScript off, cache off).
  The all-default profile is no profile. (`render-profile-spec-presets`)
- A custom user agent is printable ASCII, at most `MAX_CUSTOM_USER_AGENT_LENGTH` characters, and
  non-blank; any other text is rejected, never cut. (`custom-user-agent-is-capped`)
- The crawler and mobile strings carry the app's own Chromium version where the published strings
  carry the evergreen version; a malformed version becomes `0.0.0.0`. (`user-agent-strings`)
- With a device preset the page sees the device's width in CSS pixels whatever the window size: the
  view is scaled down (never up) to fit, centred, inside the page-area frame. (`fit-keeps-device-width`)

## How it is applied
- Through CDP on the tab's own `webContents.debugger` (in-process, no remote-debugging port or
  switch). Only `render-profile-debugger.ts` touches a debugger (Semgrep
  `debugger-outside-allowlisted-modules`), and only a browse-session tab's: any other WebContents
  is refused before a debugger is touched. It sends only `RENDER_PROFILE_CDP_METHODS`, plus the two
  `RENDER_PROFILE_SESSION_METHODS` under their rules (`isAllowedCdpCommand`); anything else is
  refused before it reaches the debugger. (`debugger-refuses-unlisted-method`,
  `debugger-refuses-non-browse-contents`, `session-methods-are-restricted`)
- **Cross-site frames and workers.** A cross-site iframe runs in a renderer of its own, which the
  tab's session does not reach. frost turns on auto-attach (`TARGET_AUTO_ATTACH_PARAMS`) on the tab
  and on every child frame, so each new cross-site frame (nested ones too) and dedicated worker is
  announced paused, before it runs anything. A child frame gets the profile's commands but the
  viewport (`TOP_LEVEL_ONLY_METHODS`: refused there; it keeps the size its parent gives it), a worker
  the user agent and cache switch (`WORKER_METHODS`); it is resumed once they have all answered, or
  after `CHILD_RESUME_TIMEOUT_MS` at the latest, so a child never holds the tab up. A profile change
  reaches every live child; a child's failure never fails the tab's profile. A child that was already
  running when the profile was set gets the commands without a pause ("Reload to apply" covers what it
  did before). (`child-frames-get-the-profile`, `child-resumes-after-answers-or-timeout`,
  `profile-change-reaches-children`, e2e `cross-site-iframes-are-emulated`)
- **Out of reach**, said here plainly: a service worker (it belongs to the site, not to the tab, and
  is never announced to a tab's session) keeps frost's own user agent and network, can answer the
  page's requests from its own Cache Storage whatever "cache off" says, and its script runs whatever
  "JavaScript off" says; the same goes for shared workers. A page that a service worker controls may
  therefore see some unemulated responses. A cross-site frame's viewport is the box its parent lays
  it out in, as on a real device, but its `screen` reports the machine's own screen (verified:
  `screen.width` 1440 in a cross-site frame of a phone-profiled tab whose top page sees 412): the
  viewport override is refused on child targets, so nothing carries the emulated screen there.
- A profile is sent whole every time, in a fixed order: the Network domain first (`Network.enable`
  with no buffers only while cache-off needs it, else `Network.disable`), then the cache switch, the
  user agent with matching client hints (`Sec-CH-UA-*`, `navigator.userAgentData`: the engine's
  GREASE brand and `Chromium` in the engine's own order (`clientHintsBrands`), platform, mobile), the
  network condition, device metrics and touch, then the JavaScript switch. Every method is on the
  allowlist. (`cdp-commands-for-profile`, `cdp-commands-are-allowlisted`, `client-hints-grease`)
- The debugger is attached only to a tab that has a profile (or tab overrides, below), and only by
  main. Reset detaches it, which clears every override at once (unless the tab has overrides: then
  the merged list goes out with frost's defaults for the profile part); closing the tab detaches it. A detach main did not ask for is
  answered with one new attach and the profile sent again; a failed attach or command marks the
  profile `failed` (the chrome says so) and never throws into browsing.
  (`debugger-attaches-lazily-and-detaches`, `unexpected-detach-reattaches-once`, `apply-failure-is-visible`)
- Commands are dispatched at once, never one awaited before the next (CDP handles a session's
  commands in order): dispatching is synchronous, so the browser-side overrides (user agent, network
  conditions, cache) are in place when the call returns, while renderer-side ones (viewport, touch,
  JavaScript) are answered only once the tab has a renderer — a fresh tab gets one from its first
  load. The profile is `applying` until every command has answered, then `active`.
- A load main starts (address bar, restored tab, a tab opened from another) puts the tab's profile
  for that URL into effect first, so its first request already carries it, without waiting.
  (`load-carries-profile`, `load-never-waits-for-answers`)
- "Reload to apply": the page on screen loaded before (part of) the current profile was in effect —
  set or changed after its navigation started (or it had failed then). Any reload, navigation or
  back / forward to a new document under the profile clears it. (`reload-to-apply`)

## Scope and lifetime
- A profile is the tab's own: no other tab, the chrome or the app session is affected, and closing
  the tab drops it with its debugger. (`render-profile-is-tab-scoped`, unit `profile-scoped-to-tab`)
- **Cross-origin navigation:** a profile set on the tab stays with the tab whatever it navigates to
  (same or other origin, redirects, back / forward, reloads). (`profile-persists-cross-origin`)
- **Pin to this site:** stores the profile for the origin of the page the tab shows (its committed
  page, never a destination still loading), locally (`render_profile_pins` in
  `@app/db`, at most `MAX_RENDER_PROFILE_PINS`, the oldest dropped). A tab with no profile of its own
  that navigates to a pinned origin takes that pin (`source: site`); leaving the origin drops it again
  (a pin belongs to its site, not to the tab). A tab's own profile wins over a pin. Pins survive a
  relaunch, are forgotten by Clear Browsing Data (in memory too: a later navigation in the same
  session no longer picks one up), and a tampered row is skipped. Pinning or unpinning changes
  another tab already on that site when it next navigates, never under it.
- `browser.setRenderProfile`'s `pin`: `true` pins the profile to this site, `false` unpins this site
  (the editor bar's "Pin to this site", unticked), and leaving it out leaves the site's pin as it is
  (the quick chips and the palette's "Render as …": they set the tab's own profile, which wins on
  this tab, and keep the site's pin for its other visits). (`pin-committed-origin`,
  `quick-profile-keeps-site-pin`, `forgotten-pins-stay-forgotten`)
  (`pin-applies-by-origin`, `pins-in-memory`, `render-profile-pins-roundtrip`, `tampered-pin-rows-skipped`,
  `render-profile-pins-capped`, `clear-browsing-data-forgets-pins`, `pin-persists-across-relaunch`)
- **Reset** (`browser.clearRenderProfile`) is one click: the tab's profile goes, and with it this
  site's pin, so the site does not come back emulated. (`reset-clears-pin`, `reset-restores-defaults`)
- **Popups:** a tab the page opens (a gesture-backed popup, "Open link in new tab") and a page the
  SEO sidebar opens from the audited page (a link, an image or resource, a structured-data URL:
  `browser.openBackgroundTab` with `inherit: true`) start with the opener's own tab profile, applied
  before the first request; a pin is not inherited (the new tab's own origin decides). Everything
  else `browser.openBackgroundTab` opens does not inherit (`inherit` left out or `false`): the
  palette's "Open in" tools, help pages, and the site's robots.txt and sitemap — those are files a
  crawler fetches, but opening one in a tab is for reading it, and frost's robots.txt verdicts come
  from its own fetcher, not from a tab. (`popup-inherits-tab-profile`, `tools-do-not-inherit`)

## Visible state
- The overridden state is always visible: the tab shows a badge (with the profile in its tooltip and
  accessible name), the status bar a chip with the profile and "Reload to apply", and the page area a
  frame with the profile, "Reload to apply" and Reset. A crawler user agent shows
  `CRAWLER_HONESTY_NOTE`. Main lays the tab's view out inside the frame (`fitRenderViewport`) and
  sends the device's emulated viewport again when the page area changes size; the frame draws the
  device's outline from the same fit. The editor bar takes a row of its own under the toolbar, so
  nothing is ever drawn over a tab's view. (`render-profile-view`, `outline-follows-the-fit`,
  `view-in-frame`, e2e `render-profile-is-tab-scoped`)

## Recorded with audits
- Every audit records the profile its extraction ran under (`seo.getAudit`'s ready answer,
  `renderProfile`: `null` for none; `partial` when the page predates it). The profile is taken when
  the run's extraction starts and travels with that run: it is stored with the audit the run
  produces, so an audit still shown while a newer run is under way keeps its own label. The Overview
  shows it, and the Speed panel's lab-data caveat names it (`profileLabDataNote`).
  (`audit-records-profile`, `held-audit-keeps-its-profile`)

## Page writes (Phase 11 Task 6, under its security review)
- Emulation never writes to the page, with **one stated exception**: **CSS off** (Tab overrides,
  below) sets `disabled` on the top frame's stylesheets and adopted sheets from its own isolated world
  (`TAB_OVERRIDES_WORLD_ID`), and only while the user has the switch on for that tab. It adds no
  element and no attribute, and changes nothing else, but the page can observe it
  (`document.styleSheets[i].disabled`), so the switch's badge says "CSS off (stylesheets)". This is the
  user-requested exception to the page-integrity statements of `devtools.spec.ts` (the drawer "never
  runs script in a page and never edits a page's DOM"), `devtools.feature.md` and
  `STORAGE_USAGE_NOTE`: those still hold for the drawer; CSS off is not the drawer.
- **Cookie block exception** to `web-request.ts`'s rule "no blocking listener on the browse
  session": the rule now reads "none unless a tab of that session has cookies off". While at least one
  tab of a browse-class session has cookies off, `browser/cookie-block.ts` (the only module allowed
  to, Semgrep `webrequest-blocking-outside-allowlisted-modules`) registers a blocking
  `onBeforeSendHeaders` / `onHeadersReceived` pair on that tab's own session (`contents.session`),
  acting only on those tabs' `webContentsId`s (`COOKIE_BLOCK`); the pair goes when the session's last
  cookies-off tab closes or turns it off. Electron's filters cannot select a `webContentsId`, so while
  the pair is registered **every** request of every tab of that session passes through main (answered
  at once for other tabs): "Slightly slows loading in all tabs while on" (`COOKIES_OFF_HINT`).

## Tab overrides (Phase 11 Task 6, Decision 8)
Spec: `render-profile.spec.ts` (`TabOverrides`, `DEFAULT_TAB_OVERRIDES`, `GEOLOCATION_LIMITS`,
`GEOLOCATION_PRESETS`, `TAB_OVERRIDES_WORLD_ID`, `COOKIE_BLOCK`, labels and hints),
`render-profile.schema.spec.ts` (`TabOverridesSchema`, `SetTabOverridesInputSchema`), `browser.spec.ts`
(`TabState.tabOverrides`, `loadedUnderOverrides`, `overridesRevision`, `overridesStatus`).
- **Tab-local, not a profile.** CSS off, cookies off and a browser geolocation are a separate per-tab
  value, `TabOverrides`, held by main (`browser/tab-overrides.ts`) and shown in `TabState`. They are
  not in `RenderProfile` / `RenderProfileSchema`, so they never reach pins, project profiles, lane
  keys (`laneKeyFor`), `storableProfile`, captures or sync; they end when the tab closes, are never
  pinned to a site and are not inherited by a tab opened from it. (`emulation-is-tab-local-and-not-pinned`,
  `emulation-ends-with-the-tab`, `render-profile-schema-rejects-emulation-fields`, `lane-key-unchanged-by-emulation`)
- **One merged command list per tab.** `render-profile.ts` owns, per tab, one list built from the
  effective profile (frost's defaults when there is none) **and** the tab's overrides
  (`entry.tabOverrides`; `entry.emulation` stays the viewport fit), sent whole through
  `ProfileDebugger.send`, so the debugger's child-frame share and its re-attach after a
  Chromium-initiated detach always restore both. The overrides' commands come last:
  `Emulation.setDocumentCookieDisabled`, then `Emulation.setGeolocationOverride` (or
  `Emulation.clearGeolocationOverride`). A profile change re-sends the list (overrides kept); an
  overrides change re-sends it (profile kept). The debugger is attached when either is set and
  detached (`apply()` and Reset) only when the profile is default **and** the overrides are all off.
  `tab-overrides.ts` keeps the state and asks `render-profile.ts` to re-apply; it never talks to the
  debugger. (`emulation-survives-profile-reset`, `emulation-applies-with-default-profile`,
  `profile-change-keeps-emulation-and-child-share`, `emulation-change-keeps-profile`,
  `reattach-restores-emulation`, `detaches-only-when-both-default`, `entry-field-is-tabOverrides-not-emulation`,
  `geolocation-to-tab-and-frames`, `cookies-off-sends-document-cookie-disabled`, `unlisted-method-still-refused`)
- **CSS off** runs a self-contained script in `TAB_OVERRIDES_WORLD_ID` in the **top frame** only: it
  disables every stylesheet and adopted sheet, and watches for new ones (a `MutationObserver`, a
  capturing `load` listener for stylesheets that finish loading, and a periodic sweep for adopted
  sheets) until it is turned off, which re-enables exactly the sheets it disabled. It runs on each new
  document the tab commits while on. Inline `style` attributes, shadow roots' own styles and frames'
  styles stay. Isolated worlds run under JavaScript off, so it works there too. (`world-1701-only`,
  `top-frame-only`, `new-stylesheets-disabled`, `off-reenables`, `works-with-javascript-off`)
- **Cookies off** sends `Emulation.setDocumentCookieDisabled` (in the merged list) and turns on the
  cookie block for the tab (Page writes, above): `Cookie` is removed from its requests and
  `Set-Cookie` from its responses, subframes (cross-site too) and dedicated workers included. The
  `onSendHeaders` observer of the `web-request.ts` hub sees the request **after** the edit, so the
  devtools drawer shows what was sent. (`strips-only-listed-tabs`, `registered-only-while-needed`,
  `removed-on-tab-close-and-switch-off`, `registers-on-the-tabs-own-session`,
  `other-tabs-and-default-session-untouched`, `subframe-requests-of-the-tab-stripped`)
- **Fail-open, on purpose.** Each listener body is `try` / `catch` / `finally`: the `catch` logs one
  line (the listener's name and the error's code or name, never a URL or a header value) and
  swallows the error; the `finally` always calls `callback`, with the edited headers on success and
  `{}` (the request or response passed through unchanged) on error. Electron's filters cannot select
  a `webContentsId`, so the listeners see every tab's requests; an error in the tab lookup cannot tell
  whether the request is a cookies-off tab's, and failing closed would break or log out tabs that
  never asked. Cookies off is an SEO testing aid ("see the page as a cookieless crawler"), not a
  privacy guarantee; `COOKIES_OFF_HINT` says the page's script can still use the Cookie Store API,
  that some requests (service workers) keep cookies and that a request frost cannot apply it to is
  sent as normal. (`listener-always-answers`,
  `listener-error-passes-request-unchanged-and-logs`)
- **Geolocation** sends `Emulation.setGeolocationOverride` (cleared with
  `Emulation.clearGeolocationOverride`); the page still goes through frost's permission prompt.
  Browser geolocation only: not search or IP location, time zone or language.
- **Recorded with audits (the stamp).** Every audit records the tab's overrides when its extraction
  starts, whether or not a profile is set, in a separate weak map (`overridesOf(audit)` beside
  `profileOf` on `AuditProfiles`); the ready `seo.getAudit` answer carries it as `tabOverrides`
  (absent: all off). `AuditRenderProfile`, `auditProfile()`, `recordedProfile` and `laneKeyFor` are
  unchanged. The Overview's profile note shows the overrides. (`audit-stamps-emulation`,
  `audit-stamps-emulation-with-no-profile`, `audit-profile-unchanged-by-stamp`, `get-audit-carries-the-stamp`)
- **The document marker** (`TabState.loadedUnderOverrides`): set when a main-frame document commits,
  or is still loading, while any override is on, and (security-review ruling, stricter than Decision
  8's wording) whenever an override turns on while the tab shows a committed document, even one that
  finished loading (CSS off or cookies off may already have changed what the page did, stored or
  sent); cleared only by a later main-frame navigation to a
  new document during which no override was on at any point from its start to its completion (its
  load finishing). An override on at a navigation's start and turned off before it completes keeps
  it set; setting wins. Same-document navigations and turning overrides off never clear it. A
  main-frame navigation that ends without committing (it fails, or the tab stops loading with no new
  document: a download, a 204) leaves the marker as it was and forgets what it saw, so it never
  taints the next navigation (whole-branch review; `navigation-ending-without-a-commit-forgets-what-it-saw`).
  (`marker-set-when-a-document-loads-under-overrides`, `marker-set-when-an-override-turns-on-after-load`,
  `marker-kept-when-overrides-turned-off`,
  `marker-cleared-only-by-a-clean-navigation`, `marker-kept-when-override-on-at-navigation-start`)
- **The override revision** (`TabState.overridesRevision`) rises on every `tabOverrides.set` of the
  tab and every time the marker is set. (`override-revision-raised-on-change-and-marker-set`)
- **Capture and screenshots refuse** with `tab-emulation-on` (`changes.spec.ts`,
  `screenshot.spec.ts`): Capture now on the audit's stamp, the live overrides or the marker, before
  and after its extraction, and when the revision moved (or the marker got set) before it is stored;
  a screenshot on the live overrides or the marker, and when the revision moved before it is stored
  (no row, no file). Project runs open their own tabs with default overrides and are never refused.
- **Procedure:** `tabOverrides.set({ tabId, overrides })`: `enforceSender` first, then Zod
  (`SetTabOverridesInputSchema`); an id that names no open tab answers `false`.
  (`set-tab-overrides-validates`)
- **Whether they are in effect** (`TabState.overridesStatus`, whole-branch review): tracked apart from
  the profile's status, so it shows with no profile too. `applying` while the list that carries the
  overrides' commands is unanswered, `failed` when the debugger could not be attached (or a
  re-attach after a detach failed) or refused one, else `active` (also when no override has a CDP
  part: CSS off is a page script). Only the latest list's answer settles it.
  (`override-cdp-failure-shown-without-a-profile`)
- **Visible state:** the render-profile toggle is marked while a tab has overrides; the status bar
  shows them (`tabOverridesSummary`), the editor bar holds the three switches with their hints, and
  the Overview's profile note names the overrides an audit ran under. A `failed` status adds
  "· not applied" to the chip and the toggle's name, and the "This tab only" row shows
  `TAB_OVERRIDES_FAILED_NOTE`. (`tab-overrides-failure-shown`,
  `overrides-failure-shown-in-bar-chip-and-toggle-without-a-profile`)

## The page cannot see or defeat it
- No domain that observes the page is ever enabled (resuming a paused cross-site frame with
  `Runtime.runIfWaitingForDebugger` does not enable the Runtime domain), so nothing the page does (console getters,
  `debugger;` statements) reaches frost's session; `navigator.webdriver` stays `false`; the page has
  no API that reaches the debugger, so it cannot detach it — navigating, reloading and crossing
  origins keep it. Under no driver at all, the page sees exactly the emulated device and user agent
  and nothing else. (`emulation-is-invisible-to-page`)

## Procedures
- `browser.setRenderProfile({ tabId, profile, pin })` and `browser.clearRenderProfile({ tabId })`:
  `enforceSender` first, then Zod (`SetRenderProfileInputSchema`, `ClearRenderProfileInputSchema`).
  An id that names no open tab answers `false`. Setting the default profile is a Reset.
  (`render-profile-procedures-enforce-sender`, `set-render-profile-validates`, `clear-render-profile`)

## Electron 45 findings (verified)
- `webContents.debugger.attach('1.3')` works on a tab's WebContents with no remote-debugging switch.
- Electron 45 allows several CDP clients per WebContents: under Playwright (which launches with its
  own CDP connection and auto-attaches to every page target, tabs included) frost's attach succeeds
  and neither session disturbs the other. frost never steals a session: should an attach ever be
  refused, the profile is `failed`, visibly.
- Overrides persist across cross-origin (cross-process) navigations, and frost's session stays
  attached through a renderer crash; detaching clears every override. (Whether every override
  survives a crash was not verified: under Playwright, a probe's reload of a force-crashed tab did not
  finish, with or without frost's debugger attached.)
- `Network.emulateNetworkConditions` works without `Network.enable`; `Network.setCacheDisabled` needs
  it.
- `Emulation.setScriptExecutionDisabled` stops the page's scripts, not frost's isolated worlds: the
  SEO extractor still audits a JavaScript-off page.
- With auto-attach on, a cross-site frame is announced paused (`waitingForDebugger`); resuming it in
  the same turn as the announcement, before its commands answered, left it paused for good (with
  and without Playwright attached), while resuming once they had answered (the paused renderer does
  answer them) or 200 ms later did not. Its profile then reaches its subresources, its
  `navigator.userAgent`, its scripts (JavaScript off) and nested cross-site frames; a dedicated
  worker it starts takes the user agent. `Emulation.setDeviceMetricsOverride` is refused on a child
  ("top-level targets" only); `Network.emulateNetworkConditions` is not supported on a worker.
- Client hints `Sec-CH-UA-*` headers go only to secure (`https:`) origins; `navigator.userAgentData`
  reflects the override everywhere. An empty `Network.setUserAgentOverride` restores the engine's own
  user agent (a profile that keeps its device but goes back to frost's user agent).
- Renderer-side commands (viewport, touch, JavaScript) are not answered until the tab has a renderer:
  a fresh tab (restored, opened from another, or empty) gets one only from its first load, so frost
  never awaits them before loading (see How it is applied).

## Known limits (Phase 11 Task 6 spike, Electron 45, loopback pages)
- **CSS off (Open question 1):** setting `disabled` on `document.styleSheets` and
  `document.adoptedStyleSheets` from world `1_701` takes effect in the page (computed styles fall back
  to the defaults; inline `style` attributes stay), with the page's JavaScript on and off (a
  `MutationObserver` in the world still runs under JavaScript off). The page sees `disabled === true`
  on its sheets. A shadow root's own `<style>` is **not** reached (it is not in `document.styleSheets`)
  and keeps its styling; a `<style>` added later is disabled only by the world's observer.
- **Cookies off (Open question 2):** removing `Cookie` in a blocking `onBeforeSendHeaders` and
  `Set-Cookie` in `onHeadersReceived` on the tab's session takes effect: the server received no
  cookie, and a `Set-Cookie` under the block was never stored. The session's `onSendHeaders`
  observer saw the request **after** the edit (no `Cookie`). `details.webContentsId` was the tab's
  for its main frame, same- and cross-site subframes, images, `fetch`, a dedicated worker's script
  and its `fetch`; it was **absent** for a service worker's script and its `fetch` (so they keep
  cookies), and for frost's own fetches (robots.txt, the served-source fetch), which send no cookies
  anyway. `Emulation.setDocumentCookieDisabled` makes `document.cookie` read `''` and ignore writes.
- **Cookie Store API (security review):** cookies off does **not** reach the Cookie Store API: the
  page's script can still read and write cookies through it (`cookieStore.getAll()` returns the
  session's cookies, `cookieStore.set` writes to the jar every tab shares). No allowlisted CDP method
  turns it off, so `COOKIES_OFF_HINT` says so (e2e `cookies-off-sends-no-cookie-header` pins it).
- **HTTP cache:** a response cached while a tab had cookies off (served for a cookieless request)
  can be reused by a later navigation with cookies on, in that tab or another; "cache off" in the
  render profile, or Clear Browsing Data, avoids it.
- **Geolocation (Open question 3):** after `Emulation.setGeolocationOverride` and the user's Allow in
  frost's prompt, `getCurrentPosition` answered the override's latitude, longitude and accuracy with
  no location provider, also in a cross-site `allow="geolocation"` frame (the top-level session's
  override reached it); after `Emulation.clearGeolocationOverride` it failed again (code 2).
- **Tab-local route (Open question 10):** the overrides never enter `RenderProfileSchema` (strict),
  pins, lane keys, captures, screenshots or sync; see the unit tests named above.

## Command palette (`apps/desktop/src/renderer/__tests__/render-profile-palette.test.ts`)
Registered with `registerPaletteActions` (`command-palette.spec.ts`) in the Page group:
- "Render as …", one per `QUICK_RENDER_PROFILES` entry: sets it as the active tab's own profile
  (`pin` left out: the site's pin, if any, stays), as the editor bar's quick chips do; not offered
  while the tab already has exactly it.
- "Reset render profile": `browser.clearRenderProfile`, offered only while the tab has a profile.
- "Pin profile to this site": `browser.setRenderProfile` with `pin`, offered only for a tab on a web
  page whose profile is not this site's pin yet.
- **Scenario: palette-render-quick-profiles** — one action per quick profile; each sets it on the
  active tab without touching the site's pin and answers a status line; refused, it says nothing
  changed.
- **Scenario: palette-render-availability** — Reset only with a profile; Pin only with an unpinned
  profile on a web page; a quick profile not while it is already the tab's.
- End to end: `palette-runs-a-render-profile` (`command-palette.e2e.ts`).

## End to end (`apps/desktop/e2e/render-profile.e2e.ts`)
- `mobile-preset-viewport-and-ua`: phone + mobile user agent → the page sees `innerWidth` 412 and the
  mobile user agent, and the server gets it.
- `javascript-off-marker-absent`: JavaScript off → after reload a script-written marker is absent
  (and present again after Reset and reload).
- `slow-network-is-slower`: slow 3G → a load is measurably slower than unthrottled.
- `render-profile-is-tab-scoped`: another tab is unaffected; the badge shows only on the profiled tab.
- `emulation-is-invisible-to-page`: no debugger artifacts, and the page cannot detach it.
- `cross-site-iframes-are-emulated`: a cross-site iframe and the cross-site iframe nested in it see
  the emulated user agent and touch points and fetch with it; with JavaScript off neither one's
  script runs.
- `reset-restores-defaults`: Reset → after reload the page sees frost's own user agent and width.
- `pin-persists-across-relaunch`: a pinned site comes back emulated after a relaunch.
- `geolocation-override-after-permission-allow`: a preset location → after the page's prompt is
  allowed, `getCurrentPosition` answers it.
- `cookies-off-sends-no-cookie-header`: cookies off → after reload the server gets no `Cookie` (nor
  does a subresource), a `Set-Cookie` is not stored, and `document.cookie` is `''`; another tab still
  sends its cookies; off again → they are sent.
- `cookies-off-har-shows-no-cookie-header` (Phase 11 Task 13, with the network export of
  `devtools.feature.md`): cookies off and reload → the server gets no `Cookie` (page or image) and
  the HAR export of the new document's requests has no `cookie` header; the control, another tab
  with cookies on while the block is installed, exports both requests' `cookie` header as
  `MASKED_VALUE` (never the value). Electron 45 reports `Cookie` to `onSendHeaders` only while a
  blocking `onBeforeSendHeaders` listener is on the session, so with no tab's cookies off the log
  (and an export) has no `cookie` request header at all, as with `Referer`.
- `css-off-disables-stylesheets`: CSS off → the page's stylesheets are disabled (inline style kept);
  off again → they apply.
- `capture-now-refused-with-emulation`: CSS turned off after a clean audit → Capture now is refused
  `tab-emulation-on` (the live arm).
- `screenshot-refused-with-emulation`: with CSS off a screenshot is refused `tab-emulation-on`.
- `emulation-survives-profile-reset`: a profile and a location → Reset → the location stays in
  effect and the debugger stays attached.
