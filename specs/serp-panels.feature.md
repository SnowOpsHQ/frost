# Feature: SERP and Visibility panels

Spec: `specs/seo-sidebar.spec.ts` (`SEO_PANELS`: `serp`, `visibility`), `specs/command-palette.spec.ts`
(`FEATURE_PANEL_JUMPS`), `specs/serp-service.spec.ts` (`SERP_OUTLINE_STYLES`, `SERP_NOT_SERP_MESSAGE`),
`specs/serp-service.schema.ts` (`SerpTabState`, `PackStatus`; types only in the chrome), `specs/serp.spec.ts`
(`SERP_UNREADABLE_MESSAGES`, `SERP_TRUNCATED_NOTE`, `SERP_DEVICE_LABELS`),
`specs/serp-selector-pack.spec.ts` (`SERP_RESULT_TYPE_LABELS`, `PACK_UPDATE_MESSAGES`, the e2e seams),
`specs/intent-classifier.spec.ts` (`INTENT_LABEL_NAMES`, `INTENT_DEFINITIONS`, `INTENT_STATE_MESSAGES`,
`INTENT_ENABLE_PROMPT`, `INTENT_ENABLE_MESSAGES`, `INTENT_E2E_FAKE_SWITCH`) and
`specs/visibility-probes.spec.ts` (`PROBE_AGENTS`, `PROBE_DISCLOSURE`, `PROBE_STATUS_LABELS`,
`PROBE_OUTCOME_MESSAGES`, `PROBE_ROBOTS_VERDICT_LABELS`, `PROBE_DIFF_FACTS`, `PROBE_TRUNCATED_NOTE`,
`PROBE_MODELLED_DIRECTIVES_NOTE`, `PROBE_ROBOTS_SERVED_NOTE`). Phase 3 Task 6. Each line maps to one
named test.

## Decisions
- **Two panels after JavaScript.** `serp` ("SERP") and `visibility` ("Visibility") are appended to
  `SEO_PANELS` with no audit categories. Neither waits for the audit: the sidebar renders them before
  its audit's pending and unavailable states, from the `serp.*` procedures alone.
- **No rail dot.** A rail dot is an audit verdict over a panel's rule categories (pass / warn / error).
  The SERP reading and the probes are observations, not verdicts, so these two panels have none
  (`railStatuses` leaves out a panel without categories).
- **The chrome only renders.** Every reading, pack, intent answer and probe run lives in main; the
  panels long-poll `serp.watch` and `serp.watchProbes` while mounted (`hooks/useSerp.ts`), as the checks
  do. The view models (`serp-view.ts`, `visibility-view.ts`) are pure and unit tested. No Zod in the
  renderer bundle: values come from `*.spec.ts`, shapes from `*.schema.ts` as types only.
- **Page text stays inert.** Titles, domains, queries, URLs and directives are React text
  (`PageText`, bidi-isolated), never markup and never links.
- **The user acts first.** Nothing in either panel requests anything by being shown: "Check for
  selector updates", "Enable on-device intent" and "Run visibility probes" are buttons (or palette
  actions), and the panels state what each will fetch before the click: the model's size, host and
  licence (`INTENT_ENABLE_PROMPT`), and the probes' disclosure (`PROBE_DISCLOSURE`). The palette asks
  the same questions as an inline confirmation.
- **Outlines follow the panel.** "Outline features on the page" is a toggle; leaving the SERP panel
  (another panel, a collapsed sidebar) turns the tab's outlines off, as the Phase 2 highlight does.
- **Accessible.** Every control has an accessible name; the ownership and probe tables are real
  `<table>` markup with header cells; the composition bar is an image with a text label, and its
  counts are listed as text beside it.

## SERP panel view model (`apps/desktop/src/renderer/__tests__/serp-view.test.ts`)
- **Scenario: serp-params-labels** — the search parameters bar from `SearchParams`: engine label,
  query, country (`gl`), language (`hl`), device (`SERP_DEVICE_LABELS`) and page, a missing `gl` / `hl`
  "Not set"; the parameters of a `pending`, `ready` or `unreadable` state, none for `not-serp` or
  `disabled`.
