# Feature: projects

Spec: `specs/projects.spec.ts` (`PROJECT_RUN_LIMITS`, `RUN_STATES`, `RUN_TARGET_OUTCOMES`, Phase 10's
`RUN_SCOPES`, `normalizeSiteDomain`, `normalizeTag`, `BULK_SEARCH_LIMITS`, `splitBulkSearches`,
`PROJECT_SORTS`, `sortProjects`,
`RUN_RETRY_REFUSALS`, `QUERY_DEVICE_PROFILES`, `SavedSearchInput`, `SEARCH_PARAM_URL_RULES`,
`searchLocaleFor`, `searchUrlFor`, `queryLabel`, `PROJECT_REFUSALS`, `RUN_REFUSALS` and their messages,
`CAPTURE_RUN_NOTE`, `QUERY_FIELD_MAX_CHARS`, `DELETE_PROJECT`, the answer types) and
`specs/projects.schema.ts` (the Zod inputs and answers, `SavedSearchInputSchema`). A saved search is
stored as Phase 3's search parameters (`specs/serp-search-params.schema.ts`). Storage: `ci_projects`, `ci_project_pages`, `ci_project_queries` and the purge
path of `specs/capture-db.spec.ts` (caps `MAX_PROJECTS`, `MAX_PROJECT_PAGES`, `MAX_PROJECT_QUERIES`,
`PROJECT_NAME_MAX_CHARS`). Phase 6 Task 6. Implemented by `apps/desktop/src/main/changes/projects.ts`
(the service), `capture-run.ts` (the run), `projects-dialog.ts` and `projects-main.ts` (Electron);
`packages/ipc-contract/src/projects-router.ts` (`projectsRouter`, `ProjectsService`); and the chrome's
`components/changes/Projects.tsx`, `ProjectPicker.tsx`, `projects-sheet.ts`, `projects-view.ts` and
`projects-palette.ts`.

## Projects
- A project is a name, an optional render profile, its pages (`http(s)` URLs, stored without
  userinfo or `#fragment`) and its search queries (saved searches: Phase 3's `SearchParams`, with
  `engine`, `engineLabel`, `query`, `gl`, `hl`, `device`, `page`, `offset` and the canonical `url`). **Unfiled** is always there, listed first; it cannot be renamed or deleted.
- Names are trimmed; blank or longer than `PROJECT_NAME_MAX_CHARS` is `invalid-name`. A page that is
  not an `http(s)` URL frost can store is `invalid-url`; past a cap is `limit`. Adding a page or query
  the project already holds answers that row.
- "Add the current page" adds the active tab's page; with no web page it is `no-page`.
- A project's render profile is Default (stored as none) or a profile; the sheet offers Default and
  `QUICK_RENDER_PROFILES`.

## Saved searches
- The query form sends a `SavedSearchInput` (engine, query, country, language, device: `desktop`,
  `mobile` or `tablet`), checked by `SavedSearchInputSchema`. There is no location: Phase 3's search
  parameters have none.
- Main builds its URL, `searchUrlFor(search)`: the engine's `SEARCH_ENGINES` URL for the query (lone
  surrogates as U+FFFD, `encodeURIComponent`-encoded, so the query is only ever its parameter's
  value), then the country and language by the bundled selector pack's parameter names
  (`SEARCH_PARAM_URL_RULES`): Google `gl`/`hl`, Bing `cc`/`setlang`, DuckDuckGo `kl` =
  `<country>-<language>` only when both are set; the country first, as in Phase 3's canonical URL.
