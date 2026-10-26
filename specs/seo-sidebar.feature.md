# Feature: isolated SEO extraction, the auditor and the SEO sidebar

Spec: `specs/seo-snapshot.spec.ts` (`PageSnapshotSchema`, `SeoTabInputSchema`),
`specs/seo-limits.spec.ts` (`SEO_WORLD_ID`, `EXTRACT_TIMEOUT_MS`, `AUDIT_DEBOUNCE_MS`,
`SNAPSHOT_LIMITS`), `specs/seo-sidebar.spec.ts` (statuses, reasons, panels, toggle, widths) and
`specs/seo-rules.spec.ts` (rules and score: `seo-rules.feature.md`). Phase 2 Task 1. Each line maps
to one named test.

## Snapshot schema (`apps/desktop/src/main/seo/__tests__/snapshot.test.ts`)
- **Scenario: snapshot-schema-accepts-valid** — a full snapshot parses unchanged.
- **Scenario: snapshot-caps-lists** — one entry over any list cap (`maxRepeated`, `maxHeadings`,
  `maxLinks`, `maxImages`) is rejected; exactly at the cap is accepted.
- **Scenario: snapshot-caps-strings** — one character over any string cap (URL, title text, heading,
  anchor, alt, attribute, lang) is rejected; exactly at the cap is accepted.
- **Scenario: snapshot-is-strict** — an extra key anywhere, a missing key, a wrong type, a negative,
  fractional or non-finite count, a heading level outside 1–6, an unknown link kind, or a total
  below its list's length is rejected.
- **Scenario: parse-snapshot-never-throws** — `parseSnapshot` answers `invalid-snapshot` for
  `undefined`, `null`, a string, an array, a cyclic object and a getter that throws.

## Extraction (`apps/desktop/src/main/seo/__tests__/extract.test.ts`)
The extractor is one self-contained function in `extract.ts`, serialised with its limits into a
script string and run with `executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code }])`: never in
the main world, never changing the page's DOM, CSP or globals. It applies every cap while it reads
(lists stop at their cap, strings are cut before they are normalised, the word count walks text
nodes with a node, character and time budget and never reads `innerText`).
- **Scenario: extractor-runs-in-seo-world** — `runExtractor(contents)` calls
  `executeJavaScriptInIsolatedWorld` once, with `SEO_WORLD_ID` and one script, and answers its result.
- **Scenario: extractor-source-is-self-contained** — the script parses as JavaScript, embeds
  `SNAPSHOT_LIMITS` and `EXTRACT_TEXT_BUDGET_MS`, and names no Node or Electron global.

## Auditor (`apps/desktop/src/main/seo/__tests__/auditor.test.ts`; the controller with fakes)
- **Scenario: audit-runs-after-load** — `did-finish-load` on the active tab extracts once, after
  `AUDIT_DEBOUNCE_MS`; `getAudit` is `pending` until then, then `ready` with the audit of the tab's
  URL; `auditVersion` increased at each change, waking `watch`.
- **Scenario: audit-debounced** — `did-finish-load` and main-frame `did-navigate-in-page` events
  less than `AUDIT_DEBOUNCE_MS` apart extract once; subframe in-page navigations extract nothing.
- **Scenario: audit-active-tab-only** — events of a background tab extract nothing; when it becomes
  active its audit runs if it has none or it is for another URL, and does not rerun when it is
  still current.
- **Scenario: audit-matches-current-url** — a result that settles after the tab moved to another
  URL (`pushState`, or a new page) is dropped; `getAudit` never answers it for the new URL (it is
  `pending` until the new URL's own audit is ready), and a superseded run's late result never
  replaces a newer one.
- **Scenario: audit-timeout-is-unavailable** — an extraction that has not settled after
  `EXTRACT_TIMEOUT_MS` is `unavailable` (`timeout`); its late result is ignored.
- **Scenario: audit-invalid-snapshot-is-unavailable** — garbage, a snapshot over a cap, or one with
  an extra key is `unavailable` (`invalid-snapshot`); a run that throws is `extraction-failed`.
- **Scenario: audit-skips-non-pages** — an empty tab is `unavailable` (`no-page`), a load error
  `load-error`, a crashed tab `crashed`, an unknown id `no-tab`; none of them extracts.
- **Scenario: audit-rerun** — `rerun` extracts again at once (no debounce) and is `pending` until
  it settles; it answers `false` (and does nothing) for a tab that is not auditable.
- **Scenario: closed-tab-audit-is-forgotten** — closing a tab clears its pending timer; a late
  result for it changes nothing.

## Router (`packages/ipc-contract/src/__tests__/seo-router.test.ts`)
- **Scenario: seo-procedures-reject-foreign-sender-first** — `seo.getAudit` and `seo.rerun` reject a
  foreign sender with `FORBIDDEN` before parsing input; the service is never called.
- **Scenario: seo-procedures-validate-input** — a missing, non-integer, non-positive or extra-keyed
  `tabId` is `BAD_REQUEST`; the service is never called.
- **Scenario: seo-procedures-call-service** — `getAudit({ tabId })` answers the service's response;
  `rerun({ tabId })` its boolean.
- **Scenario: missing-seo-service-is-internal-error** — without an `seo` service both fail with the
  masked internal error.

## Toggle (`shortcuts.test.ts`, `controller.test.ts`, `menu.test.ts`)
- **Scenario: sidebar-shortcut-matches** — `Mod+Shift+S` (Cmd on macOS, Ctrl elsewhere; key-down and
  key-up) is the sidebar toggle; `Mod+S`, `Mod+Alt+Shift+S` and the other modifier are not.
- **Scenario: sidebar-shortcut-is-reserved** — on a tab's or the chrome's `before-input-event` it is
  consumed (`preventDefault`) and bumps `toggleSidebarSeq` once per press (on key-down).
- **Scenario: menu-toggles-sidebar** — the View menu has `SIDEBAR_TOGGLE_MENU_ID` with accelerator
  `CmdOrCtrl+Shift+S`, calling the controller's `toggleSidebar`.

## Renderer helpers (`apps/desktop/src/renderer/__tests__/seo-view.test.ts`)
- **Scenario: sidebar-open-from-storage** — `'1'` open, `'0'` closed, anything else (or none) the
  default (`SIDEBAR_DEFAULT_OPEN`).
- **Scenario: length-indicator** — below the minimum `short`, above the maximum `long`, else `ok`;
  missing `missing`.
- **Scenario: rail-statuses** — each available panel's dot comes from `panelStatus`; unavailable
  panels have none; nothing without a ready audit.
- **Scenario: response-matches-tab** — an answer is shown only for the tab it was fetched for and
  only while its `url` is the tab's URL; otherwise the sidebar shows `pending`.

## Sidebar (renderer)
- Docks right of the page area: the panel (`SIDEBAR_PANEL_WIDTH`), then the rail
  (`SIDEBAR_RAIL_WIDTH`) at the window's edge. The page area (and so the tab's view, through
  `setPageBounds`) shrinks to make room; collapsing hides the panel and keeps the rail. In a narrow
  window the page area keeps `PAGE_MIN_WIDTH` and the panel narrows instead
  (`narrow-window-keeps-page-usable`).
