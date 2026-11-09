# Feature: projects

Spec: `specs/projects.spec.ts` (`PROJECT_RUN_LIMITS`, `RUN_STATES`, `RUN_TARGET_OUTCOMES`, Phase 10's
`RUN_SCOPES`, `normalizeSiteDomain`, `normalizeTag`, `BULK_SEARCH_LIMITS`, `splitBulkSearches`,
`PROJECT_SORTS`, `sortProjects`, Task 8's `RANK_RUN_DISCLOSURE`, `RANK_RUN_DISCLOSURE_SETTING_KEY`,
`RANK_RUN_QUERY_SPACING_MS`, `RUN_BLOCK_REASONS`, `RUN_BLOCK_REASON_LABELS`, `RUN_BLOCKED_NOTE`,
`CHECK_RANKINGS_TEXT`, `DUE_TEXT`),
`specs/capture-schedule.spec.ts` (Task 8: `AUTO_CAPTURE_AVAILABLE`, `RANK_CHECK_AVAILABLE`, `CAPTURE_CADENCE_MS`, `isDue`,
`SCHEDULE_TICK_MS`, `AUTO_CAPTURE_IDLE_S`, `AUTO_CAPTURE_RETRY_MS`, `AUTO_START_SUSPENDED_REASONS`,
`CAPTURE_SCHEDULE_NOTE`, `CADENCE_TEXT`), `specs/projects.spec.ts` (also
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
  a `tablet` query with `TABLET_QUERY_PROFILE` (`QUERY_DEVICE_PROFILES`), a `desktop` query with
  frost's default (never the project's profile: its device would file the reading under another
  search key than the saved search's).
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

## Searches in a run (Phase 10 Task 8; plan Decision 10)
- **Legal gate (L1, plan Decision 10).** "Check rankings" (the Overview button and the palette's "Check
  rankings now") is offered only when `RANK_CHECK_AVAILABLE` (`capture-schedule.spec.ts`) is `true`,
  and it is `false` until the owner's written L1 note is under `docs/research/` (flipped in the same
  change that adds it). While it is `false` neither is shown. Everything else in this section holds
  regardless: Capture now on a project with saved searches still asks the disclosure, paces its
  searches and stops at the first challenge (Phase 6's run made safer, not an L1 surface).
- **Disclosure first.** Before the first run with search targets (Capture now on a project whose run
  would visit a saved search, Check rankings) main shows `RANK_RUN_DISCLOSURE` in its own message box,
  parented as `DELETE_PROJECT` is (the focused window, else the app's), Cancel the default: frost loads
  the saved searches in a tab over this computer's connection, one every
  `RANK_RUN_QUERY_SPACING_MS`, so the positions recorded are **as your signed-in browser profile sees
  them**; engines' terms may restrict automated searches and an engine may answer with a consent page
  or a challenge; frost stops at the first one. Cancel answers `declined` (`RUN_REFUSALS`) and starts
  nothing; Continue is remembered once per install (`RANK_RUN_DISCLOSURE_SETTING_KEY` in
  `app_settings`, through main's settings repository) and the run starts. Main asks inside `startRun`
  (and `setCadence`, Cadence): the renderer cannot skip it. One question at a time: a second
  `startRun` while it is open waits for the same answer. A run of pages that are not result pages
  never asks. *Lead rulings of the Task 8 security review (amending plan Decision 10):* a **page
  target whose URL is an engine's result page** (`runSearchOf`: `searchParamsForUrl` reads it) counts
  as a search for the disclosure, the pacing and the stop below (its own parameters are what
  `sameRunSearch` compares); so does a **page target on an engine's result path** (`queriesAnEngine`:
  its host is one of the bundled pack's engine hosts and its path one of that engine's result `paths`
  (Google and Bing `/search`; DuckDuckGo `/`, `/html`, `/html/`), whatever its parameters or the pack's
  `reject` rules, e.g. Google `udm=50` or `tbm=isch`, DuckDuckGo `ia=images`): it is disclosed and
  paced, and the stop below blocks it (`not-a-result-page`: no result page of the search it is not).
  Any other page on an engine's host (Google Maps `/maps/…`, DuckDuckGo `/about`, Bing
  `/images/search`) sends no search: it is a page target as in Phase 6 (not disclosed, paced or
  gated); after a Continue, `startRun` **reads the project and its targets again**
  (a project deleted meanwhile is `not-found`; the run is of what it holds then); an **automatic
  start** (`startAutomaticRun`, the schedule's) never opens the dialog and is `declined` without a
  Continue already given.
- **Pacing.** Search navigations go at least `PROJECT_RUN_LIMITS.querySpacingMs`
  (`RANK_RUN_QUERY_SPACING_MS`, 10 s) apart: the run waits **between** targets, before it navigates the
  next search target. *Ruling (amends "only after a search that landed"):* the wait follows **every
  search navigation that was sent** (`navigate` answered `true`), landed or not, and the run service
  keeps its time **across runs** (Cancel then Check rankings, or a rerun after a blocked run, still
  waits); a navigation the browse guard refused was never sent and adds none. The wait is not part of
  any target's `targetActiveTimeoutMs`; Cancel (or a stop on quit) ends it at once. Page targets that
  are not result pages never wait. Fixed: no jitter, no user-agent change.
- **Stop at the first challenge, checked before capture.** Once a search target has landed:
  1. the landed URL must be a result page of the target's engine (`searchParamsForUrl(landed, device)`
     with the bundled pack): none, or another engine's (a consent page on another host, a `/sorry/`
     challenge path), blocks at once (`not-a-result-page`), before any verdict;
  2. the run waits while `serpVerdictOf(runTab, landed)` is `pending`, up to `serpSettleWaitMs` of
     active time, counted in the target's `targetActiveTimeoutMs`;
  3. it captures only on `ready` whose search is the target's: the tab's parameters are
     `searchParamsOf(runTab, landed)` and `sameRunSearch(tabParams, target.searchParams)` compares
     engine, host, query, `gl`, `hl`, device and page, and the landed URL's filters
     (`serpFiltersOf`) must be the target URL's (none for a saved search), so a reading a run stores
     is always under its search's key (`rankings.feature.md`). Another device (a site's pin, a run
     tab whose profile could not be set) or other filters is `mismatch`, nothing stored. A page target
     that is a result page is compared on the device of its group's profile (the project's).
     `ready` with no tab parameters is `no-reading`;
  4. otherwise it blocks **without capturing**: `unreadable`, `not-serp` (`not-a-result-page`),
     `disabled` (`serp-off`), `ready` for another search (`mismatch`), still `pending` after the wait
     (`no-reading`), or the target reaching `targetActiveTimeoutMs` before any of this (`timed-out`).
  *Rulings:* a search target whose load fails or whose tab crashes (offline, a reset, a redirect
  loop: it never landed) stops the run (`load-failed`); the landed document (`documentSeq`) is
  recorded, and any other document before the capture or the screenshot (another URL, or a same-URL
  reload) stops it (`not-a-result-page`) without a new check — a capture already made of the checked
  document stays, without its screenshot. *Whole-branch review ruling:* a URL change **within the same
  document** (`pushState` / `replaceState`, `documentSeq` unchanged) stops it only when the new URL is
  not a result page of the target's search (`searchParamsForUrl` reads none, or `sameRunSearch` with
  the target is false); one that keeps the search goes on at the new URL (not captured yet: its verdict
  and the tab's parameters are read again for it).
  A blocked run ends `blocked` (`RUN_STATES`, `RUN_END_STATES`) with `RunState.blockedReason`
  (`RUN_BLOCK_REASONS`); that target is `blocked`, every later one `cancelled`. `changes.capture` and
  the screenshot are never called for it: nothing of a challenge or consent page (no capture,
  version, reading or screenshot) is stored in the project. The next run starts as any run does
  (`blockedReason` `null`).
- Page targets (the user's own site) that are not result pages keep Phase 6's behaviour: no verdict, no
  gate, `timed-out` and the run goes on; they never block. A page target that is an engine's result
  page is a search target (ruling above). Manual captures and screenshots are unchanged.

## Cadence (Phase 10 Task 8; plan Decision 10)
- **Legal gate (L1).** The cadence and its Due notice ship only with the owner's written L1 note
  (`RANK_CHECK_AVAILABLE`, `false` until then). While it is `false`: `projects.setCadence` answers
  `unavailable` in main whatever is asked (nothing stored, no disclosure asked; the renderer cannot
  get past it), `setAutoCapture` answers `unavailable` too, every `ProjectSummary.due` is `false` (so
  the scheduler never sees a due project), and the Settings view has no cadence section and the list
  no "Due". The rest of this section describes the cadence once the flag is `true` (tests inject it).
- A project has a capture cadence (`CAPTURE_CADENCES`: `off`, the default, `daily`, `weekly`), set by
  `projects.setCadence`; device-local, never the project's `updated_at`. **Unfiled refuses a cadence**
  (`unfiled`).
- Before a cadence other than `off` is first set (the disclosure not yet answered Continue on this
  install), main asks `RANK_RUN_DISCLOSURE` as `startRun` does: Cancel is `declined` and nothing is
  stored; Continue is remembered. Setting `off` never asks.
- A cadence is a **due notice only**: `ProjectSummary.due` is `isDue(lastProjectRunAt, cadence, now)`
  (the project's newest `project`-source capture; none is due at once), shown "Due" in the list with
  Capture now, while frost is open. Missed periods are never back-filled: a project is due once.
- `ProjectSummary.autoCapture` and `projects.setAutoCapture` exist for a later phase: while
  `AUTO_CAPTURE_AVAILABLE` is `false`, `setAutoCapture` answers `unavailable` (nothing stored), the
  "Start automatically" switch is not shown, and main's scheduler (`capture-schedule.ts`, a
  `SCHEDULE_TICK_MS` timer started by `projects-main.ts`, stopped on quit) **never starts a run**.
  With the flag injected (tests only): a due project with auto start on starts (`all`, no
  screenshots) only with the system idle ≥ `AUTO_CAPTURE_IDLE_S`, a visible, non-minimised frost
  window, no run under way and (ruling) the disclosure already accepted — it never opens the dialog
  (`startAutomaticRun`); one attempt per project per `AUTO_CAPTURE_RETRY_MS`; cancelled as soon as it
  waits for its tab (it yields to the user); after any `blocked` run, manual or automatic, automatic
  starts are suspended until frost restarts (memory only), heard as the run ends (the run service's
  `onEnded`, ruling: not sampled at a tick). No login item, no background process, no server.

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
  query's `QUERY_DEVICE_PROFILES` profile, a `desktop` query's the default, a page's the project's), groups in the order of their first target, and listed in
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
     manual capture's), so a run's capture and a manual capture of one search share a lane. A **search
     target** is captured only on a matching `ready` reading (Searches in a run: the landed-URL check,
     the verdict wait, `sameRunSearch`), with those parameters; any other page stops the run
     (`blocked`) without a capture. A **page target** takes the tab's parameters when the service has
     them, else none. Asked
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
- A page target's run captures what it meets; a search target's run stops at a consent page or a
  challenge and captures nothing of it (`CAPTURE_RUN_NOTE`, said beside Capture now; Searches in a
  run). Search targets are paced (`querySpacingMs`).

## Router
- `projects.list`, `get`, `create`, `rename`, `setRenderProfile`, `remove`, `addPage`,
  `addCurrentPage`, `removePage`, `addSearch`, `removeSearch` (a query; no procedure name says
  "query", by `db-only-in-main`), `forPage`, `startRun`, `cancelRun`, `runState`; Phase 10's
  `setFavorite`, `setSite`, `addCompetitor`, `removeCompetitor`, `setTags`, `addSearches`; Task 8's
  `setCadence`, `setAutoCapture`. Each is `enforceSender` first, then `requireProjects` (fails closed without the
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
  `rankings.feature.md`'s (The views), and **Settings** (Task 7, below). The switch is a tablist of real buttons
  under the project's name (`data-testid="projects-views"`, each `projects-view-<id>` with
  `aria-selected`; Left/Right/Home/End move between them), and the shown view is a tabpanel
  (`data-view` on `projects-detail`). It opens on Overview; the palette's "Open rankings" and
  "Compare searches" open it on that view. While a run is under way the sheet stays the same band
  (`data-running`) whatever the view, the run's progress and Cancel show above the view (whichever it
  is), and nothing in a view opens a page (the run's tab is in front). Scenario
  `projects-run-progress-on-every-view` (`renderer/__tests__/rankings-components.test.ts`).
- **Star and sort (Phase 10 Task 7).** Each project in the list has a star (`data-testid="projects-star"`,
  a toggle button named `FAVORITE_TEXT.label` with `aria-pressed`) that calls `setFavorite`; Unfiled
  shows no star (it is always first; main still answers `setFavorite` for it). A sort menu above the list (`projects-sort`, a labelled `<select>` of
  `PROJECT_SORTS` with `PROJECT_SORT_LABELS`, `DEFAULT_PROJECT_SORT` when the sheet opens) orders it
  with `sortProjects`: Unfiled first, then favorites, then the rest. The sort is view state, never
  sent to main or kept.
- **Settings (Phase 10 Task 7).** The **Settings** view (`ProjectSettings.tsx`, `PROJECT_SETTINGS_TEXT`)
  holds:
  - the **site**: a domain or address input (`projects-site-input`, bounded to
    `SITE_INPUT_MAX_CHARS`), the "Include subdomains" switch (`projects-site-subdomains`, on for a
    project with no site), Save (`projects-site-save`) and Clear (`projects-site-clear`, only with a
    site set). The chrome reads the input with `normalizeSiteDomain` first (a refused one says
    `PROJECT_REFUSAL_MESSAGES['invalid-domain']` and sends nothing); an empty input clears the site.
    Main reads it again and is the authority (e.g. a bare public suffix);
  - the **competitors**: each with Remove (`projects-competitor`, `projects-competitor-remove`), an
    input and Add (`projects-competitor-input`, `projects-competitor-add`, read the same way), "n of
    `MAX_PROJECT_COMPETITORS`", Add disabled at the cap; adding a domain the project has says
    `competitorExists`;
  - the **cadence** (Task 8, `CADENCE_TEXT`): a labelled `<select>` of `CAPTURE_CADENCES`
    (`projects-cadence`, `CAPTURE_CADENCE_LABELS`) that calls `setCadence` (main may ask the
    disclosure first; `declined` says `CADENCE_TEXT.declined` and the menu shows the stored cadence),
    and the note `CAPTURE_SCHEDULE_NOTE` (`projects-cadence-note`). The "Start automatically" switch
    (`projects-auto-capture`) shows only when `AUTO_CAPTURE_AVAILABLE` (never in this phase). The
    whole section shows only when `RANK_CHECK_AVAILABLE` (L1; not while it is `false`).

  For Unfiled the view says `PROJECT_SETTINGS_TEXT.unfiled` and offers nothing to set. The Rankings
  view's "Set your site's domain to see its position" notice carries a button
  (`rankings-open-settings`) that switches to Settings.
- **Due, Check rankings and a blocked run (Phase 10 Task 8).** "Due" and Check rankings show only
  when `RANK_CHECK_AVAILABLE` (L1; neither while it is `false`). A project whose summary is `due` shows
  `DUE_TEXT.label` beside its name in the list (`projects-due`, described by `DUE_TEXT.note`).
  Overview's capture row has **Check rankings** (`projects-check-rankings`, `CHECK_RANKINGS_TEXT`):
  `startRun` with `scope: 'searches'`, without screenshots, disabled with no saved search or while a run
  is under way. A run that ended `blocked` shows `RUN_BLOCKED_NOTE` and its reason's
  `RUN_BLOCK_REASON_LABELS` text (`projects-run-blocked`) under its progress; its target says
  `RUN_TARGET_OUTCOME_LABELS.blocked`. A `declined` start says `RUN_REFUSAL_MESSAGES.declined`.
- **Tags (Phase 10 Task 7).** Each page and saved search row of Overview shows its tags
  (`projects-page-tags`, `projects-query-tags`, each tag `projects-tag`) and an "Edit tags" button
  (`projects-page-tags-edit`, `projects-query-tags-edit`) that opens an inline editor: one text
  input (`projects-tags-input`, named `TAG_EDITOR_TEXT.label`, comma-separated), Save
  (`projects-tags-save`) and Cancel (`projects-tags-cancel`; Esc cancels too, without closing the
  sheet). The chrome reads the text with `normalizeTags` (a refused tag or more than
  `MAX_TAGS_PER_ENTRY` says `PROJECT_REFUSAL_MESSAGES['invalid-tag']` and sends nothing) and sends the
  entry's tags afterwards with `setTags`.
- **Bulk add (Phase 10 Task 7).** "Bulk add…" (`projects-bulk-open`, in Overview's Search queries)
  opens the Bulk add dialog (`BulkAdd.tsx`, `role="dialog"`, `projects-bulk`) in place of the query
  form; focus goes to its text, Esc or Close (`projects-bulk-close`) closes it and gives focus back
  to "Bulk add…". It has:
  - the queries (`projects-bulk-text`, `BULK_ADD_TEXT.textLabel`, at most
    `BULK_SEARCH_LIMITS.maxTextChars`), one per line or comma-separated (`splitBulkSearches`; at most
    `maxLines`);
  - one engine (`projects-bulk-engine`, `SEARCH_ENGINES`);
  - 1–`BULK_SEARCH_LIMITS.maxLocales` country/language pairs (`projects-bulk-locales`; each row
    `projects-bulk-country`, `projects-bulk-language`, `projects-bulk-locale-remove`; "Add a locale"
    `projects-bulk-locale-add`, disabled at the cap), checked as the query form checks them, a pair
    given twice sent once;
  - devices (`projects-bulk-devices`, a checkbox each `projects-bulk-device-<device>`, at least one);
  - tags for the searches it adds (`projects-bulk-tags`, as the tag editor reads them);
  - a summary of how many searches it makes (`projects-bulk-summary`) and how many more the project
    can hold;
  - the note `BULK_ADD_TEXT.note` (`projects-bulk-note`): it only saves searches, and nothing is sent
    until you run Check rankings (or Capture now); while `RANK_CHECK_AVAILABLE` is `false` (L1) it is
    `BULK_ADD_TEXT.noteWithoutRankCheck` instead, naming Capture now only and no cadence;
  - Add searches (`projects-bulk-submit`), then the per-line outcomes (`projects-bulk-outcomes`, each
    `projects-bulk-outcome` with `data-outcome`, `BULK_LINE_OUTCOME_LABELS`, the query as text). The
    text is cleared once lines were added.
- Every refusal of these (`setFavorite`, `setSite`, `addCompetitor`, `removeCompetitor`, `setTags`,
  `addSearches`) shows its `PROJECT_REFUSAL_MESSAGES` text in the sheet's status line; an IPC failure
  says "Something went wrong. Try again.".

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
- "Check rankings now" (Phase 10 Task 8; once a project was opened in the sheet this session, and only
  when `RANK_CHECK_AVAILABLE`: not registered while it is `false`) opens the sheet on it and starts a
  `searches` run (main asks the disclosure first when it must).

## Known limits
- A search target that lands on a consent page on another URL stops the run (`not-a-result-page`):
  nothing of it is captured. A page target that redirects is captured at the URL it ended on.
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
  `capture-run-records-query-params` (a search target is captured with the run tab's parameters
  from `searchParamsOf` on a matching `ready` reading; a page target with the tab's, else none), `capture-run-retries-a-screenshot-behind-another-tab`,
  `capture-run-applies-profiles`, `capture-run-never-removes-a-pin`, `capture-run-cancels-on-tab-close`,
  `capture-run-cancels`, `capture-run-cancel-during-a-capture`, `capture-run-times-out-per-target`,
  `capture-run-restores-previous-tab`, `capture-run-keeps-the-users-tab`, `one-run-at-a-time`,
  `capture-run-retries-a-busy-screenshot`, `capture-run-stops-on-quit` (the hook: `before-quit` and a
  window's `close` close the run's tab at once, even during a capture),
  `capture-run-caps-targets`, `run-state-long-polls`; and over the real controller, render profiles and
  pins, `capture-run-pins.test.ts` `capture-run-never-removes-a-pin`. The capture's `pageUrl`:
  `service.test.ts` `capture-records-profile-and-params`.
- **Scenario: searches in a run** (Task 8) — Tests in `capture-run.test.ts`:
  `capture-run-spaces-search-targets` (fake clock; page targets not delayed; the wait is not counted in
  the next target's active time; Cancel during the wait ends the run at once),
  `capture-run-stops-at-a-challenge` (one case per reason: a consent page on another host, a
  `/sorry/` path on the engine host, `unreadable`, `disabled`, `ready` for another search, `pending`
  past `SERP_SETTLE_WAIT_MS`, a page that never finishes loading; each ends `blocked` with that reason,
  the rest `cancelled`, and `changes.capture` never called for the blocked target),
  `capture-run-captures-only-on-ready`, `capture-run-page-targets-never-block`,
  `capture-run-after-blocked-starts-normally`, `capture-run-no-wait-after-a-failed-load` (a
  navigation the guard refused), `capture-run-ready-needs-tab-params`; the review rulings'
  `capture-run-stops-after-a-failed-search-load`, `capture-run-result-page-target-is-gated`,
  `capture-run-blocks-a-reload-after-the-check`, `capture-run-spacing-holds-across-runs`; the
  whole-branch review's `capture-run-engine-host-page-is-gated` (a page target on an engine's result
  path that the pack refuses, e.g. Google `udm=50`: spaced and blocked `not-a-result-page`, nothing
  captured; the council review: a page off the result paths, e.g. `/maps/…`, is a page target, captured,
  and the run goes on)
  and `capture-run-same-document-url-change` (a `pushState` keeping the search captures; one changing
  the query blocks);
  the council review's `capture-run-files-a-search-under-its-saved-key` (a desktop saved search in a
  project on a phone profile is read on the desktop: its reading's key is the saved row's) and
  `capture-run-blocks-another-device-or-filters` (a site pin forcing mobile, a profile that could not
  be set, a filter on the landed URL: `mismatch`, nothing captured);
  `readings-spec.test.ts` `run-search-matches-built-urls`;
  `projects.test.ts` `rank-run-asks-once-before-first-search-run` (Cancel starts nothing; Continue
  remembered; a pages-only run never asks), `rank-run-disclosure-review-rulings` (a result-page page
  asks; targets read again after Continue; an automatic start never asks),
  `rank-run-asks-for-an-engine-host-page` (whole-branch review: a page on an engine's result path that
  the pack refuses, e.g. Google `udm=50`, asks too; a page on another host, or off the engine's result
  paths, never does), `cadence-asks-the-disclosure-first` (with `RANK_CHECK_AVAILABLE`
  injected `true`), `set-cadence-unavailable-until-cleared` (the shipped flag: `setCadence` is
  `unavailable` for every cadence, nothing stored, no disclosure asked; `setAutoCapture` `unavailable`;
  no summary `due`; Capture now with searches still asks and starts).
- **Scenario: cadence** (Task 8) — Tests in `apps/desktop/src/main/changes/__tests__/capture-schedule.test.ts`:
  `due-after-cadence`, `off-is-never-due`, `no-backfill-after-sleep`, `defaults-never-start-a-run` (the
  real `AUTO_CAPTURE_AVAILABLE`: due shows, nothing starts, `setAutoCapture` is `unavailable`); with the
  flag injected: `auto-start-needs-idle-visible-and-free`, `one-auto-attempt-per-retry-window`,
  `auto-run-yields-to-the-user`, `auto-start-suspended-after-blocked`,
  `auto-start-needs-the-disclosure-accepted`, `schedule-stops-on-quit`; the
  chrome: `projects-view.test.ts` `projects-view-due-label`, `projects-view-cadence-settings`,
  `projects-view-blocked-run`, and "Check rankings now" in `projects-palette-actions` (with
  `rankCheckAvailable: true` injected); `rankings-components.test.ts`
  `projects-due-check-rankings-and-cadence` (the flag injected `true`) and
  `rank-check-hidden-until-cleared` (the shipped flag: no Check rankings button, no "Due", no cadence
  section in Settings, no "Check rankings now" in the palette; Capture now still there).
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
  (with "Open rankings" and "Compare searches"); Phase 10 Task 7's `projects-view-favorites-and-sort`,
  `projects-view-settings-form` (site and competitors), `projects-view-bulk-add-form`,
  `projects-view-tags`; and the wiring in `rankings-components.test.ts`:
  `projects-settings-view-sets-site-and-competitors`, `projects-settings-unfiled-offers-nothing`,
  `projects-bulk-add-shows-outcomes`,
  `projects-star-sort-and-tags`;
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
- **Scenario: projects-bulk-add-with-tags** — in `apps/desktop/e2e/rankings.e2e.ts` (`rankings.feature.md`,
  End to end): Bulk add with three lines × two devices and a tag makes six tagged saved searches, the
  Rankings tag filter shows only them, and nothing is requested.