- Main reads that URL as Phase 3 reads a result page (`apps/desktop/src/main/changes/serp-params.ts`
  `searchParamsForUrl`: Phase 3's `matchSerp` with the bundled selector pack, verified once, and the
  search's device) and stores what it answers, canonical JSON, as the saved search
  (`ci_project_queries.search_params`). A URL it does not read as a result page, or reads with another
  `gl` or `hl` than `searchLocaleFor(search)` (a value Phase 3 does not record), is `invalid-query`;
  so is any search while the bundled pack does not verify.
- A run visits the saved search's canonical `url`, which Phase 3 reads back as the same parameters.
  `device` is not a URL parameter: a `mobile` query is visited with `MOBILE_QUERY_PROFILE` (a phone),
  a `tablet` query with `TABLET_QUERY_PROFILE` (`QUERY_DEVICE_PROFILES`).
- **Reading saved searches:** a row is used only when its JSON parses with Phase 3's
  `SearchParamsSchema` and is what `searchParamsForUrl(params.url, params.device)` answers (so a run
  only ever visits an engine's result page); any other row is skipped, as the repository skips a
  tampered row. Saved searches written in Phase 6's earlier shape (`country`, `language`,
  `location`) exist only in development profiles (nothing was released) and are skipped the same way:
  there is no migration (captured rows are append-only by design).

## Site and competitors (Phase 10 Task 4; plan Decision 7)
- A project has an optional **site domain** and an "include subdomains" switch (on by default), set by
  `projects.setSite` (a domain or URL as typed, or `null` to clear it). Main reads it with
  `normalizeSiteDomain`: a host or an `http(s)` URL becomes its lowercase host (an IDN as punycode, via
  `URL`; port, path and trailing dots dropped); a non-public host (`isPublicHost` of
  `specs/private-address.spec.ts`: `localhost`, a single label, `.local`, `.example`, …), an IP literal,
  a label starting or ending with `-`, another scheme or a host longer than `DOMAIN_MAX_CHARS` is
  `invalid-domain`; so is a bare public suffix with nothing registrable (`co.uk`, `com.au`: main's
  `registrableOwner`, Phase 3's `ownerDomain` over `MULTI_PART_SUFFIXES`; an owner suffix such as
  `medium.com` is its own owner and stays allowed). A leading `www.` is kept (matching drops one `www.`
  when subdomains are off). The answer is the site as stored.
- Up to `MAX_PROJECT_COMPETITORS` **competitors** (`addCompetitor`, read the same way). A competitor is
  stored as its **owner domain** (`ownerDomain`), so `rival.com`, `www.rival.com` and `shop.rival.com`
  are one competitor: adding another host of an owner the project has answers that competitor (also at
  the cap); past the cap is `limit`; `removeCompetitor` tombstones it, `not-found` when it is not a live
  competitor of the project. `get` lists them, oldest first. The rank views match a competitor by its
  owner domain with subdomains on (Task 5).
- Whose positions they are is Phase 3's owner rule: main's `siteMatchOf(domain, subdomains)`
  (`apps/desktop/src/main/changes/workspace.ts`) gives the rank model's `SiteMatch` (`owner` from
  `ownerDomain`, `main/serp/serp-analyse.ts`).
- **Unfiled refuses site and competitors** (`unfiled`): it is where captures land when no project was
  chosen, not a site.
- These are device-local and never change the project's `updated_at` (`workspace-db.feature.md`,
  Sync position).

## Tags (plan Decision 8)
- A page or a saved search carries up to `MAX_TAGS_PER_ENTRY` tags (`projects.setTags`: the entry's
  kind, `page` or `search`, its id, and its tags afterwards); a project holds at most
  `MAX_PROJECT_TAGS` distinct tags (`limit`). Main reads each with `normalizeTag` (NFC, white space runs
  as one space, trimmed, lowercase; 1–`TAG_MAX_CHARS`; no control or bidirectional formatting
  character) and drops repeats (`normalizeTags`); a refused tag, or more than `MAX_TAGS_PER_ENTRY`, is
  `invalid-tag`. An entry that is not a live page or saved search of the live project is `not-found`.
  The answer is the entry's tags, sorted.
- Tags are a filter, not a hierarchy. `get` lists each page's and search's tags.
- Removing a page or a saved search tombstones its tags in the same batch; deleting a project
  tombstones its competitors and tags (`workspace-db.feature.md`, Repository).

