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
- **Scenario: eight-columns-fit** — a full run of the eight agents (`PROBE_AGENT_IDS`, the two OpenAI
  agents last, marked as frost's model like the other AI crawlers) gives eight columns and eight cells
  in every row, each column headed by the agent's short label (at most 20 characters) so the table
  stays narrow enough to scroll sideways in the panel.
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
  is `ready` without outlines (or not known yet), opening the SERP panel with focus on its rail item
  (the palette restores none); "Hide SERP outlines" while they are drawn; neither on a page known
  not to be a result page.
- **Scenario: serp-palette-pack-update** — "Check for selector updates" unless the pack is disabled or
  a check runs; it reports `PACK_UPDATE_MESSAGES[outcome]`.
- **Scenario: serp-palette-intent** — "Enable on-device intent" only while the model is missing (or the
  state is not known yet), asking first with `INTENT_ENABLE_PROMPT`; it reports
  `INTENT_ENABLE_MESSAGES[outcome]` and refreshes what the palette knows of the intent state.
- **Scenario: serp-palette-probes** — "Run visibility probes" on a web page with no run under way,
  asking first with `PROBE_DISCLOSURE` and opening the Visibility panel with focus on its rail item;
  "Stop visibility probes" while one runs.

## Edit search (Phase 10 Task 9; `specs/serp-param-editor.spec.ts`; plan Decisions 4 and 12)
On a result page the parameters bar offers **Edit search** and **Track this search…**. The editor
reloads the tab's search with other settings; it never changes what is tracked (a capture of the page
it lands on is filed under that page's own search key).
- **Closed values only.** Each field is a menu (`SERP_EDITOR_FIELDS`): Google's domain
  (`GOOGLE_EDITOR_HOSTS`, the bundled pack's Google hosts), country, language, time (`tbs`), results
  per page (`num`, with `SERP_NUM_HINT`: the engine may ignore it), SafeSearch (`safe`) and
  personalised results (`pws`); Bing's country and language (`cc`, `setlang`); DuckDuckGo's region
  (`kl`), time (`df`) and SafeSearch (`kp`); any other engine its country and language, by the
  selector pack's names (`SerpTabState.paramNames`). Country, language and region lists are frost's
  own (`EDITOR_COUNTRIES`, `EDITOR_LANGUAGES`, `EDITOR_DDG_REGIONS`), plus the tab's own value when it
  has a saved search's form. Nothing typed reaches a URL: the only text is the tab's own query.
- **DuckDuckGo's region is a search parameter.** `kl` is the pack's `gl` name, so the region is
  `SearchParams.gl` (`us-en`) and part of the search itself, never a filter
  (`SERP_FILTER_PARAMS.duckduckgo` is `df`, `kp`).
- **Apply** loads the built URL (`editedSearchUrl`) through `browser.navigate`, the address bar's
  path with its browse guards; it is disabled while the URL is `null`. No page script runs.
- **Track this search…** picks a project and calls `projects.addSearch` with `trackableSearch`'s saved
  search (Phase 6's validated path: main builds and reads the URL again). It is disabled with the
  reason (`TRACK_REFUSAL_MESSAGES`) for a search a saved search cannot be: another engine, another
  address (`google.de`), a later page, filters, or a query or locale a saved search does not take;
  such a search is tracked by capturing it into a project.
- **Keyboard.** Every field is a labelled `<select>`; Escape closes the editor and gives focus back
  to Edit search.

### View model (`apps/desktop/src/renderer/__tests__/serp-editor-view.test.ts`)
- **Scenario: editor-fields-per-engine** — Google: domain, country, language, time, results per page
  (with `SERP_NUM_HINT`), SafeSearch, personalised results; Bing: country and language; DuckDuckGo:
  region, time, SafeSearch; another engine: country and language only, and only those the pack names.
  Each list is closed; the tab's own country or language is offered when it has a saved search's form.
- **Scenario: editor-starts-from-the-tabs-filters** — the state starts from the tab's `gl`, `hl`, host
  and the filters on its page URL (`serpFiltersOf`); changing the country of a "past week" page keeps
  "past week"; a value the editor does not offer starts as not set and is named as cleared.
- **Scenario: edited-url-keeps-path-and-allowed-host** — the path is the tab's; Google's host is one of
  `GOOGLE_EDITOR_HOSTS` over `https:` (another host, or none chosen: `null`); other engines keep their
  origin; unknown parameters (`ei`, `udm`, tracking) are dropped.
- **Scenario: edited-url-encodes-values** — the query is re-encoded as `searchEngineUrl` does; a query
  or a state value with `&`, `#`, `=`, `%`, a newline, `//evil.com` or `@` can never add a parameter or
  change the host or path (a value outside a field's list gives `null`).
- **Scenario: edited-url-resets-page** — a page-3 search loads page 1 (no offset parameter).
- **Scenario: editor-keeps-the-pages-port** — Phase 3's canonical `params.url` has no port, so Apply
  builds from the page's own origin when it is the same scheme, host and path: an engine served on a
  port (the e2e's synthetic engine) is edited on that port; Google's chosen domain stays `https:`
  without one; a page URL of another host or path changes nothing.
- **Scenario: trackable-search-rules** — only an engine of `SEARCH_ENGINES`, on its default address,
  page 1, no filters, a query and locale a saved search takes; otherwise `null` with the reason; a
  DuckDuckGo region becomes its country and language.
- **Scenario: editor-requests-reach-the-panel** — a palette request opens the editor or the picker in
  the SERP panel of that tab only, once.

### Main (`apps/desktop/src/main/changes/__tests__/serp-params.test.ts`, `apps/desktop/src/main/serp/__tests__/service.test.ts`)
- **Scenario: edited-url-reads-back** — `GOOGLE_EDITOR_HOSTS` are exactly the bundled pack's Google
  hosts; for every one, Phase 3's `matchSerp` with the bundled pack reads an edited URL as the same
  query, `gl` and `hl`, page 1; its filters (`serpFiltersOf`) are the state's; the same for Bing and
  DuckDuckGo.
- **Scenario: serp-service-param-names** — the tab state names the pack's query, country and language
  parameters of a result page's engine, and none for a page that is not one.

### Command palette (`serp-palette.test.ts`)
- **Scenario: serp-palette-edit-and-track** — "Edit search…" on a known result page opens the SERP
  panel with the editor; "Track this search…" opens it with the project picker when the search is
  trackable, and answers the reason when it is not; neither on a page known not to be a result page.

## Open in an AI engine (Phase 10 Task 10; `specs/ai-destinations.spec.ts`; plan Decision 13)
On a result page (a `pending`, `ready` or `unreadable` reading with search parameters) the SERP panel
shows an **Open in** row under the search tools, and the editor shows the same row: one button per
`AI_SEARCH_DESTINATIONS` entry (Perplexity, ChatGPT, Google AI Mode), with `AI_DESTINATION_NOTE`
stated beside it before any click. The palette offers the same, asking first with the note.
- **The tab's own search.** A button or palette action calls `serp.openDestination` with the tab id and
  the destination id only. Main reads the tab's SERP state, takes its `params.query`, builds the URL
  with `aiDestinationUrl` (the table's fixed `https:` origin and path, the query as one encoded value)
  and opens it with the browser controller's `openBackgroundTab(url, false)` (browse guards, tab cap,
  no render profile inherited). Nothing the renderer typed reaches the URL.
- **Only on the user's action.** Nothing opens a destination by itself: no page load, reading, watch
  or panel mount calls `serp.openDestination`.
- **Refusals** (`OPEN_DESTINATION_REFUSALS`): `no-search` for a tab showing no search (not a result
  page, reading off, an unreadable page without parameters, a URL that does not fit); `no-tab` when no
  tab opened (the tab cap, no window, no opener wired). The status line says
  `OPEN_DESTINATION_REFUSAL_MESSAGES[reason]`, or that the destination opened in a background tab.
- **Not a result page of frost's.** The destinations' pages are never read as SERPs: the bundled
  pack's `matchSerp` answers `null` for each URL (Google AI Mode's `udm=50` hits the pack's `reject`
  rule). frost runs nothing specific there (the generic audit runs as on any page).

### Main (`apps/desktop/src/main/serp/__tests__/destinations.test.ts`)
- **Scenario: destination-urls-are-fixed-https** — each URL is the table's `https:` origin and path
  with exactly its parameters; a query with `&`, `#`, `/`, `=`, `@`, `//evil.com`, a newline or a lone
  surrogate stays one value; a blank query or one past `OPEN_IN_URL_MAX_LENGTH` gives `null`.
- **Scenario: destination-uses-the-tabs-own-query** — the URL carries the tab's `params.query` (from a
  `pending`, `ready` or `unreadable` state); a tab that is not a SERP (`not-serp`, `disabled`, an
  unreadable page without parameters) is `no-search`, and the opener is never called.
- **Scenario: destination-opener-gets-only-table-urls** — the injected opener receives exactly
  `aiDestinationUrl(destination, query)` and nothing else, once per call.
- **Scenario: ai-destinations-are-not-serps** — the bundled pack's `matchSerp` gives `null` for every
  destination URL, on every device.
- **Scenario: destination-no-tab-at-the-cap** — an opener answering `null` (the tab cap) gives
  `no-tab`; so does a service set up without an opener.

### Router (`packages/ipc-contract/src/__tests__/serp-router.test.ts`)
- **Scenario: open-destination-enforces-sender** — `serp.openDestination` refuses a foreign sender
  before the service is touched, takes `{ tabId, destination }` strictly (no query, URL or host;
  an unknown destination is refused), fails closed without the service and answers
  `OpenDestinationAnswerSchema`.

### Command palette (`serp-palette.test.ts`)
- **Scenario: serp-palette-ai-destinations** — one action per destination on a known result page
  (none on a page known not to be one, before the chrome has seen one, or without a tab), asking first
  with `AI_DESTINATION_NOTE`; running it calls `openDestination(tabId, id)` only, and reports the
  answer (`openDestinationMessage`).

### End to end (`apps/desktop/e2e/rankings.e2e.ts`)
- **Scenario: serp-editor-applies-country-and-language** — on page 3 of a synthetic search, Edit search
  sets country and language: the tab's URL is the same origin and path with the query and the pack's
  `gl`/`hl` names only (page reset to 1). (`rankings.feature.md`, End to end.)
- **Scenario: serp-open-in-perplexity** — on the synthetic result page, the panel's
  `serp-open-in-perplexity` button opens a new tab whose address is the built URL; the destination
  host resolves to `~NOTFOUND`, so nothing loads.

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
