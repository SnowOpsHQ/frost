# Phase 6 — Change Intelligence Implementation Plan

> **For agentic workers:** implement task by task, subagent-driven. A fresh implementer runs each
> task (spec, then a failing test, then the code, then one conventional commit), and a fresh reviewer
> checks it before the next task starts. A whole-branch review runs at the end. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** per-page change history and visual evidence, with explicit retention controls:
- capture what a page says to search engines, and keep each distinct state as an immutable version;
- see what changed between two versions, region by region, in a readable diff;
- keep screenshots (viewport, a selected area, the full page) as local evidence;
- group pages and queries into projects and capture them on demand;
- inspect the current page's DOM read-only;
- decide how long any of it is kept, see what it costs on disk, and purge on request.

**Architecture:** the Phase 2 and 2.5 architecture holds:
- page-facing scripts run only in isolated worlds;
- the chrome talks to main only through `enforceSender`-first tRPC procedures;
- page text is always inert;
- `@app/db` is main-only.

New in this phase:
- **Append-only tables** in the session database (`frost-browser.db`, migrations `0040`–`0041`).
  SQLite triggers refuse every `UPDATE` and `DELETE` on captured rows. The one exception is a
  recorded purge: a row may be deleted only once an immutable tombstone names it (see Schema).
- **A pure diff engine** in a new package, `@app/change-intel`: no Electron, DOM, Zod or Node APIs.
- **A capture** joins two sources: the tab's ready audit (Phase 2) and a region extraction run in a
  new isolated world. The region extraction tags each heading, link and text block with the page
  landmark it sits in.
- **Screenshots** come from `webContents.capturePage`. A full page is stitched from viewport captures
  as the page is scrolled. Files are named only by their content hash, under the profile directory.