## Bulk add (plan Decision 8)
- `projects.addSearches` takes `BulkSearchesInput`: the typed text, one engine, 1–`maxLocales`
  distinct country/language pairs and 1–3 distinct devices (`BULK_SEARCH_LIMITS`), and tags for the
  searches it adds. `splitBulkSearches(text)` makes its lines: one query per line or comma-separated,
  white space runs as one space, trimmed, blanks and repeats dropped; 1–`maxLines`
  (`MAX_PROJECT_QUERIES`) lines, else the input is refused.
- Each line makes one saved search per locale and device (`bulkSearchInputs`), each through **the
  Phase 6 path** of Saved searches: `searchUrlFor` → `searchParamsForUrl` (local: nothing is sent to
  any engine), the same check of the country and language read back, stored as `addSearch` stores it.
- Per-line outcomes (`BULK_LINE_OUTCOMES`): a line any of whose searches is not one frost can make is
  `invalid` and stores none of them; otherwise its searches are stored in order: `exists` when every
  one was already saved, `added` (with how many) when at least one was new; when the project reaches
  `MAX_PROJECT_QUERIES` the line is `limit` (what it added before stays) and **every later line is
  `limit` without being tried**.
- The tags (`normalizeTags`, else `invalid-tag` and nothing stored) go on each search the bulk add
  added; a project that would hold more than `MAX_PROJECT_TAGS` distinct tags is `limit` before
  anything is stored. Searches already saved keep their tags.
- Bulk add stores searches only: nothing is sent until a run visits them.

## Favorites and sort
- `projects.setFavorite` stars a project (Unfiled too); `ProjectSummary.favorite`. The summary also has
  `site`, `createdAt` and `lastCapturedAt` (the newest capture filed in it, of any source: one grouped
  read for the whole list, `projectsLastCapturedAt`).
- The list sorts in the chrome (view state, not persisted): `sortProjects(projects, sort)` with
  `PROJECT_SORTS` (`name` A–Z; `last-captured` newest `lastCapturedAt` first, never captured last; `created`
  newest first): Unfiled first, then favorites, then the rest, each part by the sort, ties by name.

## Run scope (plan Decision 11)
- `projects.startRun` takes `scope` (`RUN_SCOPES`: `all`, the default when left out, or `searches`).
  With `searches` the run visits only the saved searches ("Check rankings"); a project with none is
  `no-targets`. The caps are unchanged.

## The service
- Every method answers; none rejects. A refusal is typed (`PROJECT_REFUSALS`, `RUN_REFUSALS`); a
  database failure is `store-failed` and one log line with its code, never its message.
- `get` answers the pages and queries, each with its last capture **in this project** and the change
  count of its lane's latest version (a page's lane has no search parameters, or those the SERP
  service read when the page is a result page; a query's has its own, so a desktop and a mobile query
  of one URL are told apart): `null` for a first version.
- `forPage(url)` lists the live projects holding the page.

## Deleting a project
1. Unfiled is `unfiled`; a project whose run is under way is `running`.
2. Main asks in its own message box (`DELETE_PROJECT`, parented to the focused window, the name quoted
   and bidi-isolated; Cancel is the default): Cancel is `declined` and nothing changes.
3. The project is tombstoned with its pages and queries.
4. `planPurge({ mode: 'all' })` and `executePurge(…, 'project-deleted')`: every capture and screenshot
   of the project goes in one recorded purge; a version another project also captured stays.
5. Each hash of the purge's `unreferencedHashes` is checked again with `isHashReferenced`, and its file
   unlinked only if no row names it.
6. If the purge fails (after the tombstone), the delete still answers `deleted`, with `purged: null`;
   the sheet says `DELETED_NOT_PURGED`. `purgeDeleted` retries every tombstoned project that still has
   captures or screenshots (`deletedProjectsWithRows`), at startup and before each run.

## Capture now
- One run at a time, app-wide (`busy`, reserved as it starts). A project with no pages or queries is
  `no-targets`; the project is checked again as the run starts (`not-found`).
