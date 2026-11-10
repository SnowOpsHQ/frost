# Feature: visual baseline

A screenshot baseline of every main surface of the browser chrome, in light and dark, so a
design-system change can be proven (a token-only change: zero visual difference) or reviewed (a
restyle: the diff images show exactly what moved). Test: `apps/desktop/e2e/visual.e2e.ts`; config:
`apps/desktop/playwright.config.ts` (`snapshotPathTemplate`, `updateSnapshots`,
`expect.toHaveScreenshot`); baselines: `apps/desktop/e2e/__screenshots__/visual.e2e.ts/<state>-<theme>.png`.

## What is captured
- **Only the chrome page** (`app://app/`), via `toHaveScreenshot`. A tab's page is a native
  `WebContentsView` that no page screenshot includes: the page area shows the chrome behind it.
- **Linux only.** The file skips itself elsewhere, so the macOS and Windows e2e workflows never
  compare. Baselines are CI's renderings (ubuntu-24.04, `xvfb-run`); no platform suffix.
- **Window**: content size 1280 × 800 (`BrowserWindow.setContentSize`), compared at CSS scale
  (`scale: 'css'`). In CI (no window manager) the chrome's viewport must really be that size; a
  local run additionally pins the chrome's layout viewport (`page.setViewportSize`), because a
  tiling window manager (Hyprland) resizes the window whenever it likes.
- **Themes**: each state as `<state>-light.png` and `<state>-dark.png`. The theme is the chrome
  page's emulated `prefers-color-scheme` (`page.emulateMedia({ colorScheme })`; theming is pure CSS
  `@media (prefers-color-scheme: dark)` in `src/renderer/*.css`). Every capture checks that
  `matchMedia('(prefers-color-scheme: dark)')` follows the emulation and that the body's computed
  background differs between the two (light `rgb(243, 245, 248)`, dark `rgb(29, 32, 38)` when
  written); `nativeTheme.themeSource` is not needed.

## States (each from the flow of the suite named)
| Baseline | State | Flow copied from |
| --- | --- | --- |
| `new-tab` | a fresh profile's empty tab: the start view, the sidebar's hint | `seo-sidebar` empty-tab-shows-hint |
| `new-tab-jump-back-in` | the new tab after five visits: "Jump back in" tiles | `browser-polish` new-tab-page-jump-back-in |
| `history` | the History sheet listing three pages | `browser-polish` history-lists-searches-deletes-clears |
| `seo-overview` | the guide page, sidebar on Overview (score, issues) | `seo-sidebar` good-page-scores-high |
| `seo-on-page` | On-Page facts and headings | `seo-sidebar` |
| `seo-schema` | Schema: three valid JSON-LD blocks, the tree | `seo-schema` schema-valid-page-shows-clean-tree |
| `seo-page-speed` | Page Speed, live measurement | `seo-speed` `measure` |
| `seo-search-console` | Search Console connected to the fake Google: this page, 28 days, the clicks chart | `gsc-panel` not-connected, page-totals-and-chart |
| `seo-changes` | Changes: two captures, the diff by region | `changes` capture-first-version, diff-by-region |
| `devtools-drawer` | the SEO devtools drawer on Console | `devtools` |
| `find-bar` | the find bar, "tea", 1 of 3 | `browser-polish` find-counts-steps-and-clears |
| `command-palette` | the palette with "zoom" typed | `command-palette`, `update` |
| `settings` | the Settings sheet | `settings` |
| `projects` | the Projects sheet: a project with two pages | `projects` projects-create-and-add-pages |
| `render-profile` | phone + mobile UA applied and reloaded, the editor bar open | `render-profile` mobile-preset-viewport-and-ua |
| `permission-bar` | the notification prompt bar, armed | `permissions` allow-grants-and-is-remembered-e2e |
| `update-bar` | the update bar offering 99.0.0 (signed fake feed over TLS) | `update` update-available-download-verify-show |
| `agent-empty` | the agent panel open, no chat yet | `agent` `launchWith` |
| `agent-conversation` | one scripted turn: a `page_text` tool card, then the answer | `agent` agent-chat-export-and-restore (scripted model seam) |

