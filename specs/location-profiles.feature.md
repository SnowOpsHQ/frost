# Location profiles — acceptance (Phase 12 Task 10b)

Spec: `location-profiles.spec.ts` (values), `location-profiles.schema.ts` (shapes); plan
`docs/plans/phase-12-big-bets.md`, Decisions 7 and 11, Global constraints "Partitions" and
"Secrets", Threat model rows "A location tab bypasses its proxy" and "Proxy credentials answer a
site's auth prompt", K-D. Not legally gated (no L-note covers proxies); K-D (the leak test, Task 11)
decides whether proxy locations ship.

## Behaviour
- **A profile** is a label, a scheme (`http` | `https` | `socks5`), a host and a port, in
  `location_profiles` (migration `0244_location_profiles`, no secret column), at most
  `LOCATION_LIMITS.maxProfiles`. It is never synced (`location_profiles` is not in `SYNC_TABLES`).
- **Its sign-in** (`http` / `https` only): a username and password in `location-credentials.json`
  (`createCredentialStore`, `os` protection only, two slots per profile, each blob sealed to its
  slot, 0600, atomic). The renderer sends them once and learns `hasCredentials` only. A `socks5`
  profile with either is refused (`socks-credentials`): Chromium does not authenticate SOCKS proxies.
  Changing a profile's scheme, host or port (or to `socks5`) removes the stored ones **first**,
  before the row, its tabs or its partition change; if they cannot be removed the edit answers
  `failed` and nothing changes (a sign-in is never sent to a proxy it was not saved for). A new
  sign-in that fails to store leaves no half behind: both slots are cleared, the new username and any
  older password alike (removed again; a failure to remove it is logged).
  `weak` / `unavailable` protection refuses to store one (`no-keychain`) and the stored ones are
  treated as absent. On a plain `http` proxy the sign-in travels unencrypted: Settings and the README
  recommend an `https` proxy when one is needed (`LOCATION_HTTP_SIGN_IN_NOTE`).
- **Its partition**: `frost-location-<profileId>`, in memory (never `persist:`). At its first tab
  main calls `session.setProxy({ mode: 'fixed_servers', proxyRules: '<scheme>://<host>:<port>' })`
  and awaits it (no `proxyBypassRules`: Chromium's implicit loopback bypass stays; no `direct://`
  fallback), then registers the session as browse-class (`registerBrowseClassSession`): every Task
  10a installer runs on it (main-frame and request observers, guard, permission handlers, downloads
  cancelled). Only then is the tab created, so its WebContents is classified as a tab at creation.
  If `setProxy` or the registration fails, no tab opens (`failed`). Before any of that (once, when
  the partition's session is first taken) its spellchecker is turned off: `setSpellCheckerLanguages([])`,
  then `setSpellCheckerEnabled(false)` (Electron turns spellcheck on whenever languages are set), so
  Chromium never loads or downloads a dictionary for it: a location session makes no request the
  user did not ask for (whole-branch review).
- **A location tab** is created on that partition (`createTabView(partition)`), and its WebContents
  gets `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` in the same call, before any
  navigation. A tab the page opens (`window.open`, `target=_blank`: the guard denies the popup and
  opens a background tab) and a link opened from the tab's panels (`openBackgroundTab`: a sidebar
  link, a SERP result destination, robots.txt or a sitemap; the render profile is inherited only with
  `inherit`) are location tabs of the same profile; a tool ("Open in", `openTool`) opens on the
  user's own connection. Its `TabState.location` is `{ profileId, label }`, set at creation only.
- **Permissions** (security review, lead ruling): in a location session (`location/sessions.ts`
  marks it before it joins the browse class) `geolocation` is denied outright, request and check,
  whatever was decided elsewhere; every other permission is asked afresh: its decisions are keyed by
  the session's context (`location:<profileId>:<generation>`), never persisted, never matched by a
  home decision (and home never matches them), and end when the partition is reset or retired
  (`LOCATION_PERMISSIONS_NOTE` in Settings and the README). Clear Browsing Data forgets them too.
- **The badge** shows on every location tab in the strip, active or not, and is never shrunk or cut:
  the title is cut first. There is no status-bar badge.
