# Feature: page speed (Page Speed panel)

Spec: `specs/seo-speed.spec.ts` (`SPEED_WORLD_ID`, `SPEED_STATE_KEY`, `VITAL_METRICS`,
`VITAL_THRESHOLDS`, `SPEED_LIMITS`, `SPEED_SETTLE_MS`, `SPEED_MEASURE_TIMEOUT_MS`, `SPEED_POLL_MS`,
`SPEED_LIVE_MAX_POLLS`, `SPEED_MIN_INTERVAL_MS`, `SPEED_UNAVAILABLE_REASONS`, `RESOURCE_TYPES` and
their classification, `THIRD_PARTY_RULE`, the rule thresholds, `PERFORMANCE_RULE_SPECS`,
`SNAPSHOT_PERFORMANCE_RULES`), `specs/seo-speed.schema.spec.ts` (`PerformanceMeasurementSchema`,
`BlockingScriptsSchema`), `specs/seo-rules.spec.ts` (the `performance` category) and
`specs/seo-sidebar.spec.ts` (the Speed panel). Phase 2 Task 5. Each line maps to one named test.

## Lab data, not field data
Every value is **one visit, measured in this tab on this machine**, with its cache, network and CPU.
It is not what real visitors experience (field data, the 75th percentile of
many visits on many devices), which can be very different. The panel says so under the verdict
(`LAB_DATA_NOTE`), and every measured rule's condition says so too.

## Decisions
- **web-vitals in an isolated world of its own.** `web-vitals` (Apache-2.0, unmodified, the IIFE build)
  is bundled into main as a string (`vite.web-vitals.ts`: the package's `exports` do not expose the
  IIFE, so a Vite plugin reads it from the installed package and serves it as
  `virtual:web-vitals-iife`; the chrome's bundle never contains it). Main injects it with
  `executeJavaScriptInIsolatedWorld(SPEED_WORLD_ID, …)`, never into the main world and never into the
  chrome (review focus `measurement-runs-isolated`). Its own world, not the extractor's
  (`SEO_WORLD_ID`): the library's module state and frost's observers live there for the document's
  lifetime, kept in the world's global `SPEED_STATE_KEY` (non-enumerable, not writable). The IIFE is
  wrapped in a function, so even in that world `webVitals` is a local, not a global.
- **It works in an isolated world (verified in Electron 45 / Chromium 156).** Performance entries
  belong to the document, not to a JavaScript world, so the isolated world's own
  `PerformanceObserver` sees the same paints, LCP candidates, layout shifts, event timings and
  resource timings the page does; web-vitals runs unchanged (no fallback observer was needed). The
  page cannot replace or wrap the `PerformanceObserver`, `performance` or DOM functions the isolated
  world uses (each world has its own globals and prototypes), cannot read the library's state, and
  sees no global, observer or listener of it. It does share the document, so it can still influence
  the measurement through it: it can dispatch events on the shared `window` / `document`, clear the
  timing buffers or change the DOM. frost limits that where it can: in the speed world only the
  browser's own (`isTrusted`) `TRUSTED_ONLY_EVENTS` reach any listener (the world's
  `EventTarget.prototype.addEventListener` / `removeEventListener` are wrapped before the library
  loads and stay wrapped: only frost's code runs there, and the library adds some of these listeners
  later), so a synthetic `pageshow` cannot restart the metrics; and the observers start at
  `dom-ready` (below). What remains is noted in the panel.
- **Early attachment, buffered.** Main primes the collector at `dom-ready` of the active tab's
  document (install only: `CollectOptions.prime`), so a page that clears its resource timings later
  (`performance.clearResourceTimings()`) no longer hides its requests; a tab measured later (a
  background tab once shown) is installed by its first collection. Installing sets up web-vitals
  with `reportAllChanges: true` (every new value is kept) and a `resource` observer, both with
  `buffered: true` observers, so a late start still sees FCP, LCP, layout shifts and earlier
  resources. TTFB comes from the navigation entry. The buffered entries arrive asynchronously: the
  state holds a settle promise for `SPEED_SETTLE_MS`, and every collection made meanwhile (concurrent
  first runs included) awaits it; later ones answer at once.
- **Background tabs (main owns the signal).** frost's background tabs are detached views: they report
  `visible` and paint only when shown, so web-vitals alone would measure "time until the user
  switched". Main records per tab's WebContents when the current document was first shown (its view
  attached; at commit, the time the view has been attached since) and first hidden after that
  (`vitals-shown.ts`), and passes both with every collection. A document whose `timeOrigin` precedes
  its first-shown time by more than `SHOWN_TOLERANCE_MS`, or that was hidden before its first
  contentful paint, `loadedHidden`: FCP, LCP and CLS are dropped (`null`, so no finding, live or in
  the audit) and their cards say `LOADED_HIDDEN_HINT`. TTFB and INP stay.
