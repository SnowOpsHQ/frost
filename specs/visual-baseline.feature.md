# Feature: visual baseline

A screenshot baseline of every main surface of the browser chrome, in light and dark, so a
design-system change can be proven (a token-only change: zero visual difference) or reviewed (a
restyle: the diff images show exactly what moved). Test: `apps/desktop/e2e/visual.e2e.ts`, with its
screenshot-only stylesheet `apps/desktop/e2e/visual.css`; config: `apps/desktop/playwright.config.ts`
(`snapshotPathTemplate`, `updateSnapshots`, `expect.toHaveScreenshot`); baselines:
`apps/desktop/e2e/__screenshots__/visual.e2e.ts/<state>-<theme>.png`.

## What is captured
- **Only the chrome page** (`app://app/`), via `toHaveScreenshot`. A tab's page is a native
  `WebContentsView` that no page screenshot includes: the page area shows the chrome behind it.
- **Never retried.** CI runs a failed e2e test again (`ci-pipeline.feature.md`,
  `e2e-retries-only-in-ci`); this file opts out, so a differing or missing image fails at once and
  a baseline run renders each state once.
- **Linux only.** The file skips itself elsewhere, so the macOS and Windows e2e jobs never
  compare. Baselines are CI's renderings: ubuntu-24.04, `xvfb-run -a -s "-screen 0 1280x1024x24"`
  (`.github/workflows/ci.yml`; xvfb-run's own default, written out so a change of that default
  cannot move the baselines silently). No platform suffix. A font or rendering change in the
  runner image (a new ubuntu-24.04 image, Electron's Chromium) shifts every image: re-baseline all
  of them (Baseline procedure), reviewing that the diffs are rendering only.
- **Window**: content size 1280 × 800 (`BrowserWindow.setContentSize`), compared at CSS scale
  (`scale: 'css'`). In CI (no window manager) the chrome's viewport must really be that size; a
  local run also pins the chrome's layout viewport (`page.setViewportSize`), because a tiling
  window manager (Hyprland) resizes the window whenever it likes.
- **Themes**: each state as `<state>-light.png` and `<state>-dark.png`. The theme is the chrome
  page's emulated `prefers-color-scheme` (`page.emulateMedia({ colorScheme })`; theming is pure CSS
  `@media (prefers-color-scheme: dark)` in `src/renderer/*.css`); `nativeTheme.themeSource` is not
  needed. Every capture checks that `matchMedia('(prefers-color-scheme: dark)')` follows the
  emulation and that the body's computed background differs between light and dark.
- **Each capture is the visible window only** (1280 × 800). A surface longer than its scroller gets
  more captures of the same state with that scroller moved (`capture(name, { scroll })`): to its
  end (`-lower`) and, where the end alone would leave much of the middle out, to a fixed offset
  (`-middle`). See "What is compared".
