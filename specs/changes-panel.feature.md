# Feature: the Changes panel

Spec: the `changes` entry of `SEO_PANELS` (`specs/seo-sidebar.spec.ts`) and of
`FEATURE_PANEL_JUMPS` (`specs/command-palette.spec.ts`); the answers it reads are
`specs/changes.spec.ts` (`CaptureAnswer`, `HistoryAnswer`, `HistoryVersion`, `DiffAnswer`,
`CAPTURE_REFUSAL_MESSAGES`); the diff's shape and wording are `specs/capture.spec.ts`
(`DIFF_REGIONS`, `DIFF_REGION_LABELS`, `DIFF_FIELD_LABELS`, `CHANGE_KINDS`, `Change`,
`SnapshotDiff`); lane labels use `specs/render-profile.spec.ts` (`QUICK_RENDER_PROFILES`,
`renderProfileSummary`) and `specs/browser-polish.spec.ts` (`searchEngine`). Phase 6 Task 4; the
procedures are `changes-capture.feature.md`, the diff `changes-diff.feature.md`. Implemented by
`apps/desktop/src/renderer/changes-view.ts` (pure helpers), `changes-palette.ts` and
`components/changes/` (`Changes.tsx`, `changes-icons.tsx`).

## Where it lives
- A **Changes** rail item, after JavaScript, with frost's own icon. The panel has no rule categories
  (`categories: []`): it scores nothing, so its rail item has no status dot.
- The panel is one per tab and page: a new tab or another URL starts afresh, while an in-page anchor
  (the same URL but its `#fragment`, `pageUrlOf`) is the same page and keeps its state.
- The rail scrolls (no scrollbar drawn) in a window too short for every item.
- **History does not depend on the audit.** The sidebar hands the Changes panel the tab and its
  audit answer before it shows the audit's pending skeleton or its unavailable hint, so a page's
  history shows while its audit is pending or unavailable. Only capturing needs a ready audit.
- Without a web page (an empty tab, a non-`http(s)` page, an error or crash panel) the panel shows a
  hint and nothing else.

## Capture now
- **Capture now** is enabled only when main would take the capture (`canCapture`): the tab shows a
  web page that has finished loading, its audit is **ready** and settled (robots.txt no longer
  `pending`: that audit is provisional), and no capture is running. Otherwise it is disabled, and a
  line says why. Main's refusal stays the authority; this only keeps the button honest.
- It calls `changes.capture({ tabId, projectId })` (`captureInput`). The project has one source,
  `components/changes/capture-project.ts` (`captureProject` / `setCaptureProject`), read by the
  panel and by the palette alike: `undefined` (Unfiled) until Task 6's project picker sets it.
- The outcome is announced in a polite live region (`captureOutcomeText`):
  - a lane's first version: "Captured the first version of this page.";
  - a new version: "Captured a new version: N changes." (one change: "1 change");
  - an unchanged page: "No change since the last capture.";
  - a refusal: its `CAPTURE_REFUSAL_MESSAGES` text;
  - an IPC failure: "The capture could not be saved."
- After a capture (from the panel or the palette) the history is read again, as far as it was
  listed (a "Load more" is not undone) and at least as far as the captured version, following the
  cursor (`historyReadLimit`, `historyGoalMet`; at most `MAX_HISTORY_READS` pages).

## History
- `changes.history({ url })` for the tab's URL, newest first, one page (`HISTORY_PAGE_SIZE`) at a
  time. **Load more** reads the next page through the answer's cursor, and appends it (a version
  already listed is not listed twice).
- The history is read again when the tab, or the tab's URL, changes.
- Each version shows its time (`toLocaleString`, to the second), its capture count ("1 capture", "N captures") and
  its summary against its parent (`versionSummaryText`):
  - "First capture" when it has no parent;
  - "Earlier versions removed" when it has a parent but no summary (the parent or the diff was
    purged);
  - otherwise each region with changes, in `DIFF_REGIONS` order, `DIFF_REGION_LABELS` and its count
    (`Head 1 · Main content 2`); "No visible changes" when every count is 0.
- The list is keyboard-navigable: each version is a button; Tab reaches the list once (roving
  `tabIndex`, on the selected version); ArrowUp / ArrowDown move between them, Home / End go to the
  first and last; Enter or Space selects.
- Count badges (the History heading, the lane chips) read `N+` while the history has more pages.

## Lanes
- Versions are grouped into lanes by `laneKey` (`groupByLane`), in the order of each lane's newest
  version. A lane's label (`laneLabel`) is its render profile (`null` or the default profile:
  "Default"; a quick profile: its label, e.g. "Googlebot smartphone"; any other:
  `renderProfileSummary`), then its search parameters when it has any (the query in quotes, then the
  engine's label, country, language, location and device), joined with ` · `.
- With more than one lane, chips at the top name each lane (`aria-pressed` on the chosen one); the
  list shows only the chosen lane's versions. Which lane is shown, in order: the one the user chose
  (while it is in the history); else, after a capture, the captured version's lane (also after a
  "no change" capture whose version is not on the first page: the re-read reaches it); else the
  newest version's lane.