No state is skipped. The ChatGPT route's conversation is not captured: the scripted-model turn
already shows the same chat surface without a sign-in.

## Determinism
- **Fixed names, no ports.** The fixture site answers on `visual.frost-e2e.net` (and
  `permissions.frost-e2e.net`, treated as a secure origin so a page may ask for a permission) via
  `--host-resolver-rules=MAP <host> 127.0.0.1:<port>`: every URL the chrome shows (address bar,
  status bar, On-Page, Schema, Projects, History) is the same in every run, though the server's
  port is random. The site's pages are frost's own, fixed text; nothing in them changes but the
  Changes page's two versions.
- **Settled before capture.** Each flow waits for what its suite waits for (the audit's URL in
  On-Page, the Changes panel's ready audit, the find count, the armed prompt, …), then for the
  sidebar's audit to hold still for 1.5 s (rail dots, score, audit footer); `toHaveScreenshot`
  itself waits for two identical frames. A transient message (the palette's status pill) is
  waited out, not captured.
- **No pointer or focus noise.** Before each capture focus leaves the chrome (except where the
  focused field is the state: find bar, palette) and the pointer rests on the status bar.
  `animations: 'disabled'`, `caret: 'hide'`, `maxDiffPixelRatio: 0.002`.
- **Masked** (drawn as a solid box, so only their place is compared): the audit footer's clock time
  and read duration (`seo-duration`, every state); Page Speed's measured values, their bars, the
  timing breakdown, the waterfall and the "updated … ago" line; the Changes versions' capture times
  (history list, "Version of", the compare picker); History's visit times; Search Console's dates
  (x-axis ticks, "Through …", the freshness line), which follow today's date.

## Baseline procedure
A missing or different image fails the e2e gate in CI. `updateSnapshots` is `'missing'` everywhere,
not `'none'` in CI: under `'none'` Playwright (1.64) fails a missing baseline without rendering
anything, so there would be no actual to adopt. Under `'missing'` it renders the state and writes
it both as the baseline (in CI's throwaway checkout) and as `*-actual.png`; in CI (`CI` set) the
test itself fails each capture whose baseline file did not exist. Each capture is a soft assertion
and the tests are independent (not serial), so one CI run writes every state's light and dark
`*-actual.png` (and, for a difference, `*-expected.png` / `*-diff.png`) under
`apps/desktop/test-results/`, which the failed job uploads as the `playwright-report` artifact.

**First baselines, or after an intended visual change:**
1. Push the branch. Without a pull request, run CI on it: `gh workflow run ci.yml --ref <branch>`.
   (For an intended change, either delete the affected baselines first or let CI fail on the
   difference.)
2. When the run fails on the visual suite: `gh run download <run-id> -n playwright-report -D <dir>`.
3. Review: open each `*-diff.png` (or the HTML report in the artifact) and check that only the
   intended surfaces changed, in both themes. A token-only change must produce no actual at all.
4. Copy each actual to its baseline, dropping `-actual`:
   `find <dir> -name '*-actual.png' -exec sh -c 'cp "$1" "apps/desktop/e2e/__screenshots__/visual.e2e.ts/$(basename "$1" -actual.png).png"' _ {} \;`
5. Commit the PNGs, push, and run CI again: the visual suite passes.

**Local runs**: a local run (Wayland/Hyprland, other fonts and scale) writes missing images and
compares against them, useful to look at a state or to check that two runs on one machine agree. Those images differ from CI's and are **never committed**;
delete `apps/desktop/e2e/__screenshots__/` and `apps/desktop/test-results/` after looking.

## End to end (`e2e/visual.e2e.ts`)
- **Scenario: every-state-light-and-dark** — each state above matches its two baselines.
- **Scenario: missing-baseline-fails-ci-with-an-actual** — in CI a state without a baseline fails,
  and its `*-actual.png` is written under `test-results/`; the other states still run.
- **Scenario: theme-emulation-repaints-the-chrome** — in each capture the media query follows the
  emulated scheme and the body's background differs between light and dark.