- **Comparator**: `threshold: 0` (any change of a pixel's colour counts; Playwright's default 0.2
  would let a subtle token colour shift pass) and `maxDiffPixelRatio: 0.002`: up to 0.2 % of the
  pixels, 2,048 at 1280 × 800, may differ, for anti-aliasing noise (seen: the Search Console range
  select's chevron in dark, 2 pixels by one RGB step between two runs on one machine). Playwright's
  pixelmatch never counts a pixel it classifies as anti-aliasing (it does not pass `includeAA`), at
  any threshold. A green run
  therefore proves "within 0.2 %", not "identical". **Strict mode**: `VISUAL_STRICT=1` sets
  `maxDiffPixels: 0` and `maxDiffPixelRatio: 0` for every capture (a local run, or CI with the
  variable set), so any pixel pixelmatch counts as differing fails and its diff image shows where.
  It is not a byte-for-byte proof: a change confined to pixels classified as anti-aliasing passes.

## States (`CAPTURES` in the test; each from the flow of the suite named)
| Baseline | Test | State | Flow copied from |
| --- | --- | --- | --- |
| `new-tab` | new-tab | a fresh profile's empty tab: the start view, the sidebar's hint | `seo-sidebar` empty-tab-shows-hint |
| `new-tab-jump-back-in` | jump-back-in-and-history | the new tab after five visits: "Jump back in" tiles | `browser-polish` new-tab-page-jump-back-in |
| `history` | jump-back-in-and-history | the History sheet listing the same visits | `browser-polish` history-lists-searches-deletes-clears |
| `seo-overview` | seo-overview | the guide page, sidebar on Overview (score, issues, AI readiness 3 of 4) | `seo-sidebar` good-page-scores-high |
| `seo-on-page` | seo-on-page | On-Page facts and headings | `seo-sidebar` |
| `seo-schema` | seo-schema | Schema: three valid JSON-LD blocks, the tree | `seo-schema` schema-valid-page-shows-clean-tree |
| `seo-page-speed` | seo-page-speed | Page Speed, live: LCP, CLS, FCP and TTFB measured, all good | `seo-speed` `measure` |
| `seo-page-speed-middle` | seo-page-speed | the same, `.seo-body` at 600 px: the vitals' end, Issues, Navigation timing, Requests | |
| `seo-page-speed-lower` | seo-page-speed | the same, `.seo-body` at its end: Requests, Largest requests, Hosts, DOM | |
| `seo-search-console` | seo-search-console | Search Console connected to the fake Google: this page, 28 days, the clicks chart | `gsc-panel` not-connected, page-totals-and-chart |
| `seo-search-console-lower` | seo-search-console | the same at its end: the top queries, the freshness line | |
| `seo-changes` | seo-changes | Changes: two captures, the diff by region | `changes` capture-first-version, diff-by-region |
| `seo-changes-lower` | seo-changes | the same at its end: the rest of the diff, Screenshots | |
| `devtools-drawer` | devtools-drawer | the SEO devtools drawer on Console | `devtools` |
| `find-bar` | find-bar | the find bar, "tea", 1 of 3 | `browser-polish` find-counts-steps-and-clears |
| `command-palette` | command-palette | the palette with "zoom" typed | `command-palette`, `update` |
| `settings` | settings | the Settings sheet, every section answered | `settings` |
| `settings-lower` | settings | the same, `.settings-content` at its end: AI checks' end, Telemetry | |
| `help-shortcuts` | help-shortcuts | Help › Keyboard Shortcuts over the guide page | `browser-polish` help-shortcuts-sheet |
| `projects` | projects | the Projects sheet: a project with two pages | `projects` projects-create-and-add-pages |
| `projects-lower` | projects | the same, `.projects-main` at its end: search queries, Retention and disk usage, Purge log | |
| `render-profile` | render-profile | phone + mobile UA applied and reloaded, the editor bar open | `render-profile` mobile-preset-viewport-and-ua |
| `permission-bar` | permission-bar | the notification prompt bar, armed | `permissions` allow-grants-and-is-remembered-e2e |
| `update-bar` | update-bar | the update bar offering 99.0.0 (signed fake feed over TLS) | `update` update-available-download-verify-show |
| `agent-empty` | agent-empty | the agent panel open, no chat yet | `agent` `launchWith` |
| `agent-conversation` | agent-conversation | one scripted turn: a `page_text` tool card, then the answer | `agent` agent-chat-export-and-restore (scripted model seam) |

26 captures, 52 images. No state is skipped. The ChatGPT route's conversation is not captured: the
scripted-model turn already shows the same chat surface without a sign-in.

## What is compared
Only what each capture's window shows (measured locally at 1280 × 800):
- **Everything** of the states that fit their window, and of the chrome around every state (tab
  strip, toolbar, bars, rail, status bar, the agent panel).
- **Page Speed** (`.seo-body` about 1,690 px tall in a 606 px window): the top, 600–1,206 px and the
  last screen, so every part; **Search Console** (about 1,280 in 636): the top and the end (a 9 px
  strip between them, inside the queries card, is not); **Changes** (about 1,160 in 636), **Settings** (about 1,170
  in 624) and **Projects** (about 1,180 in 606): the top and the end, which overlap.
- **Not compared**: whatever lies below the window in the other states (the Overview's lower issues
  and Page card, On-Page below Headings, the Schema tree's later blocks, the Projects sheet's list
  column below its items); the tab's page itself; and the text that visual.css hides (below).
  Those panels have their own e2e suites for content; a restyle reviewer should open them by hand.

## Determinism
- **Fixed names, no ports.** The fixture site answers on `visual.frost-e2e.net` (and
  `permissions.frost-e2e.net`, treated as a secure origin so a page may ask for a permission) via
  `--host-resolver-rules=MAP <host> 127.0.0.1:<port>`: every URL the chrome shows (address bar,
  status bar, On-Page, Schema, Projects, History) is the same in every run, though the server's
  port is random. The site's pages are frost's own fixed text, never cached (`no-store`); nothing
  in them changes but the Changes page's two versions.
- **Settled before capture.** Each flow waits for what its suite waits for (the audit's URL in
  On-Page, the Changes panel's ready audit, all four measurable vitals, AI readiness `partial`, no
  Settings section "Loading…", the find count, the armed prompt, …); Page Speed also asserts that
LCP, CLS, FCP, TTFB and the verdict are in the good band (`data-band="good"`), so a slow runner
fails by name rather than as an image difference. Then every capture waits until
  nothing on screen is busy (`aria-busy`, a tab spinner, the audit skeleton, the Search Console or
  Changes loading block, a "Loading… / Reading… / Checking… / Measuring…"-style line) and the
  chrome's text and `data-state` / `data-status` / `data-band` / `data-outcome` attributes have held
  still for 1.5 s (after a scroll, again); `toHaveScreenshot` itself waits for two identical frames.
  The text left out of that comparison is exactly Page Speed's measured values, which its live
  updates may rewrite: the live line's text, the vitals' values, the Navigation card's total badge
  and TTFB / DOM ready / Load values, and the largest requests' durations (all hidden by
  visual.css). A transient message (the palette's status pill) is waited out, not captured.
- **Order independence.** In the shared app each state starts from one tab, every sheet, bar and
  drawer closed, the sidebar open, and the SEO panel's scroller (`.seo-body`) back at the top (the
  Settings and Projects sheets are closed, so their scrollers start at the top when reopened).
