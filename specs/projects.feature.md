# Feature: projects

Spec: `specs/projects.spec.ts` (`PROJECT_RUN_LIMITS`, `RUN_STATES`, `RUN_TARGET_OUTCOMES`,
`RUN_RETRY_REFUSALS`, `MOBILE_QUERY_PROFILE`, `SEARCH_PARAM_URL_RULES`, `SEARCH_PARAMS_NEVER_SENT`,
`searchUrlFor`, `queryLabel`, `PROJECT_REFUSALS`, `RUN_REFUSALS` and their messages, `CAPTURE_RUN_NOTE`,
`QUERY_LOCATION_NOTE`, `DELETE_PROJECT`, the answer types) and `specs/projects.schema.ts` (the Zod
inputs and answers). Storage: `ci_projects`, `ci_project_pages`, `ci_project_queries` and the purge
path of `specs/capture-db.spec.ts` (caps `MAX_PROJECTS`, `MAX_PROJECT_PAGES`, `MAX_PROJECT_QUERIES`,
`PROJECT_NAME_MAX_CHARS`). Phase 6 Task 6. Implemented by `apps/desktop/src/main/changes/projects.ts`
(the service), `capture-run.ts` (the run), `projects-dialog.ts` and `projects-main.ts` (Electron);
`packages/ipc-contract/src/projects-router.ts` (`projectsRouter`, `ProjectsService`); and the chrome's
`components/changes/Projects.tsx`, `ProjectPicker.tsx`, `projects-sheet.ts`, `projects-view.ts` and
`projects-palette.ts`.

## Projects
- A project is a name, an optional render profile, its pages (`http(s)` URLs, stored without
  userinfo or `#fragment`) and its search queries (`SearchParams`: engine, query, country, language,
  location, device). **Unfiled** is always there, listed first; it cannot be renamed or deleted.
- Names are trimmed; blank or longer than `PROJECT_NAME_MAX_CHARS` is `invalid-name`. A page that is
  not an `http(s)` URL frost can store is `invalid-url`; past a cap is `limit`. Adding a page or query
  the project already holds answers that row.
- "Add the current page" adds the active tab's page; with no web page it is `no-page`.
- A project's render profile is Default (stored as none) or a profile; the sheet offers Default and
  `QUICK_RENDER_PROFILES`.

## Search URLs
- A query is visited at `searchUrlFor(params)`: the engine's `SEARCH_ENGINES` URL for the query (lone
  surrogates as U+FFFD, `encodeURIComponent`-encoded, so the query is only ever its parameter's
  value), then the parameters of `SEARCH_PARAM_URL_RULES`, frost's own table: Google `hl`/`gl`, Bing
  `setlang`/`cc`, DuckDuckGo `kl` = `<country>-<language>` only when both are set.
- `location` is **never sent**: it is recorded with the query only (`QUERY_LOCATION_NOTE`). `device`
  is not a parameter: a `mobile` query is visited with `MOBILE_QUERY_PROFILE`.

## The service
- Every method answers; none rejects. A refusal is typed (`PROJECT_REFUSALS`, `RUN_REFUSALS`); a
  database failure is `store-failed` and one log line with its code, never its message.
- `get` answers the pages and queries, each with its last capture **in this project** and the change
  count of its lane's latest version (a page's lane has no search parameters; a query's has its own,
  so a desktop and a mobile query of one URL are told apart): `null` for a first version.
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
- **Targets:** each page, then each query's search URL, at most `maxRunTargets` (the rest are
  `omitted`, and the progress says so).