- **Ephemeral**: its visits are never recorded (no `recordVisit`, no `updateVisitTitle`), it is
  left out of the saved session, and Reopen Closed Tab reopens it (same profile, same partition) only
  within the run; a profile edited or removed drops its closed tabs.
- **Editing or removing a profile** closes its tabs, clears the partition's storage and cache
  (service workers too) and closes its connections, and forgets its credentials. Remove forgets the
  sign-in **first** and answers `failed` (nothing removed, the user retries) if it cannot; edit as
  above. Edit sets the new proxy before the next tab; remove retires the
  partition for the run (never registered or used again). A removed partition's proxy is **not**
  set to `direct` (fail closed: anything that outlived the clear can only reach the old proxy, which
  no longer gets a sign-in).
- **Proxy authentication** (`location/proxy-auth.ts`): one `app` `login` listener. It answers only
  when `authInfo.isProxy` is true, `webContents` is a live WebContents whose `session` is that
  profile's partition, `authInfo.host:port` equals the profile's (`proxyAuthKey`), and
  `authenticationResponseDetails.firstAuthAttempt` is true (a rejected sign-in is not retried in a
  loop). It then calls `callback(username, password)` from inside the key store's `withKey` closure.
  Everything else (a site's 401, another partition, another host or port, no webContents, no stored
  sign-in, a second attempt) is cancelled: `preventDefault()` and `callback()` with no arguments,
  which Electron documents as cancelling with the auth error returned to the page.
- **SERP**: the SERP service adds `location: { via: 'proxy', label }` to a location tab's result
  page parameters after `matchSerp`, so its readings, Phase 6 lane and Phase 10 search key differ
  from the home connection's.
- **Capture and screenshots** refuse `location-tab` on a location tab unless the page's search
  parameters carry `location`; a home tab is unaffected.
- **Sync**: rows whose `search_params` carry `location`, and diffs into such versions, stay on this
  device (`sync-engine.feature.md`, location-rows-stay-device-local).
- **Clear Browsing Data** clears every browse-class session, location partitions included.
- **What is not proxied** (Settings, README, `LOCATION_NOT_PROXIED_NOTE`), all from the user's own
  connection:
  - Chromium's implicit bypass: localhost, loopback and link-local addresses (literals and
    `localhost` names) are reached directly;
  - frost's own fetches for a location tab (Decision 11), through the browse session's bounded
    fetchers: robots.txt, the served HTML, the visibility probes, and on request the link, sitemap
    and hreflang checks;
  - a site crawl started while a location tab is in front (the crawl lane is the browse session's);
  - "Open in" tools (third-party sites, `openTool`).
  SERP result destinations opened from a location tab's panels stay in the location (above).

## Electron and Chromium, as verified (Q6, Q7)
Read on 2026-11-10 from Electron 45's own typings (`node_modules/electron/electron.d.ts`, "Type
definitions for Electron 45.0.0") and Chromium's `net/docs/proxy.md`
(https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md). No spike was run here;
Task 11's leak test is the check.
- **Q7, the `login` event.** `app.on('login', (event, webContents | null,
  authenticationResponseDetails { url, pid, isRequestForNavigation, firstAuthAttempt }, authInfo
  { isProxy, scheme, host, port, realm }, callback(username?, password?)))`: "Emitted when
  `webContents` or Utility process wants to do basic auth. The default behavior is to cancel all
  authentications." `webContents.on('login', …)` has the same arguments minus `webContents` and is
  emitted first; frost installs none, so the `app` event is the one place. `ClientRequest` and utility
  processes have their own `login` events, which frost does not use. Nothing in the typings ties the
  event to a session, so the partition is decided from `webContents.session`; a request with no
  WebContents (a service worker) is cancelled. HTTPS proxies use the same flow (Chromium: "HTTPS
  proxies … support the same HTTP authentication schemes", plus client certificates, which frost
  does not offer).
- **Q6, coverage of `fixed_servers`.** A single URI-format proxy (`<scheme>://host:port`) fills
  Chromium's "other proxies" list, which is used for `http:` and `https:` and, by Chromium's rule for
  WebSockets, for `ws:` / `wss:` too. With an HTTP or HTTPS proxy "name resolution is always
  deferred to the proxy"; with SOCKS5 "name resolution is always done proxy side" and "SOCKSv5 is only
  used to proxy TCP … It cannot be used to relay UDP traffic", and Chromium supports no SOCKS5
  authentication. No `direct://` fallback is given, so an unreachable proxy fails the request rather
  than going direct.
- **Loopback bypass.** Chromium's implicit bypass rules match only `localhost`, `*.localhost`,
  `[::1]`, `127.0.0.1/8`, `169.254/16`, `[FE80::]/10`, `0.0.0.0/32`, `[::]/128` and
  `[::ffff:0.0.0.0]/128`, and IP-range bypass rules apply to URL **literals** only (a name is never
  resolved to decide). So a public-looking name is proxied even if it would resolve to loopback.
- **Not verified from documents** (Task 11's spike decided; results under "Observed (Q6)" in End to
  end below): whether DNS-over-HTTPS or the host resolver issues any lookup for a proxied name (the
  docs above say resolution is deferred to the proxy, which implies none); whether
  `--host-resolver-rules` touches the proxy's own name resolution (the e2e uses a loopback literal
  for the proxy, so it does not matter there); whether `disable_non_proxied_udp` leaves any host
  candidate (Chromium's policy name says only proxied UDP, and neither proxy scheme relays UDP, so
  WebRTC should gather no UDP candidate at all).