- **Start:** remember the active tab.
- **Targets:** each page, then each query's canonical URL (`params.url`), at most `maxRunTargets`
  (the rest are `omitted`, and the progress says so).
- **Render profiles:** the targets are grouped by the profile they need (a `mobile` or `tablet`
  query's `QUERY_DEVICE_PROFILES` profile, else the project's), groups in the order of their first target, and listed in
  the order they are visited. Each group gets a fresh browse tab through the browser controller (it
  is active; a tab limit is `no-tab`, or `failed` for a later group), whose own profile is set once,
  without `pin`, before its first navigation; a group needing the default gets no profile set at all.
  The run never sets the default profile on a tab (a Reset, which also unpins the site the tab shows)
  and never changes a tab's profile after it has loaded, so it never removes a pin. A site's pinned
  profile still applies in a run tab without one of its own (pins are the user's choice); the capture
  records the profile actually in effect (the audit's `renderProfile`). The next group's tab opens
  only with the last one in front.
- **For each target**, only while the run's tab is the active one:
  1. `navigate(url)` (which acts on the active tab);
  2. once a new document has committed and finished loading, the page of that first commit is the
     target's (a redirect is allowed); if the tab moves to another page afterwards (the user navigated
     it), the target fails;
  3. a load that fails is a failed target at once: an error that is new since the navigation (its text
     differs from the one before, or the URL changed), or one after a load was seen;
  4. `changes.capture(runTab, { projectId, source: 'project', searchParams, pageUrl })` (`pageUrl`
     the landed page, which the capture's audit must be of). `searchParams` are **the run tab's own**,
     read from Phase 3's SERP service for the landed page (`searchParamsOf(runTab, pageUrl)`, as a
     manual capture's), so a run's capture and a manual capture of one search share a lane; when the
     service has none for it (not read yet, a consent page on another URL, SERP reading disabled),
     the target's own: the saved search's parameters for a query, none for a page. Asked
     again every `captureRetryMs` while it answers `no-audit`, `busy` or `not-active`; `no-tab` ends the
     run (`tab-closed`), `no-project` ends it (`cancelled`), any other refusal fails the target;
  5. with screenshots asked, a viewport screenshot linked to the capture (`captureId`, the search
     parameters the capture recorded), asked again while it answers `not-active` or `busy` (another screenshot of the tab
     under way) and the target's time lasts; its size is
     the page area's below the sheet's band;
  6. the outcome (`RUN_TARGET_OUTCOMES`), with the capture's change count.
- **Timing:** while its tab is not active the run waits (`waiting-for-tab`) and that time does not
  count; a target gives up after `targetActiveTimeoutMs` of active time (`timed-out`). Time counts from
  one look at the tab to the next with it in front at both; time inside a capture or a screenshot
  counts the same way (an approximation).
- **Cancel:** Cancel, or its tab closing (`tab-closed`, also while a capture is under way); the
  remaining targets are `cancelled`. A capture under way when Cancel comes stays, without its screenshot.
- **End:** its tab closes if still open; the remembered tab is activated again only if the run's tab
  was the one in front (else the user's choice of tab stays) and the remembered one is still open.
- **Quit:** a run never leaves its tab in the saved session (the next launch would restore it as one
  of the user's tabs). The session store saves the strip as it changes and when the window closes
  (its `close` event), and flushes on `will-quit` (`flushBeforeQuit`, after both). Phase 6's wiring
  (`projects-main.ts`, `stopRunOnQuit`) stops the run, closing its tab **at once** (not when the run's
  loop next looks), the remembered tab in front again as at its end, on:
  - the app's `before-quit` (Quit from the menu or the dock: it comes before any window closes);
  - each window's `close` (registered from `browser-window-created`, so before the controller's own
    `close` listener saves the strip): closing the last window on Linux and Windows quits the app only
    after the window closed, when `before-quit` is too late.
  The run then ends `cancelled`, as a Cancel would; one stopped while it starts (its project being
  checked again) opens no tab (`no-tab`). Limit: a crash or a killed process saves nothing
  more, so a run tab already in the last saved strip stays there.
- **State:** `RunState`, served by the long-poll `projects.runState(sinceVersion)` (answers at once
  when newer, else on the next change or after `runStateWatchTimeoutMs`; at most
  `maxPendingRunWatches` wait).
- What a run meets is what it captures: search engines may answer with a consent page or a challenge
  (`CAPTURE_RUN_NOTE`, said beside Capture now).

## Router
- `projects.list`, `get`, `create`, `rename`, `setRenderProfile`, `remove`, `addPage`,
  `addCurrentPage`, `removePage`, `addSearch`, `removeSearch` (a query; no procedure name says
  "query", by `db-only-in-main`), `forPage`, `startRun`, `cancelRun`, `runState`; Phase 10's
  `setFavorite`, `setSite`, `addCompetitor`, `removeCompetitor`, `setTags`, `addSearches`. Each is `enforceSender` first, then `requireProjects` (fails closed without the
  service), with a strict input; the answers are checked against their schemas on the way out.

## The sheet
- Over the page column like History (`data-projects` on the page column; the page area gives way).
  It opens from the palette ("Open projects", "Add this page to a project", "Capture project now"),
  from the Changes panel's "Projects" button; Esc and Close close it.
- It lists the projects (Unfiled first) with create and inline rename, and shows one project: delete
  (main asks), its pages (add a URL, add the current page, remove), its queries (add: engine, query,
  country, language, device; each row shows the engine's label, the query, `gl`/`hl` and the device;
  remove), its render profile, and "Capture now" with "with
  viewport screenshots", the honesty note, the progress (current of total, each target's outcome) and
  Cancel. A page or query shows its last capture and change count; a click opens it in the active tab.
- While a run is under way the sheet is a band of fixed height (`data-running`) so the run's tab is on
  screen, and its pages and queries do not open (the run's tab is in front).
- The History sheet and this one never show together: opening one closes the other.
- The page column gives way by `.page-column:has(> .projects-sheet)` (no attribute on `App.tsx`'s column).
- Its retention and disk usage section is `retention.feature.md`'s (The project view).
- **Views (Phase 10 Task 6).** One project shows in one of its views (`PROJECT_VIEWS`,
  `PROJECT_VIEW_LABELS`): **Overview** (everything above: Capture now, pages, queries, retention),
  **Rankings** (the rank table and a search's series) and **Compare** (two readings side by side), both
  `rankings.feature.md`'s (The views); Task 7 adds **Settings**. The switch is a tablist of real buttons
  under the project's name (`data-testid="projects-views"`, each `projects-view-<id>` with
  `aria-selected`; Left/Right/Home/End move between them), and the shown view is a tabpanel
  (`data-view` on `projects-detail`). It opens on Overview; the palette's "Open rankings" and
  "Compare searches" open it on that view. While a run is under way the sheet stays the same band
  (`data-running`) whatever the view, the run's progress and Cancel show above the view (whichever it
  is), and nothing in a view opens a page (the run's tab is in front). Scenario
  `projects-run-progress-on-every-view` (`renderer/__tests__/rankings-components.test.ts`).

## Changes panel
- A project picker next to Capture now: it lists the projects, starts on the first project listing the
  page (Unfiled aside), else Unfiled, and drives `setCaptureProject`, the seam the palette's "Capture
  this page" reads too. When the page or panel goes, captures go to Unfiled again. A choice the user made
  is never overridden by the default arriving late; a chosen project that is deleted falls back to the
  default; when the sheet changes the projects or their pages the picker reads them again (and the
  default with them, unless the user chose). "Projects" opens the sheet on the chosen project.
- **Scenario: picker-refresh-never-outlives-the-picker** — a refresh (on focus, or after the sheet
  changed the projects) that answers after the picker left its page or the panel closed changes
  nothing: the capture destination stays as the picker gave it back. Test:
  `apps/desktop/src/renderer/__tests__/project-picker.test.ts`.

## Command palette
- "Open projects" opens the sheet; "Add this page to a project" (a web page in the tab) opens it asking
  which project; "Capture project now" (once a project was opened in the sheet this session) opens the
  sheet on it and starts its run (no screenshots). Deleting that project withdraws the action.
- "Open rankings" and "Compare searches" (Phase 10 Task 6) open the sheet on the Rankings or Compare
  view of the project last opened in the sheet (else the first project, Unfiled).

## Known limits
- A search engine that redirects (a consent page on another URL) is captured at the URL it ended on;
  `get` looks the query up at its search URL, so that capture is not shown on the query's row.
- Saved searches are read with the **bundled** selector pack, not one installed by "Check for
  selector updates": a pack update that renames an engine's parameters changes what the SERP service
  reads on a run tab (which the capture records), not the saved search's URL.
- A result page's lane follows its canonical search URL (Phase 3's `params.url`), not the URL it was
  reached at, so an engine's own tracking parameters never split one search into two lanes.
- A run waits for its tab with no end while another tab is in front; Cancel or closing the tab ends it.
- A page that redirects itself by script after its first commit is taken as the tab moving away: that
  target fails.
- Two targets of one group at the same URL that fail with the same error: the second is told only
  after a load is seen, else it times out.

## Scenarios
- **Scenario: search-url-for-params** — each engine's URL and parameters, encoding (the query never
  changes the host, path or hash), a lone surrogate as U+FFFD. Test:
  `apps/desktop/src/main/changes/__tests__/projects-spec.test.ts` `search-url-for-params`.
- **Scenario: search-url-reads-back-as-phase-3** — for every engine, with and without a country and
  a language and on each device, Phase 3's `matchSerp` reads `searchUrlFor(search)` with
  `searchLocaleFor(search)` and the search's device, and reads its canonical `url` back as the same
  parameters; `device` never reaches the URL. Test:
  `apps/desktop/src/main/changes/__tests__/serp-params.test.ts` `search-url-reads-back-as-phase-3`.
- **Scenario: saved-search-is-phase-3-params** — adding a search stores what `searchParamsForUrl`
  answers for its URL; a search Phase 3 does not read back is `invalid-query`; a stored row that is
  not Phase 3's parameters of its own URL (Phase 6's old shape, a tampered `url`) is skipped by `get`
  and `startRun`. Test: `projects.test.ts` `saved-search-is-phase-3-params`.
- **Scenario: projects-spec-values** — the long-poll matches `browser.watch`; the mobile and tablet profiles; labels;
  the delete dialog. Test: `projects-spec.test.ts` `projects-spec-values`.
- **Scenario: project-crud-validates** — create, rename, render profile, refusals. Test:
  `apps/desktop/src/main/changes/__tests__/projects.test.ts` `project-crud-validates`.
- **Scenario: project-pages-and-queries** — add (URL, current page, query), remove, `forPage`. Test:
  `projects.test.ts` `project-pages-and-queries`; caps: `project-page-cap`.
- **Scenario: project-detail-shows-last-capture** — last capture in the project and the latest
  version's change count, per lane. Test: `projects.test.ts` `project-detail-shows-last-capture`.
- **Scenario: delete-project-purges-and-unlinks** — tombstone, one `project-deleted` purge, shared
  versions kept, only unreferenced files unlinked. Tests: `projects.test.ts`
  `delete-project-purges-and-unlinks`, `delete-project-unlinks-only-unreferenced`,
  `delete-project-asks-first`.
- **Scenario: deleted-project-purge-is-retried** — a failed purge is retried at startup and before a run.
  Tests: `projects.test.ts` `deleted-project-purge-is-retried`; `packages/db/src/change-intel/__tests__/projects.test.ts`
  `deleted-projects-with-rows`.
- **Scenario: unfiled-cannot-be-deleted** — Test: `projects.test.ts` `unfiled-cannot-be-deleted`.
- **Scenario: start-run-plans-pages-then-queries** — Test: `projects.test.ts`
  `start-run-plans-pages-then-queries`; its scope (`searches` with no saved search is `no-targets`):
  `start-run-passes-its-scope`.
- **Scenario: projects-never-reject** — Test: `projects.test.ts` `projects-never-reject`.
- **Scenario: capture run** — Tests in `apps/desktop/src/main/changes/__tests__/capture-run.test.ts`:
  `capture-run-visits-each-target-in-its-own-tab`, `capture-run-waits-for-active-tab`,
  `capture-run-retries-until-settled`, `capture-run-waits-for-its-navigation`,
  `capture-run-refuses-a-moved-tab`, `capture-run-fails-fast-on-a-load-error`,
  `capture-run-records-query-params` (the run tab's parameters from `searchParamsOf`, else the
  target's), `capture-run-retries-a-screenshot-behind-another-tab`,
  `capture-run-applies-profiles`, `capture-run-never-removes-a-pin`, `capture-run-cancels-on-tab-close`,
  `capture-run-cancels`, `capture-run-cancel-during-a-capture`, `capture-run-times-out-per-target`,
  `capture-run-restores-previous-tab`, `capture-run-keeps-the-users-tab`, `one-run-at-a-time`,
  `capture-run-retries-a-busy-screenshot`, `capture-run-stops-on-quit` (the hook: `before-quit` and a
  window's `close` close the run's tab at once, even during a capture),
  `capture-run-caps-targets`, `run-state-long-polls`; and over the real controller, render profiles and
  pins, `capture-run-pins.test.ts` `capture-run-never-removes-a-pin`. The capture's `pageUrl`:
  `service.test.ts` `capture-records-profile-and-params`.
- **Scenario: project workspace** — Tests in `apps/desktop/src/main/changes/__tests__/workspace.test.ts`:
  `site-domain-normalized` (scheme, path, case, IDN, private hosts refused),
  `competitors-capped-and-unique`, `tags-normalized-and-capped`, `bulk-add-lines-and-combinations`
  (devices × locales; per-line outcomes; stops at the cap with `limit`),
  `bulk-add-uses-the-phase-6-path` (each through `searchUrlFor` + `searchParamsForUrl`; no network),
  `favorite-and-sort`, `unfiled-refuses-workspace-fields`, `workspace-never-rejects`; the values:
  `projects-spec.test.ts` `projects-workspace-values`; the run scope: `capture-run.test.ts`
  `run-scope-searches-skips-pages`.
- **Scenario: router** — Tests in `packages/ipc-contract/src/__tests__/projects-router.test.ts`:
  `every-projects-procedure-enforces-sender` (and fail-closed), `projects-inputs-are-validated`,
  `projects-procedures-call-service`, `projects-answers-are-checked`.
- **Scenario: the sheet's helpers and palette** — Tests in
  `apps/desktop/src/renderer/__tests__/projects-view.test.ts`: `projects-view-profile-choice`,
  `projects-view-query-form`, `projects-view-page-input`, `projects-view-wording`,
  `projects-view-picked-project`, `projects-view-default-capture-project`, `projects-palette-actions`
  (with "Open rankings" and "Compare searches");
  `use-projects-sheet.test.ts` `projects-and-history-sheets-exclude-each-other`; and
  `palette-all-features.test.ts` `palette-features-register-together`.

## End to end (`apps/desktop/e2e/projects.e2e.ts`, two loopback pages)
- **Scenario: projects-create-and-add-pages** — open the sheet (the page area gives way), create a
  project, add two URLs; a non-web address is refused; opening History closes it, and opening it
  closes History; Esc closes it.
- **Scenario: projects-capture-now** — Capture now with screenshots: both targets captured with their
  screenshots, the run's tab closes, the tab in front before is again, and the Changes panel of one of
  the pages starts its picker on the project and shows its version.
- **Scenario: projects-delete-purges** — Cancel in main's dialog keeps it; confirmed, the project, its
  captures and its screenshot files are gone, and the Changes panel shows no captures.