- **Render profiles:** the targets are grouped by the profile they need (a `mobile` query's
  `MOBILE_QUERY_PROFILE`, else the project's), groups in the order of their first target, and listed in
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
  4. `changes.capture(runTab, { projectId, source: 'project', searchParams, pageUrl })` (the query's
     parameters, else none; `pageUrl` the landed page, which the capture's audit must be of), asked
     again every `captureRetryMs` while it answers `no-audit`, `busy` or `not-active`; `no-tab` ends the
     run (`tab-closed`), `no-project` ends it (`cancelled`), any other refusal fails the target;
  5. with screenshots asked, a viewport screenshot linked to the capture (`captureId`, the same search
     parameters), asked again while it answers `not-active` and the target's time lasts; its size is
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
- **State:** `RunState`, served by the long-poll `projects.runState(sinceVersion)` (answers at once
  when newer, else on the next change or after `runStateWatchTimeoutMs`; at most
  `maxPendingRunWatches` wait).
- What a run meets is what it captures: search engines may answer with a consent page or a challenge
  (`CAPTURE_RUN_NOTE`, said beside Capture now).

## Router
- `projects.list`, `get`, `create`, `rename`, `setRenderProfile`, `remove`, `addPage`,
  `addCurrentPage`, `removePage`, `addSearch`, `removeSearch` (a query; no procedure name says
  "query", by `db-only-in-main`), `forPage`, `startRun`, `cancelRun`, `runState`. Each is `enforceSender` first, then `requireProjects` (fails closed without the
  service), with a strict input; the answers are checked against their schemas on the way out.

## The sheet
- Over the page column like History (`data-projects` on the page column; the page area gives way).
  It opens from the palette ("Open projects", "Add this page to a project", "Capture project now"),
  from the Changes panel's "Projects" button; Esc and Close close it.
- It lists the projects (Unfiled first) with create and inline rename, and shows one project: delete
  (main asks), its pages (add a URL, add the current page, remove), its queries (engine, query,
  country, language, device, location; remove), its render profile, and "Capture now" with "with
  viewport screenshots", the honesty note, the progress (current of total, each target's outcome) and
  Cancel. A page or query shows its last capture and change count; a click opens it in the active tab.
- While a run is under way the sheet is a band of fixed height (`data-running`) so the run's tab is on
  screen, and its pages and queries do not open (the run's tab is in front).
- The History sheet and this one never show together: opening one closes the other.
- The page column gives way by `.page-column:has(> .projects-sheet)` (no attribute on `App.tsx`'s column).
- A region is kept for Task 7's retention and disk usage.

## Changes panel
- A project picker next to Capture now: it lists the projects, starts on the first project listing the
  page (Unfiled aside), else Unfiled, and drives `setCaptureProject`, the seam the palette's "Capture
  this page" reads too. When the page or panel goes, captures go to Unfiled again. A choice the user made
  is never overridden by the default arriving late; a chosen project that is deleted falls back to the
  default; when the sheet changes the projects or their pages the picker reads them again (and the
  default with them, unless the user chose). "Projects" opens the sheet on the chosen project.

## Command palette
- "Open projects" opens the sheet; "Add this page to a project" (a web page in the tab) opens it asking
  which project; "Capture project now" (once a project was opened in the sheet this session) opens the
  sheet on it and starts its run (no screenshots). Deleting that project withdraws the action.

## Known limits
- A search engine that redirects (a consent page on another URL) is captured at the URL it ended on;
  `get` looks the query up at its search URL, so that capture is not shown on the query's row.
- A run waits for its tab with no end while another tab is in front; Cancel or closing the tab ends it.
- A page that redirects itself by script after its first commit is taken as the tab moving away: that
  target fails.
- Two targets of one group at the same URL that fail with the same error: the second is told only
  after a load is seen, else it times out.

## Scenarios
- **Scenario: search-url-for-params** — each engine's URL and parameters, encoding (the query never
  changes the host, path or hash), a lone surrogate as U+FFFD. Test:
  `apps/desktop/src/main/changes/__tests__/projects-spec.test.ts` `search-url-for-params`.
- **Scenario: search-url-never-sends-location** — `location` and `device` never reach the URL. Test:
  `projects-spec.test.ts` `search-url-never-sends-location`.
- **Scenario: projects-spec-values** — the long-poll matches `browser.watch`; the mobile profile; labels;
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
  `start-run-plans-pages-then-queries`.
- **Scenario: projects-never-reject** — Test: `projects.test.ts` `projects-never-reject`.
- **Scenario: capture run** — Tests in `apps/desktop/src/main/changes/__tests__/capture-run.test.ts`:
  `capture-run-visits-each-target-in-its-own-tab`, `capture-run-waits-for-active-tab`,
  `capture-run-retries-until-settled`, `capture-run-waits-for-its-navigation`,
  `capture-run-refuses-a-moved-tab`, `capture-run-fails-fast-on-a-load-error`,
  `capture-run-records-query-params`, `capture-run-retries-a-screenshot-behind-another-tab`,
  `capture-run-applies-profiles`, `capture-run-never-removes-a-pin`, `capture-run-cancels-on-tab-close`,
  `capture-run-cancels`, `capture-run-cancel-during-a-capture`, `capture-run-times-out-per-target`,
  `capture-run-restores-previous-tab`, `capture-run-keeps-the-users-tab`, `one-run-at-a-time`,
  `capture-run-caps-targets`, `run-state-long-polls`; and over the real controller, render profiles and
  pins, `capture-run-pins.test.ts` `capture-run-never-removes-a-pin`. The capture's `pageUrl`:
  `service.test.ts` `capture-records-profile-and-params`.
- **Scenario: router** — Tests in `packages/ipc-contract/src/__tests__/projects-router.test.ts`:
  `every-projects-procedure-enforces-sender` (and fail-closed), `projects-inputs-are-validated`,
  `projects-procedures-call-service`, `projects-answers-are-checked`.
- **Scenario: the sheet's helpers and palette** — Tests in
  `apps/desktop/src/renderer/__tests__/projects-view.test.ts`: `projects-view-profile-choice`,
  `projects-view-query-form`, `projects-view-page-input`, `projects-view-wording`,
  `projects-view-picked-project`, `projects-view-default-capture-project`, `projects-palette-actions`;
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