- **Less work per poll.** Each collection answers only the resources added since the ones main
  already holds (`since` / `epoch`); main puts the list back together (`reassemble`: it checks only
  the answer's shape and caps the list, never reads a record) before the worker validates the whole
  measurement (`resourceOffset` is always 0 there). The DOM's element count, depth and fetching
  elements are recomputed on the first collection and every `DOM_REFRESH_EVERY` after.
- **Route changes.** The vitals and the navigation timing belong to the page load (the hard
  navigation); the panel labels them `SINCE_LOAD_LABEL`. When the URL changes inside the document
  (a route change; a fragment does not count) the collector starts a new resource epoch: the
  requests are counted from that change and the panel says so (`SOFT_NAVIGATION_NOTE`). The
  epoch's boundary is set when the URL changes, not at the next collection: the world listens for
  the Navigation API's trusted `currententrychange` (it fires inside `pushState` / `replaceState`,
  before the route's own requests start; verified in Electron 45's isolated worlds), and without it
  the resource observer and each collection check the URL, the boundary then being the last time the
  old URL was seen. Requests that started at or after the boundary belong to the new route (also
  those observed before the next collection); earlier ones belong to the old route and are dropped.
- **Metric limits.**
  - INP needs interactions: until the user clicks, taps or types in the page there is none, and the
    card says `INP_HINT` ("Interact with the page to measure INP"). Interactions before the first
    collection only count if the browser buffered them (long ones).
  - LCP stops at the first input or scroll (by definition), and Chromium leaves low-entropy images
    (placeholders, flat colours) out of it.
  - A page that was hidden before its first paint (opened in a background tab) has no meaningful
    paint metrics: see Background tabs; the panel says to re-measure (`loadedHidden`).
  - On some Linux Wayland compositors Chromium receives no presentation feedback and records no
    paint timing at all, in any world: no FCP, no LCP and no CLS (web-vitals reports CLS only after
    FCP). Main detects a native Wayland ozone platform (`nativeWayland`: Linux with
    `--ozone-platform=wayland`, or `auto` / unset in a Wayland session, unless the hint says x11);
    when no paint entry exists `PAINT_GRACE_MS` after the load event the measurement says
    `paintUnavailable`, the verdict card shows `WAYLAND_PAINT_NOTE` (with the hint to launch with
    `--ozone-platform=x11`) and those cards say `WAYLAND_HINT`. frost does not force X11; the e2e
    suite runs the app with `--ozone-platform=x11` on Linux.
  - Requests made inside iframes are not counted (`IFRAME_NOTE`: each frame has its own timeline).
  - Cross-origin responses without `Timing-Allow-Origin` report 0 for every size: they count as
    requests but not in byte totals, and show as "size unavailable" (`SIZE_UNAVAILABLE_NOTE`).
  - The browser's resource timing buffer holds 250 entries by default; a page that made more
    requests before the collector observed may have lost some (`bufferFull`: 250 or more entries
    at install, or a `resourcetimingbufferfull` event since; approximate when the page changed its
    buffer size; said in the panel, `BUFFER_FULL_NOTE`). After install, the observer receives every
    request, whatever the buffer does.
  - Too few requests: when the requests observed are far fewer than the page's fetching elements
    suggest (`LOW_RESOURCES_MIN_HINTS`, `LOW_RESOURCES_RATIO`: cleared timing entries, the memory
    cache) the panel says so (`LOW_RESOURCES_NOTE`). A note, never a finding.
- **Caps** (`SPEED_LIMITS`). The collector keeps the first `maxResources` requests itemised (URL cut to
  `maxResourceUrlChars`, `urlCut` says so: such a URL is shown, never opened) and only sums the rest
  (`overflow`), so totals stay complete; every number is clamped; the DOM's depth comes from a walk
  of at most `maxDomWalk` elements in `domWalkBudgetMs`.
- **Validation in the worker.** Main never parses the measurement: it posts it to the analysis
  worker (`{ id, kind: 'speed', raw }`, the same worker, queue and `ANALYSIS_TIMEOUT_MS` as audits),
  which parses it with `PerformanceMeasurementSchema` (strict) and summarises it (`speedReport`). The
  audit's own measurement travels in the page's context and is parsed there separately: an invalid
  one is dropped (no measured rule fails), the audit still runs.
