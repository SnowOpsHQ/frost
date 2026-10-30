# Phase 10 — Projects as a workspace (local rank tracking, SERP parameters, AI destinations) Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. Tasks 1 (append-only storage and purge), 5 (CSV and file writes), 8 (runs that
> query search engines: disclosure, pacing, stop at a challenge, cadence), 9 (URLs built from tab
> state and chosen values) and 10 (URLs opened on third-party AI hosts) get a security-focused
> review. Do not commit unless the lead asks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a project becomes the place where an SEO practitioner tracks searches over time, all local:
- each tracked search shows the project site's **position**, its change and a trend line, read from
  result pages frost captures (no new data source, no frost server);
- two searches, or two dates of one search, can be **compared** side by side;
- searches can be **added in bulk** (one per line, several devices and locales at once) with **tags**,
  and the rankings filtered by tag;
- a project has a **site domain**, a **competitors** list (their positions show next to the site's),
  and can be starred as a **favorite**; the project list sorts;
- rankings export as **CSV** (clipboard or a file the user picks);
- a capture **cadence** (daily / weekly) that marks a project **due** while frost is open; frost never
  starts a run by itself in this phase;
- runs that visit search engines say so first, are paced, and **stop at the first challenge or
  consent page**;
- on a result page, a **SERP parameter editor** (Google domain, country, language, time, results per
  page, SafeSearch, personalisation; Bing `cc`/`setlang`) reloads the search with those settings;
- the same search opens in **Perplexity, ChatGPT or Google AI Mode** as an ordinary tab (frost does
  not read the answer; that is Phase 12).

**Spec sources:**
- `docs/research/serplens-gap-analysis.md`: §2.1 (SL-006, SL-008), §2.3 (SL-045), §2.7 (SL-086,
  SL-087, SL-090, SL-091, SL-092, SL-094, SL-095), §3.2 backlog #4 and #11, §3.3 Wave 3, §4 (Rank
  tracking, option (a) and its risks; SERP locations, option (a) only), §6 (third-party options
  unverified).
- Competitor behaviour (requirements only, clean-room): the audit's SL-006, 008, 045, 086–095 entries.
- Existing specs this phase extends: `specs/projects.{feature.md,spec.ts,schema.ts}`,
  `specs/capture-db.feature.md`, `specs/changes-capture.feature.md`,
  `specs/retention.{feature.md,spec.ts,schema.ts}`, `specs/serp-panels.feature.md`,
  `specs/serp-service.schema.ts`. Read only, unchanged: `specs/serp-search-params.schema.ts`,
  `specs/serp-snapshot.schema.ts`, `specs/serp-overlay.feature.md`, `specs/sync.spec.ts`,
  `specs/browser-polish.spec.ts` (`SEARCH_ENGINES`). Patterns followed: `specs/seo-panels.feature.md`
  (CSV through main), `specs/open-in.spec.ts` (`openInUrl`) with `specs/command-palette.spec.ts`
  (`OPEN_IN_URL_MAX_LENGTH`), `specs/private-address.spec.ts` (`isPublicHost`).
- `docs/design/IMPLEMENTATION-PLAN.md` §1 non-goals (no server-side rank tracking, no VPN), §3.
- Cross-plan rulings (lead, 2026-10-29): Phase 10 **owns** the store of SERP readings and the
  position read model, defined over `SerpSnapshot` independent of source, so Phase 12's BYO SERP-API
  readings go into the same store; location here is `gl`/`hl` only (proxies, VPN, `uule` are
  Phase 12); CSV follows `seo.copyLinksCsv` independently of Phase 11; phases land in numeric order
  and a later phase touching a shared schema rebases on the earlier one.

## What the code holds today (read before planning; corrects the gap analysis)
| Claim in the analysis | The code | Consequence |
|---|---|---|
| "Derive positions from the SERP snapshots already stored in `ci_versions`" (§3.2 #4) | `ci_versions.snapshot` is a `CaptureSnapshot` (`specs/capture-snapshot.schema.ts`: head, headings, links, regions, audit). The ranked `SerpSnapshot` is **never stored**: `apps/desktop/src/main/changes/serp-params.ts` `searchParamsOfState` keeps only `snapshot.params` ("the rest of the reading is not recorded"). | Phase 10 must start **recording** each capture's SERP reading (Task 2). Captures taken before Phase 10 have no positions; there is no backfill (the snapshot's capped, region-tagged `links.list` mixes ads, features and engine redirect links and is not a position source). |
| "Positions are visible only inside a capture's diff" (SL-090) | The Changes diff shows changed heading and link **text** of the result page, not ranks. | Rank tracking is new, not a re-presentation. |
| Wave 3 touches "`M/serp/` (params)" | Saved-search URLs are built by `searchUrlFor` in `specs/projects.spec.ts` and read back by `apps/desktop/src/main/changes/serp-params.ts` `searchParamsForUrl` (bundled pack). The live SERP state is `main/serp/service.ts`. | The editor builds URLs in a new spec; saved searches keep their Phase 6 path. |
| §2.9/§3 "no quota" | Caps exist: `MAX_PROJECTS` 100, `MAX_PROJECT_QUERIES` 50, `PROJECT_RUN_LIMITS.maxRunTargets` 70 (`specs/capture-db.spec.ts`, `specs/projects.spec.ts`). | They are safety caps, not quotas; kept (Decision 11). |

## Decisions (made in this plan)
1. **Positions come from a SERP reading stored with each capture.** When a capture's page is a
   result page and Phase 3's SERP state for that tab and page is finished (`ready` or `unreadable`)
   with the same search parameters the capture records, main stores that reading beside the capture,
   in the capture's own write batch. Phase 10 **owns** this store and the position read model over
   it (lead ruling). Each reading holds the results list as Phase 3 analysed it (per result: rank,
   organic/ad position or feature slot, result type, title, URL, owner domain), its composition and
   ownership, the pack version, the capture time (`observed_at`) and the search parameters, with its
   source a field. *Rejected:* parsing positions out of `CaptureSnapshot.links` (capped, mixes ads
   and features, no redirect unwrapping); re-reading old pages (they are gone).
2. **A new table, `ci_serp_readings`, outside `CAPTURED_TABLES`.** `ci_tombstones.table_name` has a
   `CHECK (table_name IN (…CAPTURED_TABLES))` frozen in applied migration `0040`; adding a table to
   `CAPTURED_TABLES` would edit an applied migration (forbidden by `packages/db/src/migrations.ts`)
   and still fail on existing databases. So readings are append-only with their **own** delete
   guard: a `capture`-source reading may be deleted only once its capture row is gone. Nor can a
   reading be removed behind that guard's back: the no-replace guard also refuses a row whose
   non-null `capture_id` is already taken, so an `INSERT OR REPLACE` with a fresh reading id and an
   existing capture id cannot delete the original through the unique `capture_id` index (REPLACE's
   implicit delete fires no `DELETE` trigger with `recursive_triggers` = 0, as both drivers read it,
   `specs/sync-package.spec.ts:44-45`; Task 1). The purge path
   (`packages/db/src/change-intel/purge.ts` `executePurge`) deletes the readings of purged captures in
   the same batch, after `ci_captures`. Captures removed on this device by another device's tombstone
   (sync's `SYNC_PURGE_DELETE_ORDER`) leave orphan readings; `deleteOrphanReadings` runs at startup,
   after every purge, and before every rankings read of a project (Task 1, Task 5), and the read
   model ignores a **capture-sourced** reading whose capture is gone. An orphan is only ever a
   `source = 'capture'` row: a `serp-api` reading (Phase 12) has `capture_id NULL` by design and is
   never filtered or swept as an orphan, so neither the sweep nor the read path may be written as
   "no `ci_captures` row with `id = capture_id`" alone. *Rejected:* a `serp_reading` column on
   `ci_captures` (a Phase 12 API reading has no capture; every capture row would carry up to 0.5 MB);
   rebuilding `ci_tombstones` (an append-only audit table: too risky for this phase).
3. **The read model is source-independent.** It takes `SerpObservation { id, searchKey, params,
   filters, observedAt, source, snapshot }` where `snapshot` is a Zod-free `SerpSnapshotShape` and
   `source` is one of `SERP_READING_SOURCES = ['capture', 'serp-api']`. Phase 10 writes only
   `capture`; `serp-api` is reserved in the table's `CHECK` now (a later `CHECK` change needs a table
   rebuild) and refused by the Phase 10 repository's public `appendReading` (Phase 12 enables it, with
   `capture_id` null, and adds its own delete guard in its migration block). Nothing in the read model
   changes for Phase 12.
4. **`SearchParams` stays as it is; the series key is versioned.** Result-shaping parameters the
   editor sets (Google `tbs`, `num`, `safe`, `pws`; DuckDuckGo `df`, `kp`) are not in Phase 3's
   canonical URL. Phase 10 does not touch `SearchParamsSchema`, `matchSerp` or lane keys. Each reading
   records `filters` (the known filter parameters of the landed page URL, `SERP_FILTER_PARAMS`) and its
   **search key**: SHA-256 of `searchIdentityJson(params, filters)` = **every** `SearchParams` field
   present except `SEARCH_IDENTITY_EXCLUDED`, plus the engine host (from `params.url`; `google.de` ≠
   `google.com`) and `filters`.
   - `SEARCH_IDENTITY_EXCLUDED` (lead ruling: the named exclusion list) = `url` (replaced by the
     host), `offset` (`page` says which page), `engineLabel` (a display string from the selector pack:
     a relabel must not split series).
   - Each reading stores `search_key_version` (`SEARCH_KEY_VERSION = 1`). Readings are append-only, so
     a key can never be rewritten: when a later version changes the identity rule, the read model
     recomputes the key of older-version rows from their stored `search_params` and `filters`; the
     stored key is the index for current-version rows only.
   - `query` is Phase 3's normalised text (whitespace collapsed, trimmed) with its **case kept**:
     "Green tea" and "green tea" are two series (frost does not guess how an engine folds case; a
     later key version may fold it).
   - Because the key takes every present field, a field a later phase adds (Phase 12's planned
     `location`) splits series without a change here.
   - Provenance is the reading row's `source` only (lead ruling). `SearchParams` never carries it,
     so a tab reading and an API reading of one search share one series. A later field that must
     not split series is added to `SEARCH_IDENTITY_EXCLUDED` with a key-version bump.
   - *Rejected:* new optional `SearchParams` fields for filters (`matchSerp` would have to read them by
     selector-pack names; packs are strict, so older builds would refuse a pack naming them).

   **Fields Phase 10 adds to `SearchParamsSchema`: none.** Its new fields live on the reading row
   (`ci_serp_readings`: `source`, `capture_id`, `search_key`, `search_key_version`, `filters`,
   `page_url`, `status`, `pack_version`, `observed_at`) and in the reading JSON (the unchanged
   `SerpSnapshot`). The reading row's `source` (where the **reading** came from) is the authority for
   which store path wrote the row.