- **Scenario: serp-composition-segments** — one segment per type with results, in
  `SERP_RESULT_TYPES` order, each with its count, its `SERP_OUTLINE_STYLES` colour and its place on a
  0–100 bar (widths sum to 100); a summary sentence is the bar's text equivalent.
- **Scenario: serp-ownership-rows** — one row per domain in main's order, with its count, its share as
  a whole percent and its positions; the title names the page; `SERP_TRUNCATED_NOTE` when
  `ownership.complete` is false.
- **Scenario: serp-result-rows** — every result with its rank, its type label (organic results and ads
  numbered by position), its title ("No title" when empty) and its domain (`null` without a link).
- **Scenario: serp-intent-chip** — a `ready` answer is its label (`INTENT_LABEL_NAMES`), its definition
  and its confidence as a whole percent; `model-missing`, `downloading` and `unavailable` are their
  `INTENT_STATE_MESSAGES` (the first offers "Enable on-device intent"); `no-query` and `null` show no
  chip.
- **Scenario: serp-state-messages** — `not-serp` says `SERP_NOT_SERP_MESSAGE`; `unreadable` says
  "Couldn't read this layout" with `SERP_UNREADABLE_MESSAGES[reason]` and offers the update check;
  `disabled` says SERP reading is off (`pack-invalid`); `pending` says the page is being read.
- **Scenario: serp-known-state** — the palette reads the last state a panel saw for the tab; it is
  forgotten when the SERP panel unmounts (no panel watches it any more), so a stale state never
  decides what the palette offers.
- **Scenario: serp-pack-status-text** — the pack's version, source and publication date; a disabled
  pack says so; the last update check's outcome is `PACK_UPDATE_MESSAGES`, and a check under way says
  it is checking.

## Visibility panel view model (`apps/desktop/src/renderer/__tests__/visibility-view.test.ts`)
- **Scenario: probe-table-shape** — one column per agent in `PROBE_AGENTS` order (the browser first,
  the AI crawlers marked as frost's model) and one row per fact (status, redirects, robots.txt,
  noindex, nofollow, canonical, words, size, visible text); an `idle` run has no table.
- **Scenario: probe-table-cells** — a row's status, redirect hops, robots.txt verdict, noindex /
  nofollow, canonical, word count, size (with "cut") and text similarity as short text, the longer
  wording (`PROBE_OUTCOME_MESSAGES`, `PROBE_ROBOTS_VERDICT_LABELS`) as the cell's title; a row still
  waiting or with no answer shows a dash.
- **Scenario: probe-diff-marks** — a cell is marked when main's diff for that agent lists its fact
  (`redirects` for `redirects` or `finalUrl`); the browser's column never is; the count of agents that
  differ is in the summary.
- **Scenario: probe-notes** — `PROBE_TRUNCATED_NOTE` when a diff compared cut content,
  `PROBE_MODELLED_DIRECTIVES_NOTE` whenever there are rows, and the robots.txt files read with
  `PROBE_ROBOTS_SERVED_NOTE`.
- **Scenario: probes-known-state** — the palette reads the last probes a panel saw for the tab; they
  are forgotten when the Visibility panel unmounts or moves to another tab, so a run that ended
  unseen never leaves only Stop offered.
- **Scenario: classify-query-input** — a typed query is trimmed and cut to the classify input's cap,
  never splitting a surrogate pair; a blank one is not sent.
- **Scenario: query-intent-answer-belongs-to-its-query** (`query-intent.test.ts`) — submitting
  another query clears the shown answer at once; while it is classified no earlier answer shows
  beside the new query, and an earlier request that answers late is dropped.

## Command palette (`apps/desktop/src/renderer/__tests__/serp-palette.test.ts`)
Registered with one `registerPaletteActions` call from `components/seo/Serp.tsx`; both panels' jumps
are this feature's own (`FEATURE_PANEL_JUMPS`), so the built-ins list no second ones.
- **Scenario: serp-palette-jumps** — "Open SERP panel" and "Open Visibility panel" are always offered
  and open their panel with focus on its rail item; the built-ins offer neither again.
