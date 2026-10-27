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
- The debugger is attached only to a tab that has a profile, and only by main. Reset detaches it,
  which clears every override at once; closing the tab detaches it. A detach main did not ask for is
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