## Tests (unit, `apps/desktop/src/main/location/__tests__/` unless noted)
- **location-session-is-browse-class** — before a profile's first tab its partition's session is
  not browse-class; after `ensure` it is (registered after `setProxy` resolved, never before); the
  default session and `frost-data-api` stay app-class.
- **location-session-has-browse-wiring** — every installer added with `onBrowseClassSession` ran
  once on the location session.
- **location-partition-is-in-memory** — the partition is `frost-location-<id>`, never `persist:`.
- **location-session-has-no-spellchecker** — `ensure` sets no spellchecker languages, then disables
  the spellchecker, before `setProxy` and the registration; once per partition (a second tab or a
  reset never turns it on again).
- **proxy-login-only-for-its-proxy** — the profile's own proxy on its partition, first attempt:
  answered with the stored sign-in; a wrong host or port, a site's 401 (`isProxy: false`), another
  partition (the browse session or another profile's), no webContents, a second attempt, no stored
  sign-in: cancelled (`preventDefault` and `callback()` with no arguments).
- **no-login-listener-cancels** — today's behaviour pinned: no module under `main/` but
  `location/proxy-auth.ts` listens for `login`; with no profile prepared the listener cancels every
  `login` it gets.
- **location-credentials-never-leave-main** — the IPC view has `hasCredentials` only (strict
  schema, no username or password), the row has no secret column, the log lines carry neither,
  `weak` protection refuses to store (`no-keychain`), and `socks5` refuses credentials.
- **location-tab-webrtc-proxied-only** — `createTabView(locationPartition)` sets the policy before
  returning (before any load); the controller creates the first tab, a second tab of the same
  profile and a tab the page opens on that partition, each with the policy before its first
  `loadURL`; a home tab keeps the default (`browser/__tests__/location-tabs.test.ts`).
- **cookie-block-on-a-location-tab** — cookies off on a location tab registers the blocking pair on
  that profile's session and strips `Cookie` / `Set-Cookie` there, as on the browse session.
- **location-rows-stay-device-local** — `sync/__tests__/engine.test.ts` (see `sync-engine.feature.md`).
- **clear-browsing-data-covers-location-partitions** — `clearBrowseStorage` clears the browse
  session and a prepared location partition.
- **location-tab-not-in-history-or-session** — a location tab's commits record no visit and no
  title; the saved session leaves it out (the active index counts saved tabs only); Reopen Closed Tab
  reopens it on its profile within the run, and not after its profile is forgotten
  (`browser/__tests__/location-tabs.test.ts`).
- **serp-params-carry-the-tabs-location** — `serp/__tests__`: a location tab's reading carries
  `location: { via: 'proxy', label }`; its lane key and Phase 10 search key differ from the same
  search's on a home tab.
- **location-tab-captures-only-result-pages** — `changes/__tests__/service.test.ts` and
  `screenshots/__tests__/service.test.ts`: on a location tab a result page whose parameters carry
  `location` is captured and screenshotted; an ordinary article in the same tab is refused
  `location-tab`, nothing stored; a home tab is unaffected.
- **location-badge-always-visible** — renderer: every location tab in the strip shows the badge,
  active or not, outside the cut label, with no width cap or ellipsis; a home tab shows none.
- **location-geolocation-denied** — a home Allow for geolocation does not apply in a location tab,
  which is denied geolocation without a prompt (request and check).
- **location-permissions-not-persisted** — a location tab's Block or Allow is never written, a home
  Block does not apply there (it is asked afresh), and its answers end with a partition reset.
- **location-forget-failures-change-nothing** / **location-create-failed-sign-in-leaves-nothing** —
  the credential ordering above, each failure path.

## End to end (Task 11)
`apps/desktop/e2e/location.e2e.ts`, against loopback fakes only (K-D). The design below is meant to
give a clean yes/no: the disclosed direct traffic is made visible and accounted for, not avoided.
- **Names.** The fake site is served on a loopback port under a public-looking name (e.g.
  `site.frost-e2e.test`), over plain HTTP, so Chromium's implicit bypass (literals and `localhost`
  names only) does not apply and the request is proxied. The same name **is** in
  `--frost-e2e-public-hosts` (`E2E_PUBLIC_HOSTS_SWITCH`), so the disclosed direct audit fetches
  (robots.txt, the served HTML; the checks if run) are allowed by the bounded fetcher and **do** reach
  the tripwire, where they are counted and classified. The profile's proxy is
  `apps/desktop/e2e/fake-proxy.ts` (`startFakeProxy`) on `127.0.0.1:<port>`, a literal (its own
  address needs no resolution).