- **Scenario: serp-palette-outlines** — "Outline SERP features" on a web page whose last known reading
  is `ready` without outlines (or not known yet), opening the SERP panel; "Hide SERP outlines" while
  they are drawn; neither on a page known not to be a result page.
- **Scenario: serp-palette-pack-update** — "Check for selector updates" unless the pack is disabled or
  a check runs; it reports `PACK_UPDATE_MESSAGES[outcome]`.
- **Scenario: serp-palette-intent** — "Enable on-device intent" only while the model is missing (or the
  state is not known yet), asking first with `INTENT_ENABLE_PROMPT`; it reports
  `INTENT_ENABLE_MESSAGES[outcome]` and refreshes what the palette knows of the intent state.
- **Scenario: serp-palette-probes** — "Run visibility probes" on a web page with no run under way,
  asking first with `PROBE_DISCLOSURE` and opening the Visibility panel; "Stop visibility probes"
  while one runs.

## End to end (`apps/desktop/e2e/serp.e2e.ts`, `apps/desktop/e2e/visibility.e2e.ts`)
Synthetic result pages (frost's own minimal markup) served by a loopback server under a public-looking
name (`--host-resolver-rules`, `--frost-e2e-public-hosts`). The test makes an ephemeral Ed25519
keypair, signs a pack for that host (version above the bundled one) and serves it with its `.sig`;
`--frost-e2e-serp-pack-url` and `--frost-e2e-serp-pack-key` point the app at them.
- **Scenario: serp-nothing-before-action** — loading result pages and opening both panels requests
  neither the pack nor any probe; the pack is requested only by "Check for selector updates".
- **Scenario: serp-pack-update-installs** — "Check for selector updates" installs the test pack (its
  version and source shown, the outcome message); a result page on the test host is then read.
- **Scenario: serp-composition-and-ownership** — the composition bar and its counts, the ownership
  table (domains, counts, shares, positions) and the results list for a synthetic page.
- **Scenario: serp-params-per-tab** — two tabs with different `gl` / `hl`; switching tabs updates the
  parameters bar.
- **Scenario: serp-outlines-isolated** — the toggle draws the outlines in the SERP world; the page's
  main world sees no new globals and no shadow content (at most a host element with a closed root);
  a navigation removes them and turns the toggle off.
- **Scenario: serp-unreadable-layout** — a result page without the pack's results area says "Couldn't
  read this layout" with its reason, and offers the update check.
- **Scenario: serp-not-a-result-page** — a page that is no result page says "Not a search result
  page".
- **Scenario: serp-intent-fake** — with `--frost-e2e-intent-fake`, the real utility process answers the
  query's intent: a label and a confidence percent in the chip, and the Visibility panel's query box
  classifies a typed query.
- **Scenario: serp-intent-model-missing** — without the fake, the Visibility panel's query box offers
  "Enable on-device intent" with the download size, host and licence shown before any click.
- **Scenario: serp-panel-intent-model-missing** — without the fake, with the test pack installed, the
  SERP panel's chip on a synthetic result page says intent is off and offers "Enable on-device
  intent" with the size, host and licence shown before any click; the state stays `model-missing`
  and no model file appears in the profile (Enable is never clicked).
- **Scenario: serp-pack-requested-only-on-check** — after every other scenario, the pack was requested
  only by the two checks of `serp-pack-update-installs`.
- **Scenario: visibility-probes-per-agent** — on a loopback site whose robots.txt disallows GPTBot and
  which sends `X-Robots-Tag: googlebot: noindex` and a smaller page to one crawler, the disclosure is
  shown before the run; "Run visibility probes" fills one column per agent, with GPTBot's robots.txt
  and Googlebot's noindex marked as differences, and the notes shown; one request per crawler, and
  robots.txt asked at most once (main's cache).
- **Scenario: visibility-probes-stop** — a run against slow answers shows Stop; Stop ends it
  (`stopped`), keeping what was found.
