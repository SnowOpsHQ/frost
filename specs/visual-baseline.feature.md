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
- **Linux only.** The file skips itself elsewhere, so the macOS and Windows e2e workflows never
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
- **Comparator**: `threshold: 0` (any change of a pixel's colour counts; Playwright's default 0.2
  would let a subtle token colour shift pass) and `maxDiffPixelRatio: 0.002` (at most 0.2 % of the
  pixels may differ: anti-aliasing jitter, e.g. a select's chevron by one RGB step).

## States (`CAPTURES` in the test; each from the flow of the suite named)
| Baseline | Test | State | Flow copied from |
| --- | --- | --- | --- |
| `new-tab` | new-tab | a fresh profile's empty tab: the start view, the sidebar's hint | `seo-sidebar` empty-tab-shows-hint |
| `new-tab-jump-back-in` | jump-back-in-and-history | the new tab after five visits: "Jump back in" tiles | `browser-polish` new-tab-page-jump-back-in |
| `history` | jump-back-in-and-history | the History sheet listing the same visits | `browser-polish` history-lists-searches-deletes-clears |
| `seo-overview` | seo-overview | the guide page, sidebar on Overview (score, issues, AI readiness 3 of 4) | `seo-sidebar` good-page-scores-high |
| `seo-on-page` | seo-on-page | On-Page facts and headings | `seo-sidebar` |
| `seo-schema` | seo-schema | Schema: three valid JSON-LD blocks, the tree | `seo-schema` schema-valid-page-shows-clean-tree |
| `seo-page-speed` | seo-page-speed | Page Speed, live: LCP, CLS, FCP and TTFB measured | `seo-speed` `measure` |
| `seo-search-console` | seo-search-console | Search Console connected to the fake Google: this page, 28 days, the clicks chart | `gsc-panel` not-connected, page-totals-and-chart |
| `seo-changes` | seo-changes | Changes: two captures, the diff by region | `changes` capture-first-version, diff-by-region |
| `devtools-drawer` | devtools-drawer | the SEO devtools drawer on Console | `devtools` |
| `find-bar` | find-bar | the find bar, "tea", 1 of 3 | `browser-polish` find-counts-steps-and-clears |
| `command-palette` | command-palette | the palette with "zoom" typed | `command-palette`, `update` |
| `settings` | settings | the Settings sheet, every section answered | `settings` |
| `projects` | projects | the Projects sheet: a project with two pages | `projects` projects-create-and-add-pages |
| `render-profile` | render-profile | phone + mobile UA applied and reloaded, the editor bar open | `render-profile` mobile-preset-viewport-and-ua |
| `permission-bar` | permission-bar | the notification prompt bar, armed | `permissions` allow-grants-and-is-remembered-e2e |
| `update-bar` | update-bar | the update bar offering 99.0.0 (signed fake feed over TLS) | `update` update-available-download-verify-show |
| `agent-empty` | agent-empty | the agent panel open, no chat yet | `agent` `launchWith` |
| `agent-conversation` | agent-conversation | one scripted turn: a `page_text` tool card, then the answer | `agent` agent-chat-export-and-restore (scripted model seam) |

No state is skipped. The ChatGPT route's conversation is not captured: the scripted-model turn
already shows the same chat surface without a sign-in. Known limit: the Projects sheet's Retention
section (below the fold today) shows the database file's size, which varies; a restyle that brings
it above the fold needs it hidden too.

## Determinism
- **Fixed names, no ports.** The fixture site answers on `visual.frost-e2e.net` (and
  `permissions.frost-e2e.net`, treated as a secure origin so a page may ask for a permission) via
  `--host-resolver-rules=MAP <host> 127.0.0.1:<port>`: every URL the chrome shows (address bar,
  status bar, On-Page, Schema, Projects, History) is the same in every run, though the server's
  port is random. The site's pages are frost's own fixed text, never cached (`no-store`); nothing
  in them changes but the Changes page's two versions.
- **Settled before capture.** Each flow waits for what its suite waits for (the audit's URL in
  On-Page, the Changes panel's ready audit, all four measurable vitals, AI readiness `partial`, no
  Settings section "Loading…", the find count, the armed prompt, …). Then every capture waits until
  nothing on screen is busy (`aria-busy`, a tab spinner, the audit skeleton, the Search Console or
  Changes loading block, a "Loading… / Reading… / Checking… / Measuring…"-style line) and the
  chrome's text and `data-state` / `data-status` / `data-band` / `data-outcome` attributes (bar the
  per-second Page Speed values) have held still for 1.5 s; `toHaveScreenshot` itself waits for two
  identical frames. A transient message (the palette's status pill) is waited out, not captured.
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
    line, the largest requests' durations, and the Navigation card's total, waterfall bars, TTFB /
    DOM ready / Load; its phase list is left out (which phases took any time varies), so the card
    keeps one height. The request breakdown (counts and sizes) is compared.

## Baseline procedure
`updateSnapshots` is `'missing'`, in CI too. For a missing baseline Playwright renders the state,
writes it as the baseline (in CI: into the throwaway checkout) and as `*-actual.png` under
`apps/desktop/test-results/` (kept for passing tests too, `preserveOutput: 'always'`), and the test
passes, so a baseline run shares one app per group exactly like a green run. Not `'none'`: it fails
a missing baseline without rendering anything, so there is no actual to adopt. Not `'default'`: it
writes the actual but fails each test that had a missing one, and Playwright replaces the worker
after a failure, so a baseline run would relaunch the app for every test. A missing baseline still
fails CI: the last test, **every capture has a baseline**, checks in CI that every capture's two
images are committed (`git ls-files`; on disk they now all exist). It also fails, locally too, on a
PNG in the baseline directory that no capture makes (a renamed or removed state). A *different*
image fails its own test, with `*-actual.png`, `*-expected.png` and `*-diff.png`. Captures are soft
assertions and the tests independent (not serial), so one CI run yields every actual. The failed job
uploads `apps/desktop/test-results/` in the `playwright-report` artifact.

**First baselines, or after an intended visual change:**
1. Push the branch. Without a pull request, run CI on it: `gh workflow run ci.yml --ref <branch>`.
   (For an intended change, either delete the affected baselines first or let CI fail on the
   difference.)
2. When the run fails on the visual suite: `gh run download <run-id> -n playwright-report -D <dir>`.
3. Review: open each `*-diff.png` (or the HTML report in the artifact) and check that only the
   intended surfaces changed, in both themes. A token-only change must produce no difference at all.
4. Copy each actual to its baseline, dropping `-actual`:
   `find <dir> -name '*-actual.png' -exec sh -c 'cp "$1" "apps/desktop/e2e/__screenshots__/visual.e2e.ts/$(basename "$1" -actual.png).png"' _ {} \;`
   (a green run's artifact is not uploaded; after an intended change, only the changed states have
   an actual). Delete the baselines of a removed state.
5. Commit the PNGs, push, and run CI again: the visual suite passes.

**Local runs**: a local run (Wayland/Hyprland, other fonts and scale) writes missing images and
compares against them, useful to look at a state or to check that two runs on one machine agree.
Those images differ from CI's and are **never committed**; delete
`apps/desktop/e2e/__screenshots__/` and `apps/desktop/test-results/` after looking.

## End to end (`e2e/visual.e2e.ts`)
Each state test drives its flow and captures its baselines (table above) in both themes; in each
capture the media query follows the emulated scheme and the body's background differs between light
and dark, and the stylesheet's marker is in effect.
- **Scenario: new-tab**, **jump-back-in-and-history** (a fresh profile).
- **Scenario: seo-overview**, **seo-on-page**, **seo-schema**, **seo-page-speed**, **seo-changes**,
  **devtools-drawer**, **find-bar**, **command-palette**, **settings**, **projects**,
  **render-profile**, **permission-bar** (one app; each starts from one tab, everything closed).
- **Scenario: agent-empty**, **agent-conversation** (the scripted model seam).
- **Scenario: seo-search-console** (fake backend and Google).
- **Scenario: update-bar** (fake feed).
- **Scenario: every capture has a baseline** — no orphaned PNG; in CI, every `CAPTURES` name's two
  images committed.
