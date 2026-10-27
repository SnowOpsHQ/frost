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
  `debugger-outside-allowlisted-modules`), and it sends only `RENDER_PROFILE_CDP_METHODS`; anything
  else is refused before it reaches the debugger. (`debugger-refuses-unlisted-method`)
- A profile is sent whole every time, in a fixed order: the Network domain first (`Network.enable`
  with no buffers only while cache-off needs it, else `Network.disable`), then the cache switch, the
  user agent with matching client hints (`Sec-CH-UA-*`, `navigator.userAgentData`: brand, platform,
  mobile), the network condition, device metrics and touch, then the JavaScript switch. Every method
  is on the allowlist. (`cdp-commands-for-profile`, `cdp-commands-are-allowlisted`)
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
- **Pin to this site:** stores the profile for the tab's origin, locally (`render_profile_pins` in
  `@app/db`, at most `MAX_RENDER_PROFILE_PINS`, the oldest dropped). A tab with no profile of its own
  that navigates to a pinned origin takes that pin (`source: site`); leaving the origin drops it again
  (a pin belongs to its site, not to the tab). A tab's own profile wins over a pin. Pins survive a
  relaunch, are forgotten by Clear Browsing Data, and a tampered row is skipped. Pinning or unpinning
  changes another tab already on that site when it next navigates, never under it.
  (`pin-applies-by-origin`, `pins-in-memory`, `render-profile-pins-roundtrip`, `tampered-pin-rows-skipped`,
  `render-profile-pins-capped`, `clear-browsing-data-forgets-pins`, `pin-persists-across-relaunch`)
- **Reset** (`browser.clearRenderProfile`) is one click: the tab's profile goes, and with it this
  site's pin, so the site does not come back emulated. (`reset-clears-pin`, `reset-restores-defaults`)
- **Popups:** a tab opened from a profiled tab (a gesture-backed popup, "Open link in new tab", a link
  from the SEO sidebar) starts with the opener's own tab profile, applied before its first request; a
  pin is not inherited (the new tab's own origin decides). (`popup-inherits-tab-profile`)

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
  `renderProfile`: `null` for none; `partial` when the page predates it). The Overview shows it, and
  the Speed panel's lab-data caveat names it (`profileLabDataNote`). (`audit-records-profile`)

## The page cannot see or defeat it
- No domain that observes the page is ever enabled, so nothing the page does (console getters,
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
- Client hints `Sec-CH-UA-*` headers go only to secure (`https:`) origins; `navigator.userAgentData`
  reflects the override everywhere. An empty `Network.setUserAgentOverride` restores the engine's own
  user agent (a profile that keeps its device but goes back to frost's user agent).
- Renderer-side commands (viewport, touch, JavaScript) are not answered until the tab has a renderer:
  a fresh tab (restored, opened from another, or empty) gets one only from its first load, so frost
  never awaits them before loading (see How it is applied).

## Command palette (`apps/desktop/src/renderer/__tests__/render-profile-palette.test.ts`)
Registered with `registerPaletteActions` (`command-palette.spec.ts`) in the Page group:
- "Render as …", one per `QUICK_RENDER_PROFILES` entry: sets it as the active tab's own profile
  (never a pin), as the editor bar's quick chips do; not offered while the tab already has exactly it.
- "Reset render profile": `browser.clearRenderProfile`, offered only while the tab has a profile.
- "Pin profile to this site": `browser.setRenderProfile` with `pin`, offered only for a tab on a web
  page whose profile is not this site's pin yet.
- **Scenario: palette-render-quick-profiles** — one action per quick profile; each sets it on the
  active tab with `pin: false` and answers a status line; refused, it says nothing changed.
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
- `reset-restores-defaults`: Reset → after reload the page sees frost's own user agent and width.
- `pin-persists-across-relaunch`: a pinned site comes back emulated after a relaunch.