- **The proxy resolves.** Behind an HTTP proxy the proxy resolves names, so `startFakeProxy` maps
  the public-looking name to the real loopback origin itself (`hosts`; loopback literals only),
  for plain HTTP (absolute-form) and `CONNECT`, and adds the marker `x-frost-e2e-via: proxy` to every
  request it forwards over plain HTTP. It requires Basic auth when given `auth` (407 with
  `Proxy-Authenticate: Basic realm="frost-e2e"`).
- **The tripwire.** `--host-resolver-rules="MAP site.frost-e2e.test 127.0.0.1:<tripwire port>"`
  points the same name, resolved directly, at a tripwire. Task 11 extends `startTripwire` from a
  connection counter into a recorder: it parses each HTTP request (method, path, and the headers
  `user-agent`, `accept`, `upgrade-insecure-requests`, `sec-fetch-mode`, `sec-fetch-dest`,
  `sec-fetch-site`, `cookie`), records it, and answers 404 with no body.
- **The classifier** (each recorded tripwire request is one of):
  - *disclosed audit fetch*: `GET /robots.txt`, or `GET` of exactly the location tab's page URL with
    `accept` equal to `SERVED_ACCEPT` (`seo-javascript.spec.ts`, the served HTML), and, for both, no
    `cookie`, no `upgrade-insecure-requests`, no `sec-fetch-*`, and the user agent the audit uses
    (`browseSession.getUserAgent()` or the tab's render-profile UA). The bounded fetcher
    (`seo/fetcher.ts` `netHop`) is `net.request` with `credentials: 'omit'`, `useSessionCookies:
    false`, and sets only `User-Agent` and `Accept`;
  - *leak*: anything else. In particular a navigation (Chromium sends
    `upgrade-insecure-requests: 1` on navigations), any path under `/leak-probe/` (the page under
    test references `/leak-probe/img.png`, `/leak-probe/script.js`, a `fetch('/leak-probe/fetch')`
    and a WebSocket to `/leak-probe/ws`: only the renderer ever asks for them), and anything with a
    `cookie`.
  - Chromium sends `sec-fetch-*` only to potentially trustworthy origins (HTTPS or `localhost`), so on
    this plain-HTTP name their absence proves nothing by itself: the classifier never relies on it.
    If the Task 11 spike shows any doubt (an audit fetch that cannot be told from a renderer request),
    the bounded fetcher gets an unpackaged-only marker header under the same e2e seam (e.g.
    `x-frost-e2e-fetcher: audit`, set only when `E2E_PUBLIC_HOSTS_SWITCH` is given) and the classifier
    keys on it instead.
- **Pass** (K-D) = (1) the tripwire saw no *leak*; (2) every request the real origin logged carries
  the proxy marker; (3) the proxy logged a 407 then an authenticated request for the first page load;
  (4) a WebRTC candidate gathered in the location tab (`RTCPeerConnection` with a loopback STUN fake,
  read from the page) carries no host or server-reflexive address; (5) the NetLog check below. Any
  miss: **do not ship proxy locations**.
- **NetLog: no local resolution of the proxied name.** Electron documents the Chromium switch
  `--log-net-log=<path>` (command-line switches) and, per session, `session.netLog.startLogging(path)`
  (`electron.d.ts`: "A `NetLog` object for this session"). Task 11 starts it on the location
  partition's session through an unpackaged-only seam (or passes the switch to the e2e launch), loads
  the page, stops it, and asserts that no `HOST_RESOLVER_*` job (`HOST_RESOLVER_MANAGER_JOB`,
  `HOST_RESOLVER_DNS_TASK` and the like) names `site.frost-e2e.test` **within the location
  partition's requests**, and that every `URL_REQUEST` for that name in it resolved its proxy to
  `PROXY 127.0.0.1:<port>`, never `DIRECT`. Caveat: whether a session's NetLog holds only that
  network context's events is not stated in the docs; if it is global (the browse session's disclosed
  fetches resolve the same name, through `netResolver`), the assertion is narrowed to the
  `URL_REQUEST` sources of the location tab (their `PROXY_RESOLUTION_SERVICE` result and any
  dependent resolver job, followed by source id), which the Task 11 spike confirms.