5. **Tracked searches = the project's saved searches ∪ searches seen in its readings.** A SERP
   captured into a project from the Changes panel is tracked without a separate step; saved searches
   (visited by runs) are listed first. Tags attach to saved searches and pages only.
6. **What "position" means.** The site's **best organic position on the page read** (`position` of an
   `organic` result, page-local, as Phase 3 defines it). Saved searches are page 1 (`searchUrlFor`
   sets no offset); a page-2+ reading is shown with its page ("p2 · 3"), never converted to an
   absolute rank. Outcomes: `ranked`, `not-found` (organic list complete, site absent: shown "> n"
   with n the organic count read), `unknown` (a reader cap cut organic results and the site is not
   among those read), `unreadable` (the reading itself), `no-site` (no site domain set). SERP
   features that link to the site (featured snippet, AI overview, …) are listed as "also in", never
   counted as a position. Ads never count (Phase 3 already excludes them from ownership).
7. **A project has an explicit site domain, and up to 10 competitors.** Matching uses Phase 3's owner
   rule (`ownerDomain` in `main/serp/serp-analyse.ts`; results already carry `domain`): with "include
   subdomains" (default on) a result matches when its `domain` equals the site's owner domain; off,
   when its URL host equals the site host exactly, after removing one leading `www.` from both
   (`example.com` matches `www.example.com`, not `shop.example.com`). Competitor positions are
   computed from the same stored readings, so adding one shows its history at once. No favicon fetch
   and no "goal" field (a favicon is a network fetch to the site; a goal is free text with no
   behaviour): deferred.
8. **Tags and bulk add.** Bulk add takes one query per line (or comma-separated), one engine, up to
   `BULK_SEARCH_LIMITS.maxLocales` country/language pairs and any of the three devices; each
   combination is one saved search through the existing `searchUrlFor` → `searchParamsForUrl` path,
   with per-line outcomes (`added`, `exists`, `invalid`, `limit`). Bulk add stores searches only: it
   sends nothing to any engine (`searchParamsForUrl` is local). Tags (up to 8 per entry, 50 per
   project) are a filter, not a hierarchy. Removing a page or search tombstones its tags; deleting a
   project tombstones its competitors and tags in the same batch as its pages and searches
   (`tombstoneProject`). A project deleted on another device reaches this one through sync (its
   synced tombstone, `ci_projects.deleted_at`), which never runs `tombstoneProject` here; its
   device-local competitors and tags are tombstoned by the startup orphan sweep (Task 1).
9. **No sync of Phase 10 data in this phase, and device-local changes never win a sync.**
   `SYNC_TABLES` stays "exactly Phase 6's nine". The new `ci_projects` columns have
   `NOT NULL DEFAULT`s and the sync engine copies only listed columns
   (`apps/desktop/src/main/sync/engine.ts`: `INSERT` of listed columns, `UPDATE … SET` listed
   columns). Because `ci_projects` merges last-writer-wins on `updated_at`, **workspace-only updates
   (favorite, site, subdomains, cadence, auto start) do not touch `updated_at`**: otherwise a
   device-local star on device B would beat a real rename on device A. Readings, tags and competitors
   are device-local; a follow-up extends `SYNC_TABLES` (and its replica). Documented in
   `specs/workspace-db.feature.md` (sync has no "what syncs" UI copy to update today).