- **Distinct sizes.** The guide's two images are valid PNGs of different byte sizes (each padded
  with a `tEXt` chunk of its own length): Page Speed's Largest requests sorts by size and keeps equal sizes in load
  order, which would follow timing.
- **No pointer or focus noise.** Focus leaves the chrome (except where the focused field is the
  state: find bar, palette) and the pointer rests on the status bar. `animations: 'disabled'`,
  `caret: 'hide'`.
- **Hidden, not masked.** A mask paints an element's own box, and a box sized by date or clock text
  changes size from one day to the next. Instead `visual.css` is inserted into the chrome from main
  (`webContents.insertCSS`) for each capture: Playwright's `stylePath` would inject a `<style>`
  element, which the chrome's strict CSP refuses silently; a marker property proves the sheet is in
  effect. It draws such text without glyphs (`color` / `fill: transparent`), so the element's box,
  background and border are still compared, and every hidden element sits where its width moves
  nothing else:
  - every state: the audit footer, "Audited <time> · read in <n> ms";
  - Changes: the versions' capture times, "Version of <time>", the compare picker's text;
  - History: the visit times (a fixed column);
  - Search Console: "Through <date>", the chart's date ticks, and the freshness line (also clipped to
    one line, as its three dates could change how it wraps);
  - Page Speed: the vitals' values and their meter markers (the zones stay), the "updated … ago"
    line, the largest requests' durations (the last item of their row: the fixture's requests are
    never cached or third-party), and the Navigation card's total badge (hidden whole; it sits at
    the end of the card's header), waterfall bars and TTFB / DOM ready / Load (three equal grid
    columns); its phase list is left out (which phases took any time varies, each with a duration),
    so the card keeps one height. The request breakdown, the largest requests' URLs, types and
    sizes, Hosts and DOM are compared;
  - Projects: Retention's "Database file (all projects)" size, which grows with whatever the app
    has stored (the value column of a two-column grid).