- Also: the badge shows; a result-page capture records the location; Capture on an ordinary article
  in the same tab is refused `location-tab`; geolocation in the tab is denied.

### As built (`apps/desktop/e2e/location.e2e.ts`, Electron 45, Linux, 2026-11-10)
One app, one in-memory profile; the scenarios run in order. The site and the synthetic engine
(`serp-fixtures.ts`, `SEARCH_HOST`) share one loopback origin; the proxy (`startFakeProxy`, Basic auth)
maps both names to it; `--host-resolver-rules` maps `site.frost-e2e.test` (port included) to the
tripwire and `SEARCH_HOST` to the origin (main fetches the test pack from it directly). The proxy
sign-in is stored through Settings with the shared test-only keychain stand-in (`fake-keychain.cjs`,
Linux only: Playwright's `--password-store=basic` would leave frost `weak` protection).
- **location-profile-opens-a-badged-tab** — a profile (HTTP proxy, sign-in) is added in Settings ›
  Locations, the page never shows the password; New tab opens an active tab whose strip badge reads
  `LOCATION_BADGE.text(label)` with `LOCATION_BADGE.title(label)`.
- **location-leak-test-k-d** — the tab loads `http://site.frost-e2e.test:<port>/page` (an image, a
  script, a `fetch` and a WebSocket, all under `/leak-probe/`), a NetLog of the location partition
  runs meanwhile (`session.netLog.startLogging`, from the test through `app.evaluate`), the audit's
  disclosed fetches are awaited on the tripwire, and a WebRTC probe runs in the tab. Pass (1)–(5)
  above, as asserted:
  1. every tripwire request is classified (`classifyTripwireRequest`); none is a leak, and both
     disclosed kinds are there (`GET /robots.txt`, and `GET /page` with `SERVED_ACCEPT`, the browse
     user agent, no cookie, no `upgrade-insecure-requests`, no `sec-fetch-*`). No marker header on
     the bounded fetcher was needed: path, `Accept`, user agent and the absent navigation headers tell
     the two apart;
  2. every request the origin logged for the site carries `x-frost-e2e-via: proxy`, except the
     WebSocket upgrade, which arrived inside a `CONNECT` tunnel: the proxy records the local port of
     its own connection to the origin (`FakeProxyRecord.upstreamPort`), and the origin matches it;
  3. the proxy's first answer for the site was 407, then the page came through signed in;
  4. the location tab's ICE gathering completed with no candidate at all and no datagram reached the
     loopback STUN fake;
  5. NetLog: every `HTTP_STREAM_JOB_CONTROLLER` for the site's name in the location tab resolved to
     `PROXY 127.0.0.1:<proxy port>` (the page, each `/leak-probe/` resource and the `ws://` socket); the
     only `DIRECT` ones are the disclosed audit fetches (`/robots.txt`, `/page`, privacy mode
     `enabled`: the bounded fetcher omits credentials, a renderer request does not); no
     `HOST_RESOLVER_*` event names the site.
- **location-webrtc-probe-is-not-vacuous** — the same probe in a home tab (a loopback-literal page)
  yields a candidate or a STUN datagram (here: an mDNS `.local` host candidate and STUN binding
  requests), so the location tab's empty answer is the policy's doing. A machine whose home tab
  gathers nothing at all (no usable interface, or macOS Local Network privacy blocking the mDNS host
  candidate) records an annotation and skips the check with its reason instead of failing; where
  anything was gathered the assertion holds.
- **location-result-page-capture-records-the-location** — with the test pack installed, the result
  page loads in the location tab (its own request carried the proxy's marker), the SERP panel reads
  it, Capture now stores the first version, and that `ci_versions` row's `search_params` carry
  `location: { via: 'proxy', label }` (read from the session database).
- **location-capture-refuses-an-ordinary-article** — an article on the site in the same tab: Capture
  now answers `LOCATION_TAB_REFUSAL_MESSAGE` (`refused`), no version is stored, the article came only
  through the proxy and the tripwire still holds no leak.
- **location-tripwire-catches-a-direct-load** — the control: the site's page loaded in a home tab
  goes direct, reaches the tripwire as a navigation (`upgrade-insecure-requests: 1`) and is
  classified a leak, so the tripwire and the classifier can fail.
- Not run end to end: geolocation (the fixture is plain HTTP, an insecure context where Chromium
  denies geolocation anyway, so the e2e could not tell frost's denial apart; the unit tests
  `location-geolocation-denied` cover it).

### Observed (Q6, K-D)
**K-D verdict: pass.** No leak: the tripwire saw only the disclosed audit fetches, every origin
request came through the proxy, WebRTC gathered nothing, and no stream for the name went direct
from the location tab.
- **DNS.** With an HTTP proxy the location tab never resolved the site's name: its streams went to
  the proxy, whose connect jobs resolve only the proxy's IP literal, and no host resolver event in the
  NetLog names the site; no DNS-over-HTTPS or DNS task for the name appeared. Caveat: under
  `--host-resolver-rules` Chromium rewrites a mapped name before the resolver sees it, so even the
  browse session's direct audit fetches log no resolver event naming the site; the no-resolver check is
  weak alone, and the per-stream proxy decision (`PROXY` vs `DIRECT`) with the tripwire is the evidence.
- **The NetLog is global.** `session.netLog` on the location partition captured the whole network
  service (the browse session's audit fetches are in it too), so the assertion is narrowed by stream:
  URL, proxy decision and privacy mode, as the design's caveat foresaw.
- **WebSocket.** A `ws://` socket from the location tab goes to the proxy as a `CONNECT` tunnel, signed
  in from the session's cached proxy sign-in (no second 407), and its NetLog stream is `PROXY`.
- **WebRTC.** `disable_non_proxied_udp` with an HTTP proxy: no candidate at all (no host, mDNS, srflx
  or relay) and no STUN traffic; a home tab gathers an mDNS host candidate and sends STUN requests.
- **Loopback bypass and host rules.** A public-looking name mapped to loopback is proxied (the implicit
  bypass matches literals and `localhost` names only), and `--host-resolver-rules` did not affect the
  proxy itself (a loopback literal).
- **Seen in passing, not a leak.** On some runs the proxy log also held a `CONNECT
  redirector.gvt1.com:443` from the location partition, most likely the spellchecker's dictionary
  download for the new session (Electron's default dictionary URL is on that host; frost sets none). It went to the profile's proxy (never direct), got the 407, and frost's `login`
  listener cancelled it (no WebContents). Follow-up for the owner: whether frost should download
  spellchecker dictionaries at all (the browse session likely does the same, directly, on Linux and
  Windows; not checked here).