10. **Runs that query search engines (decided now, lead ruling).**
    - **Disclosure first.** Before the first run with search targets (Capture now on a project with
      searches, Check rankings) and before a cadence is first enabled, main shows
      `RANK_RUN_DISCLOSURE` in its own message box (parented as `DELETE_PROJECT` is; Cancel is the
      default): frost will load the saved searches in a tab from this computer's connection, one every
      10 seconds, so the positions recorded are **as your signed-in browser profile sees them**
      (the browse session's cookies go with each search, as in any tab); search engines' terms may
      restrict automated searches and an engine may answer with a consent page or a challenge; frost
      stops at the first one. Continue is remembered once per
      install (`RANK_RUN_DISCLOSURE_SETTING_KEY` in `app_settings`); Cancel starts nothing. The
      renderer cannot skip it (main asks inside `startRun` / `setCadence`).
    - **Pacing.** Search targets in any run start at least `RANK_RUN_QUERY_SPACING_MS = 10_000` apart.
      Why 10 s: a full project (50 searches, the cap) then takes about 10–12 minutes including loads,
      acceptable for a deliberate check, and it keeps frost at the pace of a person reading result
      pages rather than a burst of 50 requests in a minute (the pattern engines challenge). It is
      fixed: no jitter, no user-agent changes, nothing meant to look like something it is not. The
      wait happens **between** targets, before the next search target is navigated: it is not part
      of that target's `targetActiveTimeoutMs`, and Cancel ends it at once. It follows only a search
      target that **landed** (a new document committed, so the engine answered); one that failed to
      load before landing (offline, DNS) adds no wait. Like every run timing, it is a
      `PROJECT_RUN_LIMITS` entry (`querySpacingMs`, default `RANK_RUN_QUERY_SPACING_MS`), so tests
      override it through `CaptureRunDeps.limits`.
    - **Stop at the first challenge, checked before capture.** A search target is captured only on a
      positive verdict. The run has a named, **required** input (`CaptureRunDeps.serpVerdictOf`; no
      default, so the type makes every caller and test supply it), `serpVerdictOf(tabId, pageUrl):
      SerpRunVerdict` (`SERP_RUN_VERDICTS = ['ready', 'unreadable', 'not-serp', 'pending',
      'disabled']`, read from Phase 3's `SerpReadApi.snapshot` for that tab **and** page; another tab's
      or page's state, or an unbound API, is `pending` — never collapsed to `null`). After a search
      target lands, the run:
      1. blocks at once (`not-a-result-page`) when the landed URL is not a result page of the target's
         engine (`searchParamsForUrl(landed, device)` is `null` or names another engine: a consent page
         on another host, a `/sorry/` challenge path);
      2. waits while the verdict is `pending`, up to `SERP_SETTLE_WAIT_MS = 8_000` of active time
         (Phase 3's read timeout 2 s + analysis 2 s + its in-page debounce, with margin; the
         `PROJECT_RUN_LIMITS.serpSettleWaitMs` entry, overridable like `querySpacingMs`); this wait
         counts toward the target's `targetActiveTimeoutMs`;
      3. captures only on `ready` whose search is the target's: the tab's parameters come from
         `searchParamsOf(tabId, landed)` (the same tab and page; Phase 6's existing dependency) and
         `sameRunSearch(tabParams, target.searchParams)` compares engine, host, query, `gl`, `hl`,
         page (not device: a site's pin may set another device, and the capture records the one in
         effect, as Phase 6 does). A `ready` verdict with `searchParamsOf` answering `null` is
         `no-reading`, never a capture with `null` parameters;
      4. otherwise blocks, **without capturing**: `unreadable` (`unreadable`), `not-serp`
         (`not-a-result-page`), `disabled` (`serp-off`: SERP reading is off, so frost cannot tell),
         `ready` for another search (`mismatch`), still `pending` after the settle wait
         (`no-reading`), or the target reaching `targetActiveTimeoutMs` before any of this
         (`timed-out`).
      A blocked run ends `blocked` (new `RUN_STATES` value, also in `RUN_END_STATES` and in
      `capture-run.ts`'s `Visit['end']`) with its `blockedReason`
      (`RUN_BLOCK_REASONS`); the target is `blocked` (new `RUN_TARGET_OUTCOMES` value), the rest
      `cancelled`; the sheet says `RUN_BLOCKED_NOTE`. Nothing of a challenge or consent page is stored
      in the project. Page targets (the user's own site) keep Phase 6's behaviour, including
      `timed-out`, and never block. This changes Phase 6 for **search targets of runs** only: the
      fallback "capture with the target's own parameters when the SERP service has none" goes away
      for them, in `projects.feature.md` (Capture now step 4, and the `capture-run-records-query-params`
      scenario text, ~line 225) and in the header comment of `capture-run.ts` ("else the target's own
      (the saved search's for a query, none for a page)" becomes "for a page, else none; a search
      target is captured only on a matching ready reading"); manual captures and screenshots are
      unchanged.
    - **Legal gate (owner, not an implementer; the same rule as Phase 12's L3, kept in its
      "Deferred proposals", D1).** Answered in writing (a short note under `docs/research/`, the
      owner's own words) before the surfaces it gates ship; "unclear" counts as **no**.

      | # | Question | Gates | How to resolve |
      |---|---|---|---|
      | L1 | Do Google's and Bing's terms allow frost to load a user's saved searches in a visible tab, programmatically, paced and stopped as above, on the user's action? | Shipping "Check rankings" and the cadence / Due notice (Task 8) | The owner reads the current Google Terms of Service and Bing terms and writes the note; without it neither ships (open question 1 stays the separate question of automatic starts). |
    - **Cadence is a due notice only.** A project's cadence (`off` default, `daily`, `weekly`) marks it
      **due** ("Due" in the list, with Capture now) while frost is open. Missed periods are never
      back-filled. Automatic starts are behind `AUTO_CAPTURE_AVAILABLE = false` in
      `specs/capture-schedule.spec.ts`: with it `false`, the "Start automatically" switch is not shown,
      `setAutoCapture` answers `unavailable`, and the scheduler never starts a run. The gated logic is
      specified and tested with the flag injected (idle ≥ `AUTO_CAPTURE_IDLE_S`, a visible
      non-minimised window, no run under way, one attempt per `AUTO_CAPTURE_RETRY_MS`, yields to the
      user, suspended after a `blocked` run). Turning the flag on is a lead decision after open
      question 1, and first requires persisting the suspension state (it is memory-only in this
      phase). No login item, no background process, no server.
11. **Caps unchanged; a "searches only" run.** `MAX_PROJECT_QUERIES` (50) and `maxRunTargets` (70)
    stay. `startRun` gains `scope: 'all' | 'searches'` ("Check rankings" visits only the saved
    searches).
12. **The SERP parameter editor builds a URL and navigates; it does not change what is tracked.** The
    editor (in the SERP panel) starts from the tab's `SearchParams` **and** the filters on the tab's
    current URL (`serpFiltersOf`), so editing the country of a "past week" page keeps "past week";
    every known filter carries over unless changed, unknown parameters are dropped (the canonical URL).
    It offers closed value sets only (`SERP_EDITOR_FIELDS`), including the Google **domain** (the
    bundled pack's Google `hosts`: `www.google.com`, `.co.uk`, `.ca`, `.com.au`, `.de`, `.fr`, `.es`,
    `.it`, `.co.in`, `.com.br`, `.co.jp`; host change only, path kept), and loads the result through
    `browser.navigate` (the address bar's path and browse guards). `gl`/`hl` go by the pack's names
    (`SEARCH_PARAM_URL_RULES` for the three known engines; the selector pack's `params.gl/hl` names
    otherwise). "Track this search" adds the tab's search to a project as a saved search only when it
    has no filters, the default host, and an engine of `SEARCH_ENGINES` (saved searches keep the Phase
    6 shape); anything else is tracked by capturing it (Decision 5).
13. **AI destinations are a separate fixed table, opened by main.** `AI_SEARCH_DESTINATIONS`
    (Perplexity, ChatGPT, Google AI Mode) are **not** added to `SEARCH_ENGINES` (the address-bar
    default, the saved-search engine set and `SEARCH_PARAM_URL_RULES`' key set; an AI engine cannot be
    read back by Phase 3). As `browser.openTool` does, main builds the URL from the table and the
    **SERP tab's own query** (no renderer-supplied text), with `URL`/`URLSearchParams`, and opens it in
    a background tab through the controller's existing `openBackgroundTab(url, false)` (its browse
    guards and tab cap), so the query is sent from the user's own signed-in account for that engine
    and lands in its history (`AI_DESTINATION_NOTE` says so). frost runs nothing specific on those pages (the generic audit runs as on any
    page); Google AI Mode (`udm=50`) is refused by the bundled pack's `reject` rule, so it is never
    read as a SERP. Address-bar prefixes for AI destinations are deferred: the one-letter prefix space
    would make `a …` (AI Mode) catch ordinary English queries.
14. **CSV goes through main.** As `seo.copyLinksCsv`: main formats with `@app/seo-core` `csvCell`
    (formula guard: SERP titles and queries are untrusted text) and writes the clipboard, answering a
    row count; "Save CSV…" asks for a path in main's own save dialog (as `main/agent/dialogs.ts`
    `chooseExportPath`), the renderer never names a path. No shared helper with Phase 11.
15. **Reading lifetime follows capture retention.** A reading lives as long as its capture: a project
    on `versions N` or `days N` retention keeps only that much rank history (SERPs change often, so
    `versions N` can mean days). Phase 10 does not add independent reading retention; the Rankings view
    states the horizon (`RANK_HISTORY_NOTE` with the project's policy, and that positions are **as
    your signed-in browser profile sees them**) and disk usage counts readings.
    Independent retention is open question 8.
16. **Scope cuts (deliberate).** **Hide ads** (SL-008): no engine offers a URL parameter for it, and
    hiding them would mean changing the page's DOM or CSS, which frost never does (page integrity,
    `IMPLEMENTATION-PLAN.md` §3); the SERP panel and the rank model already leave ads out of
    positions. No agent tool for rankings (a candidate for Phase 8's skill pack); GSC average
    position is cut from the rank table (the Search Console panel already shows it; not merged into
    the rank table); no proxies, VPN or BYO SERP API (Phase 12), no `uule` (deferred in Phase 12);
    no cookieless search targets (open question 9);
    no screenshot-library search (SL-093); no Site Structure / Pages crawler (Phase 12); no project goal
    or favicon; sort order is view state, not persisted; automatic run starts stay off (Decision 10).

## Global constraints
Everything in the Phase 0–7 Global Constraints and `CONTRIBUTING.md` still holds, plus:
- **IPC** only through `packages/ipc-contract`; every new procedure starts
  `publicProcedure.use(enforceSender)` then its fail-closed service middleware (`requireProjects`
  pattern), strict Zod inputs, answers checked on the way out. No procedure name says "query" or
  names SQL (`db-only-in-main`, `browser-session-db.feature.md`): searches, not queries.
- **The renderer has no database and no Zod-only spec**: it imports the Zod-free `*.spec.ts` values
  and types (as `projects.spec.ts` / `projects.schema.ts` split today). `@app/change-intel` stays Zod-
  free (Task 3).
- **Untrusted page data.** Every stored reading is parsed with `SerpSnapshotSchema` on write and on
  every read (a row that fails is skipped, as `service.ts` `parsedJson` does). Titles, URLs, queries
  and domains render as inert text; trend lines are drawn from numbers only; CSV cells pass
  `csvCell`. No reading text reaches the agent in this phase.
- **Isolated worlds:** no new page script. The SERP reading stays Phase 3's (signed selector pack,
  `read-script.ts` in its world); the editor and destinations run no script in a page.
- **No new secrets, no new network of frost's own.** Nothing here contacts a frost server or a SERP
  vendor. The only fetches are tab navigations the user caused (a run the user started, an edited
  search, an AI destination), through the existing browse guards, paced and stopped as Decision 10.
- **Append-only stays append-only.** `ci_serp_readings` refuses `UPDATE`, `REPLACE` and unguarded
  `DELETE` by trigger (`0223`'s named triggers: `ci_serp_readings_no_update`,
  `ci_serp_readings_no_replace`, `ci_serp_readings_capture_gone_only`; Phase 12's `0245` drops the
  last by that name and adds `ci_serp_readings_delete_guard` in its place, updating
  `serp-readings-triggers-named`); `REPLACE` is refused over an existing id **and** over an existing
  non-null `capture_id` (Decision 2); new mutable rows (`ci_project_competitors`, `ci_entry_tags`) are tombstoned
  with `deleted_at`, never deleted, with UUIDv7 ids and one live row per key, exactly Phase 6's
  conventions (`packages/db/src/change-intel/migrations.ts`).
- **Migrations:** only ids `0220`–`0229`. Planned: `0220_project_workspace`,
  `0221_project_workspace_guards`, `0222_serp_readings`, `0223_serp_readings_guards`; `0224`–`0229`
  spare. SQL limited to SQLite 3.45 (`LIBSQL_SQLITE_VERSION`). Never edit `0040`/`0041`.
  **Placement (lead ruling):** `migrations-are-forward-only` (`packages/db/src/__tests__/migrations.test.ts`)
  requires ids strictly increasing in `MIGRATIONS` array order. Each phase spreads its own list at
  the **end** of `MIGRATIONS`, in phase order (8, 9, 10, 11, 12): `...WORKSPACE_MIGRATIONS` goes after
  Phase 9's `...AI_CHECKS_MIGRATIONS` (`0210`); Phase 11's `0230` and Phase 12's `0240`–`0245` follow
  it. Phase 8 already moved the test-only fixture ids to `9000_`; this phase only checks the test.
- **CI makes no network call.** Unit tests use fakes; e2e uses loopback servers, the existing
  unpackaged-only seams (`--frost-e2e-serp-pack-url`, `--frost-e2e-serp-pack-key`, refused when
  packaged) and `--host-resolver-rules` mapping every third-party host to loopback or `~NOTFOUND`;
  fixture hosts are public-looking names (never `.example`, which `specs/private-address.spec.ts:24`
  lists as non-public), Task 11.
- **Clean-room:** all labels, notes and help text are frost's own words.

## Team contract
- New files only in: `specs/workspace-db.*`, `specs/rankings.*`, `specs/capture-schedule.spec.ts`,
  `specs/serp-param-editor.spec.ts`, `specs/ai-destinations.spec.ts`; `packages/db/src/change-intel/`
  (`workspace-migrations.ts`, `workspace-schema.ts`, `readings.ts`, `workspace.ts`);
  `packages/change-intel/src/rankings.ts`, `compare.ts`; `apps/desktop/src/main/changes/`
  (`readings.ts`, `workspace.ts`, `rankings.ts`, `rank-csv.ts`, `rank-dialogs.ts`,
  `capture-schedule.ts`); `apps/desktop/src/main/serp/destinations.ts`;
  `packages/ipc-contract/src/rankings-router.ts`, `rankings-service.ts`; renderer
  `rankings-view.ts`, `serp-editor-view.ts`, `components/changes/{Rankings,Compare,ProjectSettings,BulkAdd}.tsx`,
  `components/seo/SerpEditor.tsx`; tests beside each (new test files named in the tasks);
  `apps/desktop/e2e/rankings.e2e.ts`, `rank-fixtures.ts`.
- Existing owner files extended in place (not hubs): `specs/projects.*`, `specs/capture-db.feature.md`
  (one pointer line), `specs/changes-capture.feature.md`, `specs/retention.{feature.md,spec.ts,schema.ts}`,
  `specs/serp-panels.feature.md`, `specs/serp-service.schema.ts`,
  `packages/db/src/change-intel/{repository.ts,purge.ts,schema.ts}`,
  `packages/change-intel/src/{index.ts,__tests__/purity.test.ts}` (one allowlist entry),
  `apps/desktop/src/main/changes/{service.ts,serp-params.ts,projects.ts,capture-run.ts,projects-main.ts,projects-dialog.ts,retention.ts}`,
  `apps/desktop/src/main/serp/setup.ts` (one optional option and one service member),
  `packages/ipc-contract/src/{projects-router.ts,serp-router.ts,serp-service.ts}`,
  renderer `projects-view.ts`, `projects-palette.ts`, `serp-view.ts`, `serp-palette.ts`, `ipc.ts`,
  `components/changes/{Projects.tsx,Retention.tsx}`, `components/seo/Serp.tsx`.
- Hub files get one-line registrations only: `apps/desktop/src/main/index.ts` (pass
  `serpParams.readingOf` and `serpParams.verdictOf`, the settings repository to projects, `openBackgroundTab` to `setupSerp`, the
  rankings service), `packages/ipc-contract/src/router.ts` (`rankings: rankingsRouter`) and
  `services.ts`, `packages/db/src/migrations.ts` (`...WORKSPACE_MIGRATIONS`, spread last, after Phase 9's `0210` block),
  `packages/db/src/change-intel/migrations.ts` (export its `mutable`/`captured` guard helpers, no SQL
  change), `App.tsx` (nothing expected: the views live inside the Projects sheet), the palette
  registry (`renderer/palette/registry.ts` sources list), root config (none expected).

## Data shapes (sketch)
```ts
// specs/rankings.spec.ts (Zod-free; change-intel imports only this and capture.spec)
type SearchParamsShape = { engine: string; engineLabel: string; query: string; gl: string | null;
  hl: string | null; device: 'desktop' | 'mobile' | 'tablet'; page: number; offset: number | null; url: string }
  & Readonly<Record<string, unknown>>;                         // later optional fields pass through
// SerpResultType: re-exported by rankings.spec.ts from serp-selector-pack.spec.ts (Zod-free)
type SerpResultShape = { rank: number; type: SerpResultType; position: number | null;
  featureSlot: number | null; title: string; url: string | null; redirected: boolean; domain: string | null };
type SerpSnapshotShape =
  | { status: 'ready'; params: SearchParamsShape; packVersion: number; results: SerpResultShape[];
      composition: {…}; ownership: { page: number; organic: number; complete: boolean; domains: {…}[] }; truncated: boolean }
  | { status: 'unreadable'; reason: string; params: SearchParamsShape | null; packVersion: number | null };
type SerpFilters = Readonly<Record<string, string>>;           // known filter params only, sorted keys
interface SerpObservation { id: string; searchKey: string; params: SearchParamsShape; filters: SerpFilters;
  observedAt: number; source: 'capture' | 'serp-api'; snapshot: SerpSnapshotShape }
interface SiteMatch { owner: string; host: string; subdomains: boolean }
type RankOutcome = 'ranked' | 'not-found' | 'unknown' | 'unreadable' | 'no-site';
interface RankPoint { readingId: string; at: number; outcome: RankOutcome; position: number | null;
  url: string | null; organicRead: number; page: number; alsoIn: string[] }
interface RankRow { searchKey: string; params: SearchParamsShape; filters: SerpFilters;
  saved: { id: string; tags: string[] } | null; latest: RankPoint | null; previous: RankPoint | null;
  change: number | 'new' | 'lost' | null; best: number | null; points: RankPoint[];
  competitors: Record<string, RankPoint | null> }
// specs/rankings.schema.ts proves the shapes: SerpSnapshotSchema satisfies z.ZodType<SerpSnapshotShape>,
// SearchParamsSchema satisfies z.ZodType<SearchParamsShape> (compile-time, plus a spec test).
```

---

### Task 1: Storage — workspace tables and SERP readings (security review)
**Purpose:** the tables Phase 10 needs, with Phase 6's integrity guarantees.
- [ ] **Spec:** new `specs/workspace-db.spec.ts` (Zod-free): `WORKSPACE_TABLES`
  (`ci_project_competitors`, `ci_entry_tags`, `ci_serp_readings`), `WORKSPACE_MIGRATION_IDS`,
  `SERP_READING_SOURCES`, `SERP_READING_STATUSES` (`ready`, `unreadable`), `ENTRY_KINDS` (`page`,
  `search`), `CAPTURE_CADENCES` (`off`, `daily`, `weekly`), `SEARCH_KEY_VERSION` (1), caps
  `MAX_SERP_READING_JSON_BYTES` (524 288), `MAX_SERP_FILTERS_JSON_BYTES` (1 024),
  `MAX_PROJECT_COMPETITORS` (10), `MAX_TAGS_PER_ENTRY` (8), `MAX_PROJECT_TAGS` (50), `TAG_MAX_CHARS`
  (32), `DOMAIN_MAX_CHARS` (253). New `specs/workspace-db.feature.md`: tables, columns, triggers, the
  purge and orphan rules and when the sweep runs, the `updated_at` rule and sync position
  (Decision 9). One pointer line in `specs/capture-db.feature.md`. `specs/retention.spec.ts`
  `RetentionUsage` gains `readingBytes`; `specs/retention.schema.ts` `UsageAnswerSchema` gains it;
  `specs/retention.feature.md`: usage and the purge preview's bytes include readings.
- [ ] **Migrations** (`packages/db/src/change-intel/workspace-migrations.ts`, in `MIGRATIONS` by id):
  - `0220_project_workspace`: `ALTER TABLE ci_projects ADD COLUMN` `favorite`, `site_domain`,
    `site_subdomains`, `capture_cadence`, `auto_capture` (each `NOT NULL DEFAULT` with a `CHECK`,
    except nullable `site_domain`); `CREATE TABLE ci_project_competitors (id, project_id, domain,
    created_at, updated_at, deleted_at)`; `CREATE TABLE ci_entry_tags (id, project_id, entry_kind,
    entry_id, tag, created_at, updated_at, deleted_at)`; indexes.
  - `0221_project_workspace_guards`: Phase 6's `mutable` guards for both tables (live keys
    `(project_id, domain)` and `(entry_kind, entry_id, tag)`).
  - `0222_serp_readings`: `ci_serp_readings (id, project_id, capture_id NULL, source, search_key,
    search_key_version, search_params, filters, page_url NULL, status, pack_version NULL, reading,
    reading_bytes, observed_at, created_at)`, `CHECK (source IN ('capture','serp-api'))` (Decision 3:
    `serp-api` reserved now), `CHECK (source <> 'capture' OR capture_id IS NOT NULL)`;
    indexes `(project_id, search_key, observed_at)` and unique `(capture_id) WHERE capture_id IS NOT NULL`.
  - `0223_serp_readings_guards`, triggers named in the Phase 6 style (`${table}_no_update`, …;
    Phase 12's `0245` drops the delete guard by this exact name):
    - `ci_serp_readings_no_update` (`BEFORE UPDATE`: abort);
    - `ci_serp_readings_no_replace` (`BEFORE INSERT`: abort over an existing id, **or** when
      `NEW.capture_id` is not null and a row with that `capture_id` already exists — otherwise
      `INSERT OR REPLACE` with a fresh id and an existing capture id deletes the original through
      the unique `capture_id` index, bypassing the delete guard because `recursive_triggers` = 0,
      `specs/sync-package.spec.ts:44-45`);
    - `ci_serp_readings_capture_gone_only` (`BEFORE DELETE`: abort unless `source = 'capture'` and
      no `ci_captures` row has `id = OLD.capture_id`).
- [ ] **Repository:** `workspace-schema.ts` (Drizzle tables; the new `ci_projects` columns added to
  `schema.ts` `ciProjects`); `readings.ts`: `appendReading(input)` (public; refuses `serp-api` in this
  phase), `readings({ projectId, searchKey?, from?, to?, limit })`, `readingSearches(projectId)`,
  `reading(id)`, `deleteOrphanReadings(projectId?)`; `workspace.ts`: competitors, tags,
  `tombstoneOrphanWorkspaceRows()` (sets `deleted_at` on the live competitors and tags of every
  project whose `deleted_at` is set, as one deleted through sync is), project flags
  (the flag updates set their column only, **never `updated_at`**), `lastProjectRunAt(projectId)` (the
  latest `source = 'project'` capture, for `due`). `AppendCaptureInput` gains optional `reading`; in
  `appendCapture` it is inserted with `insertWhere(…, EXISTS (SELECT 1 FROM ci_captures WHERE id =
  captureId))` in **both** branches (the unchanged-head branch has no `inserted` predicate today), never
  for a `stale` append. `executePurge` deletes the purged captures' readings after `ci_captures`, and
  `planPurge` counts their bytes in `bytes` (the `ci_purges` columns stay fixed). `tombstoneProject`
  also tombstones the project's competitors and tags in its batch; `removePage` / `removeQuery`
  tombstone the entry's tags. `usage()` gains `readingBytes`; `main/changes/retention.ts` copies it;
  `usageRows` in `renderer/projects-view.ts` adds a "Search readings" row (`Retention.tsx` only maps
  the rows, unchanged).
- [ ] **Sweep wiring:** `projects-main.ts` runs `deleteOrphanReadings()` at startup (after
  `purgeDeleted`) and after each purge; Task 5's rankings reads run it for the project first. The
  startup sweep also runs `tombstoneOrphanWorkspaceRows()`.
- [ ] **Failing tests first:** `packages/db/src/change-intel/__tests__/workspace.test.ts`:
  `workspace-migrations-apply-in-order` (0220–0223 after 0041 and after Phase 9's `0210`;
  `migrations-are-forward-only` unchanged and green), `serp-readings-triggers-named` (the three names
  above exist in `sqlite_master`), `serp-readings-are-append-only`
  (update, replace, insert-over-id abort),
  `serp-reading-replace-over-capture-id-refused` (regression: `INSERT OR REPLACE` with a different
  reading id and the same capture id aborts and the original row is preserved, on both supported
  drivers, `node:sqlite` and libSQL), `serp-reading-deleted-only-without-its-capture`,
  `serp-api-reading-refused-in-phase-10`, `reading-goes-in-with-its-capture` (both `appendCapture`
  branches; a `stale` append writes no reading), `purge-deletes-readings-of-purged-captures`
  (retention and project-deleted), `purge-plan-counts-reading-bytes`, `orphan-readings-swept` (capture-sourced rows only),
  `competitors-and-tags-are-tombstoned` (one live row per key, no delete; with their entry and with
  the project), `project-flags-default-on-old-rows` (Unfiled included: cadence `off`, not favorite),
  `workspace-updates-leave-updated-at`, `usage-counts-reading-bytes`, `last-project-run-at`; update
  `change-intel/__tests__/migrations.test.ts` `change-intel-migrations-create-schema` for the added
  columns. `apps/desktop/src/main/sync/__tests__/engine.test.ts`:
  `sync-keeps-device-local-project-columns` (a pulled `ci_projects` row changes listed columns only;
  `SYNC_TABLES` unchanged), `device-local-change-never-wins-a-rename` (device A renames, device B
  stars later; after a pass both have A's name and B keeps its star), `orphan-readings-swept-after-sync-pull`
  (a pulled tombstone deletes a capture; the next sweep removes its reading),
  `orphan-competitors-and-tags-tombstoned-after-sync-pull` (a pulled `ci_projects` row deletes a
  project; the next startup sweep tombstones its device-local competitors and tags, deleting none).
  `apps/desktop/src/main/changes/__tests__/retention.test.ts` `usage-reports-reading-bytes`;
  `apps/desktop/src/renderer/__tests__/projects-view.test.ts` `usage-rows-show-readings`.
- [ ] **Acceptance:** all above green; `0040`/`0041` text unchanged (`git diff` empty on them);
  migrations run over `node:sqlite` and libSQL (`file:`) in the existing driver test, and
  `serp-reading-replace-over-capture-id-refused` passes on both.
- **Risks:** the existing migrations test asserts Phase 6's exact schema; update it, do not weaken
  it. A purge batch with readings must stay one transaction. A unique index lets `REPLACE` delete
  a row without a `DELETE` trigger firing (`recursive_triggers` = 0), so the no-replace guard must
  cover the `capture_id` index as well as the id.

### Task 2: Record a SERP reading with each capture
**Purpose:** from now on every capture of a result page carries its ranked reading.
- [ ] **Spec:** new `specs/rankings.spec.ts` (Zod-free): the shapes in "Data shapes",
  `SERP_FILTER_PARAMS` (google: `tbs`, `num`, `safe`, `pws`; bing: none in this phase; duckduckgo:
  `df`, `kp`), `serpFiltersOf(pageUrl, engine)` (known names only, lowercase values within
  `MAX_SERP_FILTERS_JSON_BYTES`, sorted), `SEARCH_IDENTITY_EXCLUDED` (`url`, `offset`, `engineLabel`),
  `searchIdentityJson(params, filters, host)`, `SERP_RUN_VERDICTS`, `SerpRunVerdict`,
  `sameRunSearch(tabParams, targetParams)`. `specs/projects.spec.ts`: `SERP_SETTLE_WAIT_MS` (8 000)
  and `PROJECT_RUN_LIMITS.serpSettleWaitMs` (= it; `ProjectRunLimits` follows), so run tests override
  it through `CaptureRunDeps.limits`. New `specs/rankings.schema.ts`
  (Zod): `SerpFiltersSchema`, `StoredReadingSchema` (`SerpSnapshotSchema` plus the row's checks), the
  `satisfies` proofs of the shapes. `specs/changes-capture.feature.md`: a "SERP reading" section.
- [ ] **Failing tests:** `apps/desktop/src/main/changes/__tests__/serp-params.test.ts`
  `serp-reading-of-state` (a `ready` state of the same tab and stored page answers its snapshot; an
  `unreadable` state is rebuilt as `{ status: 'unreadable', reason, params, packVersion }` and answers
  `null` when its `params` is `null` (no search key); `pending`, `not-serp`, another page, garbage
  answer `null`; validated with `SerpSnapshotSchema`); new `readings-spec.test.ts` `search-identity-*`
  (host, filters and device split; key order irrelevant; `engineLabel`, `url`, `offset` never count; an
  unknown optional field present splits, absent leaves the key as before; case kept) and
  `rankings-shapes-match-schemas`; `service.test.ts` `capture-records-serp-reading` (params equal the
  capture's, filters from the landed URL, key and key version stored),
  `capture-without-reading-still-captures` (pending, mismatching params, over
  `MAX_SERP_READING_JSON_BYTES`: the capture succeeds with no reading and one log line, never page
  text), `filtered-serp-is-its-own-series`, `non-serp-capture-has-no-reading`;
  `serp-params.test.ts` `serp-verdict-of-state` (each `SerpTabState` status maps to its verdict for
  the same tab and stored page; another tab or page, garbage, a throwing or unbound API answer
  `pending`, never `null`); `capture-run.test.ts` `capture-run-waits-for-the-serp-verdict` (a search
  target waits while `pending`, up to `SERP_SETTLE_WAIT_MS` of active time counted in the target's
  timeout, then captures; until Task 8 a non-`ready` verdict still captures as Phase 6 does).
- [ ] **Implementation:** `serp-params.ts` gains `serpReadingOfState`, `serpVerdictOfState` and
  `LateSearchParams.readingOf` / `verdictOf` (same late binding to `SerpReadApi.snapshot`);
  `service.ts` `captureTab` asks for the reading after the second `readyTab` check, builds the reading
  row (key hashed with `sha256Hex` from `snapshot.ts`) and passes it in `appendCapture`;
  `CaptureRunDeps` (`capture-run.ts`) gains **required** `serpVerdictOf`, passed by
  `projects-main.ts` (`MainProjectsDeps.serpVerdictOf`, also required); `visit()` waits on it after
  landing, before `deps.capture`; `main/index.ts` passes `serpParams.readingOf` and
  `serpParams.verdictOf` (one line each).
- [ ] **Existing tests updated here (the new required dependency):** `__tests__/fakes.ts` gains
  `readySerpFor(targets)`: `serpVerdictOf` answering `ready` and `searchParamsOf` answering, for the
  landed page, the params of the target with that URL (else `null`). `capture-run.test.ts`
  `setup()` passes `serpVerdictOf: () => 'ready'` by default (a test may override it), and
  `capture-run-pins.test.ts` `capture-run-never-removes-a-pin` passes it in its `createCaptureRuns`
  call. With `ready` there is no wait, so every existing run test keeps asserting exactly what it
  asserts today.
- [ ] **Acceptance:** a capture of a ready SERP stores exactly one reading; Phase 6 behaviour and lane
  keys unchanged (all existing changes/projects tests green).
- **Risks:** SERP state can lag a reload; the run waits, a manual capture records none rather than a
  stale one.

### Task 3: The rank read model (pure)
**Purpose:** positions, change, trend and comparison, computed the same way for any source.
- [ ] **Spec:** `specs/rankings.spec.ts` adds `RANK_OUTCOMES`, `RANK_RANGES` (`7d`, `30d`, `90d`,
  `365d`, `all`) with `rangeStart(range, now)`, `RANK_LIMITS` (`maxPointsPerSeries` 400, `maxRows`
  150), `RANK_CSV_COLUMNS`, `RANK_HISTORY_CSV_COLUMNS`, labels (`rankLabel`, `changeLabel`),
  `RANK_HISTORY_NOTE` (the horizon, and that positions are "as your signed-in browser profile sees
  them"). New `specs/rankings.feature.md`: Decision 6 and 7 semantics (including the
  `www.` rule), change rules (only between two `ranked` points; ranked → not-found is `lost`, the
  reverse `new`), the key-version rule (Decision 4), comparison rules, each scenario mapped to a test.
- [ ] **Failing tests** (`packages/change-intel/src/__tests__/rankings.test.ts`, `compare.test.ts`):
  `rank-of-ready-reading` (best organic position; ads and features never a position; `alsoIn`),
  `rank-subdomain-rule` (on: owner domain; off: exact host, one `www.` ignored), `rank-not-found-vs-unknown`
  (`ownership.complete`), `rank-unreadable`, `rank-no-site`, `rank-page-two-keeps-page`,
  `rank-change-and-best`, `rank-range-filters-points`, `rank-table-saved-first-then-observed`,
  `rank-competitor-columns`, `rank-ignores-serp-api-or-capture-alike` (the same snapshot from either
  source answers the same point), `rank-old-key-version-regrouped`, `compare-two-readings` (per
  domain: up/down/new/gone; features present on each side; site and competitors flagged),
  `compare-is-bounded`, `rank-csv-rows` (columns, ISO dates; no cell formatting here).
  `purity.test.ts` `change-intel-is-pure`: the allowlist gains exactly `@app/specs/rankings.spec`
  (a named, reviewed edit; still no Zod, Electron, DOM or Node).
- [ ] **Implementation:** `packages/change-intel/src/rankings.ts` (`rankOf`, `rankSeries`,
  `rankTable`, `rankCsvRows`), `compare.ts` (`compareSerps`), over the Zod-free shapes only; exported
  from `src/index.ts`.
- [ ] **Acceptance:** model total over any `SerpObservation[]`; no I/O; no import of a `*.schema.ts`.

### Task 4: Project workspace — site, competitors, favorites, tags, bulk add, run scope
**Purpose:** the project fields and actions the rank views need (cadence comes in Task 8).
- [ ] **Spec:** `specs/projects.spec.ts`: `ProjectSummary` gains `favorite`, `site`
  (`{ domain, subdomains } | null`); `PROJECT_REFUSALS` gains `invalid-domain`, `invalid-tag`;
  `normalizeSiteDomain(input)` (a host or URL → lowercase host, IDN as punycode via `URL`, public host
  only via `isPublicHost` from `specs/private-address.spec.ts`, ≤ `DOMAIN_MAX_CHARS`), `normalizeTag`,
  `BULK_SEARCH_LIMITS` (`maxLines` = `MAX_PROJECT_QUERIES`, `maxLocales` 5), `BULK_LINE_OUTCOMES`,
  `splitBulkSearches(text)`, `RUN_SCOPES` (`all`, `searches`), `PROJECT_SORTS` (`name`,
  `last-captured`, `created`) and `sortProjects` (Unfiled first, favorites next).
  `specs/projects.schema.ts`: `SetFavoriteInputSchema`, `SetSiteInputSchema`,
  `AddCompetitorInputSchema`, `RemoveCompetitorInputSchema`, `SetTagsInputSchema` (entry kind, id,
  tags), `BulkAddSearchesInputSchema`, `StartRunInputSchema.scope` (optional, default `all`), the
  answers. `specs/projects.feature.md`: Site and competitors, Tags, Bulk add, Favorites and sort;
  Unfiled refuses site and competitors (`unfiled`).
- [ ] **Failing tests:** new `apps/desktop/src/main/changes/__tests__/workspace.test.ts`:
  `site-domain-normalized` (scheme, path, case, IDN, private hosts refused),
  `competitors-capped-and-unique`, `tags-normalized-and-capped`, `bulk-add-lines-and-combinations`
  (devices × locales; per-line outcomes; stops at the cap with `limit`), `bulk-add-uses-the-phase-6-path`
  (each through `searchUrlFor` + `searchParamsForUrl`; no network), `favorite-and-sort`,
  `unfiled-refuses-workspace-fields`, `workspace-never-rejects`; `capture-run.test.ts`
  `run-scope-searches-skips-pages`; `packages/ipc-contract/src/__tests__/projects-router.test.ts`: the
  new procedures in `every-projects-procedure-enforces-sender`, `projects-inputs-are-validated`,
  `projects-answers-are-checked`; `projects-spec.test.ts` `projects-workspace-values`.
- [ ] **Implementation:** `apps/desktop/src/main/changes/workspace.ts` (service over Task 1's
  repository; `ownerDomain` from `main/serp/serp-analyse.ts` for the site's owner), `projects.ts`
  (summary fields, `startRun` scope), `capture-run.ts` (scope), procedures in
  `packages/ipc-contract/src/projects-router.ts` (`setFavorite`, `setSite`, `addCompetitor`,
  `removeCompetitor`, `setTags`, `addSearches`) and its `ProjectsService`.
- [ ] **Acceptance:** existing projects tests green; every new answer schema-checked.

### Task 5: Rankings service, IPC and CSV export (security review)
**Purpose:** main serves the rank table, series, comparison and exports.
- [ ] **Spec:** `specs/rankings.schema.ts` adds the inputs and answers: `RankTableInputSchema`
  (`projectId`, `range`, optional `tag`), `RankSeriesInputSchema` (`projectId`, `searchKey`, `range`),
  `ReadingDatesInputSchema`, `CompareInputSchema` (`projectId` and two `readingId`s, both of that live
  project), `RankCsvInputSchema` (`projectId`, `kind: 'table' | 'history'`, `range`, `tag?`), answers
  `RankTableSchema` (with the project's retention for `RANK_HISTORY_NOTE`), `RankSeriesSchema`,
  `SerpComparisonSchema`, `CopyCsvAnswer` (`number | null`), `SaveCsvAnswer` (`saved` | `cancelled` |
  refused). `RANKINGS_REFUSALS` (`not-found`, `store-failed`). `specs/rankings.feature.md`: Router and
  Export sections (`RANK_CSV_FILE_NAME`, save dialog wording).
- [ ] **Failing tests:** new `apps/desktop/src/main/changes/__tests__/rankings.test.ts`:
  `rank-table-reads-live-project-only`, `tampered-reading-skipped`, `orphan-reading-ignored-and-swept`
  (a **capture-sourced** reading whose capture is gone; the filter tests `source = 'capture'`, so a
  capture-less reading of another source is not an orphan),
  `compare-refuses-readings-of-another-project`, `rankings-never-reject`; new `rank-csv.test.ts`:
  `rank-csv-uses-csv-cell` (formula guard on a title/query starting `=`, `+`, `-`, `@`),
  `rank-csv-copies-through-main` (clipboard written in main, count answered),
  `rank-csv-save-asks-for-the-path` (no path from the renderer; cancel writes nothing; written
  owner-only, `mode: 0o600`, as chat export's `writeExport` in `main/agent/service.ts`),
  `rank-csv-bounded`; new `packages/ipc-contract/src/__tests__/rankings-router.test.ts`:
  `every-rankings-procedure-enforces-sender` (and fails closed), `rankings-inputs-are-validated`,
  `rankings-answers-are-checked`.
- [ ] **Implementation:** `apps/desktop/src/main/changes/rankings.ts` (sweeps the project's
  capture-sourced orphans,
  reads via Task 1, parses with `StoredReadingSchema`, runs Task 3's model with the project's site and
  competitors), `rank-csv.ts` (`csvCell` from `@app/seo-core`, CRLF), `rank-dialogs.ts` (save dialog as
  `main/agent/dialogs.ts`); `packages/ipc-contract/src/rankings-router.ts` and `rankings-service.ts`
  (`rankings.table`, `series`, `readingDates`, `compare`, `copyCsv`, `saveCsv`); one line each in
  `router.ts`, `services.ts`, `main/index.ts`.
- [ ] **Acceptance:** no procedure reads another project's rows by id alone; no file written without
  the dialog; CSV formula guard on.
- **Risks:** a large project × `all` range is the heaviest read: bounded by `RANK_LIMITS` and the
  repository's `limit`.

### Task 6: Rankings and Compare views
**Purpose:** the rank table, series and comparison in the Projects sheet (over the page column; SEO
sidebar left, agent right, unchanged).
- [ ] **Spec:** `specs/rankings.feature.md` "The views": table columns (search, engine, locale,
  device, filters, tags, position, change, best, trend, last checked, competitors), range and tag
  filters, empty states ("Set your site's domain to see its position"; "No readings yet: capture a
  search or run Check rankings"), `RANK_HISTORY_NOTE` when the project keeps limited history, row click
  opens the series (date, position, URL; "Open this result page" loads the canonical URL in the active
  tab), Compare pickers (search + date, twice), Copy CSV / Save CSV…. `specs/projects.feature.md` "The
  sheet": the views Overview, Rankings, Compare (Settings in Task 7).
- [ ] **Failing tests:** new `apps/desktop/src/renderer/__tests__/rankings-view.test.ts`:
  `rank-row-view` (labels for each outcome, change text, "> n"), `trend-points-from-numbers` (SVG
  points from positions only), `range-and-tag-filter`, `history-note-follows-retention`,
  `compare-view-rows`; `projects-view.test.ts` `projects-palette-actions` and
  `palette-all-features.test.ts` `palette-features-register-together` with "Open rankings" and
  "Compare searches".
- [ ] **Implementation:** `renderer/rankings-view.ts` (pure view model), `components/changes/Rankings.tsx`,
  `Compare.tsx`; `Projects.tsx` gains the view switch; `projects-palette.ts`; IPC wrappers in
  `renderer/ipc.ts`.
- [ ] **Acceptance:** no innerHTML of reading text; keyboard reachable; the run band (`data-running`)
  unchanged.

### Task 7: Project library, Settings and Bulk add views
**Purpose:** favorites and sort, site and competitors, tags, bulk add.
- [ ] **Spec:** `specs/projects.feature.md` "The sheet": a star and a sort menu in the project list;
  Settings view (site, include subdomains, competitors; the cadence part is Task 8's); tags on page and
  search rows and the Bulk add dialog (lines, engine, locales, devices, tags; per-line outcomes; "adds
  searches only; nothing is sent until you run Check rankings").
- [ ] **Failing tests:** `projects-view.test.ts`: `projects-view-favorites-and-sort`,
  `projects-view-settings-form` (site and competitors), `projects-view-bulk-add-form`,
  `projects-view-tags`.
- [ ] **Implementation:** `components/changes/ProjectSettings.tsx`, `BulkAdd.tsx`; `Projects.tsx`,
  `projects-view.ts`; IPC wrappers in `renderer/ipc.ts`.
- [ ] **Acceptance:** every Task 4 procedure reachable from the sheet; refusals shown with their
  `PROJECT_REFUSAL_MESSAGES`.

### Task 8: Runs that query search engines — disclosure, pacing, stop at a challenge, cadence (security review)
**Purpose:** Decision 10 in full.
- [ ] **Precondition (L1, Decision 10):** the owner's written note on Google's and Bing's terms is
  in `docs/research/` before "Check rankings" or the cadence / Due notice ships.
- [ ] **Spec:** `specs/projects.spec.ts`: `RANK_RUN_DISCLOSURE` (dialog: message, detail, buttons
  Continue / Cancel, Cancel default; frost's own words as Decision 10, including that positions are
  "as your signed-in browser profile sees them"), `RANK_RUN_DISCLOSURE_SETTING_KEY`,
  `RANK_RUN_QUERY_SPACING_MS = 10_000` and `PROJECT_RUN_LIMITS.querySpacingMs` (= it; between
  landed search targets, outside `targetActiveTimeoutMs`), `RUN_STATES` and `RUN_END_STATES` +=
  `blocked`, `RUN_TARGET_OUTCOMES` += `blocked`, `RUN_BLOCK_REASONS`
  (`not-a-result-page`, `unreadable`, `serp-off`, `mismatch`, `no-reading`, `timed-out`),
  `RunState.blockedReason` (nullable), `RUN_BLOCKED_NOTE` and a label per reason;
  `RUN_STATE_LABELS` and `RUN_TARGET_OUTCOME_LABELS` gain `blocked` (their
  `Record<RunStateName | RunTargetOutcome, string>` typing forces it); `CAPTURE_RUN_NOTE` changes to
  say search targets are paced and a run stops, capturing nothing, at a consent page or a challenge;
  `specs/projects.feature.md` Capture now step 4 and the `capture-run-records-query-params` scenario
  text (~line 225) rewritten for search targets (the verdict gate of Decision 10; the
  target-parameters fallback kept for page targets only), plus the new scenarios below;
  `ProjectSummary` gains `cadence`, `autoCapture`, `due`. `specs/projects.schema.ts`: `RunStateSchema`
  enums follow; `SetCadenceInputSchema`, `SetAutoCaptureInputSchema`; `PROJECT_REFUSALS` += `unavailable`.
  New `specs/capture-schedule.spec.ts`: `AUTO_CAPTURE_AVAILABLE = false`, `CAPTURE_CADENCE_MS`,
  `SCHEDULE_TICK_MS` (60 000), `AUTO_CAPTURE_IDLE_S` (300), `AUTO_CAPTURE_RETRY_MS` (6 h),
  `isDue(lastRunAt, cadence, now)`, `AUTO_START_SUSPENDED_REASONS`, `CAPTURE_SCHEDULE_NOTE` (only while
  frost is open; a due project waits for you; search engines may show a challenge).
  `specs/projects.feature.md`: "Searches in a run" and "Cadence" sections; Unfiled refuses a cadence.
- [ ] **Failing tests:** `capture-run.test.ts`: `capture-run-spaces-search-targets` (fake clock; page
  targets not delayed; the wait is not counted in the next target's active time; Cancel during the wait
  ends the run at once), `capture-run-stops-at-a-challenge` with one case per reason — a consent page on
  another host (`not-a-result-page`, before any verdict), a `/sorry/`-style path on the engine host,
  an `unreadable` verdict, a `disabled` verdict (`serp-off`), a `ready` verdict for another search
  (`mismatch`), a page that stays `pending` past `SERP_SETTLE_WAIT_MS` (`no-reading`), a page that
  never finishes loading until `targetActiveTimeoutMs` (`timed-out`) — each: the run ends `blocked`
  with that reason, the rest `cancelled`, and **`deps.capture` was never called for the blocked
  target** (no capture, version, reading or screenshot in the project); `capture-run-captures-only-on-ready`
  (a matching `ready` verdict captures with the tab's own parameters);
  `capture-run-page-targets-never-block` (a page target that times out stays `timed-out` and the run
  goes on); `capture-run-after-blocked-starts-normally`; `capture-run-no-wait-after-a-failed-load`;
  `capture-run-ready-needs-tab-params` (`ready` with `searchParamsOf` `null` is `no-reading`, nothing
  captured); new `readings-spec.test.ts` `run-search-matches-built-urls` (for Google, Bing and
  DuckDuckGo, every `SavedSearchInput` shape the bulk add can make: `searchUrlFor` → landed unchanged
  → `searchParamsForUrl` → `sameRunSearch` is true, so the gate cannot false-positive on the shipped
  engines; a different `gl`, `hl`, query or host is false).
- [ ] **Existing tests updated in this task (each keeps asserting what it asserts today):**
  - `capture-run.test.ts` `capture-run-records-query-params`: its first case passes
    `readySerpFor(targets)` (the query is captured with `desktop`, as now); the `read` case keeps its
    own `searchParamsOf` (a tablet reading of the same search: same search, captured with the tab's
    params, as now); the sentence "none: the target's" is dropped for queries and kept for the `page`
    case.
  - `capture-run.test.ts` `capture-run-applies-profiles` and `capture-run-never-removes-a-pin`: pass
    `readySerpFor(targets)` and `limits: { querySpacingMs: 0, serpSettleWaitMs: 0 }`, so all targets
    are visited and the run is `done` within `run(RETRY * 12)` as today.
  - `capture-run-pins.test.ts` `capture-run-never-removes-a-pin` (real timers): `readySerpFor(targets)`
    and `limits: { captureRetryMs: 10, querySpacingMs: 0, serpSettleWaitMs: 0 }`, so the three targets
    are `captured` within its 5 s `vi.waitFor`.
  - `projects.test.ts`: its service setup gains a `confirmRankRun` fake answering Continue (and a
    settings fake), so `start-run-plans-pages-then-queries` and the other `startRun` calls keep their
    assertions; the new disclosure tests override it.
  - The remaining `capture-run.test.ts` tests use page targets only and are untouched. `projects.test.ts`: `rank-run-asks-once-before-first-search-run`
  (Cancel starts nothing; Continue remembered; a pages-only run never asks),
  `cadence-asks-the-disclosure-first`; new `capture-schedule.test.ts` (fake clock, idle, windows, runs):
  `due-after-cadence`, `off-is-never-due`, `no-backfill-after-sleep`, `defaults-never-start-a-run`
  (the real `AUTO_CAPTURE_AVAILABLE`: due shows, nothing starts, `setAutoCapture` is `unavailable`);
  with `autoCaptureAvailable: true` injected: `auto-start-needs-idle-visible-and-free`,
  `one-auto-attempt-per-retry-window`, `auto-run-yields-to-the-user` (the run is cancelled when it
  enters `waiting-for-tab`), `auto-start-suspended-after-blocked`, `schedule-stops-on-quit`;
  `projects-view.test.ts`: `projects-view-due-label`, `projects-view-cadence-settings` (no automatic
  switch while unavailable), `projects-view-blocked-run`; palette "Check rankings now".
- [ ] **Implementation:** `capture-run.ts` (spacing between landed search targets from
  `limits.querySpacingMs`; in `visit()` for a search target: the landed-URL check, the verdict wait
  from Task 2 (`limits.serpSettleWaitMs`), `searchParamsOf` + `sameRunSearch`, then `blocked` without
  calling `deps.capture` on any non-`ready`, mismatched or param-less verdict, and `timed-out` →
  `blocked`; `Visit['end']` gains `blocked`; `RunState.blockedReason`; the header comment rewritten
  as Decision 10 says), `projects-dialog.ts` (`confirmRankRun`, main's message box),
  `projects.ts` (`startRun` asks the
  disclosure through `projects-dialog.ts`, reads/writes the setting through the settings repository
  passed by `projects-main.ts`; `due` from `lastProjectRunAt`), `capture-schedule.ts` (timer started in
  `projects-main.ts`; injected `powerMonitor`, window visibility, the run service, the flag),
  `setCadence` / `setAutoCapture` in `projects-router.ts`; Settings cadence part in
  `ProjectSettings.tsx`, "Due", "Check rankings" and the blocked note in `Projects.tsx`.
- [ ] **Acceptance:** "Check rankings" and the cadence / Due notice ship only with L1's written
  note; with the shipped constants frost never starts a run by itself; no run with search
  targets starts before the disclosure was accepted; every run stops at its first challenge, consent
  page, unreadable or mismatched result page or timed-out search target, and nothing of that page is
  stored in the project; every pre-existing changes/projects test is green, apart from the updates
  listed above (which keep their assertions).
- **Risks:** `RunState` gains enum values (additive; the renderer's labels must cover them).

### Task 9: SERP parameter editor and "Track this search" (security review)
**Purpose:** SL-008 and the path from a SERP into a project.
- [ ] **Spec:** new `specs/serp-param-editor.spec.ts` (Zod-free): `SERP_EDITOR_FIELDS` per engine —
  Google: domain (`GOOGLE_EDITOR_HOSTS`, the bundled pack's Google hosts), country `gl`, language `hl`,
  time `tbs` (`any`, `hour` = `qdr:h`, `day` = `qdr:d`, `week` = `qdr:w`, `month` = `qdr:m`, `year` =
  `qdr:y`), results `num` (`10`, `20`, `50`, `100`; with `SERP_NUM_HINT`), SafeSearch `safe` (`default`,
  `active`, `off`), personalisation `pws` (`default`, `off` = `0`); Bing: `cc`, `setlang`; DuckDuckGo:
  region `kl`, time `df` (`d`, `w`, `m`, `y`), SafeSearch `kp` (`1` strict, `-2` off); any other
  engine: the pack's `gl`/`hl` names only. `editorStateOf(params, pageUrl)` (initial values: params
  plus `serpFiltersOf(pageUrl)`). `editedSearchUrl(params, state, names)`: from `params.url` (path
  kept; host only from `GOOGLE_EDITOR_HOSTS` for Google), the query re-encoded as `searchEngineUrl`
  does, every known filter of `state` carried over, page reset to 1, values only from the closed sets
  (country `^[a-z]{2}$`, language as `SavedSearchInputSchema`), built with `URL`/`URLSearchParams`;
  `null` when the result is not an allowed origin with the same path. `trackableSearch(params, filters)`
  → `SavedSearchInput | null` (Decision 12). `specs/serp-panels.feature.md`: "Edit search" section.
- [ ] **Failing tests:** new `apps/desktop/src/renderer/__tests__/serp-editor-view.test.ts`:
  `editor-fields-per-engine`, `editor-starts-from-the-tabs-filters` ("past week" stays when the country
  changes), `edited-url-keeps-path-and-allowed-host`, `edited-url-encodes-values` (a crafted value
  cannot add a parameter or change the host), `edited-url-resets-page`, `trackable-search-rules`;
  `apps/desktop/src/main/changes/__tests__/serp-params.test.ts` `edited-url-reads-back` (Phase 3's
  `matchSerp` with the bundled pack reads the same query, `gl`, `hl` on every Google host; filters via
  `serpFiltersOf`); `serp-palette.test.ts` `serp-palette-edit-and-track`.
- [ ] **Implementation:** `renderer/serp-editor-view.ts`, `components/seo/SerpEditor.tsx` (opened from
  `ParamsBar` in `Serp.tsx`; Apply calls `browser.navigate` with the built URL); "Track this search…"
  picks a project (the `ProjectPicker` pattern) and calls `projects.addSearch` (existing); disabled
  with the reason when `trackableSearch` is `null`.
- [ ] **Acceptance:** the editor never writes free text into a URL; tracking goes only through Phase
  6's validated path.

### Task 10: AI-engine destinations (security review)
**Purpose:** SL-006 / SL-045: open the current search in an AI engine as a plain tab.
- [ ] **Spec:** new `specs/ai-destinations.spec.ts`: `AI_SEARCH_DESTINATIONS` (`perplexity`:
  `https://www.perplexity.ai` `/search` `q`; `chatgpt`: `https://chatgpt.com` `/` `q`;
  `google-ai-mode`: `https://www.google.com` `/search` `q` + `udm=50`), `aiDestinationUrl(dest, query)`
  (as `openInUrl` in `specs/open-in.spec.ts`: fixed `https:` origin and path, the query one encoded
  value, ≤ `OPEN_IN_URL_MAX_LENGTH` from `specs/command-palette.spec.ts`), `AI_DESTINATION_NOTE`
  ("Opens as an ordinary tab, so the query is sent from your own signed-in account and lands in
  that engine's history. frost does not read the answer."), `OPEN_DESTINATION_REFUSALS`
  (`no-search`, `no-tab`). `specs/serp-service.schema.ts`: `OpenDestinationInputSchema` (`tabId`,
  `destination` enum) and its answer. `specs/serp-panels.feature.md`: "Open in an AI engine".
- [ ] **Failing tests:** new `apps/desktop/src/main/serp/__tests__/destinations.test.ts`:
  `destination-urls-are-fixed-https` (origin, path, one parameter; a query with `&`, `#`, `/`, lone
  surrogates stays one value), `destination-uses-the-tabs-own-query` (no renderer text; a tab that is
  not a SERP is `no-search`), `destination-opener-gets-only-table-urls` (the injected opener receives
  exactly `aiDestinationUrl(…)` and nothing else), `ai-destinations-are-not-serps` (bundled pack
  `matchSerp` → `null` for each URL), `destination-no-tab-at-the-cap`; `serp-router.test.ts`
  `open-destination-enforces-sender` (and the strict input); `serp-palette.test.ts`
  `serp-palette-ai-destinations`.
- [ ] **Implementation:** `apps/desktop/src/main/serp/destinations.ts` (`createDestinations({ state,
  openBackgroundTab })`: reads the tab's `SerpState` query, builds the URL, calls the opener);
  `SerpSetupOptions` (`main/serp/setup.ts`) gains optional `openBackgroundTab?: (url: string) =>
  number | null` and the returned service gains `openDestination` (answers `no-tab` without it);
  `SerpService` in `packages/ipc-contract/src/serp-service.ts` gains `openDestination`;
  `serp.openDestination` in `serp-router.ts`; `main/index.ts` passes `(url) =>
  browser.openBackgroundTab(url, false)` (the controller's existing public method; no controller
  change). An "Open in" row in `Serp.tsx` and the editor; palette actions in `serp-palette.ts`.
- [ ] **Acceptance:** no AI-destination URL is built from renderer text; no reading of those pages.

### Task 11: End to end
**Purpose:** the user path over real Electron, no third-party network.
- [ ] **Setup:** new `apps/desktop/e2e/rank-fixtures.ts`: frost's own synthetic result pages whose
  organic order changes per request count, and a challenge page, served on loopback; the signed test
  pack and key as `serp-fixtures.ts` does (the existing `--frost-e2e-serp-pack-url` /
  `--frost-e2e-serp-pack-key` seams); `--host-resolver-rules` mapping the synthetic host to `127.0.0.1`
  and `www.perplexity.ai`, `chatgpt.com`, `www.google.com` to `~NOTFOUND`. **Fixture hosts are
  public-looking names mapped to loopback** (the existing e2e pattern, e.g. `agent.e2e.ts`'s
  `agent.frost-e2e.net`: `--host-resolver-rules=MAP <name> 127.0.0.1` plus
  `--frost-e2e-public-hosts=<name>`), never `.example` names, which
  `NON_PUBLIC_NAME_SUFFIXES` (`specs/private-address.spec.ts:24`) treats as non-public. The site
  and competitor are `leafhouse-frost-e2e.net` and `brewguide-frost-e2e.net` (each its own
  registrable domain, so Decision 7's owner rule keeps them apart), mapped the same way.
- [ ] **Scenarios** (new `apps/desktop/e2e/rankings.e2e.ts`, each named in `rankings.feature.md`):
  `rankings-two-captures-show-change` (create a project, set site `leafhouse-frost-e2e.net`,
  competitor `brewguide-frost-e2e.net`; open the synthetic SERP, Capture into the project; reload with a new order,
  Capture again; Rankings shows position 3 → 2, change "+1", two trend points, the competitor column);
  `rankings-compare-two-dates` (Compare shows the site moved up, a domain new); `rankings-copy-csv`
  (clipboard read in main via `electronApp.evaluate`; header and two rows; a title starting `=` is
  guarded); `projects-bulk-add-with-tags` (three lines × two devices → six searches with the tag;
  filter by tag; the fixture server saw no request); `serp-editor-applies-country-and-language`
  (synthetic engine: the tab's URL carries the pack's `gl`/`hl` names, page reset);
  `serp-open-in-perplexity` (a new tab whose address is the built URL; nothing loads). The run
  disclosure, pacing and challenge stop are unit-tested (saved searches use the bundled pack's real
  engines, which the e2e must not load).
- [ ] **Acceptance:** suite green on the CI matrix; no request leaves loopback (the fixture server
  counts requests; `~NOTFOUND` for the rest).

---

## Review focus
- Append-only integrity of readings; purge, orphan and `updated_at` rules (Task 1).
- Untrusted SERP text never becomes markup, a formula or a URL part (Tasks 5, 6, 9, 10).
- No run with searches starts without the disclosure, runs are paced and stop at a challenge, and
  nothing starts a run by itself (Task 8); no AI host opens without the user's action (Task 10).
- `SearchParams`, lane keys and Phase 6's saved-search path are unchanged (Tasks 2, 4, 9).

## Open questions
| # | Question | How to resolve |
|---|---|---|
| 1 | Google's and Bing's terms on automated queries. Decided default: due notice only, disclosure, 10 s pacing, stop at the first challenge (Decision 10). Open: whether automatic starts may ever be offered. | The lead reads the current Google Terms of Service and Bing terms; only an explicit lead decision flips `AUTO_CAPTURE_AVAILABLE` (after persisting the suspension state). |
| 2 | Does Google still honour `num` (reports in 2025 said `num=100` stopped working) and `pws=0`? | Manual check on a real profile before Task 9 ships; if ignored, drop the value from `SERP_EDITOR_FIELDS` or keep it with `SERP_NUM_HINT` saying the engine may ignore it. |
| 3 | AI destination URL forms: `perplexity.ai/search?q=`, `chatgpt.com/?q=`, `google.com/search?udm=50&q=` | Open each by hand (signed in and out) before Task 10 ships; adjust the table; the e2e never loads them. |
| 4 | (Only if automatic starts are ever enabled.) Do runs in a visible-but-unfocused window audit within `targetActiveTimeoutMs` (background throttling)? Does `powerMonitor.getSystemIdleTime()` work on Linux Wayland (it may read 0) as well as X11? | Measure on macOS, Windows, Linux X11 and Wayland before flipping the flag; if idle is unreliable on a platform, automatic starts stay off there. |
| 5 | Reading size in practice vs `MAX_SERP_READING_JSON_BYTES` | Log sizes (counts only) in the Task 2 unit fixtures from the bundled pack's engines; tune the cap before release. |
| 6 | Sync of readings, tags, competitors and the new project columns | A follow-up to Phase 7 (extend `SYNC_TABLES` and the replica); decide after Phase 12 settles `serp-api` rows. |
| 7 | Bing filter parameters (time, SafeSearch) | Check Bing's current URL parameters; add to `SERP_FILTER_PARAMS` and the editor only once verified, with a `SEARCH_KEY_VERSION` bump (older Bing readings were keyed without those filters). |
| 8 | Should rank history outlive capture retention (e.g. keep readings beyond `versions N`)? | Decide after usage data: an independent reading retention needs its own guard and purge path; until then the Rankings view states the horizon (Decision 15). |
| 9 | Should runs load search targets **cookieless** (not as the signed-in browser profile), so positions are less personalised? Not built in this phase: positions are "as your signed-in browser profile sees them" (`RANK_RUN_DISCLOSURE`, `RANK_HISTORY_NOTE`). | Lead decision later. A change alters what a reading measures, so it needs a `SEARCH_KEY_VERSION` bump (cookieless readings never share a series with earlier ones). |