- **Projects' capture-now** drives one visible tab of its own through the project's pages and
  queries. Only the active tab is ever audited (Phase 2's rule), so the capture tab is active while it
  works, and the run waits whenever it is not.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §4 Phase 6, and §2 (Data: `node:sqlite` now, libSQL in Phase 7
  through a driver swap).
- UI direction: `docs/ui-reference/README.md` (Changes panel; Projects and Screenshots views).

## Spec-Driven Development protocol
As before:
- every task authors its `specs/` artifacts first;
- each scenario has a named test that cites it;
- reviewers check that spec, test and code agree.

## Global Constraints
Everything in the Phase 0–2.5 Global Constraints and `CONTRIBUTING.md` still holds, plus the
following.
- **Clean-room.** Behaviour is specified here in frost's own words, from SEO practice and public web
  standards (ARIA landmarks, HTML sectioning). Nothing is copied from any other product's UI text,
  code, prompts or assets.
- **Team contract (parallel phases).**
  - New files live in Phase 6's own namespace:
    - `packages/db/src/change-intel/`, `packages/change-intel/`;
    - `packages/ipc-contract/src/{changes-router,changes-service,projects-router,inspector-router}.ts`;
    - `specs/{changes,capture,screenshot,projects,inspector,retention}-*`;
    - `apps/desktop/src/main/{changes,screenshots,inspector}/`;
    - renderer `changes-view.ts`, `projects-view.ts`, `inspector-view.ts`, their palette files, and
      `components/changes/`.
  - Shared hub files change only by small, append-only, one-line registrations; all logic stays in
    Phase 6's files. A hub file is never reformatted or reordered. The hub files are:
    - `router.ts`, `services.ts`, `index.ts` (main and ipc-contract);
    - `App.tsx`, `SeoSidebar.tsx`, the `SEO_PANELS` registry;
    - `migrations.ts`, `store.ts`, `packages/db/src/index.ts`;
    - the root `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
  - Migration ids are `0040`–`0059`. Tests are turbo `test` tasks; CI workflows are not touched.
- **Main only, no paths from outside main.**
  - Screenshot files are written only under `<userData>/frost-captures/screenshots/`.
  - A file's name is its own SHA-256 (`/^[0-9a-f]{64}\.png$/`), computed by main from the bytes it
    encoded. No procedure takes a path, a file name or a hash to read from.
  - The directory is created `0700`, files `0600`. Writes go to a temporary name in the same
    directory and are renamed into place; a symlink there is never followed.
- **Read-only towards the page.** Capture, screenshot and inspector scripts read the DOM in their
  own isolated worlds, and never change a page element's attributes, styles or text.
  - The area selector, the picker highlight and the inspector highlight live in a closed shadow root
    on one host element of their own (the Phase 2 highlight's technique). It is removed when done.
  - A full-page screenshot scrolls the page, which the page can observe. The UI says so, and the
    original scroll position is restored.
  - Only trusted input events (`event.isTrusted`) select an area or pick an element, so a page
    cannot pick for the user.
- **Bounded.** Every extraction, list, tree, image and diff has a cap and a deadline, written in the
  specs. A hostile page gives a `partial` capture, never an unbounded one.
- **Isolated worlds.** Phase 6 takes world ids `1_600` (capture regions), `1_601` (screenshots:
  scroll and area selection) and `1_602` (inspector); no other phase uses them.
- **Local-first, honest.** Captures and screenshots never leave the machine in this phase. Disk usage
  shows measured numbers: rows' stored bytes, files' sizes from `stat`, and the database file. It
  says when freed space is reclaimed only by compaction.
- **Clear Browsing Data** leaves change intelligence alone. Captures, screenshots and projects are
  the user's evidence, kept until retention or "Purge now" removes them; the retention controls are
  the deletion path. The dialog text is not changed (Phase 1's file).

## Review Focus
- **Captured rows cannot be changed or silently deleted.**
  - The triggers reject `UPDATE` and `DELETE` on every captured table, whoever runs the SQL.
  - A delete passes only for a row with a tombstone of a recorded purge.
  - A tombstoned id can never be inserted again.
  - Task 1 (`captured-rows-are-immutable`, `purge-needs-a-tombstone`, `tombstoned-ids-never-return`).
- **Schema stays libSQL-compatible.** Plain SQLite SQL only: tables, indexes, `CHECK`s and triggers
  with `RAISE(ABORT, …)`; no `PRAGMA`, `ATTACH`, virtual tables, JSON functions, generated columns or
  `STRICT` in migrations. Task 1 (`change-intel-sql-is-portable`).
- **Screenshot files cannot be pointed elsewhere.** Hash-only names, containment checks, no symlink
  follow, no renderer-supplied path. Task 5 (`screenshot-paths-are-main-only`).
- **The page cannot drive the picker or the area selector.** Trusted events only, a cancel path
  (Esc, timeout, navigation), and the overlay is removed afterwards. Tasks 5 and 8.
- **Diffs are bounded and deterministic.** Same inputs give the same diff; LCS work is capped, with a
  documented fallback. Task 2 (`diff-is-deterministic`, `diff-work-is-bounded`).
- **Retention deletes exactly what it says.** "Purge now" shows its plan before it runs, the purge
  record matches what was deleted, and files are removed only once no row needs them. Task 7
  (`purge-matches-its-plan`).

---

## Schema

For the Phase 7 (libSQL sync) teammate. The tables are in the session database
(`frost-browser.db`), created by migration `0040_change_intelligence`; the triggers are created by
`0041_change_intelligence_guards`. The Drizzle schema is `packages/db/src/change-intel/schema.ts`.

### Conventions
- **Stable ids.** Every row's primary key is `id TEXT`, a lowercase **UUIDv7** (RFC 9562; 36
  characters, time-ordered), generated in main (`packages/db/src/change-intel/ids.ts`). There is no
  autoincrement anywhere.
- **Times** are Unix milliseconds (`INTEGER`). Every row has `created_at`; mutable rows also have
  `updated_at`.
- **JSON** is stored as `TEXT`, written in canonical form: object keys sorted, no whitespace. The
  JSON is validated with Zod in main on the way in and on the way out (a tampered row is skipped).
  SQL never parses it.
- **Hashes** are lowercase hex SHA-256.
- **URLs** are stored as `http(s)` URLs without userinfo or `#fragment`, at most
  `MAX_STORED_URL_LENGTH` (Phase 1's rule).
- **Mutable rows** are tombstoned with `deleted_at`, never deleted, so sync can carry a deletion.
  Sync resolves them last-writer-wins on `updated_at`.
- **Captured rows** are append-only (immutable). Sync only ever inserts them, and carries purges as
  `ci_tombstones` rows.

### Mutable tables

| table | columns | notes |
|---|---|---|
| `ci_projects` | `id`, `name`, `render_profile` (JSON, nullable), `retention_mode` (`forever`/`versions`/`days`), `retention_value` (nullable int), `created_at`, `updated_at`, `deleted_at` (nullable) | `UNFILED_PROJECT_ID` (`00000000-0000-7000-8000-000000000000`, named "Unfiled") is inserted by the migration. It is the same on every device, and cannot be deleted. |
| `ci_project_pages` | `id`, `project_id`, `url`, `created_at`, `updated_at`, `deleted_at` | one live row per `(project_id, url)`. |
| `ci_project_queries` | `id`, `project_id`, `query`, `search_params` (JSON `SearchParams`), `created_at`, `updated_at`, `deleted_at` | |

### Append-only tables (immutable)

| table | columns | notes |
|---|---|---|
| `ci_versions` | `id`, `lane_key`, `page_url`, `render_profile` (JSON, nullable), `search_params` (JSON, nullable), `snapshot` (JSON `CaptureSnapshot`), `snapshot_hash`, `snapshot_bytes`, `schema_version`, `parent_version_id` (nullable), `created_at` | One distinct state of a page in a **lane**: `lane_key` is the SHA-256 of canonical `{url, renderProfile, searchParams}`, so a phone and a desktop capture never diff against each other. A capture makes a new version only when its `snapshot_hash` differs from its lane's latest version. `parent_version_id` is that latest version at insert time; it may later be purged. |
| `ci_captures` | `id`, `project_id`, `version_id`, `lane_key`, `page_url`, `render_profile`, `render_profile_partial` (0/1), `search_params`, `source` (`manual`/`project`), `audit_taken_at`, `created_at` | Every capture, including one that found no change; it points at its version. |
| `ci_diffs` | `id`, `lane_key`, `from_version_id`, `to_version_id`, `engine_version`, `diff` (JSON `SnapshotDiff`), `summary` (JSON counts per region), `change_count`, `created_at` | Written with each new version that has a parent. A diff between any other pair is computed on demand, and not stored. |
| `ci_screenshots` | `id`, `project_id`, `page_url`, `capture_id` (nullable), `kind` (`viewport`/`full`/`area`), `rect` (JSON, nullable), `width`, `height`, `bytes`, `sha256`, `segments`, `render_profile`, `search_params`, `created_at` | The PNG is `<userData>/frost-captures/screenshots/<sha256>.png`, deduplicated by hash. Sync carries the row; the file is a blob for Phase 7 to move separately. |
| `ci_purges` | `id`, `reason` (`retention`/`purge-now`/`project-deleted`), `project_id` (nullable), `policy` (JSON, nullable), `captures`, `versions`, `diffs`, `screenshots`, `bytes`, `created_at` | The audit log of deletions. |
| `ci_tombstones` | `id`, `purge_id`, `table_name`, `row_id`, `created_at` | `UNIQUE (table_name, row_id)`: one tombstone per deleted row. Sync replays these as deletes. |

Indexes:
- `ci_versions (lane_key, created_at)` and `(page_url, created_at)`;
- `ci_captures (project_id, created_at)`, `(version_id)` and `(page_url, created_at)`;
- `ci_diffs (to_version_id)`;
- `ci_screenshots (project_id, created_at)`, `(page_url, created_at)` and `(sha256)`;
- `ci_project_pages (project_id)`, `ci_project_queries (project_id)`;
- `ci_tombstones (purge_id)`.

### Triggers (`0041_change_intelligence_guards`)
For each captured table `T` in `ci_versions`, `ci_captures`, `ci_diffs` and `ci_screenshots`:
- `T_no_update`: `BEFORE UPDATE ON T BEGIN SELECT RAISE(ABORT, 'T is append-only'); END`.
- `T_purge_only`: `BEFORE DELETE ON T WHEN NOT EXISTS (SELECT 1 FROM ci_tombstones t JOIN ci_purges p
  ON p.id = t.purge_id WHERE t.table_name = 'T' AND t.row_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'T
  rows are deleted only by a recorded purge'); END`.
- `T_no_resurrect`: `BEFORE INSERT ON T WHEN EXISTS (SELECT 1 FROM ci_tombstones WHERE table_name =
  'T' AND row_id = NEW.id) BEGIN SELECT RAISE(ABORT, 'T row was purged'); END`.

`ci_purges` and `ci_tombstones` reject every `UPDATE` and `DELETE`.

On the mutable tables:
- `ci_projects_no_delete` and the pages' and queries' `_no_delete` triggers reject `DELETE`
  (tombstone with `deleted_at` instead);
- `ci_projects_unfiled_stays` rejects an `UPDATE` of `UNFILED_PROJECT_ID` that sets `deleted_at` or
  changes `id`.

### The purge path
One transaction (`BEGIN IMMEDIATE`, the store's batch):
1. insert the `ci_purges` row;
2. insert one `ci_tombstones` row per row to delete;
3. delete those rows, children first: diffs, screenshots, captures, then versions. Each delete passes
   its trigger only because of step 2.

After the commit, main unlinks each screenshot file whose hash no row references any more. A crash
between the commit and the unlink leaves an orphan file. A startup sweep deletes files with no row,
and only files whose names match the hash pattern.

What a purge removes:
- **Retention** works per project.
  - `versions N` keeps, in each lane, the captures of the project's newest N versions.
  - `days N` keeps captures newer than N days, but always the captures of each lane's newest
    version, so the next capture still has something to compare with.
- **Screenshots** follow the same window, by `created_at`.
- A **version** is purged once no capture references it. Diffs touching a purged version go with it.
- `project-deleted` purges every capture and screenshot of the project.

### Interfaces for other phases
- **Phase 5 (agent).** `packages/ipc-contract/src/changes-service.ts` exports `ChangesReadService`
  and `CHANGES_READ_API`: Zod input and output schemas (from `specs/changes.schema.ts`) for
  `listPages`, `history`, `getVersion`, `diff` and `listScreenshots`. They are read-only, bounded and
  main-side.
- **Phase 3 (SERP).** Search parameters are frost's own `SearchParams`
  (`specs/capture-search-params.schema.ts`), stored as validated JSON. `TODO(phase-3-merge)`: replace
  it with `specs/serp-search-params.schema.ts`, and make a manual capture of a SERP tab record the
  tab's visible search parameters (`searchParamsOf(tabId)` answers `null` until then).
- **Phase 7 (sync).** See Conventions. Every synced row has `id` (UUIDv7) and `created_at`. Captured
  tables only ever insert. Deletions travel as `ci_tombstones` with their `ci_purges` row. Screenshot
  files are content-addressed blobs.

---

## Tasks

### Task 1: Change-intelligence schema, immutability and the purge path
- **Spec:** `specs/capture-db.spec.ts`, `specs/capture-db.feature.md`.
  - The spec holds `CHANGE_INTEL_TABLES`, `UNFILED_PROJECT_ID`, `CAPTURE_SOURCES`,
    `SCREENSHOT_KINDS`, `RETENTION_MODES`, `PURGE_REASONS`, the UUIDv7 pattern, size caps, and
    `CAPTURES_DIR_NAME` (`frost-captures`).
  - The feature file has the scenarios.
- **Code:**
  - `packages/db/src/change-intel/{migrations,schema,ids,repository,purge}.ts`, and
    `packages/db/src/change-intel/__tests__/*`.
  - Hub lines: `migrations.ts` (`...CHANGE_INTEL_MIGRATIONS`), `store.ts` (`changeIntel`),
    `index.ts` (type exports), and the existing migrations test's table and index lists.
- **Repository (async, Drizzle):**
  - `appendCapture` makes a new version, or reuses the lane's latest one when the hash is equal. It
    inserts the capture, and the diff when one is given, in one batch.
  - `appendScreenshot`.
  - Reads: `latestVersion(lane)`, `history(url, filter, cursor)`, `version(id)`, `diffFor(from, to)`,
    `screenshots(filter, cursor)`, `pages(filter)`.
  - Projects, pages and queries: create, rename, tombstone, list.
  - Retention: `setRetention`, `planPurge(projectId, policy, now)` (a dry run) and
    `executePurge(plan)`.
  - Usage: `usage(projectId?)`.
  - The repository answers JSON as strings plus parsed `unknown`; main validates it.
- **Failing tests first:**
  - `change-intel-migrations-create-schema`;
  - `captured-rows-are-immutable` (raw SQL `UPDATE`/`DELETE` on each captured table throws);
  - `purge-needs-a-tombstone`;
  - `tombstoned-ids-never-return`;
  - `purges-and-tombstones-are-immutable`;
  - `unfiled-project-cannot-be-deleted`;
  - `uuidv7-ids-are-time-ordered`;
  - `same-hash-reuses-the-lane-version`;
  - `execute-purge-is-one-transaction` (an injected failure leaves everything);
  - `change-intel-sql-is-portable`.
- [ ] commit `feat(db): append-only change-intelligence schema with audited purges`

### Task 2: Capture snapshot, search parameters and the diff engine
- **Spec:**
  - `specs/capture.spec.ts` (Zod-free): `CAPTURE_REGIONS`, `DIFF_REGIONS`, `CAPTURE_LIMITS`,
    `CAPTURE_WORLD_ID`, `CAPTURE_SNAPSHOT_VERSION`, `DIFF_ENGINE_VERSION`, `DIFF_LIMITS`, and region
    labels.
  - `specs/capture-snapshot.schema.ts` (Zod): `CaptureSnapshotSchema`, `SnapshotDiffSchema`.
  - `specs/capture-search-params.schema.ts`: `SearchParamsSchema`, with the Phase 3 TODO.
  - `specs/changes-diff.feature.md`.
- **The capture snapshot** (v1):
  - URL, HTTP status, `X-Robots-Tag`, indexable, score;
  - the failing rule ids;
  - head: title, meta description, canonical, robots meta, lang, viewport, Open Graph title,
    description and image, hreflang;
  - structured data: types, plus each JSON-LD block's types, hash and capped text;
  - headings and links, each with its region;
  - per region: word count, text hash and capped text blocks;
  - totals, and `partial`.
- **Regions** (ARIA landmarks, nearest ancestor wins):
  - `main`, `nav`, `header` (a banner, not inside article, aside, main, nav or section), `aside` and
    `footer` (contentinfo, the same scoping);
  - `other`: outside any landmark when the page has a main landmark. A page without one has its
    unlandmarked content counted as `main`.
  - Diff regions add `head`, `http`, `structured-data` and `audit`.
- **Engine:** `packages/change-intel` (`@app/change-intel`): `diffSnapshots(before, after)`,
  `inlineDiff(a, b)` (word segments) and `canonicalJson(value)`. How each part is compared:
  - head and HTTP fields by value;
  - headings by an LCS on `(level, text)` per region, with a remove and an add at the same level
    paired as `changed`;
  - links by `href` per region (text or rel changes are `changed`);
  - text blocks by an LCS per region, pairing similar blocks (token Jaccard ≥ 0.5) as `changed`
    with inline segments, each with context (the nearest unchanged block before it);
  - structured data by type and block hash;
  - hreflang by code;
  - findings by rule id, as `audit` changes.
- **Bounds:** the LCS runs only when n×m ≤ `DIFF_LIMITS.maxLcsCells`; otherwise an order-insensitive
  multiset diff (documented). At most `maxChanges` changes are kept, with `truncated`.
- **Failing tests first:**
  - `regions-tag-every-change`;
  - `unchanged-snapshots-diff-empty`;
  - `diff-is-deterministic`;
  - `diff-work-is-bounded` (a worst-case pair under a time budget);
  - `text-edit-is-a-change-with-segments`;
  - `heading-and-link-moves`;
  - `structured-data-type-changes`;
  - `search-params-schema-rejects-unknown-keys`;
  - `canonical-json-is-key-order-free`.
- [ ] commit `feat(change-intel): capture snapshot and region-tagged diff engine`

### Task 3: Capturing a page (main, IPC)
- **Spec:** `specs/changes.schema.ts` (procedure inputs and answers, and the read API's Zod schemas),
  `specs/changes-capture.feature.md`.
- **Region extraction** (`apps/desktop/src/main/changes/regions.ts`):
  - one self-contained function, serialised into a script and run in `CAPTURE_WORLD_ID`, like the
    Phase 2 extractor;
  - bounded by `CAPTURE_LIMITS` and a deadline (`partial`);
  - main validates its answer with Zod.
- **Building a snapshot** (`changes/snapshot.ts`): from the tab's **ready** audit (`seo.getAudit`)
  and the region answer, in main: hashes, canonical JSON, the lane key.
- **Service** (`changes/service.ts`):
  - `capture(tabId, projectId?)`, for the active tab only;
  - it records the tab's render profile (the audit's `renderProfile`, with `partial`) and search
    parameters (`searchParamsOf`, `null` until Phase 3);
  - it appends through `@app/db`, writing the diff against the lane's latest version;
  - reads: `history`, `version`, `diff` (stored or computed), `pages`;
  - it never rejects.
- **IPC:** `packages/ipc-contract/src/changes-router.ts` (`changes.*`, `enforceSender` first) and
  `changes-service.ts` (`ChangesService`, `ChangesReadService`, `CHANGES_READ_API`).
- **Hub lines:** `router.ts` (`changes:`), `services.ts` (`changes?`), main `index.ts` (create and
  wire).
- **Failing tests first:**
  - `capture-needs-a-ready-audit`;
  - `capture-records-profile-and-params`;
  - `unchanged-page-reuses-version`;
  - `changed-page-stores-diff`;
  - `regions-are-bounded` (a hostile DOM fixture);
  - `region-answer-is-validated`;
  - router tests (`every-changes-procedure-enforces-sender`, inputs validated);
  - `read-api-schemas-parse-answers`.
- [ ] commit `feat(changes): capture pages into versioned history`

### Task 4: Changes panel
- **Spec:** `specs/changes-panel.feature.md`; the `changes` entry in `SEO_PANELS` (hub, one line).
- **UI:** a Changes rail item, after JavaScript. It shows:
  - the current page's history, newest first;
  - lane chips when there are several lanes (profile and search parameters, labelled);
  - "Capture now", plus a project picker that defaults to the first project listing the page, else
    Unfiled;
  - each version's capture count and time, and the change summary against the previous version;
  - a diff view: two versions chosen (the latest pair by default), changes grouped by region with
    region labels, before and after as inert text, inline word segments, "Show unchanged regions";
  - empty, pending, unavailable and purged-parent states.

  The history shows even when the audit is pending; capturing needs a ready one.
- **Renderer:**
  - `changes-view.ts` (pure helpers: grouping, labels, summary text);
  - `components/changes/Changes.tsx`, `changes-palette.ts` (Capture this page, Open Changes panel);
  - hub lines in `SeoSidebar.tsx` (icon, case);
  - `ipc.ts` gets no logic: the panel calls `ipc.changes.*` directly.
- **Failing tests first:** unit tests for `changes-view.ts`; e2e `changes.e2e.ts`:
  - capture v1;
  - the loopback server changes the page; reload and capture v2;
  - the panel shows a `main` text change and a `head` title change, region-labelled;
  - a capture with no change adds no version.
- [ ] commit `feat(changes): Changes panel with history and region diff`

### Task 5: Screenshots
- **Spec:** `specs/screenshot.spec.ts` (`SCREENSHOT_LIMITS`: max stitched height, pixel area,
  segments, PNG bytes, thumbnail and preview sizes, area-selection timeout, `SCREENSHOT_WORLD_ID`),
  `specs/screenshot.schema.ts`, `specs/screenshot.feature.md`.
- **Main** (`apps/desktop/src/main/screenshots/`):
  - **Viewport:** `capturePage()`.
  - **Full page:** `planStitch` (pure) gives the scroll steps and crop rects. A script in
    `SCREENSHOT_WORLD_ID` reads the page's size and scrolls it. Main captures each step after two
    animation frames, composes the BGRA rows into one bitmap (`composeStitch`, pure over buffers),
    and restores the scroll. Caps give `truncated`.
  - **Area:** an overlay in `SCREENSHOT_WORLD_ID` (closed shadow root) lets the user drag a
    rectangle; trusted pointer events only, Esc cancels, a timeout applies, and navigation cancels.
    Main captures that rect, scaled by the view's ratio.
  - **Store** (`store.ts`): PNG, SHA-256, write-temp-then-rename, `0600`, containment and lstat
    checks; rows through `@app/db` record the render profile and search parameters.
  - **Images:** `image(id, size)` answers a downscaled `data:` URL (the chrome's CSP allows
    `img-src data:`), or `null` when the file is missing or does not match its hash.
  - **Reveal** (`shell.showItemInFolder`) and **copy** (`clipboard.writeImage`).
- **IPC:** a `screenshots` router in `changes-router.ts` (hub line `screenshots:`): `take`, `list`,
  `image`, `reveal`, `copy`, `cancelArea`.
- **UI:**
  - Changes panel: a Screenshot menu (Viewport, Full page, Select area) and a gallery of the page's
    screenshots (thumbnails, kind, size, profile chip, Reveal, Copy);
  - the full-page note says the page is scrolled;
  - palette actions.
- **Failing tests first:**
  - `plan-stitch-covers-page-once`;
  - `compose-stitch-places-rows`;
  - `screenshot-paths-are-main-only` (names from hashes only; a symlinked directory is refused; a
    traversal-looking hash is impossible by construction and is rejected);
  - `image-checks-hash`;
  - router tests;
  - e2e `screenshots.e2e.ts`: viewport, full page on a tall page (height > viewport, file hash
    matches), area by mouse drag, Esc cancels, the page's synthetic events do not select.
- [ ] commit `feat(screenshots): viewport, area and stitched full-page screenshots`

### Task 6: Projects
- **Spec:** `specs/projects.schema.ts`, `specs/projects.spec.ts` (caps: projects, pages and queries
  per project, the capture-run page timeout), `specs/projects.feature.md`.
- **Main** (`apps/desktop/src/main/changes/projects.ts`, `changes/capture-run.ts`):
  - project CRUD (a delete is confirmed in main's dialog: the project is tombstoned and a
    `project-deleted` purge runs);
  - add the current page, add a URL (`http(s)` only), add a query with `SearchParams` (engine,
    country, language, device);
  - **capture now** opens one capture tab, activates it, and applies the project's render profile
    (tab-scoped). It visits each page, then each query's search URL (built from `SEARCH_ENGINES`
    plus parameters frost knows for that engine). For each it waits for the ready audit, captures
    with `source: 'project'` (and a viewport screenshot when asked), and records the query's search
    parameters.
  - The run waits while its tab is not active, gives up on a page after the per-page timeout of
    active time, can be cancelled, and is cancelled when its tab closes. When it is done it closes
    its tab and reactivates the previous one. Progress goes out through `projects.runState`
    (long-poll).
- **IPC:** `packages/ipc-contract/src/projects-router.ts` (`projects.*`); hub lines.
- **UI:**
  - a Projects sheet over the page column (like History): a list, create, rename, delete;
  - a project view: pages and queries with each one's last capture and change count, "Capture now"
    with progress and Cancel, the retention area (Task 7);
  - `projects-view.ts` (pure helpers), `components/changes/Projects.tsx`, `projects-palette.ts`
    (Open projects, Add this page to a project);
  - an `App.tsx` hub line.
- **Failing tests first:**
  - unit: CRUD validation, tombstoning, `capture-run-waits-for-active-tab`,
    `capture-run-records-query-params`, `capture-run-cancels-on-tab-close`, `search-url-for-params`;
  - router tests;
  - e2e `projects.e2e.ts`: create a project, add two loopback pages, capture now, both are captured
    and the run tab closes.
- [ ] commit `feat(projects): projects with pages, queries and capture now`

### Task 7: Retention and disk usage
- **Spec:** `specs/retention.spec.ts` (bounds of N, enforcement cadence), `specs/retention.feature.md`.
- **Main** (`changes/retention.ts`):
  - `setRetention`;
  - `planPurge` (a dry run that answers counts and bytes);
  - `purgeNow` (shows the plan in main's dialog, then executes it);
  - the policy is enforced automatically after each capture into a project and once a day at most
    (each enforcement is a recorded `retention` purge);
  - `usage`:
    - per project: captures, versions, screenshots;
    - stored bytes: snapshots and diffs by `length()`, screenshots by `stat`, with versions shared
      across projects counted and labelled;
    - the database file and its WAL by `stat`;
  - "Compact database" (`VACUUM`, confirmed);
  - the startup orphan sweep.
- **UI** in the project view: policy controls (Keep everything / Keep the last N versions / Keep N
  days), "Purge now" with its preview, the purge log (the last 20 `ci_purges`), and usage with an
  honest note ("Deleted data frees space in the database file only after Compact").
- **Failing tests first:**
  - `keep-n-versions-per-lane`;
  - `keep-n-days-keeps-latest`;
  - `purge-matches-its-plan`;
  - `files-removed-only-when-unreferenced`;
  - `orphan-sweep-deletes-only-hash-named-files`;
  - `usage-counts-measured-bytes`;
  - e2e: set "keep 1 version", capture three changes, purge now, one version remains, the purge log
    lists it.
- [ ] commit `feat(retention): per-project retention, purge now and disk usage`

### Task 8: DOM inspector
- **Spec:** `specs/inspector.spec.ts` (`INSPECTOR_WORLD_ID`, `INSPECTOR_LIMITS`: children per node,
  attributes, value lengths, pick timeout), `specs/inspector.schema.ts`, `specs/inspector.feature.md`.
- **Main** (`apps/desktop/src/main/inspector/`):
  - scripts in `INSPECTOR_WORLD_ID` address a node by its element-index path from
    `document.documentElement`, together with a per-document token kept on the isolated world's own
    global;
  - `children(path)`: capped, each child with tag, id, classes, child count and a text preview;
  - `node(path)`: tag, capped attributes, box, a few computed styles, its landmark region, and the
    SEO facts for headings, links, images and meta;
  - `pick()`: a closed-shadow-root hover outline; a trusted click resolves the path; Esc, the timeout
    or navigation resolve `null`; afterwards the selection outline stays until cleared;
  - a stale token answers `stale`. Read-only: nothing is ever written to the page.
- **IPC:** `packages/ipc-contract/src/inspector-router.ts` (`inspector.*`: `tree`, `node`, `pick`,
  `cancelPick`, `highlight`, `clear`); hub lines.
- **UI:** an Inspector rail item, with a lazily expanded tree (keyboard tree-view ARIA), Pick
  element, and the selected node's details as inert text (`inspector-view.ts`,
  `components/changes/Inspector.tsx`, `inspector-palette.ts`).
- **Failing tests first:**
  - unit: path resolution, caps, stale token, untrusted click ignored, the pure helpers;
  - router tests;
  - e2e `inspector.e2e.ts`: expand the tree to an H1, pick an element by mouse, its details show,
    the page's synthetic click does not pick, and nothing is left in the page's DOM afterwards.
- [ ] commit `feat(inspector): read-only DOM inspector with element picker`

### Task 9: Docs, whole-branch review, release check
- README status, `apps/desktop/README.md` (what Phase 6 does, known limits), this plan's "As built".
- A whole-branch review (fresh reviewer); fixes in `fix(…)` commits.
- Full unit, lint, Electronegativity, Semgrep and e2e locally (under the shared e2e lock); CI `ci`
  and `macos` green.
- [ ] commit `docs: phase 6 change intelligence`

## Known limits (expected; confirmed in As built)
- Full-page stitching repeats fixed and sticky elements in each segment, and lazy content appears as
  the page scrolls. A page can see the scrolling.
- Capture-now visits pages in a visible tab, one at a time; a search engine may show a consent page
  or a challenge instead of results, and that is what gets captured.
- Search parameters are frost's own minimal `SearchParams` until Phase 3's schema is merged.
- Screenshot files are not synced in this phase; rows carry the hash for Phase 7.

## Self-review notes
- **Covered:**
  - append-only schema with triggers and audited purges (1);
  - diff engine with region tagging (2);
  - captures recording render profile and search parameters (3);
  - Changes panel (4);
  - screenshots (5);
  - projects (6);
  - retention and disk usage (7);
  - DOM inspector (8).
- **Out of scope:** scheduled (unattended) captures, visual pixel diffs between screenshots,
  syncing, and SERP parsing (Phase 3).