- The rail lists `SEO_PANELS` in order: available panels as buttons with a status dot, the others
  disabled, labelled `COMING_SOON_LABEL`, without a dot.
- Overview: the score ring (0–100, coloured by band) with the band's label, error / warning / info
  counts, and the top `OVERVIEW_TOP_ISSUES` ranked issues ("Show all" for the rest). Each issue
  expands to its why, its fix and its facts and samples.
- On-Page: title (with its length and an indicator against `TITLE_MIN_CHARS`…`TITLE_MAX_CHARS`),
  meta description (likewise), URL, canonical, meta robots, lang, viewport, the heading outline
  (indented, `H1`…`H6` tags), word count, link summary (internal, external, nofollow) and image
  summary (total, missing alt).
- States: `pending` shows a skeleton; `unavailable` its reason's message and Retry (`seo.rerun`); an
  empty tab a hint. The audit is fetched while the panel is collapsed too, so the rail's dots stay
  current.
- Page-derived strings are React text only: no `innerHTML`, no `dangerouslySetInnerHTML`, no
  `style=` props and no links in Task 1. Long values are cut with CSS, the full value in `title`.

## End to end (`apps/desktop/e2e/seo-sidebar.e2e.ts`, loopback pages)
- **Scenario: good-page-scores-high** — a well-formed page scores at least 90 (band `good`) with no
  error or warning issues, and On-Page shows its title, length, description, canonical, lang, viewport
  and heading outline.
- **Scenario: bad-page-shows-issues** — a page with no title, two H1s, images without alt and
  `noindex` lists `title-missing`, `h1-multiple`, `images-missing-alt` and `robots-noindex`, scores
  below 60, and the rail's On-Page dot is `error`; an issue expands to its why and fix.
- **Scenario: sidebar-toggle-resizes-page** — the toolbar button, the menu item and `Ctrl+Shift+S` in
  the page each toggle the panel; the tab's view widens by `SIDEBAR_PANEL_WIDTH` when it closes and
  narrows again when it opens; the state survives a relaunch on the same profile.
- **Scenario: spa-pushstate-reaudits** — `history.pushState` to a new path (with a new title) shows
  `pending` or the new audit, then an audit whose URL is the new one and whose title fact is the new
  title.
- **Scenario: hostile-page-snapshot-is-bounded** — a page with 100 000 links (space-separated: without
  break opportunities Chromium's own layout of them keeps the page busy for seconds, which is the
  `timeout` case below), a 10 MB title and
  `document.querySelectorAll` / `Array.prototype` / `JSON` overridden in its main world gets a
  ready audit within `EXTRACT_TIMEOUT_MS` (plus the debounce): `title-too-long` with the full length,
  at most `maxLinks` links analysed of the 100 000 reported; the page's overrides never ran for the
  extractor, and the chrome stays responsive (a new tab opens and closes).
- **Scenario: page-text-is-inert-in-sidebar** — a title, H1 and alt with `<img src=x onerror=…>`,
  `<script>` and a bidi override render as literal text; the sidebar's DOM gains no `img`, `script`
  or `a` element, and the `onerror` never runs in the chrome.
- **Scenario: busy-page-times-out-then-retries** — a page whose main thread is busy past
  `EXTRACT_TIMEOUT_MS` shows `unavailable` with the timeout message and Retry; Retry after it is
  idle gives a ready audit.
- **Scenario: empty-tab-shows-hint** — an empty tab shows the sidebar's hint, no score; the rail
  lists all six panels, the four not built yet disabled and without a status.
- **Scenario: narrow-window-keeps-page-usable** — with the chrome 500 px wide the tab's view keeps
  `PAGE_MIN_WIDTH`, the sidebar narrows (the rail stays), and a click in the page still lands.