- **Two measurements.** The audit takes one beside the snapshot (`collectContext`, at most
  `SPEED_MEASURE_TIMEOUT_MS`): its findings feed the health score and the Speed rail dot. The audit
  never waits for it: like robots.txt it is an input that may arrive later
  (`seo/context-source.ts`), so the page is analysed at once without a measurement (the audit's
  `performance` is `null`, no measured rule fails) and analysed again, once, when it and every other
  input have settled (within `CONTEXT_TIMEOUT_MS`), if the run is still current; that bumps the
  tab's `auditVersion`. A reload or re-score keeps the audit on screen until the final one. While the
  Speed panel is open the chrome polls `seo.measureSpeed` for live values; the panel shows the live
  report (with its own measured findings) and falls back to the audit's, and labels which it shows
  (`SPEED_SOURCE_LABELS`: Live / At audit time; with the live one, `SCORE_SOURCE_NOTE`: the health
  score and the rail dot use the audit-time measurement). Render-blocking scripts are
  read by the extractor (the snapshot), so that finding always comes from the audit.
- **Live updates, bounded.** The chrome polls every `SPEED_POLL_MS` after each answer (never two at
  once) and pauses after `SPEED_LIVE_MAX_POLLS` (Resume starts another run). A poll session is one
  tab, one URL and one document (the tab's `documentSeq`): switching tabs, navigating, reloading
  (toolbar, menu or shortcut: the same URL, a new document), leaving the panel or collapsing the
  sidebar ends it, and its late answers are dropped; a reload of a paused session starts a fresh,
  unpaused one, so the old document's live report is never shown over the new audit's. Main measures only the active tab, shares a collection in
  flight, answers the last measurement again sooner than `SPEED_MIN_INTERVAL_MS`, never stacks a
  collection on a page that has not answered the previous one (`timeout`), and drops what it measured
  at each new document (`did-navigate`) or URL: a late answer is never shown against another page.
- **Re-measure** reloads the page (`browser.reload`): a new document, a new audit, a fresh
  measurement.
- **Bands and severities.** The bands are the publicly documented Core Web Vitals thresholds
  (`VITAL_THRESHOLDS`). Poor is a **warning** and needs-improvement is **info** (good passes): a lab
  value from one visit is a strong hint, not proof. The lab verdict is the worst band of the Core
  Web Vitals that were measured (LCP, CLS, INP; FCP and TTFB are diagnostics).
- **Licenses.** web-vitals (Apache-2.0) and axe-core (MPL-2.0) are used unmodified (the scripts
  hold the published files' exact bytes; web-vitals without its source-map comment). The packaged
  app ships `resources/THIRD_PARTY_NOTICES` (`packagerConfig.extraResource`), generated from the
  installed packages' own license files by `apps/desktop/third-party-notices.ts` and committed:
  web-vitals' full Apache-2.0 text, axe-core's MPL-2.0 notice with where to get its source (the npm
  tarball and the repository) and its license and third-party notices, then the other bundled
  runtime packages (react, react-dom, scheduler, @trpc/client, @trpc/server, zod, drizzle-orm). A test
  fails when the committed copy is stale (`pnpm --filter @app/desktop notices` rewrites it).
- **The panel is inert.** URLs are React text (`PageText`); "Open in new tab" asks main
  (`browser.openBackgroundTab`, http(s) only, never for a cut URL). Bars and markers are SVG `<rect>`
  elements sized by their attributes (React sets attributes, not styles): no `style=` anywhere, so the
  chrome's CSP holds.

## Bands, rules and summary (`packages/seo-core/src/__tests__/performance.test.ts`)
- **Scenario: performance-rules-in-catalog** — 15 rules, category `performance`; poor rules are
  warnings, needs-improvement rules info; every measured rule states the lab caveat.
- **Scenario: clean-measurement-passes-every-performance-rule**, **no-measurement-passes-and-reports-none**.
- **Scenario: vital-bands-follow-the-thresholds** — at `good` is good, at `poor` needs improvement.
- **Scenario: verdict-is-the-worst-core-vital-measured** — FCP and TTFB never decide it.
- One scenario per vital rule, each with a passing and a failing measurement: **lcp-poor**,
  **lcp-needs-improvement**, **cls-poor**, **cls-needs-improvement**, **inp-poor**,
  **inp-needs-improvement**, **fcp-poor**, **fcp-needs-improvement**, **ttfb-poor**,
  **ttfb-needs-improvement**; and **lcp-facts-are-formatted**, **poor-is-a-warning-needs-improvement-is-info**.
- **Scenario: page-weight-heavy** — cached responses at their encoded size; not-itemised requests
  through the overflow; size-unavailable ones said and not counted.
- **Scenario: request-count-high** — the document counts. **dom-size-large**.
- **Scenario: render-blocking-scripts** — from the snapshot; an older snapshot without the field passes.
- **Scenario: uncompressed-text-resources** — text only, at least `UNCOMPRESSED_MIN_BYTES`, known sizes.
- **Scenario: resource-types-classify**, **third-party-is-another-registrable-domain** (sibling
  subdomains are one site; `MULTI_PART_SUFFIXES`; ports ignored; approximate), **uncompressed-detection**.
- **Scenario: summary-counts-requests-and-bytes**, **summary-lists-are-capped**,
  **summary-third-party-share**, **navigation-phases**, **summary-notes-route-change-wayland-and-few-requests**,
  **speed-report-has-measured-findings-only**, **formats** (CLS always with three decimals).

## Measurement, validation and main (`apps/desktop/src/main/seo/__tests__/vitals.test.ts`)
- **Scenario: vitals-script-runs-in-the-speed-world** — `SPEED_WORLD_ID`, never 0, 999, `SEO_WORLD_ID` or
  `A11Y_WORLD_ID` (the three SEO worlds are distinct).
- **Scenario: vitals-script-bundles-web-vitals-and-is-self-contained** — the IIFE, wrapped; no Node,
  Electron, DOM writes or `eval`.
- **Scenario: collector-installs-once-and-waits-for-buffered-entries** — `reportAllChanges`, buffered
  observers, the settle delay; the state non-enumerable and fixed; later runs answer at once.
- **Scenario: collector-caps-resources-and-keeps-totals**, **collector-reports-loaded-hidden-and-dom-size**,
  **collector-survives-a-missing-library-or-observer**.
- **Scenario: collector-ignores-synthetic-lifecycle-events** — an untrusted `pageshow` reaches no
  handler of the world; a trusted one does; guarded listeners stay removable.
- **Scenario: collector-runs-meanwhile-await-the-settle** — priming answers `null`; concurrent first
  runs both wait for the buffered entries; the library loads once.
- **Scenario: collector-drops-paint-metrics-for-background-loads** — shown after `timeOrigin` (past the
  tolerance), or hidden before the first paint: FCP, LCP, CLS `null`; TTFB kept.
- **Scenario: collector-says-when-paint-is-unavailable-under-wayland** — only native Wayland, no paint
  entry, `PAINT_GRACE_MS` after load.
- **Scenario: collector-answers-only-new-resources-and-restarts-on-route-change** — `since` / `epoch`;
  a fragment is not a route change.
- **Scenario: collector-keeps-route-resources-observed-before-the-next-collection** — the route's
  requests delivered after the URL change but before the next collection are answered in the new
  epoch; the boundary is the trusted `currententrychange` (earlier requests dropped, one starting at
  it kept), else the last time the old URL was seen; an untrusted event moves nothing.
- **Scenario: collector-refreshes-the-dom-every-n-collections**, **collector-notes-a-full-timing-buffer**.
- **Scenario: native-wayland-detection**, **shown-times**, **reassemble-puts-the-list-back-together**
  (and the worker accepts only a whole list).
- **Scenario: extractor-reads-render-blocking-scripts** — classic, not async (property), defer or
  nomodule; capped at `MAX_BLOCKING_SCRIPTS`.
- **Scenario: speed-analysis-validates-and-summarises** — garbage, non-web URLs, over-cap lists and
  strings, NaN, negative and over-limit numbers, extra keys and throwing getters are
  `invalid-measurement`.
- **Scenario: audit-takes-the-measurement-from-the-context** — an invalid one is dropped; the snapshot
  cannot carry one.
- **Scenario: audit-does-not-wait-for-the-measurement** — ready at once without it, analysed once more
  when the measurement and robots.txt have both settled, `auditVersion` bumped; a reload keeps the
  shown audit until the final one (`context-source.test.ts`, the context's inputs: known, later,
  stand-ins, a rejection as `null`).
- **Scenario: speed-jobs-run-in-the-analysis-worker** — wrong-shaped answers fail; timeouts terminate.
- **Scenario: speed-measures-the-active-tab-once-at-a-time**, **speed-only-for-active-web-pages**,
  **speed-times-out-and-waits-for-a-busy-page**, **speed-answers-bad-data-as-unavailable**,
  **speed-measurements-stop-at-navigation** (new document, reload, SPA route), **speed-forgets-closed-tabs**,
  **speed-measures-a-url-longer-than-the-measurement-holds** (a measurement is this page's when its
  `url`, fragment aside, is the page's URL cut to `maxUrlChars`; another page's is `invalid-measurement`),
  **speed-passes-shown-times-and-asks-for-new-resources-only** (a background tab's late first-shown
  time, a left tab's first-hidden time).

## Licenses (`apps/desktop/src/__tests__/third-party-notices.test.ts`, `forge-config.test.ts`)
- **Scenario: notices-file-is-current**, **notices-cover-the-injected-libraries**,
  **injected-libraries-are-unmodified** (`AXE_SCRIPT` starts with the bytes of `axe-core/axe.min.js`;
  the web-vitals source is the published IIFE), **ships-third-party-notices** (`extraResource`).

## Router (`packages/ipc-contract/src/__tests__/seo-router.test.ts`)
- `seo.measureSpeed` (a mutation, `SeoTabInputSchema`) rejects a foreign sender before input
  parsing, validates its input, calls `SeoService.measureSpeed` and answers its `SpeedResponse`.

## Renderer helpers (`apps/desktop/src/renderer/__tests__/speed-poller.test.ts`, `speed-view.test.ts`)
- **Scenario: speed-poller-polls-one-at-a-time**, **speed-poller-stops-on-navigation-and-close**,
  **speed-poller-pauses-after-max-polls**, **speed-poller-survives-a-throwing-measure**.
- **Scenario: speed-poller-restarts-on-a-new-document** — the same tab and URL with another
  document (a reload) ends the session (late answers dropped) and starts a fresh one, also from a
  paused session; the same document again is a no-op.
- **Scenario: use-speed-restarts-on-reload** (`use-speed.test.ts`, the hook in a DOM) — the panel's
  hook, paused at the poll limit, starts polling again with no answer shown once the tab's
  `documentSeq` changes for the same URL.
- **Scenario: meter-geometry**, **missing-vital-text**, **waterfall-geometry**, **bars-and-shares**,
  **shown-speed-prefers-live-for-this-url**, **speed-issues-merge-measured-and-snapshot-rules**,
  **openable-resources-and-ago**, **speed-notes** (Wayland, route change, too few requests, a full
  buffer, iframes; the source labels).

## End to end (`apps/desktop/e2e/seo-speed.e2e.ts`, loopback pages)
- **Scenario: lcp-late-image-e2e** — the largest element, an image that arrives after ~1.4 s, is the LCP (measured,
  in range); FCP and TTFB measured; INP shows its hint; navigation timing and the requests by type;
  the image is among the largest and opens in a background tab; the sidebar holds no `img`, `script`,
  `a` or `style=`.
- **Scenario: synthetic-pageshow-cannot-reset-vitals-e2e** — the page dispatches a persisted
  `pageshow`, a `visibilitychange` and a `pagehide` from its main world: LCP and FCP stay as they were.
- **Scenario: background-tab-has-no-false-paint-metrics-e2e** — `/lcp` opened by a link in a
  background tab, shown seconds later: FCP, LCP and CLS say `LOADED_HIDDEN_HINT`, no paint finding
  (live or in the audit: the rail dot stays green), TTFB measured.
- **Scenario: cls-flagged-e2e** — content pushed down after load: CLS above 0.1, flagged.
- **Scenario: heavy-page-flagged-e2e** — over `REQUEST_COUNT_WARN` requests and
  `PAGE_WEIGHT_WARN_BYTES`, a blocking head script and uncompressed JavaScript are flagged; the rail
  dot warns.
- **Scenario: measurement-runs-isolated** — a page that replaces `PerformanceObserver` (and its
  prototype's `observe`) and `performance.getEntriesByType` in its main world, and traps the
  `webVitals` and `SPEED_STATE_KEY` globals, sees none of them used, read or written and no global
  added, while the measurement still reports its real values (its fake LCP is never shown, both
  images are counted).
- **Scenario: spa-route-requests-are-counted-e2e** — a page changes its URL in place and fetches the
  route's data while the panel is closed: the route's audit and the panel count that request (and say
  the requests are counted from the route change).
- **Scenario: reload-starts-a-fresh-speed-session-e2e** — with the panel open, the toolbar's Reload
  (the same URL) starts the poll count again, and the shifted page's live CLS does not come back.
- **Scenario: live-updates-stop-after-navigation-e2e** — a page shifts after the panel opened and its CLS
  rises live; after navigating, the still page is measured afresh and the shifting page's values never return; leaving
  the panel ends the polls.