## Baseline procedure
`updateSnapshots` is `'missing'`, in CI too. For a missing baseline Playwright renders the state,
writes it as the baseline (in CI: into the throwaway checkout) and as `*-actual.png` under
`apps/desktop/test-results/` (kept for passing tests too, `preserveOutput: 'always'`), and the test
passes, so a baseline run shares one app per group exactly like a green run. Not `'none'`: it fails
a missing baseline without rendering anything, so there is no actual to adopt. Not `'default'`: it
writes the actual but fails each test that had a missing one, and Playwright replaces the worker
after a failure, so a baseline run would relaunch the app for every test. A missing baseline still
fails CI: the last test, **every capture has a baseline**, checks in CI that every capture's two
images are committed (`git ls-files`; on disk they now all exist). Everywhere, it also fails on a
PNG in the baseline directory that no capture makes (a renamed or removed state) and on a
`CAPTURES` entry that no `capture('<name>'` call in the file uses any more. A *different*
image fails its own test, with `*-actual.png`, `*-expected.png` and `*-diff.png`. Captures are soft
assertions and the tests independent (not serial), so one CI run yields every actual. The suite is
one file, so it runs in one of the Linux e2e shards; the failed shard uploads
`apps/desktop/test-results/` in its `playwright-report-linux-<n>` artifact.

**First baselines, or after an intended visual change:**
1. Push the branch. Without a pull request, run CI on it: `gh workflow run ci.yml --ref <branch>`.
   (For an intended change, either delete the affected baselines first or let CI fail on the
   difference.)
2. When the run fails on the visual suite: `gh run download <run-id> -p 'playwright-report-linux-*' -D <dir>`.
3. Review: open each `*-diff.png` (or the HTML report in the artifact) and check that only the
   intended surfaces changed, in both themes.
4. Copy each actual to its baseline, dropping `-actual`:
   `mkdir -p apps/desktop/e2e/__screenshots__/visual.e2e.ts && find <dir> -name '*-actual.png' -exec sh -c 'cp "$1" "apps/desktop/e2e/__screenshots__/visual.e2e.ts/$(basename "$1" -actual.png).png"' _ {} \;`
   (a green run's artifact is not uploaded; after an intended change, only the changed states have
   an actual). Delete the baselines of a removed state.
5. Commit the PNGs, push, and run CI again: the visual suite passes.

**A change that must not move anything** (a token-only foundation PR): a green run is necessary but
not sufficient, as up to 0.2 % of each image may differ and a passing comparison prints nothing.
Check it with `VISUAL_STRICT=1`, where any pixel pixelmatch counts as differing fails (anti-aliased
pixels excepted, see Comparator), alongside a non-visual proof such as a computed-style comparison:
in CI, by setting the variable on the e2e step for that run (locally against CI-made baselines is not meaningful). A strict failure
can be the known anti-aliasing noise (the Search Console range select's chevron in dark, 2 pixels by
one RGB step), so look at its diff image before treating it as a real change.

**Local runs**: a local run (Wayland/Hyprland, other fonts and scale) writes missing images and
compares against them, useful to look at a state or to check that two runs on one machine agree.
Those images differ from CI's and are **never committed**; delete
`apps/desktop/e2e/__screenshots__/` and `apps/desktop/test-results/` after looking.

## End to end (`e2e/visual.e2e.ts`)
Each state test drives its flow and captures its baselines (table above, `-middle` / `-lower` ones
included) in both themes; in each capture the media query follows the emulated scheme and the
body's background differs between light and dark, and the stylesheet's marker is in effect; a
scrolled capture's scroller has something below the fold and reached its offset.
- **Scenario: new-tab**, **jump-back-in-and-history** (a fresh profile).
- **Scenario: seo-overview**, **seo-on-page**, **seo-schema**, **seo-page-speed**, **seo-changes**,
  **devtools-drawer**, **find-bar**, **command-palette**, **settings**, **projects**,
  **render-profile**, **permission-bar** (one app; each starts from one tab, everything closed).
- **Scenario: agent-empty**, **agent-conversation** (the scripted model seam).
- **Scenario: seo-search-console** (fake backend and Google).
- **Scenario: update-bar** (fake feed).
- **Scenario: every capture has a baseline** — every `CAPTURES` name has a `capture('<name>'` call;
  no orphaned PNG; in CI, every name's two images committed.