## Diff
- Selecting a version shows its diff against the previous version **of its lane**
  (`changes.diff({ fromVersionId, toVersionId })`). At first the lane's newest version is selected,
  so the latest pair is shown. **Compare with…** (a select) chooses any older version of the lane
  that is listed; each option reads its time to the second and its capture count.
- With no older version listed: "First capture: there is nothing to compare it with yet." when the
  version has no parent; "Earlier versions removed" when it has one but it is gone (or Load more, when
  the history has more pages).
- The diff is grouped by region, in `DIFF_REGIONS` order, each group a heading with the region's
  `DIFF_REGION_LABELS` text and its count (`groupChangesByRegion`). Each change shows:
  - its field (`DIFF_FIELD_LABELS`);
  - its kind as text and colour, never colour alone (`CHANGE_KIND_LABELS`: Added, Removed, Changed);
  - before and after, as text (an `added` change has no before, a `removed` one no after);
  - for an edited text block, its inline segments **in place of** before and after: they rebuild
    both sides (before = the shared and removed segments, after = the shared and added ones), with
    removed words struck through and added words underlined, all as text, and "removed" / "added"
    said to screen readers;
  - its context line, when it has one, labelled by what it names (`contextLabel`: a text change's
    is the unchanged block it **follows**, a link's its URL, a heading's its tag).
- `truncated`: "Showing the first N of M changes." `partial`: "One of these captures was cut short
  (a cap or the deadline), so some changes may be missing and removals are not reported."
- **Show unchanged regions** (a toggle button) lists the regions with no change (`unchangedRegions`).
- No change at all: "These versions read the same."
- A diff answered `null`: "These versions cannot be compared."
- A diff that could not be read: a line and **Retry**.

## States
- loading (`changes-loading`), error with Retry (`changes-error`), empty ("No captures of this page
  yet", `changes-empty`), no web page (`changes-no-page`).

## Inert page text
Everything from the page (titles, headings, link text, `href`s, text blocks, context, segments) is
React text in a `<bdi>`: never `dangerouslySetInnerHTML`, never a link. A link's `href` is shown as
text. No inline `style` attribute anywhere (strict CSP).

## Command palette (`changes-palette.ts`)
- "Open Changes panel" (`panel.changes`: the panel's own jump, `FEATURE_PANEL_JUMPS`).
- "Capture this page" (`changes.capture`): offered on a web page with a ready audit; runs
  `changes.capture` and answers the outcome text; the panel's history is read again.

## Scenarios

### Unit (`apps/desktop/src/renderer/__tests__/changes-view.test.ts`)
- **Scenario: lanes-group-and-label** — versions of two lanes group by `laneKey` in the order of each
  lane's newest version; a `null` or default profile is "Default", a quick profile its label, another
  its summary; search parameters follow the profile.
- **Scenario: version-summary-text** — "First capture", "Earlier versions removed", region counts in
  `DIFF_REGIONS` order with their labels, "No visible changes".
- **Scenario: regions-group-in-order** — changes given out of order group by region in
  `DIFF_REGIONS` order, keeping their order within a region; `unchangedRegions` lists the rest.
- **Scenario: change-kind-labels** — every `CHANGE_KINDS` entry has a label; capture counts are
  worded ("1 capture", "3 captures").
- **Scenario: capture-outcome-text** — a first version, a new version (1 change, N changes), no
  change, each refusal's message.
- **Scenario: capture-needs-a-settled-audit** — `canCapture` only with a ready audit whose robots.txt
  is not `pending`, of a loaded web page.
- **Scenario: history-reads-cover-their-goal** — `pageUrlOf` drops the fragment; a re-read asks for as
  many versions as were listed (in pages of at most `MAX_HISTORY_PAGE`) and runs until the captured
  version is listed or the history ends; a text change's context "Follows".
- **Scenario: compare-candidates** — the older versions of a lane, the default pair, and merging a
  further history page without repeats.

### Command palette (`apps/desktop/src/renderer/__tests__/changes-palette.test.ts`)
- **Scenario: changes-palette-actions** — "Open Changes panel" opens the panel focused; "Capture
  this page" is offered only on a web page with a ready audit, calls the capture with the tab's id
  and answers the outcome (and tells the panel, with the answer); it is not offered for a provisional
  audit or a loading page; the built-ins leave the panel's jump to it.

### End to end (`apps/desktop/e2e/changes.e2e.ts`, loopback; the page can be switched v1 ↔ v2)
- **Scenario: changes-capture-first-version** — open the Changes panel, capture: one version,
  "First capture".
- **Scenario: changes-capture-no-change** — capture again with nothing changed: still one version,
  its capture count 2, "No change since the last capture" announced.
- **Scenario: changes-diff-by-region** — switch the page to v2, reload, wait for the new ready
  audit, capture: two versions; the diff shows a Head title change and a Main content text change
  with inline segments, and a Navigation link change, each under its region heading.
- **Scenario: changes-history-shows-while-pending** — a captured page, left and then loaded again by a
  load that never finishes (its audit pending: a reload of the same URL keeps its ready audit on
  screen instead), still lists its history while the tab is loading, and Capture now is disabled
  with its reason.
- **Scenario: changes-renders-page-text-inert** — page text holding markup shows as text: no
  element, link or script from it in the panel, and nothing it would run ran.
