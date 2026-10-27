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
  sees no global, observer or listener of it.
- **Late attachment.** The first collection in a document installs web-vitals with
  `reportAllChanges: true` (every new value is kept, not just the final one) and a `resource`
  observer; both use `buffered: true` observers, so injecting after load still sees FCP, LCP,
  layout shifts and resources from before. TTFB comes from the navigation entry. The buffered entries
  arrive asynchronously, so the first collection answers after `SPEED_SETTLE_MS`; later ones at once.
- **Metric limits.**
  - INP needs interactions: until the user clicks, taps or types in the page there is none, and the
    card says `INP_HINT` ("Interact with the page to measure INP"). Interactions before the first
    collection only count if the browser buffered them (long ones).
  - LCP stops at the first input or scroll (by definition), and Chromium leaves low-entropy images
    (placeholders, flat colours) out of it.
  - A page that was hidden before its first paint (opened in a background tab) has no meaningful
    paint metrics: web-vitals reports none, and the panel says to re-measure (`loadedHidden`).
  - On some Linux Wayland compositors Chromium receives no presentation feedback and records no
    paint timing at all (no FCP or LCP, in any world): those cards stay "Not reported yet". X11
    (XWayland) is not affected; the e2e suite runs the app with `--ozone-platform=x11` on Linux.
  - Cross-origin responses without `Timing-Allow-Origin` report 0 for every size: they count as
    requests but not in byte totals, and show as "size unavailable" (`SIZE_UNAVAILABLE_NOTE`).
  - The browser's resource timing buffer holds 250 entries by default; a page that made more
    requests before the first collection may have lost some (`bufferFull`, said in the panel).
    After it, the observer receives every request, whatever the buffer does.
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
  report (with its own measured findings) and falls back to the audit's. Render-blocking scripts are
  read by the extractor (the snapshot), so that finding always comes from the audit.
- **Live updates, bounded.** The chrome polls every `SPEED_POLL_MS` after each answer (never two at
  once) and pauses after `SPEED_LIVE_MAX_POLLS` (Resume starts another run). A poll session is one
  tab and one URL: switching tabs, navigating, leaving the panel or collapsing the sidebar ends it,
  and its late answers are dropped. Main measures only the active tab, shares a collection in
  flight, answers the last measurement again sooner than `SPEED_MIN_INTERVAL_MS`, never stacks a
  collection on a page that has not answered the previous one (`timeout`), and drops what it measured
  at each new document (`did-navigate`) or URL: a late answer is never shown against another page.
- **Re-measure** reloads the page (`browser.reload`): a new document, a new audit, a fresh
  measurement.
- **Bands and severities.** The bands are the publicly documented Core Web Vitals thresholds
  (`VITAL_THRESHOLDS`). Poor is a **warning** and needs-improvement is **info** (good passes): a lab
  value from one visit is a strong hint, not proof. The lab verdict is the worst band of the Core
  Web Vitals that were measured (LCP, CLS, INP; FCP and TTFB are diagnostics).
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
- **Scenario: resource-types-classify**, **third-party-is-another-site**, **uncompressed-detection**.
- **Scenario: summary-counts-requests-and-bytes**, **summary-lists-are-capped**,
  **summary-third-party-share**, **navigation-phases**, **speed-report-has-measured-findings-only**, **formats**.

## Measurement, validation and main (`apps/desktop/src/main/seo/__tests__/vitals.test.ts`)
- **Scenario: vitals-script-runs-in-the-speed-world** — `SPEED_WORLD_ID`, never 0, 999, `SEO_WORLD_ID` or
  `A11Y_WORLD_ID` (the three SEO worlds are distinct).
- **Scenario: vitals-script-bundles-web-vitals-and-is-self-contained** — the IIFE, wrapped; no Node,
  Electron, DOM writes or `eval`.
- **Scenario: collector-installs-once-and-waits-for-buffered-entries** — `reportAllChanges`, buffered
  observers, the settle delay; the state non-enumerable and fixed; later runs answer at once.
- **Scenario: collector-caps-resources-and-keeps-totals**, **collector-reports-loaded-hidden-and-dom-size**,
  **collector-survives-a-missing-library-or-observer**.
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
  **speed-measurements-stop-at-navigation** (new document, reload, SPA route), **speed-forgets-closed-tabs**.

## Router (`packages/ipc-contract/src/__tests__/seo-router.test.ts`)
- `seo.measureSpeed` (a mutation, `SeoTabInputSchema`) rejects a foreign sender before input
  parsing, validates its input, calls `SeoService.measureSpeed` and answers its `SpeedResponse`.

## Renderer helpers (`apps/desktop/src/renderer/__tests__/speed-poller.test.ts`, `speed-view.test.ts`)
- **Scenario: speed-poller-polls-one-at-a-time**, **speed-poller-stops-on-navigation-and-close**,
  **speed-poller-pauses-after-max-polls**, **speed-poller-survives-a-throwing-measure**.
- **Scenario: meter-geometry**, **missing-vital-text**, **waterfall-geometry**, **bars-and-shares**,
  **shown-speed-prefers-live-for-this-url**, **speed-issues-merge-measured-and-snapshot-rules**,
  **openable-resources-and-ago**.

## End to end (`apps/desktop/e2e/seo-speed.e2e.ts`, loopback pages)
- **Scenario: lcp-late-image-e2e** — the largest element, an image that arrives after ~1.4 s, is the LCP (measured,
  in range); FCP and TTFB measured; INP shows its hint; navigation timing and the requests by type;
  the image is among the largest and opens in a background tab; the sidebar holds no `img`, `script`,
  `a` or `style=`.
- **Scenario: cls-flagged-e2e** — content pushed down after load: CLS above 0.1, flagged.
- **Scenario: heavy-page-flagged-e2e** — over `REQUEST_COUNT_WARN` requests and
  `PAGE_WEIGHT_WARN_BYTES`, a blocking head script and uncompressed JavaScript are flagged; the rail
  dot warns.
- **Scenario: measurement-runs-isolated** — a page that replaces `PerformanceObserver` (and its
  prototype's `observe`) and `performance.getEntriesByType` in its main world, and traps the
  `webVitals` and `SPEED_STATE_KEY` globals, sees none of them used, read or written and no global
  added, while the measurement still reports its real values (its fake LCP is never shown, both
  images are counted).
- **Scenario: live-updates-stop-after-navigation-e2e** — a page shifts after the panel opened and its CLS
  rises live; after
  navigating, the still page is measured afresh and the shifting page's values never return; leaving
  the panel ends the polls.
