# Phase 12 — Big bets: BYO search data, a site crawler, AI-search visibility · Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. Tasks **1, 3, 4, 6a, 8, 10a and 10b** get a security-focused review
> (secrets, third-party requests, an append-only store's delete guard, fetching at volume, untrusted
> text into the agent, browse-class partitions). Do not commit unless the lead asks.
> Steps use checkbox (`- [ ]`) syntax.
> **Read Decisions 1–3 first:** this phase has legal questions and kill criteria. Reading AI answers
> from signed-in tabs (C2) and the `uule` experiment are **deferred proposals** (end of this plan),
> not tasks.

**Goal** (what a user can do at the end):
- Paste their own SerpApi, DataForSEO or Serper key in Settings › Data sources and check a project's
  saved searches through it. Each API reading joins the **same series** in Phase 10's rank table as
  the tab captures of that search, each point marked with where it came from (Phase 10's reading row
  `source`: `capture` or `serp-api`).
- Crawl a site politely from frost (robots.txt and `Crawl-delay` honoured, one request a second by
  default, scoped, capped, pausable and resumable after a restart), and see its **Pages** (status,
  indexability, title, canonical, depth, in-links, the served-HTML score — the crawl rule set's, not
  the sidebar's — and findings per page) and its
  **Site structure** (path tree, click depth, orphans from the sitemap), with a CSV export.
- Ask the agent (or the new AI answers view directly) how Perplexity or OpenAI's web search answers a
  query and which sites they cite, on the user's own API key, every agent call approved by the user
  with the engine and source shown.
- Open a tab whose traffic goes through the user's own proxy (a dedicated, in-memory partition with
  the proxy's password in the keychain) to see results as from that location, with the location
  recorded on the SERP reading and on every capture of that tab's result pages (other pages in a
  location tab are refused for Capture and screenshots until captures can record a location).

**Spec sources:**
- `docs/research/serplens-gap-analysis.md`: §2.3 (SL-046), §2.6 (SL-084), §2.2 (SL-029/030, capture
  side only), §2.7 (SL-096, SL-097), §2.1 (SL-009, SL-002 for location); §3.2 rows #15 and #17;
  §3.3 Wave 5; §4 rows "Rank tracking", "SERP locations / VPN", "AI-search visibility"; §6
  ("Third-party options in §4 … were not checked against current vendor docs").
- Existing specs this phase extends: `specs/agent-tools.spec.ts` (`run_ai_search`: `act`, never
  grantable), `specs/agent-search-tools.spec.ts` / `.feature.md` (`SEARCH_TOOL_LIMITS`,
  `SEARCH_TOOL_SOURCES['run_ai_search']`, `completeToolInput`, `run-ai-search-needs-approval`),
  `specs/agent-session.spec.ts` (approval notes), `specs/serp-selector-pack.spec.ts` / `.schema.ts`
  (`packVersion`), `specs/serp-snapshot.schema.ts` (`SerpSnapshotSchema`,
  `SerpReadSchema`), `specs/serp-search-params.schema.ts` (`SearchParamsSchema`),
  `specs/fetcher.spec.ts` (lanes), `specs/seo-checks.spec.ts` (`SITEMAP_LIMITS`),
  `specs/seo-javascript.schema.ts` (`ServedSnapshotSchema`, `ServedParseInput`), `specs/seo-snapshot.spec.ts`
  (`PageSnapshotSchema`, `PageContextSchema`, `ResponseMetaSchema`, `RobotsFetchSchema`),
  `specs/seo-rules.spec.ts` (`SEO_RULE_SPECS`), `specs/agent-proxy.spec.ts` (credential store rules),
  `specs/secret-store.spec.ts`, `specs/browser.spec.ts` (`BROWSE_PARTITION`, the browser state),
  `specs/security-policy.spec.ts` (`PACKAGED_FORBIDDEN_SWITCHES`), `specs/projects.spec.ts`
  (`SavedSearchInput`, `searchUrlFor`), `specs/capture-db.spec.ts` (`RETENTION_MODES`),
  `specs/changes.spec.ts` (`CAPTURE_REFUSALS`), `specs/screenshot.spec.ts` (`SCREENSHOT_REFUSALS`).
- Sibling plans: Phase 8 (`docs/plans/phase-8-ai-complete.md`: MCP presets for keyword volume,
  backlinks and vendor rank tracking; **referenced, not re-planned here**), Phase 9
  (`phase-9-gsc-ai-readiness.md`: the AI-readiness score), Phase 10
  (`phase-10-projects-rank-tracking.md`: `ci_serp_readings`, `SERP_READING_SOURCES`, the
  `appendReading` writer in `packages/db/src/change-intel/readings.ts`, the source-independent read
  model, `SEARCH_IDENTITY_EXCLUDED` / `searchIdentityJson` in `specs/rankings.spec.ts`, the SERP
  parameter editor). **This plan lands after Phase 10 and rebases on it.**

### What the gap analysis says that the code does not bear out
- **"Derive positions from the SERP snapshots already stored in `ci_versions`"** (§3.2 #4, §3.3). The
  `ci_versions.snapshot` column holds a `CaptureSnapshot` (`specs/capture-snapshot.schema.ts`), and
  `ci_versions.search_params` only `SearchParams`. No `SerpSnapshot` was stored; Phase 10 adds
  `ci_serp_readings` for that. This plan writes API readings there (Task 4).
- **"User-supplied proxy per tab or partition"** (§4). A proxy is per session, and every tab shares
  one session (`BROWSE_PARTITION = 'persist:frost-browser'`, `window.ts` `createTabView`). Several
  modules recognise a tab by identity with that one session or install per-session wiring on it only
  (Task 10a lists each). A proxied tab needs a second **browse-class** partition, not a per-tab switch.
- **"The README already documents the DNS gap"** (§4): it is `apps/desktop/README.md` (Requests frost
  makes on your behalf; the DNS-rebinding window), and `fetcher.spec.ts` already says "through a
  proxy the proxy resolves the name itself".
- **`SerpReadySchema` requires `packVersion`** (an integer ≥ 1): an API-sourced snapshot needs a
  decision (Decision 7), which the analysis does not mention.
- `run_ai_search` has no engine choice: its input is `{ query, locale? }` (`packages/ai-skills/src/tools.ts`),
  and `serpAdapter` answers it `unavailable` (`SERP_ADAPTER_REASONS.aiSearch`) — as the analysis says.

---

## Decisions

### 1. Sequence of the three bets
| Order | Bet | Tasks | Why this order | Depends on |
|---|---|---|---|---|
| A | **BYO SERP API** (§4) | 1 → 2 → 3 → 4 | Lowest risk (the user's own paid API, documented endpoints, no page automation), smallest surface, and it multiplies Phase 10's value. Task 1's credential store and API client are reused by bet C. | Phase 10 merged (Task 4) |
| B | **Site crawler** (#17) | 5 → 6a → 6b → 7 | High value, no third-party ToS beyond politeness; independent of A and C, so it may run in parallel with A. | none (Phase 10 only for the project entry point) |
| C1 | **AI-search visibility via provider APIs** (#15, API path) | 8 → 9 | Wires `run_ai_search` without driving anyone's UI; reuses Task 1. | Task 1 |
| A′ | **Location: proxy partitions** (§4) | 10a → 10b | The riskiest security change of the phase (a second browse-class session); 10a is a behaviour-preserving refactor reviewed on its own before any proxy code. | none |
| — | E2E | 11 | One suite over every surface shipped. | the tasks shipped |

**Recommendation (lead's scope cut):** ship A, B and C1 in this phase. Ship A′ (the proxy
locations, Tasks 10a and 10b) if its leak test passes (K-D). C2 (AI answers read from signed-in
tabs, #15's tab path) and the `uule` experiment are **out of this phase**: they are kept as
proposals with their research and legal notes in "Deferred proposals" (D1, D2) at the end of this
plan, with no tasks. `run_ai_search` is API-only in this phase.

### 2. Legal / ToS questions to answer before any code (owner, not an implementer)
Each is answered in writing (a short note under `docs/research/`, the owner's own words) before the
task it gates starts. "Unclear" counts as **no**. (L1–L3 gated the signed-in-tab path; they moved
with it to "Deferred proposals", D1.)

| # | Question | Gates | How to resolve |
|---|---|---|---|
| L4 | Do SerpApi, DataForSEO and Serper allow results to be stored locally without a time limit and shown in an open-source client run by the key's owner? Any attribution required? | Tasks 3–4, per vendor | Each vendor's terms / legal page. v1 supports only vendors whose terms allow keeping results locally **without an expiry**; a vendor whose terms limit how long results may be kept is **excluded** from v1 (lead ruling: no vendor metadata or expiry machinery). |
| L5 | Do the Perplexity API and OpenAI's web-search tool allow storing answers and citations locally (AI answers view)? | Tasks 8–9 | Their API terms / usage policies. |
| L6 | Crawling: is "robots.txt and `Crawl-delay` honoured, no override, 1 request/s default, identifying user-agent token" an acceptable default for an open-source tool? | Task 6a | Owner decision; recorded in `site-crawl.feature.md`. |
| L7 | Engine names in the UI (Perplexity, ChatGPT, Google AI Mode, SerpApi…) are nominative use only; no logos or icons. | All UI tasks | Owner confirms; the UI uses text labels only (clean-room rule). |

### 3. Kill criteria (each checked at the named point; a hit stops or narrows the bet)
K-C2, K-C3 (signed-in tabs) and K-E (`uule`) moved with their bets to "Deferred proposals" (D1, D2).

| Id | Bet | Kill / narrow when | Checked |
|---|---|---|---|
| K-A1 | A | A vendor's terms forbid local storage or limit how long results may be kept (L4), or its fixtures cannot be mapped to a `ready` `SerpSnapshot` whose organic positions equal the vendor's own rank field: **drop that vendor**. | Task 3 review |
| K-A2 | A | Phase 10 is not merged (no `ci_serp_readings`, no `appendReading`): **Task 4 parks**; Tasks 1–3 still ship (the "Check via API" result is shown, not stored). | Task 4 start |
| K-B1 | B | On the fixture sites, a crawl holds more than one **fetch call** in flight per origin, or starts two fetch calls to one origin closer than the effective interval: **release blocker** (politeness is not negotiable). A fetch call is one page's request plus its redirect hops: the hops of one call follow each other at once, one hop at a time, bounded by `maxRedirects` (`fetcher.spec.ts`); the interval applies between fetch calls (the fetcher's per-origin queue is per call), never between hops of one call. | Task 6a tests |
| K-B2 | B | On static fixture pages the served-HTML audit disagrees with the sidebar's rendered audit for any rule in `CRAWL_RULE_IDS`: **remove that rule from the crawl set** (never ship a crawl finding the sidebar would not show). | Task 6b tests |
| K-B3 | B | Per-page state held in memory is not bounded: a test counts the crawler's in-memory structures (frontier window, pending rows, per-origin state) and asserts they stay under `CRAWL_LIMITS.maxInMemoryEntries` over a 10 000-page fake site (everything else is in SQLite). The owner also measures main's heap over a real 10 000-page crawl before release; growth over 150 MB **lowers `maxPagesCap`** until it holds. CI asserts counts, never heap size. | Task 6b test; owner before release |
| K-C1 | C1 | A provider's API returns no structured citations (prose only): **drop that provider** (an answer without a source list cannot show visibility). | Task 8 review |
| K-D | A′ | The leak test (Task 10b/11, its design in `location-profiles.feature.md`) fails: the tripwire origin records any direct connection, the real origin sees a request without the fake proxy's marker, or a WebRTC candidate carries a non-proxied address: **do not ship proxy locations**. | Task 10b/11 |

### 4. Data sources are bring-your-own, main-only, user-initiated
- Every paid source runs on the user's key, stored by main with `safeStorage` through the existing
  `createCredentialStore` (`apps/desktop/src/main/agent/credentials.ts`: `os` protection only, blobs
  sealed to their slot, atomic 0600 writes, write-only to the renderer). One new file,
  `data-credentials.json`, one slot per secret: `serpapi`, `serper`, `perplexity`,
  `openai-search`, and DataForSEO as **two slots**, `dataforseo-login` and `dataforseo-password`
  (a slot holds one line-free string; the client builds the Basic header from both inside nested
  `withKey` closures). **Rejected:** reusing the agent's `openai` slot for OpenAI web search — the
  store's rule is that only the model proxy reads it (`withKey`); a second reader widens a reviewed
  boundary. The user pastes the key again (Settings says why).
- Requests go out from main only, with `session.fromPartition('frost-data-api').fetch` (an
  in-memory partition), `redirect: 'error'`, `credentials: 'omit'`, to one exact method + canonical
  URL per provider and purpose (`DATA_API_REQUESTS`, the `MODEL_REQUESTS` / `isAllowedModelRequest`
  pattern), with a body main builds from validated fields (never forwarded from anywhere). Error
  bodies are withheld (status only).
- **Nothing spends the user's credit in the background.** Each API call follows a user action (a
  button, a palette command) or an agent call the user approved; no timer, no schedule (consistent
  with the existing "no unattended scheduling" rule). Every surface that spends says so, and a local
  usage counter (Task 2) shows requests per provider per month.
- v1 vendors: **SerpApi, DataForSEO, Serper** (Google web results), each only if L4 finds that its
  terms allow keeping results locally **without an expiry**. A vendor whose terms limit retention is
  excluded from v1 (lead ruling), not shipped with a cap: there is no per-vendor retention metadata
  or expiry machinery. **Bright Data is deferred**: its
  SERP product is reached through its proxy network, which belongs with Decision 11's proxy rules,
  not the API client (open question Q3). Bing via APIs is deferred.

### 5. Keyword volume, backlinks and vendor rank tracking stay in Phase 8
Through MCP presets (Phase 8 backlog #9) on the user's Semrush/Ahrefs/SE Ranking subscription. This
plan adds nothing for them. **Rejected:** a native DataForSEO keywords client here — it duplicates
Phase 8's preset with a second, reviewed HTTP path; and the Google Ads Keyword Planner API (gap
analysis §4 Keyword (c)), cut and deferred: it needs a Google Ads account and a developer token, and
Phase 8's MCP presets already cover keyword data. Backlinks: Phase 11 ships the vendor "Open in"
shortcuts (§4 Backlinks (a)); Bing Webmaster Tools and Common Crawl are in Decision 12.

### 6. The crawler fetches served HTML, not rendered pages
- A fourth bounded-fetcher instance, the **`crawl` lane** (outside `FETCHER_LANES`, like the SERP
  lane), created with `perOriginConcurrency: 1` and `perOriginIntervalMs: 500` — the **floor**. The
  crawl's own pacing (`apps/desktop/src/main/crawl/politeness.ts`) submits one request per origin at a
  time and waits the **effective interval** before the next: the user's choice (500–4 000 ms, default
  1 000), raised to the site's `Crawl-delay` (capped at 10 s), raised again by back-off (doubles on
  429/503; 5 in a row pauses the run with "The site asked frost to slow down"), and by `Retry-After`
  (seconds or a date, capped at 60 s). The lane's floor is a second guarantee, never the pacing.
- `Crawl-delay`: Phase 2's robots parser deliberately ignores it (`indexability/robots.ts`: "keys
  frost does not read"), and the sidebar must not change. The crawl reads it with its own pure
  function, `crawlDelayFor(text, token)` in `packages/seo-core/src/crawl/crawl-delay.ts`, over the
  decoded robots text (`decodeRobotsBytes`), in the worker; the group is chosen the same way as
  `groupsFor` (token `frost-crawl`, else `*`). Q13 records its edge cases.
- Crawl fetches ask for `keepHeaders: ['content-type', 'x-robots-tag', 'link', 'retry-after']`
  (`separateHeaders: ['x-robots-tag']`), so the audit context and the back-off have what they need.
- Pages are parsed by `served-parse.ts` in **a worker of their own** (the `seo-analysis.cjs` bundle,
  new job kind `crawl`, as checks have their own), adapted to a `PageSnapshot` plus a `PageContext`
  (Task 6b states each field), and audited with `runAudit(…, CRAWL_RULES)` — only the rules listed in
  `CRAWL_RULE_IDS` (Task 5; K-B2). The crawl job asks the served parse for neither Phase 11's
  `sourceText` nor Phase 9's `leadText`: it passes the parse option `ServedParseInput.skipExtraText:
  true` (new, optional, default `false`; `specs/seo-javascript.schema.ts`), so no crawl result
  carries either and the per-page memory stays at the snapshot's size.
- **The crawl score is not the sidebar score.** The Pages view's score column is the score of the
  served-HTML rule subset (`CRAWL_RULES`), labelled `CRAWL_SCORE_LABEL` ("Served-HTML score"), and the
  crawl sheet names the rule set (the `CRAWL_RULE_IDS` categories, and what is excluded and why), so
  a user never reads it as the sidebar's health score.
- **Rejected:** rendering each page in a hidden `WebContents` — runs third-party JavaScript
  unattended, costs a renderer per page, and needs a new partition with its own guards. Deferred to a
  later wave; the Pages view flags "looks client-rendered" (low served word count with scripts) so the
  user can open such pages in a tab.
- robots.txt: always honoured, **no override** in v1 (L6), matched for the product token
  `frost-crawl` with the `*` fallback (`groupsFor`, `matchRobots` in `@app/seo-core`): the `frost-crawl`
  group, then `*`. The request's user agent header is the browse session's own with ` frost-crawl/1`
  appended (identifying, never a crawler's; the browse UA is kept for site compatibility).
  **The robots product token is `frost-crawl`, and robots matching is always called with that bare
  constant (`CRAWL_ROBOTS_TOKEN`), never with the user agent header.** `groupsFor` runs
  `productToken` over whatever string it is given
  (`packages/seo-core/src/indexability/robots.ts:146-149`, `:253-254`), and `productToken` reads the
  string's leading letters: passed the full header (`Mozilla/5.0 … frost-crawl/1`) it would match
  the `mozilla` group. `productToken('frost-crawl/1')` is `frost-crawl`, so the group a site writes
  for frost (`User-agent: frost-crawl`) is the group the crawl obeys (`CRAWL_ROBOTS_TOKEN =
  'frost-crawl'`, never `frost`); `crawlDelayFor` takes the same constant. The Pages view also
  shows the Googlebot verdict per page (computed from the same robots file; nothing fetched as Googlebot).
- Scope: same host (default), same registrable domain, or a path prefix; include/exclude **prefix**
  lists (no regular expressions: nothing user-typed can backtrack); `maxPages` 500 by default, hard
  cap 10 000; `maxDepth` 10; known tracking parameters stripped; at most 20 query variants per path.
- Link discovery uses the served snapshot's links, which `served-parse` caps at
  `SNAPSHOT_LIMITS.maxLinks` (1 000) per page. Links past the cap are not discovered; the page row
  keeps `linkTotal` and the Pages view marks such pages "links cut at 1 000".
- Resumable: the frontier is in SQLite; quitting pauses a run; at start-up any run left `running`
  (a crash or kill) is normalised to `paused`; a paused run continues only on the user's Resume.
- Private hosts: every crawl request is made with `page` = the run's **start URL**, so the fetcher's
  rule applies unchanged (private hosts only when the start URL is on one). A crawl whose start URL is
  on a private address is limited to its **exact origin** (scheme, host **and** port): the `site` and
  `path` scopes are refused for it, and its host scope compares the origin, so a dev-server crawl
  cannot follow links to other LAN hosts or to other ports of the same host (`127.0.0.1:3000` never
  reaches `127.0.0.1:9229`).
- **Redirects pass the crawl policy before they are followed.** Every redirect hop of a crawl page
  fetch is checked against the crawl's own policy — scope (including a private start's exact
  origin), robots.txt for the **new** URL (its origin's robots fetched through `robots.get` first),
  and the private-address rule — **before** the hop is requested. The crawl lane does this through a
  redirect-policy hook on the bounded fetcher: `BoundedFetchRequest` (`specs/fetcher.spec.ts`) gains
  an optional, async `allowRedirect(nextUrl)`, consulted in the redirect branch of `fetchBounded`
  (`apps/desktop/src/main/seo/fetcher.ts` ~:310) after the fetcher's own checks; a refusal ends the
  fetch with the outcome `redirect-refused` and the next URL is never requested. Other lanes pass no
  hook and behave as today. (If the reviewer prefers the shared fetcher untouched, the crawl lane
  sets `maxRedirects: 0` and follows each hop itself through the same policy, one fetch call per
  page as K-B1 counts it.) The page is recorded with the refusal (`blocked-by-robots`,
  `out-of-scope`, `private-redirect` or `robots-timeout`).
- **The hook's order: no request to the new origin until scope and address allow the hop.** The
  hook first decides scope and the private-address / exact-origin rule, with no request to the new
  origin (the fetcher's own DNS resolution excepted); only when both allow the hop does it fetch
  robots.txt for the new origin. A hop from `127.0.0.1:3000` to `127.0.0.1:9229` is refused
  with no request to `:9229` at all, not even `/robots.txt`.
- **The hook's robots lookup is bounded, and one rule decides its answer.** A redirect target whose
  robots answer is `timeout` refuses the hop as `redirect-refused`, and the page is recorded with the
  named outcome `robots-timeout`; it is never surfaced as a page fetch timeout (the hook's wait is
  not counted as the page fetch's own timeout). The other unknown robots outcomes (the rest of
  `ROBOTS_UNKNOWN_OUTCOMES`: `server-error`, `unreachable`, `bad-redirect`, `no-location`) follow the
  start-origin rule (Task 6a Risks): the hop is followed and the page is crawled with the default
  interval and the `robots-txt-unreachable` finding, as the sidebar treats it. The hook's own limit
  is the robots fetcher's `timeoutMs` (`ROBOTS_FETCH_LIMITS`, `specs/seo-indexability.spec.ts:110`)
  plus a small named margin, `CRAWL_ROBOTS_HOOK_MARGIN_MS` (`specs/site-crawl.spec.ts`), so the
  robots fetcher's own `timeout` answer arrives inside it; a lookup still unanswered at that limit
  counts as `timeout`.
- **Crawl robots fetches obey the private start's exact origin, redirects included.** The shared
  robots fetcher (`apps/desktop/src/main/seo/robots-fetch.ts:93`) fetches through the bounded
  fetcher, whose own check (`fetcher.ts:315`) lets a private page's redirect reach any private host
  or port. For a crawl with a private start, the crawl's `robots.get` lookups carry the exact-origin
  rule down to that fetch (an `allowRedirect` refusing any hop whose scheme, host or port differs
  from the robots URL's), so `127.0.0.1:3000/robots.txt` redirecting to `127.0.0.1:9229` is not
  followed (`robotsOutcome` in robots-fetch.ts maps that `redirect-refused` to the robots outcome
  `private-redirect`, as it maps `private-address` today, never to `unreachable`). Lookups made with
  the rule are cached apart from lookups without it (the cache is keyed by origin today), so an
  answer that followed such a redirect for another caller is never reused by the crawl.
- Retention: crawl data is the user's working data, deleted **per run** (Delete run, or deleting
  the project it belongs to). It is not part of Clear Browsing Data or project retention; the crawl
  sheet shows each run's size and says so.
- **Deleting a project deletes its crawls.** A local delete and a synced tombstone alike run the
  same shared project cleanup, the crawl service's `deleteProjectCrawls(projectId)`: it cancels the
  project's active crawl and **awaits** its end (no fetch call or row write follows), then deletes
  its crawl runs and pages (and their links and frontier, by the `0241` cascade); paused and
  completed runs are deleted the same way. A local delete calls it from the project's delete. A
  synced tombstone calls it when the pull ends: after every sync pull that applied project
  tombstones, main runs the cleanup for each tombstoned project that still has crawl runs, at the
  pass's completion path (`apps/desktop/src/main/sync/service.ts:133`, which calls no project
  cleanup today), so no crawl row is left once the pull completes, with no restart and no capture
  run. The cleanup runs after the pull's own work and in its own `try`: a cleanup failure is logged
  on its own line and never marks the sync pass failed (`sync/service.ts:131-146`); the backstops
  below retry it. Two backstops stay: a running crawl checks before each fetch call that its project is not
  tombstoned, so a tombstone that arrives by sync mid-run cancels it; and startup recovery covers
  the rest: `deletedProjectsWithRows`
  (`packages/db/src/change-intel/repository.ts:726`) also lists a tombstoned project that still has
  `crawl_runs`, and `purgeDeleted` (`apps/desktop/src/main/changes/projects.ts`) deletes them, so a
  project whose only data is a crawl is cleaned up after a failed delete or a tombstone that arrived
  while frost was closed.

### 7. API results become ordinary `SerpSnapshot`s in Phase 10's store (lead ruling)
- A vendor's JSON is mapped (in the SERP worker, never main's thread) to a `SerpRead`
  (`SerpReadSchema`: blocks in the vendor's page order), then run through the existing
  `analyseSerp` (`apps/desktop/src/main/serp/serp-analyse.ts`), so ranks, positions, composition and
  ownership are derived exactly as for a tab. Vendor result types map to `SERP_RESULT_TYPES` through
  a typed table per vendor; an unknown type is skipped and counted.
- `packVersion` is the version of the selector pack whose engine definition built the search's
  canonical URL and parameters (`searchParamsForUrl(searchUrlFor(search), device)`, as saved searches
  are today). **Rejected:** making `packVersion` nullable — every reader of `SerpReady` types it as a
  number.
- **Provenance lives only on the reading row.** `SearchParams` gains **no** `source` field. An API
  reading's `SearchParams` are built exactly as the saved search's, so its Phase 10 search key
  (`searchIdentityJson(params, filters)`, `filters` = `{}`) equals the tab captures' for the same
  search: **one series**, each point carrying Phase 10's row `source` (`capture` | `serp-api`), which
  stays the authority for which path wrote it (Phase 10 Decision 4). `SEARCH_IDENTITY_EXCLUDED` is
  unchanged.
- `SearchParamsSchema` gains one **optional** field, `location?: { via: 'proxy' | 'uule' | 'api';
  label: string }` (absent = the user's own connection; `uule` is reserved for the deferred proposal
  D2 and nothing in this phase writes it). It is **meant to split series**: Phase 10's
  search key takes every present field, so a Berlin reading never shares a trend line with a
  home-connection one, and a location tab's captures get their own Phase 6 lane (the lane key hashes
  the search parameters). Records written before it still parse.
- **Rows carrying `location` stay device-local (lead ruling).** `SearchParamsSchema` is a
  `strictObject`, and `search_params` is a synced column of `ci_versions`, `ci_captures` and
  `ci_screenshots` (and of `ci_project_queries`). An older build would fail to parse a synced
  `location` and show that capture without its search. So, until a sync-schema bump in a Phase 7
  follow-up, the sync engine never pushes a row of those tables whose `search_params` carries
  `location` (the same rule as Phase 11's tab-local overrides), nor a `ci_diffs` row whose
  `to_version_id` is such a version. A location lane's versions, captures and screenshots all carry
  it (the lane key hashes the search parameters), so the lane stays whole on this device; readings are device-local already (Phase 10 Decision 9). A tombstone of a row that
  was never pushed deletes nothing elsewhere. Task 10b wires and tests it
  (`location-rows-stay-device-local`).
- API readings have no capture. Phase 10's `0223` delete guard allows deleting a reading only when
  it is `capture`-sourced and its capture is gone, so a `serp-api` row could never be deleted. This
  plan's migration **`0245_serp_api_readings`** replaces that guard (Task 4): a `serp-api` reading
  may be deleted only after its id is recorded in a new `ci_serp_api_purges` table (the purge's
  record, the `ci_tombstones` idea for a table `ci_tombstones` cannot name, since its `CHECK` is frozen
  in `0040`); a recorded id can never be inserted again.
- **A project with only API readings is cleaned up like any other.** Phase 10's cleanup counts
  captures, versions, diffs and screenshots only, so a project holding nothing but `serp-api`
  readings would read as empty and never be purged. API reading ids are included in retention
  planning (`apps/desktop/src/main/changes/retention.ts:89`, `isEmpty`), in `executePurge`'s stale
  and emptiness checks (`packages/db/src/change-intel/purge.ts:269-271`), and in the startup retry's
  deleted-project discovery (`deletedProjectsWithRows`,
  `packages/db/src/change-intel/repository.ts:726`); retention runs after API writes (a "Check via
  API"), as it runs after captures.
- **The purge counts name the API readings.** The retention preview and the "Purge now" confirm
  pass `plan.counts` into `PurgeCountsView` (`apps/desktop/src/main/changes/retention.ts:295` and
  `:313`; `specs/retention.spec.ts:67-72`), which has no readings field, so an API-only purge would
  read "0 captures, 0 versions, 0 diffs and 0 screenshots". `PurgeCountsView` gains an optional
  `readings` count (the plan's API readings) and `purgeCountsText` (`specs/retention.spec.ts:173-174`)
  names it in the sentence when present. The count must also reach the renderer: the IPC output
  schema's strict `counts` (`specs/retention.schema.ts:45`, used by `RetentionPreviewAnswerSchema`
  and `PurgeNowAnswerSchema`, validated in `packages/ipc-contract/src/projects-router.ts:222`/`:228`)
  gains an optional bounded `readings`, and both renderer emptiness checks count it
  (`(readings ?? 0)`): `previewText` (`apps/desktop/src/renderer/projects-view.ts:232`, "would remove
  nothing") and the "Purge now" button's `nothing` (`components/changes/Retention.tsx:116`, disabling
  at `:166`). The synced `ci_purges` row gains **no** column (the purge-log entry reuses `counts` and
  stays valid without it).

### 8. `run_ai_search`: engines, "via", and what is approved
- `AI_SEARCH_ENGINES = ['perplexity', 'chatgpt', 'google-ai-mode']`; the tool input gains an optional
  `engine`. How it is reached (`via`: `api` or `tab`) is **the user's setting per engine, never the
  model's choice**; in this phase the only via is `api` (`tab` is the deferred proposal D1). v1 `api`
  providers: Perplexity's API for `perplexity`, OpenAI Responses with the
  web-search tool for `chatgpt` (labelled "OpenAI web search — may differ from the ChatGPT app").
  `google-ai-mode` has no API in v1 (Q8), so it is unavailable in this phase.
- **What is approved is what runs.** `completeToolInput` (`specs/agent-search-tools.spec.ts`, called
  by `approvals.ts` before the card is shown and the input hashed) gains a context argument and, for
  `run_ai_search`, fills `engine` and `via` into the input: `engine` as given, else the user's default
  engine setting, else the first of `AI_SEARCH_ENGINES` with a usable via; `via` from that engine's
  setting **at that moment**. Any `via` already in the input (the model's) is **dropped and
  overwritten** from the setting, never kept, so the completed input's `via` is always the
  setting's. The completed input is checked with a main-side schema
  (`runAiSearchApprovedInputSchema` in `@app/ai-skills`: `engine` and `via` required; the
  model-facing schema has no `via`) and its hash covers both. The handler runs with the approved
  engine and via; if the setting changed since, it answers `expired` ("The AI search setting changed;
  ask again") and runs nothing.
- **The approved input survives to execution.** Today the tool runner re-parses every input with
  the tool's model-facing schema (`apps/desktop/src/main/agent/tools/runner.ts:316`,
  `definition.inputSchema.safeParse`), which has no `via`, and the search tool destructures only
  `query` and `locale` for the port (`apps/desktop/src/main/agent/tools/search-tools.ts:253-254`).
  So the runner re-parses `run_ai_search` with `runAiSearchApprovedInputSchema` (not the
  model-facing strict schema), and `search-tools.ts` forwards `engine` and `via` to
  `port.aiSearch`. The path from the broker (`approvals.ts`) through the runner to the port is
  tested end to end.
- With no usable engine at all (no key, nothing enabled), the call is answered as data when it
  arrives, with no approval card (the `run-visibility-probes-private-page-never-asks` pattern):
  "No AI search source is set up. Add a Perplexity or OpenAI key in Settings › Data sources."
- Unchanged and restated: `act`, **never grantable**, asks every call; the approval card shows the
  engine, the via, the exact query, and that it spends the user's API credit; output is untrusted (`SEARCH_TOOL_SOURCES.run_ai_search = 'search:ai-answer'`), capped by
  `SEARCH_TOOL_LIMITS.maxAnswerChars` / `maxCitations`.
- New bounds: at most 2 calls per turn, and per engine at most one call every 20 s across turns
  (`AI_SEARCH_LIMITS`), so a looping model cannot run up a bill or look like automation to an engine.
- **Scope cut:** SL-046's sub-queries, opened pages, follow-ups, products and places are not read.
  v1 keeps the answer text, the citations and the cited domains.

### 9. AI answers are kept locally, in their own view
Every answer (agent or user-initiated) is stored in `ai_answers` (migration 0242) with a retention
setting (`off | 7d | 30d | forever`, default `30d`) and shown in an **AI answers** view (SL-046/084):
query, engine, via, when, the answer as inert text, the citations, cited domains, and a "watch
domain" highlight (`registrableDomain`). The view can run a query itself (a user action: no approval
card, the same cost note). **Phase 9's AI-readiness score must not read this table or import this
phase's modules** (cross-plan ruling; a test in Task 9 keeps it so).

### 10. *(Moved out of this phase: reading AI answers from signed-in tabs is deferred proposal D1.)*

### 11. Location is the user's proxy on a dedicated partition; never a built-in VPN
- A **location profile** = label, scheme (`http` | `https` | `socks5`), host, port; username and
  password in the keychain (`location-credentials.json`, slots per profile, the MCP secrets
  pattern in `agent/mcp/secrets.ts`). Chromium does not authenticate SOCKS proxies, so a `socks5`
  profile has no credentials.
- Each profile gets an **in-memory** partition `frost-location-<profileId>` with
  `session.setProxy({ mode: 'fixed_servers', proxyRules })` and Chromium's implicit loopback bypass
  kept (a loopback dev server is reached directly; the README says so). Its tabs are browse-class
  (Task 10a): every per-session installer the browse session gets, including Phase 11's cookies-off
  pair (`browser/cookie-block.ts`, registered on the tab's own session while a tab of that session
  has cookies off), plus WebRTC limited to proxied UDP. `setWebRTCIPHandlingPolicy` is a
  **WebContents** method, not a session or partition setting, so no Task 10a installer can apply it:
  it is applied (`LOCATION_WEBRTC_POLICY = 'disable_non_proxied_udp'`) to **each location tab's
  WebContents at creation**, before its first navigation (Task 10b).
- Proxy authentication answers Electron's `login` event **only** when `authInfo.isProxy` is true,
  the request's session is that profile's partition, and `host:port` equals the profile's; every
  other `login` is cancelled — what Electron does today, since frost installs no `login` listener.
- **A location tab is an ephemeral context**: its visits are not written to history, it is not saved
  in the restored session, and it is not reopened by Reopen Closed Tab after a restart (the in-memory
  partition is gone). Its tab state carries `location: { profileId, label }`, which the badge, the
  SERP service and the capture and screenshot guards read.
- **Capture provenance on a location tab.** Location reaches a capture only through its
  `search_params` (Decision 7); a capture of any other page records nothing of the proxy and would
  read as the user's own connection. So, until location has a capture-level representation, Capture
  now and screenshots **refuse** on a location tab unless the page carries location-bearing search
  params (a result page whose `SearchParams` carry `location`, as the SERP service sets them):
  refusal `location-tab` in `CAPTURE_REFUSALS` and `SCREENSHOT_REFUSALS`, message "This tab goes
  through a location proxy. Only its search result pages can be captured for now." The sync
  exclusion of rows carrying `location` (Decision 7) stays as it is.
- What is not proxied, stated in the UI and the README: frost's own fetches for a location tab's
  audit (robots.txt, served HTML, probes, link checks) still go through the browse session from the
  user's own address. **Rejected:** proxying those lanes too — it would mean per-profile fetcher lanes
  and resolvers, for little SEO value; revisit if users ask.
- **Rejected:** a built-in VPN or bundled proxy list (non-goal, `IMPLEMENTATION-PLAN.md` §1; phase-4
  decision 4); recommending proxy vendors.

### 12. Scope cuts and deferrals
- Not in this phase: rendered crawling (Decision 6); crawl scheduling; ignoring robots.txt; crawl
  over a location proxy; an agent tool over crawl data (`site_pages` — a later wave, read-only);
  agent `serp_results` falling back to a paid API (it stays free and tab-based; spending needs a user
  action); Bing via APIs; Bright Data; Google AI Mode via API; SL-046 sub-queries/products/places;
  tracked AI prompts per project over time (the view stores history; a per-project tracker is a later
  wave); multi-account per vendor; history or session restore for location tabs; reading AI
  answers from signed-in tabs (C2) and the `uule` experiment (deferred proposals D1, D2); captures
  of non-result pages in a location tab (Decision 11); sync of
  `serp-api` readings (Phase 10's follow-up 6 decides it); sync of rows carrying `location`
  (Decision 7; a Phase 7 follow-up with a sync-schema bump).
- Gap analysis §4, decided here:
  - **Bing Webmaster Tools backlinks** (§4 Backlinks (c)): deferred. Its API is unverified and needs
    a verified-site OAuth flow; open question Q14 checks it before anyone commits to it.
  - **Common Crawl's web graph** (§4 Backlinks (d)): cut. It is a large offline dataset with coarse,
    domain-level data: a download and processing pipeline out of proportion to a desktop browser.
  - **Google Ads Keyword Planner** (§4 Keyword (c)): cut and deferred. It needs a Google Ads account
    and a developer token; Phase 8's MCP presets already cover keyword data (Decision 5).

---

## Global constraints
Everything in `CONTRIBUTING.md`, `docs/design/IMPLEMENTATION-PLAN.md` §3 and the Phase 0–7, Phase 5
and Phase 10 global constraints still holds. In particular, and new for this phase:
- **IPC:** every new procedure is in `packages/ipc-contract` (new `*-router.ts` / `*-service.ts`
  files) behind `enforceSender`; no raw `ipcMain` / `ipcRenderer`. Inputs Zod-validated, bounded.
- **Secrets** (API keys, DataForSEO login/password, proxy credentials) live only in main, through
  `createCredentialStore` with `os` protection (stored and used only then; `weak` / `unavailable`
  refuse, as `agent-proxy.spec.ts` `KEY_PROTECTIONS`). Never in the renderer (write-only plus
  `hasKey`), the agent runtime, the model's context, logs, error text, the database, or a logged URL.
  SerpApi takes its key as a query parameter: the URL with the key is built **and fetched** inside
  the `withKey` closure and never leaves it (`withKey` returns the closure's value,
  `apps/desktop/src/main/agent/credentials.ts:291`, so the closure returns the response and the
  key-less URL only); logged and returned URLs are the key-less form.
- **Third-party requests** (`frost-data-api`, in memory, `session.fetch`): exact allowlist,
  `redirect: 'error'`, `credentials: 'omit'`, response size and time caps, error bodies withheld,
  body built by main.
- **Untrusted text:** vendor JSON, AI answers and crawled HTML are page data. They are parsed in
  workers (the SERP worker; the analysis worker's `crawl` instance), validated with strict, capped
  Zod schemas, shown as inert text (no `innerHTML`, no markdown rendering, links not clickable
  until the user opens them in a tab through the address bar's path), and reach the agent only inside
  the untrusted wrapper (`tool-output.ts`). No answer text reaches a privileged context.
- **Isolated worlds:** no new page script in this phase (the AI answer reader is deferred, D1).
- **Partitions:** `frost-data-api` and `frost-location-<id>` are in-memory (no `persist:`); location
  partitions are browse-class through one registry (Task 10a) and covered by Clear Browsing Data.
- **Approvals:** what an approval card shows is what runs (`completeToolInput`, the input hash).
- **Fetching on the user's behalf** (`fetcher.spec.ts`): the crawl lane follows every rule there
  (private addresses, redirects one hop at a time, caps, per-origin queue), every redirect hop of a
  crawl page fetch passes the crawl policy before it is followed (scope and the private-address /
  exact-origin rule first, with no request to the new origin (the fetcher's own DNS resolution
  excepted); robots for the new origin only after both allow it), a
  private start's robots fetches never follow a redirect off its exact origin (Decision 6), and
  `FETCH_DISCLOSURE` appears on the crawl sheet.
- **Robots token:** crawl robots matching (`groupsFor`, `matchRobots`, `crawlDelayFor`) is always
  given the bare `CRAWL_ROBOTS_TOKEN` (`frost-crawl`), never the sent user agent header (Decision 6).
- **CI makes no network call:** vendor APIs, AI engines, crawled sites and proxies are loopback fakes.
  New unpackaged-only seams, refused in packaged builds (`PACKAGED_FORBIDDEN_SWITCHES`):
  `frost-e2e-data-api` (a JSON file mapping each provider to a loopback base URL, the
  `frost-e2e-chatgpt` pattern).
- **Database:** migrations for this phase use **only ids 0240–0249**; every one is new text, no
  applied migration is edited. **Placement (lead ruling):** each list (site crawl, AI answers, data
  usage, location profiles, SERP-API readings) is spread in `MIGRATIONS` in id order **after**
  Phase 11's `...PHASE11_MIGRATIONS` (`0230`/`0231`), so `migrations-are-forward-only` holds. The
  tasks add them out of numeric order (Task 2 `0243`, Task 4 `0245`, Task 5 `0240`/`0241`, Task 9
  `0242`, Task 10b `0244`): a task that adds a lower id than one already spread inserts its list
  **before** that id. Final order: `CHANGE_INTEL`, `0200`, `0210`, `0220`–`0223`, `0230`/`0231`,
  `0240`/`0241`, `0242`, `0243`, `0244`, `0245`. The test-only fixture ids are already `9000_`
  (Phase 8).

  | Id | Creates / changes |
  |---|---|
  | `0240_site_crawl` | `crawl_runs`, `crawl_pages`, `crawl_links`, `crawl_frontier` |
  | `0241_site_crawl_guards` | `CHECK`s, the cascade trigger from a deleted run to its rows |
  | `0242_ai_answers` | `ai_answers` |
  | `0243_data_api_usage` | `data_api_usage` (provider, month, requests) |
  | `0244_location_profiles` | `location_profiles` (no secrets) |
  | `0245_serp_api_readings` | `ci_serp_api_purges (reading_id PRIMARY KEY, purged_at)`; `DROP TRIGGER ci_serp_readings_capture_gone_only` (Phase 10's `0223` `BEFORE DELETE` guard) and recreates it with two arms (Decision 7) as `ci_serp_readings_delete_guard`; a no-resurrect trigger for recorded ids; `ci_serp_readings_no_update` and `ci_serp_readings_no_replace` untouched |
  | `0246`–`0249` | reserved |
  Settings (vendor choice per purpose, engine via and default engine, retention)
  use the existing `app_settings` table (`0005_app_settings`); no migration.
- **Clean-room:** vendor fixtures are synthetic JSON written from the vendors' public documentation;
  AI answer selectors and every string are frost's own; no competitor code, copy or selectors.
- **Phase 9 independence:** nothing in Phase 9's score reads `ai_answers` or imports this phase's
  modules.

## Threat model (what this phase adds)
| Threat | Mitigation | Test |
|---|---|---|
| An API key leaks (renderer, log, agent, error) | Write-only store, the request sent inside the `withKey` closure, key-less URLs returned and logged, error bodies withheld | Task 1 `data-key-never-leaves-main`, `serpapi-key-never-in-a-logged-url` |
| Main is made to call an arbitrary host with a key | Exact `DATA_API_REQUESTS` allowlist, no redirects, canonical URLs | Task 1 `data-api-allowlist`, `data-api-refuses-redirects` |
| Hostile vendor or AI JSON (huge, deep, odd types) | Size cap before parse, worker-side parse, strict capped schemas, unknown types skipped | Task 3 `serp-api-parse-is-bounded`, Task 8 `ai-api-parse-is-bounded` |
| API readings deleted or rewritten outside a purge | `0245` guard: delete only with a recorded purge; Phase 10's no-update / no-replace triggers kept | Task 4 `serp-api-reading-deleted-only-by-a-recorded-purge`, `serp-api-reading-never-resurrected` |
| An AI answer steers the agent (prompt injection) | Untrusted wrapper, `act` never grantable, the model never chooses `via`, per-turn and per-engine caps | Task 8 `run-ai-search-asks-every-call`, `run-ai-search-capped-per-turn-and-engine` |
| The setting changes between approval and run | Engine and via completed into the approved input and its hash; a changed setting answers `expired` | Task 8 `run-ai-search-runs-what-was-approved` |
| The approved engine and via are lost on the way to the provider | The runner re-parses `run_ai_search` with the approved schema, and the search tool forwards `engine` and `via` to the port | Task 8 `run-ai-search-approved-input-reaches-the-port` |
| The model exfiltrates page text through a query | Query ≤ 256 chars, shown exactly on the approval card | Task 8 `run-ai-search-approval-shows-query-engine-and-via` |
| The crawler hammers a site or reaches the LAN | One in flight per origin, effective interval ≥ 500 ms (≥ `Crawl-delay`, back-off, `Retry-After`), robots honoured for the bare `frost-crawl` token (never the sent header), `page` = start URL, private starts limited to their exact origin (their robots fetches and robots redirects included), every redirect hop checked against the crawl policy before it is followed (scope and address first, no request to the new origin before both allow it, the fetcher's own DNS resolution excepted) | Task 6a `crawl-is-polite`, `crawl-honours-robots`, `crawl-robots-matches-the-bare-token`, `crawl-private-start-is-origin-only`, `crawl-redirects-pass-the-crawl-policy`, `crawl-robots-fetch-is-origin-only`, `crawl-redirect-robots-timeout-refuses-the-hop` |
| A crawled page exhausts memory or the parser | `served-parse` caps, its own worker, per-page body cap, bounded in-memory state, rows written per page | Task 6b `crawl-in-memory-state-bounded` (K-B3) |
| A location tab bypasses its proxy (direct, WebRTC) | `fixed_servers` proxy, WebRTC policy, browse-class wiring | Task 10b `location-tab-traffic-goes-through-proxy`, `location-tab-webrtc-proxied-only` |
| Proxy credentials answer a site's auth prompt | `login` answered only for `isProxy` on that partition and that host:port | Task 10b `proxy-login-only-for-its-proxy`, `no-login-listener-cancels` |
| A location tab escapes browse guards or misses wiring | One browse-class registry consulted by every consumer; each per-session installer run per browse-class session | Task 10a `browse-class-registry-is-the-only-test`, `every-browse-installer-runs-per-session` |
| Hidden spend | User action or approval for every call; usage counter | Task 2 `data-usage-counts-every-request`, Task 4 `api-check-is-user-initiated` |

## Team contract
- **New files only under:** `apps/desktop/src/main/data-sources/**`, `apps/desktop/src/main/crawl/**`,
  `apps/desktop/src/main/ai-search/**`, `apps/desktop/src/main/location/**`,
  `apps/desktop/src/main/browser/browse-class.ts` (Task 10a); `packages/db/src/site-crawl/**`,
  `packages/db/src/ai-answers*.ts`, `packages/db/src/data-usage*.ts`,
  `packages/db/src/location-profiles*.ts`, `packages/db/src/change-intel/serp-api-*.ts`;
  `packages/seo-core/src/crawl/**`;
  `packages/ipc-contract/src/{data-sources,crawl,ai-answers,location}-{router,service}.ts`;
  `specs/{data-sources,serp-api,site-crawl,ai-search,location-profiles}.*`;
  renderer `components/crawl/**`, `components/ai-answers/**`, `settings-data-sources*.ts(x)`,
  `settings-locations*.ts(x)`, `crawl-view.ts`, `crawl-palette.ts`, `ai-answers-view.ts`,
  `ai-answers-palette.ts`, `data-sources-palette.ts`, `location-view.ts`, `location-palette.ts`;
  e2e `apps/desktop/e2e/{data-sources,crawl,ai-answers,location}.e2e.ts` and fakes
  `fake-data-api.ts`, `crawl-fixtures.ts`, `fake-proxy.ts`, `ai-answer-fixtures.ts`.
- **Hub files get one-line registrations only:** `apps/desktop/src/main/index.ts` (except Task
  10a's move of the browse-session wiring into a per-session installer, reviewed as part of that
  task), `packages/ipc-contract/src/router.ts` / `services.ts`, `App.tsx`, the palette registry,
  `packages/db/src/migrations.ts` (one spread per migration list, in id order after
  `...PHASE11_MIGRATIONS`; Global constraints), root config, `forge.config.ts`
  (none expected: the crawl worker reuses the `seo-analysis.cjs` bundle).
- **Existing files this phase edits (each named in its task, kept small):**
  - specs: `serp-search-params.schema.ts` (optional `location`), `fetcher.spec.ts` (crawl lane;
    `BoundedFetchRequest.allowRedirect`), `seo-javascript.schema.ts`
    (`ServedParseInput.skipExtraText`), `agent-search-tools.spec.ts` / `.feature.md`
    (`completeToolInput`), `agent-session.spec.ts` (approval note), `security-policy.spec.ts`
    (forbidden switches), `browser.spec.ts` (tab `location` in the browser state),
    `changes.spec.ts` / `screenshot.spec.ts` (the `location-tab` refusal);
  - agent: `packages/ai-skills/src/{ports,tools,fakes}.ts`,
    `apps/desktop/src/main/agent/ports/{serp-adapter,index}.ts`, `agent/service.ts`,
    `agent/approvals.ts` (the `completeToolInput` call), `agent/session.ts` (the note selector),
    `agent/tools/runner.ts` (`run_ai_search` re-parsed with the approved schema),
    `agent/tools/search-tools.ts` (`engine` and `via` forwarded to the port);
  - Phase 10's store (Task 4): `packages/db/src/change-intel/readings.ts` (`appendReading`,
    `deleteOrphanReadings`), `purge.ts` (`executePurge`, its stale and emptiness checks counting API
    readings), `repository.ts` (`deletedProjectsWithRows` finding API-only and crawl-only deleted
    projects), and Phase 10's test
    `serp-api-reading-refused-in-phase-10` in `change-intel/__tests__/workspace.test.ts`; Phase 10's
    `apps/desktop/src/main/changes/rankings.ts` (its orphan filter and sweep stay capture-sourced
    only, so API readings are listed); `apps/desktop/src/main/changes/retention.ts` (`isEmpty` counts
    API readings; enforcement after API writes; the plan's readings count passed to the preview
    and the confirm), `specs/retention.spec.ts` (`PurgeCountsView.readings?`, `purgeCountsText`),
    `specs/retention.schema.ts` (`counts.readings?`), renderer `projects-view.ts` (`previewText`)
    and `components/changes/Retention.tsx` (`nothing`); Phase 10's `components/changes/Rankings.tsx` (one
    button, one point label);
  - project deletion (Task 6b): `apps/desktop/src/main/changes/projects.ts` (a project's delete and
    `purgeDeleted` cancel and await its active crawl and delete its crawl runs),
    `apps/desktop/src/main/sync/service.ts` (after a pull that applied project tombstones, the same
    cleanup for each tombstoned project; ~:133);
  - sync (Task 10b): `apps/desktop/src/main/sync/engine.ts` (push skips rows whose `search_params`
    carry `location`), `specs/sync.spec.ts` / `sync-engine.feature.md` (the rule, Decision 7);
  - SERP and SEO: `apps/desktop/src/main/serp/{serp-worker,service,setup}.ts`,
    `apps/desktop/src/main/seo/{analysis-worker,served-parse,fetcher,robots-fetch}.ts` (the crawl
    job, the parse option, the redirect-policy hook, the exact-origin rule passed down for a private
    start's robots fetch);
  - capture guards (Task 10b): `apps/desktop/src/main/changes/service.ts`,
    `apps/desktop/src/main/screenshots/service.ts` (the `location-tab` refusal);
  - browse-class (Task 10a/10b): `security/register.ts`, `browser/{guard,render-profile-debugger,web-request,permissions,tab-permissions,tab-model,controller,session-sync,history-service,cookie-block}.ts`,
    `devtools/{site-data,storage}.ts`, `window.ts`, `session-store.ts`, `clear-browsing-data.ts`;
  - renderer: `settings-view.tsx` (section entries); docs: `README.md`, `apps/desktop/README.md`.
- **Phase 10 owns** the project workspace (`components/changes/Projects.tsx`), the rank table and the
  parameter editor; this phase adds one entry point each (a "Check via API" button, a "Site" entry),
  one line each, coordinated with the lead.

---

## Tasks

### Task 1 — Data-source keys and the data API client (main) · security review
**Purpose:** one reviewed place where frost holds third-party data keys and calls their APIs.
- [ ] **Spec first:** `specs/data-sources.spec.ts` (plain values): `DATA_PROVIDERS`
  (`serpapi`, `dataforseo`, `serper`, `perplexity`, `openai-search`), `DATA_PROVIDER_PURPOSES`
  (`serp` | `ai-search`), `DATA_PROVIDER_LABELS`, `DATA_CREDENTIAL_SLOTS` (`serpapi`, `serper`,
  `perplexity`, `openai-search`, `dataforseo-login`, `dataforseo-password`),
  `DATA_PROVIDER_SLOTS` (provider → its slots), `DATA_CREDENTIALS_FILE = 'data-credentials.json'`,
  `DATA_API_PARTITION = 'frost-data-api'`, `DATA_API_REQUESTS` (one `{ method, url }` per provider
  and purpose, canonical; `isAllowedDataRequest`), `DATA_API_LIMITS` (`timeoutMs` 30 000,
  `maxResponseBytes` 2 MiB, `minIntervalMs` per provider 1 000), `DATA_API_REFUSALS` and their
  messages, `DATA_API_E2E_SWITCH = 'frost-e2e-data-api'`, the cost note `DATA_SPEND_NOTE`.
  `specs/data-sources.schema.ts`: key input shapes per provider (DataForSEO `{ login, password }`,
  each one line), the renderer view `DataSourcesView` (per provider: `hasKey` — all its slots set —
  and `protection`; never a key). `specs/data-sources.feature.md`: scenarios below.
- [ ] Add `frost-e2e-data-api` to `PACKAGED_FORBIDDEN_SWITCHES` (`specs/security-policy.spec.ts`).
- [ ] **Red** (`apps/desktop/src/main/data-sources/__tests__/`): `data-key-never-leaves-main` (no
  view, IPC answer, log line or thrown error contains the key); `data-credentials-need-os-protection`;
  `data-credentials-sealed-to-slot`; `dataforseo-needs-both-slots` (one missing is `no-key`; setting
  one never clears the other); `data-api-allowlist` (other hosts, paths, methods, ports refused
  before any request); `data-api-refuses-redirects`; `data-api-response-capped` (2 MiB + 1 is
  `too-large`, body not read further); `data-api-error-body-withheld`;
  `serpapi-key-never-in-a-logged-url` (the fetch happens inside `withKey`: no value
  `dataApiRequest` returns and no log line contains the key; only the key-less URL is returned or
  logged); `data-api-e2e-seam-only-unpackaged`.
- [ ] **Green:** `apps/desktop/src/main/data-sources/credentials.ts` (a `createCredentialStore`
  instance with `DATA_CREDENTIAL_SLOTS`), `api-client.ts` (`dataApiRequest(provider, purpose,
  build)`: `build` receives the provider's secrets inside `withKey` and returns method, URL, headers,
  body; the client checks `isAllowedDataRequest` and **sends the request inside the same closure**
  (`session.fromPartition(DATA_API_PARTITION).fetch` with `redirect: 'error'`, `credentials:
  'omit'`; reads up to the cap); the closure's value, which `withKey` returns
  (`credentials.ts:291`), is the capped response plus the key-less URL only, so the keyed URL never
  leaves it), `index.ts` (setup, e2e seam).
  `packages/ipc-contract/src/data-sources-{router,service}.ts`: `status`, `setKey`, `clearKey`
  (inputs bounded; `enforceSender`). Registrations in `router.ts`, `services.ts`, `main/index.ts`.
- **Acceptance:** all scenarios pass; the renderer can set and clear keys and learn `hasKey` only.
- **Risks:** vendor auth styles differ (header, Basic, query parameter); the allowlist is per
  provider and purpose, so adding a vendor is a reviewed spec change.

### Task 2 — Settings › Data sources and the usage counter
**Purpose:** the user sees which sources are set up, what they cost, and how much they used.
- [ ] **Spec first:** extend `data-sources.feature.md` (UI scenarios); `DATA_USAGE_LIMITS` and the
  `app_settings` key `DATA_SERP_PROVIDER_KEY` (which SERP vendor "Check via API" uses) in
  `data-sources.spec.ts`. Migration `0243_data_api_usage` (`packages/db/src/data-usage-migrations.ts`,
  `data-usage-schema.ts`, `data-usage.ts`).
- [ ] **Red:** `data-usage-counts-every-request` (each request the client sends increments
  provider × month, refused ones do not); `data-usage-migration-creates-table`; renderer
  `settings-data-sources.test.ts` (`apps/desktop/src/renderer/__tests__/`): key set / not set,
  `weak` protection explains and disables the field, Clear asks first, the cost note shown, no key
  ever rendered.
- [ ] **Green:** `apps/desktop/src/renderer/settings-data-sources.tsx`,
  `settings-data-sources-view.ts`; a section entry in `settings-view.tsx`; `usage` procedure on the
  data-sources router.
- **Acceptance:** keys are entered in a password field, cleared on save, never shown again; usage
  shows this month's and last month's request counts per provider.
- **Risks:** users expect a "test key" button; v1 has none (a test call costs money). Q2 asks
  whether any vendor has a free account-status endpoint to use instead.

### Task 3 — BYO SERP API → `SerpSnapshot` · security review
**Purpose:** a vendor's results become a schema-valid `SerpSnapshot` with the same derivations as a tab.
- [ ] **Spec first:** `specs/serp-api.spec.ts`: `SERP_API_PROVIDERS` (`serpapi`, `dataforseo`,
  `serper`, each with its engines — `google` only in v1 — devices, page size 10 and how gl / hl /
  location / device map to its request; only vendors whose terms L4 found allow keeping results
  without an expiry — no retention field), `SERP_API_TYPE_MAP` (vendor type → `SerpResultType`),
  `SERP_API_LIMITS` (`maxResponseBytes`, `maxItems`, `maxLocationChars` 128),
  `SERP_API_OUTCOMES`. `specs/serp-api.schema.ts`: per-vendor response schemas that pick only the
  fields read (`z.looseObject` at the envelope, strict and capped below), and
  `SerpApiRequestSchema` (a `SavedSearchInput` plus optional `location`). Extend
  `specs/serp-search-params.schema.ts` with the optional `location` field and its doc comment
  (Decision 7: it splits series; there is no `source` field).
- [ ] **Red** (`apps/desktop/src/main/serp/__tests__/serp-api-parse.test.ts`,
  `apps/desktop/src/main/data-sources/__tests__/serp-api.test.ts`):
  `serp-api-maps-to-a-ready-snapshot` (per vendor fixture: `SerpSnapshotSchema` parses it; organic
  positions equal the vendor's own rank field — K-A1); `serp-api-features-mapped-unknown-skipped`;
  `serp-api-parse-is-bounded` (oversize, deep, wrong types → `invalid-answer`, never a throw);
  `serp-api-params-equal-the-saved-searchs` (no location: the API reading's `SearchParams` equal
  `searchParamsForUrl(searchUrlFor(search), device)`, so `searchIdentityJson` matches the tab
  series); `serp-api-location-splits-the-key` (a location is recorded as `{ via: 'api', label }` and
  changes the search key); `old-search-params-still-parse` (records without `location`);
  `serp-api-request-built-by-main` (only validated fields reach the vendor; location capped and
  printable); `serp-api-packversion-is-the-builders`.
- [ ] **Green:** `apps/desktop/src/main/serp/serp-api-parse.ts` (vendor JSON → `SerpRead`, then
  `analyseSerp`), job kind `api` in `serp-worker.ts`; `apps/desktop/src/main/data-sources/serp-api.ts`
  (`checkSearchViaApi(search, provider)`: request through Task 1's client, parse in the worker,
  answer `SerpSnapshot` + `SearchParams`). Fixtures in `apps/desktop/src/main/serp/__tests__/fixtures/serp-api/`
  (synthetic, from public docs).
- **Acceptance:** for each vendor fixture, the snapshot's ownership and composition match what the
  same results read from a tab would give.
- **Risks:** vendor shapes drift (fixtures pin today's documented shape; Q1); DataForSEO's
  `location_code` vs `location_name`.

### Task 4 — "Check via API" into Phase 10's readings · security review
**Purpose:** API positions appear in Phase 10's rank table, in the same series as tab captures.
- [ ] **Precondition (K-A2):** Phase 10 merged: `ci_serp_readings` (`0222`), its guards (`0223`:
  `ci_serp_readings_no_update`, `ci_serp_readings_no_replace`, `ci_serp_readings_capture_gone_only`),
  `SERP_READING_SOURCES` with `serp-api` reserved in the table's `CHECK`, `appendReading` in
  `packages/db/src/change-intel/readings.ts` (public, and refuses `serp-api` in Phase 10), `deleteOrphanReadings`,
  `executePurge` deleting the readings of purged captures.
- [ ] **Spec first:** `data-sources.feature.md` (Check via API scenarios);
  `specs/workspace-db.feature.md` (Phase 10's) gains a section "API readings (Phase 12)": the
  `0245` guard, the purge record, retention; `projects.feature.md` gains "Checking searches via a
  data API". Retention of API readings follows the project's `RETENTION_MODES` setting per search
  key: `forever` keeps all; `days N` purges `serp-api` readings older than N days; `versions N` keeps
  the N newest `serp-api` readings per search key; deleting the project purges them all. A project
  holding only API readings is no exception: its retention, its deletion and the startup retry of a
  failed deletion all see the readings (Decision 7). `specs/retention.spec.ts`: `PurgeCountsView`
  gains optional `readings` and `purgeCountsText` names it when present; `specs/retention.schema.ts`:
  `counts` gains `readings: count.optional()`; `retention.feature.md`:
  the preview and the "Purge now" confirm count API readings (`ci_purges` unchanged).
- [ ] **Migration** `0245_serp_api_readings` (`packages/db/src/change-intel/serp-api-migrations.ts`,
  spread in `MIGRATIONS` in id order, after `0244` once present; Global constraints):
  `ci_serp_api_purges`; `DROP TRIGGER ci_serp_readings_capture_gone_only` (Phase 10's `0223`
  `BEFORE DELETE` guard) and `CREATE TRIGGER ci_serp_readings_delete_guard BEFORE DELETE ON
  ci_serp_readings` so a delete is allowed only when (`source = 'capture'` and no `ci_captures` row
  has `id = OLD.capture_id`) **or** (`source = 'serp-api'` and `OLD.id` is in `ci_serp_api_purges`);
  a `BEFORE INSERT` trigger refusing an id already in `ci_serp_api_purges`. Phase 10's
  `ci_serp_readings_no_update` and `ci_serp_readings_no_replace` are untouched.
- [ ] **Repository:** Phase 10's public `appendReading` (`readings.ts`) keeps refusing `serp-api`;
  a `source: 'serp-api'` reading with `captureId: null` is written **only** through a new exported
  `appendApiReading(input)` in `packages/db/src/change-intel/serp-api-readings.ts` (`appendCapture`
  still passes `capture` only); `deleteOrphanReadings` sweeps `source = 'capture'` rows only; `executePurge` (`purge.ts`)
  records then deletes the `serp-api` readings its policy selects, in the same transaction. **API-only
  projects:** the purge plan carries the API reading ids it selects; `executePurge`'s stale check
  (`sameRows`) compares them and its emptiness check counts them (`purge.ts:269-271`), so a plan with
  only API readings is purged, not answered `empty`; retention's `isEmpty`
  (`apps/desktop/src/main/changes/retention.ts:89`) counts them too; `deletedProjectsWithRows`
  (`repository.ts:726`) also lists a tombstoned project that still has `serp-api` readings, so the
  startup retry (`purgeDeleted`) finds it. The plan's counts carry its API readings — `readings`
  is present only when the plan selects at least one API reading (absent, never 0, otherwise, so
  today's exact count assertions stay valid) and is never spread into the `ci_purges` insert
  (`purge.ts:282`) or `PurgeRecord.counts` (`purge.ts:61`, built at `:314`) — and
  `retentionPreview` and `purgeNow` (`retention.ts:295`, `:313`) pass that count into
  `PurgeCountsView.readings`; the synced `ci_purges` row gains no column.
- [ ] **Red:** replace Phase 10's `serp-api-reading-refused-in-phase-10` with
  `serp-api-reading-only-through-appendApiReading` (the public `appendReading` and the capture path
  still refuse `serp-api`);
  `serp-api-reading-deleted-only-by-a-recorded-purge`; `serp-api-reading-never-resurrected`;
  `capture-reading-guard-unchanged` (Phase 10's capture arm behaves as before);
  `orphan-sweep-skips-api-readings`; `rank-table-shows-api-readings` (`main/changes/rankings.ts`:
  a `serp-api` reading with no capture row is listed in the rank table and series, never filtered
  as an orphan); `purge-applies-retention-to-api-readings` (each mode, and
  project deleted); `api-only-project-obeys-retention` (a project with `serp-api` readings and no
  capture: each mode purges what it selects, never answered `empty`; a "Check via API" runs
  retention after its writes); `api-only-purge-counts-show-readings` (an API-only project's
  retention preview and "Purge now" confirm text show its readings count, not all zeros, through the
  router round-trip (output schema accepts `readings`) and the renderer (`previewText` does not say
  "would remove nothing"; the "Purge now" button is enabled); no `ci_purges` column added);
  update Phase 10's `serp-readings-triggers-named` to the trigger set after `0245`
  (`ci_serp_readings_capture_gone_only` dropped, `ci_serp_readings_delete_guard` present); `api-only-project-delete-retried-after-restart` (its deletion's purge
  fails; after a restart `deletedProjectsWithRows` lists it and `purgeDeleted` removes its readings);
  `api-check-is-user-initiated` (only the procedure starts it; no timer);
  `api-check-joins-the-tab-series` (one reading per search, row `source = 'serp-api'`, the same
  search key as a tab capture of it); `api-check-says-the-count-first` (the confirm shows N requests
  on <provider>); `api-check-partial-failure` (one vendor error leaves the other searches' readings);
  renderer `rank-point-shows-source` (Phase 10's table labels each point's source).
- [ ] **Green:** Phase 10's `apps/desktop/src/main/changes/rankings.ts` (its orphan rule kept to
  `source = 'capture'` rows if the merged code is broader); `retention.ts` (`isEmpty` counts API
  readings; the project's policy enforced after a "Check via API" writes, as `afterCapture` does;
  the preview and the confirm pass the readings count); `specs/retention.spec.ts`
  (`PurgeCountsView.readings?`, `purgeCountsText`); `specs/retention.schema.ts` (`counts.readings?`);
  renderer `projects-view.ts` `previewText` and `components/changes/Retention.tsx` `nothing` count
  `(readings ?? 0)`;
  `purge.ts` and `repository.ts` as above; `apps/desktop/src/main/data-sources/project-check.ts`, procedure
  `dataSources.checkProjectSearches({ projectId, searchIds? })` with `enforceSender`; the button in
  Phase 10's `Rankings.tsx` and a palette command "Check searches via <provider>"
  (`apps/desktop/src/renderer/data-sources-palette.ts`).
- **Acceptance:** a project with three saved searches and a SerpApi key gets three readings with
  `source = 'serp-api'` in the same series as its tab captures; they are purged by retention and
  project deletion and by nothing else, also in a project that has no captures (including the
  startup retry of a failed deletion); the retention preview and the "Purge now" confirm name the
  readings a purge removes.
- **Risks:** a trigger rebuilt in a later migration must keep Phase 10's capture arm exactly
  (`capture-reading-guard-unchanged`); location strings are vendor-specific (shown as typed).

### Task 5 — Crawl spec, the crawl lane and storage
**Purpose:** the crawler's contract, its fetcher lane and its tables, before any crawling.
- [ ] **Spec first:** `specs/site-crawl.spec.ts`: `CRAWL_LIMITS` (`defaultMaxPages` 500,
  `maxPagesCap` 10 000, `maxDepth` 10, `maxQueryVariantsPerPath` 20, `maxBodyBytes` (the served
  HTML's cap), `maxLinksStoredPerPage`, `backoffAfter` 5, `maxRetryAfterMs` 60 000,
  `maxInMemoryEntries`), `CRAWL_INTERVAL_MS` (default 1 000, range 500–4 000),
  `MAX_CRAWL_DELAY_MS` 10 000, `CRAWL_ROBOTS_HOOK_MARGIN_MS` 1 000 (the small margin added to
  `ROBOTS_FETCH_LIMITS.timeoutMs` for the redirect hook's robots lookup; Decision 6),
  `CRAWL_KEEP_HEADERS`, `CRAWL_SCOPES` (`host`, `site`, `path`; a
  private start allows `host` only, narrowed to its exact origin: scheme, host and port),
  `CRAWL_TRACKING_PARAMS`, `CRAWL_USER_AGENT_TOKEN = 'frost-crawl/1'`, `CRAWL_ROBOTS_TOKEN =
  'frost-crawl'` (the product token `productToken` reads from the user agent token, and the only
  string robots matching is ever given — never the sent user agent header; Decision 6),
  `CRAWL_SCORE_LABEL` ("Served-HTML score"), `CRAWL_RUN_STATES` (`queued`, `running`,
  `paused`, `done`, `cancelled`, `failed`), `CRAWL_PAGE_OUTCOMES` (including the redirect
  refusals `blocked-by-robots`, `out-of-scope`, `private-redirect` and `robots-timeout`), and
  `CRAWL_RULE_IDS`, a typed
  `readonly SeoRuleId[]` of real catalogue ids:
  - title: `title-missing`, `title-empty`, `title-multiple`, `title-too-short`;
  - meta description: `meta-description-missing`, `meta-description-too-short`,
    `meta-description-multiple`;
  - headings: `h1-missing`, `h1-multiple`, `h1-empty`, `heading-level-skipped`;
  - canonical: `canonical-missing`, `canonical-multiple`, `canonical-relative`, `canonical-off-host`,
    `canonical-og-url-mismatch`, `canonical-has-query`;
  - indexing: `robots-noindex`, `robots-noindex-other-bot`, `robots-nofollow`;
  - indexability (from the crawl's context): `http-status-redirect`, `http-status-client-error`,
    `http-status-server-error`, `http-redirect-chain`, `x-robots-noindex`,
    `x-robots-noindex-other-bot`, `x-robots-nofollow`, `robots-txt-blocks-googlebot`,
    `robots-txt-blocks-all`, `robots-txt-unreachable`, `robots-txt-no-sitemap`,
    `canonical-elsewhere`, `canonical-header-conflict`;
  - hreflang: `hreflang-invalid-code`, `hreflang-missing-self`, `hreflang-no-x-default`,
    `hreflang-duplicate`, `hreflang-relative-url`;
  - other: `lang-missing`, `viewport-missing`, `content-thin`, `images-missing-alt`,
    `image-alt-too-long`, `links-empty-anchor`, `links-javascript-href`, `links-nofollow`,
    `url-too-long`, `url-uppercase`, `url-underscores`;
  - JSON-LD only: `schema-json-invalid`, `schema-over-limit`, `schema-context-missing`,
    `schema-context-not-schema-org`, `schema-type-missing`, `schema-type-unknown`,
    `schema-required-missing`, `schema-recommended-missing`, `schema-url-not-absolute`,
    `schema-date-invalid`, `schema-breadcrumb-positions`, `schema-price-invalid`.
  Excluded, with the reason in the spec: `schema-none` and `schema-entity-conflict` (served HTML
  carries no microdata or RDFa), the social, image-layout (`images-missing-dimensions`,
  `images-oversized`, `images-lazy-in-first-viewport`), performance, security, accessibility and
  javascript rules (no layout, no rendering). K-B2 may remove more.
  `specs/site-crawl.schema.ts`: `CrawlSettingsSchema` (start URL, scope, include/exclude prefixes ≤
  20 each, max pages, interval, sitemap seeding on/off), `CrawlPageRowSchema`, `CrawlRunViewSchema`.
  `specs/site-crawl.feature.md`. In `specs/fetcher.spec.ts`: a "crawl lane" paragraph and
  `CRAWL_FETCHER_LIMITS` (`perOriginConcurrency: 1`, `perOriginIntervalMs: 500` — the floor;
  `maxQueuedPerOrigin: 4`), and the optional redirect-policy hook `BoundedFetchRequest.allowRedirect`
  with its outcome `redirect-refused` (Decision 6), its doc comment stating that the hook decides
  scope and the private-address / exact-origin rule before any request to the new origin (the
  fetcher's own DNS resolution excepted), and that time the hook spends is not the page fetch's own
  timeout (a hook past its time refuses the hop).
- [ ] Migrations `0240_site_crawl`, `0241_site_crawl_guards` in
  `packages/db/src/site-crawl/{schema,migrations,repository}.ts`: `crawl_runs` (id, project_id
  nullable, start_url, settings JSON, state, counts, created/updated), `crawl_pages` (run_id, url,
  depth, outcome, status, final_url, content_type, title, canonical, indexable, robots verdicts,
  word_count, link_total, links_cut, score, findings JSON of rule ids + severities, inlinks,
  outlinks, bytes, fetched_at), `crawl_links` (run_id, from_page, to_url, internal, nofollow; capped
  per page), `crawl_frontier` (run_id, url, depth, state). Deleting a run removes its rows (trigger).
- [ ] **Red:** `site-crawl-migrations-create-schema`; `crawl-repository-round-trips`;
  `crawl-delete-run-purges-rows`; `crawl-settings-schema-bounds` (no regex fields, prefixes only,
  caps; a private start with `site` or `path` scope refused); `crawl-rule-ids-are-catalog-ids`
  (every id is in `SEO_RULE_SPECS`; none is in an excluded category);
  `crawl-lane-floor-is-the-minimum-interval` (`CRAWL_FETCHER_LIMITS.perOriginIntervalMs ===
  CRAWL_INTERVAL_MS.min`); `crawl-robots-token-is-the-user-agent-token`
  (`productToken(CRAWL_USER_AGENT_TOKEN) === CRAWL_ROBOTS_TOKEN`, both `frost-crawl`).
- [ ] **Green:** the schema, migrations, repository and the lane constant (no crawler yet).
- **Risks:** row volume (10 000 pages × links) — links capped per page; indexes on `(run_id, url)`.

### Task 6a — Crawl fetching: lane, politeness and robots · security review
**Purpose:** every request the crawler makes is polite, in scope and allowed by robots.txt.
- [ ] **Spec first:** `site-crawl.feature.md` scenarios for scope, robots, `Crawl-delay`,
  politeness, back-off, `Retry-After`, private starts; L6 recorded there.
- [ ] **Red** (`apps/desktop/src/main/crawl/__tests__/`, `packages/seo-core/src/crawl/__tests__/`):
  `crawl-is-polite` (fake clock: never 2 fetch calls in flight per origin; consecutive fetch-call
  starts ≥ the effective interval for every choice from 500 to 4 000 ms — K-B1; a redirecting
  fixture page's hops, one fetch call bounded by `maxRedirects`, are not spaced by the interval, and
  the next call still waits the full interval after that call started); `crawl-delay-parsed` (`crawlDelayFor`:
  the `frost-crawl` group, else `*`; seconds and decimals; absent, negative, non-numeric → none; capped at
  `MAX_CRAWL_DELAY_MS`); `crawl-honours-crawl-delay-and-retry-after` (the effective interval rises
  to `Crawl-delay`; a 429 or 503 with `Retry-After` in seconds or as a date waits it, capped);
  `crawl-backs-off-and-pauses` (429/503 doubling, 5 in a row pauses); `crawl-honours-robots`
  (disallowed URLs recorded `blocked-by-robots`, never fetched; the `frost-crawl` group, then `*`; a
  fixture with `User-agent: frost-crawl` / `Disallow: /` blocks every URL although `*` allows them);
  `crawl-robots-matches-the-bare-token` (requests carry the full header as sent — the browse UA with
  ` frost-crawl/1` appended — and robots `User-agent: frost-crawl` / `Disallow: /`: the crawl is
  refused; a `User-agent: mozilla` group is **not** applied to the crawl; robots matching and
  `crawlDelayFor` receive `CRAWL_ROBOTS_TOKEN`, never the header);
  `crawl-scope-host-site-path`; `crawl-strips-tracking-params`; `crawl-caps-query-variants`;
  `crawl-private-start-is-origin-only` (every request's `page` is the start URL; a link to another
  private host is out of scope, never requested; a start on `127.0.0.1:3000` never requests
  `127.0.0.1:9229`); `crawl-redirects-pass-the-crawl-policy` (a page redirecting to a same-host path
  robots.txt disallows, to an out-of-scope public host, and to another private host: each hop is
  refused before it is requested, `redirect-refused`, and the page recorded with the refusal; a
  `127.0.0.1:3000` page redirecting to `127.0.0.1:9229` is refused with **no request to `:9229` at
  all**, not even `/robots.txt` — scope and the address rule are decided before any robots lookup);
  `crawl-robots-fetch-is-origin-only` (a private start's `127.0.0.1:3000/robots.txt` redirecting to
  `127.0.0.1:9229` is not followed: no request reaches `:9229`, and a robots answer cached for
  another caller that followed such a redirect is not reused by the crawl);
  `crawl-redirect-robots-timeout-refuses-the-hop` (a redirect target whose robots answer is
  `timeout`, and one whose lookup is still unanswered at `ROBOTS_FETCH_LIMITS.timeoutMs` +
  `CRAWL_ROBOTS_HOOK_MARGIN_MS`: the hop is refused `redirect-refused`, the page recorded
  `robots-timeout`, never a page fetch `timeout`; a target whose robots answer is another unknown
  outcome — `server-error`, `unreachable`, `bad-redirect` or `no-location`, each its own case —
  follows the start-origin rule: the hop is followed and the page carries the
  `robots-txt-unreachable` finding);
  `crawl-keeps-the-headers-it-needs`
  (`CRAWL_KEEP_HEADERS`, `x-robots-tag` kept apart); `crawl-user-agent-identifies`.
- [ ] **Green:** `packages/seo-core/src/crawl/crawl-delay.ts`;
  `apps/desktop/src/main/crawl/{scope,politeness,fetch}.ts`: the crawl lane via
  `createBoundedFetcher({ hop, resolve, limits: CRAWL_FETCHER_LIMITS })` over main's hop and resolver
  (`main/index.ts` one line), robots through main's robots fetcher (`robots.get`), the robots text
  parsed (groups and `Crawl-delay`) by the crawl worker, always matched with `CRAWL_ROBOTS_TOKEN`
  (the header with ` frost-crawl/1` is only sent); `fetch.ts` passes `allowRedirect` with every page
  request, deciding scope and the private-address / exact-origin rule first with no request to the
  new origin (the fetcher's own DNS resolution excepted) and only then robots for the new URL, its
  robots lookup bounded by `ROBOTS_FETCH_LIMITS.timeoutMs` + `CRAWL_ROBOTS_HOOK_MARGIN_MS` (a
  `timeout` answer or none by then: refused, `robots-timeout`; other unknown answers: the
  start-origin rule);
  `apps/desktop/src/main/seo/fetcher.ts` consults the hook in its redirect branch (~:310) before the
  hop is followed, outside the page fetch's own timeout; for a private start, the crawl's
  `robots.get` lookups pass the exact-origin rule down, and `robots-fetch.ts` (~:93) forwards it to
  the bounded fetcher as `allowRedirect`, maps its `redirect-refused` to `private-redirect`, and
  caches those lookups apart.
- **Acceptance:** all scenarios pass on loopback fake sites with a fake clock.
- **Risks:** `Crawl-delay` semantics vary by crawler (Q13); a site whose robots.txt is unreachable is
  crawled with the default interval and the `robots-txt-unreachable` finding, as the sidebar treats it
  (the start-origin rule). A redirect target follows the same rule for every unknown robots
  outcome except `timeout`, which refuses the hop (`robots-timeout`, Decision 6): one rule, one
  exception.

### Task 6b — Crawl runs: frontier, resume and the served-HTML audit
**Purpose:** a bounded, resumable crawl that audits each page as the sidebar would, minus rendering.
- [ ] **Spec first:** `site-crawl.feature.md` scenarios for the frontier, max pages and depth,
  pause/resume/quit/crash, sitemap seeding, the snapshot adapter and the audit.
- [ ] **Red:** `crawl-respects-max-pages-and-depth`; `crawl-html-only` (other types recorded, not
  parsed); `crawl-resumes-from-frontier` (quit mid-run → `paused`; Resume continues without
  refetching); `crawl-never-resumes-on-start`; `crawl-running-at-start-becomes-paused` (a crash
  leaves `running`; start-up normalises it); `crawl-sitemap-seeds` (via the sitemap parser,
  `SITEMAP_LIMITS`); `crawl-links-cut-recorded` (a page with more than 1 000 links: `linkTotal` kept,
  `links_cut` set); `served-to-page-snapshot-maps-fields` (below; the result parses with
  `PageSnapshotSchema`, which requires `imageTotal`, `specs/seo-snapshot.spec.ts:295-316`);
  `project-delete-removes-its-crawls` (a project whose only data is a crawl, one run `running`:
  deleted locally — the running crawl is cancelled and awaited and its runs and pages are gone; with
  the deletion interrupted, start-up recovery finds the project and deletes them);
  `synced-tombstone-deletes-crawls-at-pull` (no restart, no capture run: a project tombstone arrives
  by sync pull while the project has, in turn, a running crawl, a paused crawl, a completed crawl,
  and a crawl on its final fetch when the tombstone arrives — each leaves no crawl rows once the
  sync pull completes);
  `crawl-parse-carries-no-extra-text` (the crawl job's parse has `skipExtraText: true`: crawl
  results carry neither `sourceText` nor `leadText`); `crawl-context-from-the-fetch`
  (below); `crawl-audit-matches-sidebar-on-static-pages` (K-B2); `crawl-in-memory-state-bounded`
  (K-B3: counts, not heap); `crawl-worker-is-separate` (a crawl never delays a sidebar audit job).
- [ ] **The adapter** (`packages/seo-core/src/crawl/served-to-page.ts`, pure):
  `servedToPageSnapshot(served, fetched)` fills `PageSnapshot` from `ServedSnapshot`:
  copied — `url`, `lang`, `titles`/`titleTotal`, `metaDescriptions`/`metaDescriptionTotal`,
  `metaRobots`, `canonicals`/`canonicalTotal`, `ogUrl`, `viewport`, `headings`/`headingTotal`
  (no visibility check: hidden headings count, as a crawler sees them), `links`/`linkTotal`,
  `imageTotal`,
  `jsonLd`/`jsonLdTotal`, `hreflang`/`hreflangTotal`, `wordCount`, `textTruncated`, `partial`;
  mapped — `images` (each `{ src, alt }` with `width`/`height`/`loading`/`rendered`/`natural` `null`,
  `inFirstViewport` and `cssSized` `false`; the rules reading those are excluded); defaulted —
  `extractedAt` (fetch time), `durationMs` (fetch duration), `social` (every tag `null`; social rules
  excluded), `security` (an empty, neutral value; security rules excluded), `microdata`/`rdfa` `[]`
  with totals 0; omitted (optional) — `hiddenHeadings`, `blockingScripts`, `visibleText`.
- [ ] **The context** (`packages/seo-core/src/crawl/crawl-context.ts`, pure): `PageContext` with
  `response` = `ResponseMeta` built from the bounded fetch result (`url` = final URL, `source:
  'network'`, `status`, `headersAvailable: true`, the kept headers that are in
  `RESPONSE_HEADER_ALLOWLIST` — `x-robots-tag`, `link`, `content-type` — and `redirects` from the
  fetch `chain` with `internal: false`), `robots` = the origin's `RobotsFetch` from main's robots
  fetcher; no `accessibility`, no `checks`, `served: null`, `performance: null`.
- [ ] **Green:** `apps/desktop/src/main/crawl/{frontier,crawler,service}.ts`; job kind `crawl` in
  `analysis-worker.ts` (`parseServedHtml` with `skipExtraText: true` — `served-parse.ts` skips
  `sourceText` and `leadText` when it is set — + adapter + context + `runAudit(snapshot, CRAWL_RULES)`,
  `CRAWL_RULES` in `packages/seo-core/src/crawl/crawl-rules.ts` from `RULES` and `CRAWL_RULE_IDS`),
  run on a worker instance of its own; rows written per page; one crawl at a time app-wide. Project
  deletion (Decision 6): the crawl service's `deleteProjectCrawls(projectId)` cancels the project's
  active crawl and awaits its end, then deletes its runs (paused and completed ones too);
  `apps/desktop/src/main/changes/projects.ts` calls it from a project's delete and from
  `purgeDeleted` (start-up and before each capture run, as today); `apps/desktop/src/main/sync/service.ts`
  calls the same cleanup after every pull that applied project tombstones, for each tombstoned
  project with crawl runs (at the pass's completion path, ~:133), before the pass completes;
  backstops: `deletedProjectsWithRows` also lists a tombstoned project with `crawl_runs`, and the
  crawler checks its project is not tombstoned before each fetch call (a synced tombstone cancels
  the run).
- **Acceptance:** all scenarios pass on loopback fake sites; the crawler never parses on main's thread;
  a synced project tombstone leaves no crawl rows once the sync pull completes (no restart, no
  capture run).
- **Risks:** client-rendered sites look thin (flagged, Decision 6); infinite URL spaces (calendars)
  — caps and the per-path query-variant limit bound them; a crawl cancelled but not awaited could
  write a page row after its runs were deleted, so the cleanup awaits the crawl's end before deleting.

### Task 7 — Pages and Site structure (IPC + UI)
**Purpose:** SL-096/097: browse a crawl's pages and the site's shape; export it.
- [ ] **Spec first:** `site-crawl.feature.md` UI scenarios; `CRAWL_PAGE_FILTERS`,
  `CRAWL_PAGE_SORTS`, `CRAWL_CSV_COLUMNS` (the score column headed `CRAWL_SCORE_LABEL`) in
  `site-crawl.spec.ts`; the sheet's rule-set note (Decision 6).
- [ ] **Red:** `crawl-router-enforces-sender`; `crawl-pages-query-paged-and-filtered` (status,
  indexable, finding, depth, links cut; ≤ 200 rows a page); `crawl-structure-tree` (path tree with
  counts, click-depth histogram, orphans = sitemap URLs never linked); `crawl-csv-written-by-main`
  (save dialog in main, cells via `csvCell` from `@app/seo-core`, which neutralises formula-leading
  cells); renderer `crawl-view.test.ts` (start form disclosure `FETCH_DISCLOSURE`, progress
  long-poll, pause/resume/cancel, run size and "deleted per run" note, "Open in tab" uses the
  address bar's path, the score column labelled `CRAWL_SCORE_LABEL` and the sheet naming the crawl
  rule set, never "health score").
- [ ] **Green:** `packages/ipc-contract/src/crawl-{router,service}.ts` (`start`, `pause`, `resume`,
  `cancel`, `delete`, `watch` long-poll like `browser.watch`, `pages`, `structure`, `exportCsv`);
  renderer `components/crawl/{CrawlSheet,SitePages,SiteStructure}.tsx`, `crawl-view.ts`,
  `crawl-palette.ts` ("Crawl this site…", "Show site crawl"); a "Site" entry in Phase 10's project
  sheet (one line) and the palette for the active tab's site.
- **Acceptance:** a user crawls a site from its tab, watches progress, filters to non-indexable
  pages, sees the structure tree and exports a CSV.
- **Risks:** large tables in the renderer — paged queries only, no client-side full list.

### Task 8 — `run_ai_search` via provider APIs · security review
**Purpose:** SL-084/046 on the user's key: the agent asks an AI engine and reads its citations.
- [ ] **Spec first:** `specs/ai-search.spec.ts`: `AI_SEARCH_ENGINES`, `AI_SEARCH_VIAS`
  (`api` in this phase; `tab` belongs to the deferred proposal D1), `AI_SEARCH_API_PROVIDER` (`perplexity` → `perplexity`, `chatgpt` →
  `openai-search`), the fixed request bodies' shapes (model allowlist per provider, e.g. Perplexity
  `sonar`; OpenAI a small allowlist; `store: false`), `AI_SEARCH_LIMITS` (`maxCallsPerTurn` 2,
  `perEngineCooldownMs` 20 000), `AI_SEARCH_UNAVAILABLE_REASONS` (incl. `none-set-up`,
  `setting-changed`), the `app_settings` keys `AI_SEARCH_VIA_KEY(engine)` and
  `AI_SEARCH_DEFAULT_ENGINE_KEY`, and `resolveAiSearch(input, settings)` (pure: the engine and via
  rule of Decision 8). `specs/ai-search.schema.ts`: provider response schemas (only the answer text
  and citation fields), `AiAnswerSchema`.
  `specs/agent-search-tools.spec.ts`: `completeToolInput(toolName, input, tabUrl, context?)` — the
  new optional `context` carries the AI search settings; for `run_ai_search` it returns the input
  with `engine` and `via` filled by `resolveAiSearch` (no usable engine: the input unchanged and the
  call answered `none-set-up` as data before any card); `.feature.md` scenarios.
  `specs/agent-session.spec.ts`: `runAiSearchApprovalNote(engine, via)` (frost's own words: which
  engine, that it goes through the user's own API key and spends their credit, that the query is
  sent as shown; `via` is always `api` in this phase, signed-in tabs being deferred proposal D1),
  and the `note` field's doc comment updated.
  `packages/ai-skills`: `AiSearchQuery.engine?` and `via?` (what the port receives from the
  approved input), `AiSearchAnswer.engine` / `via` / `note`, the
  model-facing input's optional `engine` (enum), `runAiSearchApprovedInputSchema` (`engine` and `via`
  required), fakes updated.
- [ ] **Red:** `run-ai-search-asks-every-call` (no grant can cover it; the existing
  `run-ai-search-needs-approval` still passes); `run-ai-search-approval-shows-query-engine-and-via`
  (the card's input and hash include the completed `engine` and `via`; the note is
  `runAiSearchApprovalNote`); `run-ai-search-runs-what-was-approved` (the via setting changed after
  approval: `expired`, nothing sent); `run-ai-search-default-engine` (no `engine`: the default
  setting, else the first usable); `run-ai-search-none-set-up-never-asks`;
  `run-ai-search-model-cannot-choose-via` (a `via` in the model's input is refused by the
  model-facing schema; and `completeToolInput` given an input that carries a `via` drops it and sets
  `via` from the setting, so the input reparsed with `runAiSearchApprovedInputSchema`, the one hashed,
  shown and run, always holds the setting's via);
  `run-ai-search-approved-input-reaches-the-port` (the full broker → runner → port path: an
  approved call goes through `approvals.ts`, the tool runner and `search-tools.ts`, and the fake
  port's `aiSearch` receives the approved `engine` and `via`; the runner never answers
  `invalid-input` for the approved input, which carries `via`);
  `run-ai-search-capped-per-turn-and-engine`; `ai-api-request-body-built-by-main` (only the query and
  the allowlisted model vary); `ai-api-parse-is-bounded`; `ai-api-maps-citations` (Perplexity's
  source list, OpenAI's URL citations → `{ url, title }`, http(s) only, deduplicated, ≤
  `maxCitations`); `ai-search-unavailable-explained` (engine off, `google-ai-mode` without the tab
  path); `ai-search-result-is-untrusted` (wrapped, source `search:ai-answer`).
- [ ] **Green:** `apps/desktop/src/main/ai-search/{api,service}.ts`;
  `apps/desktop/src/main/agent/ports/ai-search-adapter.ts` (the `aiSearch` member, given the
  approved engine and via); `serp-adapter.ts` keeps `results` and delegates `aiSearch` to the new
  adapter when given, else today's reason; `completeToolInput` drops any model-supplied `via` and
  sets it from the setting; `approvals.ts` passes the settings context to `completeToolInput` and
  reparses `run_ai_search` with `runAiSearchApprovedInputSchema`;
  `apps/desktop/src/main/agent/tools/runner.ts` (:316 today re-parses every input with
  `definition.inputSchema`) re-parses `run_ai_search` with `runAiSearchApprovedInputSchema`, not the
  model-facing strict schema, and `search-tools.ts` (:253-254) forwards `engine` and `via` to
  `port.aiSearch`;
  `session.ts`'s note selector (today `execute_javascript` → `EXECUTE_JS_APPROVAL_NOTE`,
  `run_visibility_probes` → `RUN_PROBES_APPROVAL_NOTE`) gains `run_ai_search` →
  `runAiSearchApprovalNote(input.engine, input.via)`; wiring in `agent/service.ts` / `ports/index.ts`.
- **Acceptance:** a scripted turn calls `run_ai_search` without an engine; the card shows the
  default engine, its via and the query; an approval returns the fake provider's answer and citations
  wrapped as untrusted, from the engine and via that were approved.
- **Risks:** API answers differ from the consumer apps (labelled); provider model names change (Q4).

### Task 9 — AI answers view and storage
**Purpose:** keep and compare answers; run a query without the agent.
- [ ] **Spec first:** migration `0242_ai_answers` (`packages/db/src/ai-answers-{schema,migrations}.ts`,
  `ai-answers.ts`: query, engine, via, provider, answer text ≤ `maxAnswerChars`, citations JSON ≤
  20, cited domains, chat id nullable, created_at); `AI_ANSWER_RETENTION_KEY` and values in
  `ai-search.spec.ts`; `specs/ai-search.feature.md` (view scenarios).
- [ ] **Red:** `ai-answers-stored-from-agent-and-view`; `ai-answers-retention-purges`;
  `ai-answers-router-enforces-sender`; `ai-answers-view-runs-without-approval-card` (a user action;
  the cost note shown first); renderer `ai-answers-view.test.ts` (text inert, links not clickable
  until "Open in tab", cited domains grouped, the watched domain highlighted via
  `registrableDomain`); `phase-9-score-does-not-read-ai-answers` (an import-graph test: nothing under
  Phase 9's modules imports `ai-answers*` or `main/ai-search/**`).
- [ ] **Green:** `packages/ipc-contract/src/ai-answers-{router,service}.ts` (`list`, `get`, `run`,
  `delete`, `deleteAll`, `setRetention`); renderer `components/ai-answers/{AiAnswers,AiAnswer}.tsx`,
  `ai-answers-view.ts`, `ai-answers-palette.ts` ("Ask AI engines…", "Show AI answers"); entry in
  `App.tsx` (one line).
- **Acceptance:** an answer from the agent and one from the view both appear, with sources and
  domains; Delete all empties the table.
- **Risks:** retention vs chats (an answer inside a chat record follows chat retention; the table
  follows its own setting — the view says so).

### Task 10a — The browse-class registry (refactor only) · security review
**Purpose:** make "is this a tab's session?" one question with one answer, and install every
per-session wiring through it, **with no behaviour change** (still exactly one browse-class session).
- [ ] **Spec first:** `specs/browser.spec.ts`: `BROWSE_CLASS_PARTITIONS` doc (the browse partition,
  plus whatever Task 10b registers), `BROWSE_PARTITION` unchanged; `specs/browser-chrome.feature.md`
  (classification) and `window-hardening.feature.md` scenarios restated against the registry.
- [ ] **Every consumer today** (each moves to `apps/desktop/src/main/browser/browse-class.ts`:
  `isBrowseClassSession(session)`, `browseClassSessions()`, `onBrowseClassSession(installer)`):
  - `security/register.ts` `isBrowseContents` (guard classification);
  - `main/index.ts` (its own "Whether `contents` is a tab's" check, and lines ~378–409: the
    browse-session wiring — `observeMainFrames(…, responses)`, `observeRequests(…, devtools.observer)`,
    `hardenBrowseSession` with the permission handlers and the download notice — becomes one
    installer registered with `onBrowseClassSession`; the bounded fetchers' `netHop` and
    `netResolver` stay on `BROWSE_PARTITION` only, Decision 11);
  - `browser/render-profile-debugger.ts` (its own `isBrowseContents`; throws for non-browse tabs);
  - `browser/guard.ts` (`hardenBrowseSession`), `browser/web-request.ts` (one listener per event per
    session), `browser/permissions.ts`, `browser/tab-permissions.ts`;
  - `devtools/site-data.ts`, `devtools/storage.ts` (the tab's session from its `WebContents`, not
    `fromPartition(BROWSE_PARTITION)`);
  - `window.ts` `createTabView` (partition from the caller, default `BROWSE_PARTITION`; hardened
    `webPreferences` still literals);
  - `clear-browsing-data.ts` (`clearBrowseStorage` over every browse-class session);
  - Phase 11's `browser/cookie-block.ts`: its blocking `onBeforeSendHeaders` / `onHeadersReceived`
    pair is registered on the session of each browse-class tab that has cookies off (the tab's
    `contents.session`, never `fromPartition(BROWSE_PARTITION)`), while at least one tab of that
    session has it off, and removed per session (one blocking listener per event per session; no
    other module installs one on a browse-class session).
- [ ] **Red:** `browse-class-registry-is-the-only-test` (a Semgrep or source test: no file under
  `apps/desktop/src/main/` outside `browse-class.ts` and the fetcher setup compares a session to
  `fromPartition(BROWSE_PARTITION)`); `every-browse-installer-runs-per-session` (registering a second
  session in a test runs each installer once on it: main-frame observers, request observers, guard
  and permission handlers, downloads); `render-profile-debugger-accepts-browse-class`;
  `devtools-storage-uses-the-tabs-session`; `cookie-block-per-browse-class-session` (a second
  session registered in a test gets its own pair when a tab of it turns cookies off, and loses it
  when the last such tab does; the browse session's pair is unaffected); every existing browser, security, devtools and
  render-profile test unchanged and green.
- [ ] **Green:** the registry and the moves above. No proxy, no new partition.
- **Acceptance:** with only `BROWSE_PARTITION` registered, behaviour is identical (full unit and
  e2e suites green; Electronegativity and Semgrep green).
- **Risks:** a consumer reached through a path the source test does not see (dynamic session
  lookups) — the reviewer walks every `session.fromPartition` and `.session` use in `main/`.

### Task 10b — Location profiles, proxy partitions and their UI · security review
**Purpose:** see results "from" another location through the user's own proxy, recorded on readings.
- [ ] **Spec first:** `specs/location-profiles.spec.ts`: `LOCATION_PARTITION_PREFIX =
  'frost-location-'`, `LOCATION_PROXY_SCHEMES`, `LOCATION_LIMITS` (≤ 20 profiles, label ≤ 64, host
  ≤ 253, port 1–65535), `LOCATION_CREDENTIALS_FILE = 'location-credentials.json'`,
  `LOCATION_WEBRTC_POLICY = 'disable_non_proxied_udp'` (applied per tab's WebContents at creation,
  Decision 11), the badge and README strings. `specs/changes.spec.ts` `CAPTURE_REFUSALS` and
  `specs/screenshot.spec.ts` `SCREENSHOT_REFUSALS` += `location-tab`, with their message
  (Decision 11). `specs/sync.spec.ts` / `sync-engine.feature.md`: rows whose
  `search_params` carry `location` are not pushed (Decision 7).
  `specs/location-profiles.schema.ts` (`LocationProfileSchema`, no secrets;
  `LocationProfileInputSchema` with write-only username/password). `specs/browser.spec.ts`: the tab
  state's optional `location: { profileId, label } | null`. `specs/location-profiles.feature.md`,
  including **the leak-test design** (Task 11): the fake site uses a public-looking name; the
  location partition keeps Chromium's implicit loopback bypass, which matches loopback literals and
  `localhost` names only, so that name is proxied; behind a proxy the proxy resolves names, so
  `fake-proxy.ts` maps the name to the real origin itself and adds a marker header
  (`x-frost-e2e-via: proxy`); `--host-resolver-rules` maps the same name to a **tripwire** listener
  that records any direct connection. Pass = tripwire count 0 and every origin request carries the
  marker. Migration `0244_location_profiles`.
- [ ] **Red:** `location-session-is-browse-class` (registered at first use; app partitions stay
  app-class); `location-session-has-browse-wiring` (each Task 10a installer ran on it);
  `location-partition-is-in-memory`; `proxy-login-only-for-its-proxy` (wrong host/port, a site's 401,
  another partition: cancelled); `no-login-listener-cancels` (today's behaviour pinned before the
  listener is added); `location-credentials-never-leave-main`; `location-tab-webrtc-proxied-only` (per tab: every
  WebContents created in a location partition, the first tab, a second tab of the same profile and a
  tab the page opens, has `LOCATION_WEBRTC_POLICY` set before its first navigation; a home tab keeps
  the default); `cookie-block-on-a-location-tab` (cookies off on a location tab strips `Cookie` and
  `Set-Cookie` on that profile's session, as on the browse session);
  `location-rows-stay-device-local` (`sync/__tests__/engine.test.ts`: a `ci_versions`,
  `ci_captures`, `ci_screenshots` or `ci_project_queries` row whose `search_params` carry `location`,
  or a `ci_diffs` row to such a version, is never pushed; the same rows without it are);
  `clear-browsing-data-covers-location-partitions`; `location-tab-not-in-history-or-session`
  (`history-service.ts`, `session-sync.ts` / `session-store.ts` skip it; Reopen Closed Tab works only
  within the run); `serp-params-carry-the-tabs-location` (`serp/service.ts` sets
  `location: { via: 'proxy', label }`; the capture lane and Phase 10's search key differ from the
  home connection's); `location-tab-captures-only-result-pages` (`changes/__tests__/service.test.ts`
  and `screenshots/__tests__/service.test.ts`: on a location tab, a result page whose
  `SearchParams` carry `location` is captured and screenshotted; an **ordinary-article fixture** in
  the same tab is refused `location-tab` for both, nothing stored; a home tab is unaffected);
  `location-badge-always-visible` (renderer).
- [ ] **Green:** `apps/desktop/src/main/location/{profiles,partitions,proxy-auth,secrets}.ts`;
  `browser/tab-model.ts` / `controller.ts` (a tab's location, set at creation only, in
  `BrowserState`; the controller, or `window.ts` `createTabView` given a location partition, calls
  `contents.setWebRTCIPHandlingPolicy(LOCATION_WEBRTC_POLICY)` on each location tab's WebContents at
  creation, before its first navigation); `sync/engine.ts` (push skips rows whose `search_params`
  carry `location`, Decision 7); `serp/setup.ts` passes `locationOf(tabId)` beside the device lookup and
  `serp/service.ts` adds it to the params after `matchSerp`; `changes/service.ts` and
  `screenshots/service.ts` refuse `location-tab` (their tabs dependency learns whether a tab is a
  location tab from `BrowserState`); IPC `location-{router,service}.ts`
  (profiles CRUD with write-only secrets, `newTab({ profileId })`); renderer `settings-locations.tsx`,
  `location-view.ts`, `location-palette.ts` ("New tab in location…"), the tab badge;
  `README.md` / `apps/desktop/README.md` "Locations": what is and is not proxied, the loopback
  bypass, no history (Decision 11).
- **Acceptance:** with the fake proxy, a location tab's page loads only through it (the leak test);
  the SERP panel and result-page captures show the location; other pages in a location tab are
  refused for Capture and screenshots; Electronegativity and Semgrep stay green.
- **Risks:** HTTPS proxies and WebRTC coverage (Q6, Q7).

### Task 11 — End to end
**Purpose:** prove each shipped surface in the real app against loopback fakes.
- [ ] **Spec first:** `specs/data-sources.feature.md`, `site-crawl.feature.md`,
  `ai-search.feature.md`, `location-profiles.feature.md`: an "End to end" section each.
- [ ] **Tests** (`apps/desktop/e2e/`, Playwright Electron harness, `--host-resolver-rules` +
  `--frost-e2e-public-hosts` for public-looking names, no real third-party network):
  - `data-sources.e2e.ts`: set a SerpApi key → Settings shows "set", never the key; "Check searches
    via SerpApi" on a project against `fake-data-api.ts` → Phase 10's table shows the readings in the
    searches' series, marked SerpApi; usage counter is 1 per search.
  - `crawl.e2e.ts`: crawl a 50-page site from `crawl-fixtures.ts` (robots disallowing one path, a
    `Crawl-delay`, a redirect, a 404, a noindex page) → Pages and Structure show them; pause, restart
    the app, resume; export CSV; the fake site's log shows ≤ 1 fetch call in flight and the
    effective spacing between fetch calls (a redirect's hops counted as one call, K-B1).
  - `ai-answers.e2e.ts`: scripted agent (`frost-e2e-agent-script`) calls `run_ai_search` → the card
    shows engine/via/query → approve → the answer appears in chat (untrusted) and in the AI answers
    view; the view runs one query itself.
  - `location.e2e.ts`: the leak test as specified in `location-profiles.feature.md` (public-looking
    name, `fake-proxy.ts` with auth mapping the name and adding the marker, a tripwire for direct
    connections) — K-D; the badge shows; a result-page capture records the location, and Capture
    on an ordinary article in the same tab is refused.
- **Acceptance:** the suite passes on macOS, Linux and Windows CI with no outbound network.

---

## Open questions (verify before or during the named task)
| # | Question | Task | How to resolve |
|---|---|---|---|
| Q1 | Exact current endpoints, auth and response fields: SerpApi `GET https://serpapi.com/search.json` (`api_key` query), DataForSEO `POST https://api.dataforseo.com/v3/serp/google/organic/live/advanced` (Basic auth), Serper `POST https://google.serper.dev/search` (`X-API-KEY`). Named from general knowledge, unverified (gap analysis §6). | 1, 3 | Read each vendor's API reference; write the fixtures from it; record the doc URL and date in `serp-api.spec.ts`. Read each vendor's terms on keeping results with it (L4): a vendor whose terms set an expiry is excluded from v1 and from `SERP_API_PROVIDERS`. |
| Q2 | Does any vendor offer a free account/credit-status call usable as "Test key"? | 2 | Vendor docs; add only a free, documented endpoint to the allowlist. |
| Q3 | Bright Data's SERP API: proxy-style (`brd.superproxy.io`) or an HTTPS API usable through `DATA_API_REQUESTS`? | later | Vendor docs; if proxy-only, plan it with Decision 11's rules. |
| Q4 | Perplexity API (`POST https://api.perplexity.ai/chat/completions`, model names, the citations / search-results fields) and OpenAI Responses `web_search` tool (tool type name, `url_citation` annotations, which models support it, price). Unverified. | 8 | Provider docs; pin the model allowlist; record doc URL and date. |
| Q5 | Rate limits and per-request prices per vendor, for the cost note and `minIntervalMs`. | 1, 2 | Vendor pricing pages; the UI states "billed by <vendor> to your account", never a price frost cannot keep current. |
| Q6 | Electron 45: does `session.setProxy` with `fixed_servers` route WebSocket, WebRTC TURN and DNS-over-HTTPS through the proxy; is `disable_non_proxied_udp` enough for WebRTC; does the implicit loopback bypass match only loopback literals and `localhost` names (so the e2e's public-looking name is proxied), and does `--host-resolver-rules` leave the proxy's name resolution alone? | 10b | Chromium proxy docs plus a spike with `fake-proxy.ts` and the tripwire before writing the e2e; record results in `location-profiles.feature.md`. |
| Q7 | Electron's `login` event for proxy auth on tab requests of a non-default partition: arguments, `isProxy`, and behaviour for HTTPS proxies. | 10b | Electron docs and a unit spike against `fake-proxy.ts`. |
| Q8 | Is there a sanctioned API for Google AI Mode answers (or is Gemini API grounding with Google Search close enough to label honestly)? | 8 | Google developer docs; until then `google-ai-mode` is unavailable (its tab path is the deferred proposal D1). |
| Q10 | Whether Phase 10's project sheet and `Rankings.tsx` expose an extension point or need a one-line addition (the `0223` trigger names are fixed by Phase 10's plan). | 4, 7 | Read the merged Phase 10 code; adjust names, not the contract. |
| Q13 | `Crawl-delay` semantics: seconds vs. other units, decimals, multiple values in a group, whether Google ignores it (it does not change frost's choice to honour it). | 6a | robots.txt references (RFC 9309 does not define it) and common crawler docs; record the parsing rule in `site-crawl.feature.md`. |
| Q14 | Bing Webmaster Tools API for a verified site's backlinks: is there a documented, current API, with which auth (OAuth for a verified site, or an API key), quotas and terms? (Decision 12: deferred until answered.) | later | Microsoft's Bing Webmaster API docs; if usable, plan it as a bring-your-own data source under Decision 4's rules. |

---

## Deferred proposals (out of this phase; no tasks)
Moved out of Phase 12 by the lead's scope cut (council round 1). Neither is built here; each needs
its own plan, with tasks, before any code. Their research and legal notes are kept below so that plan
starts from them. Phase 12 ships A (BYO SERP API), B (crawler), C1 (provider-API AI search) and the
proxy locations (Tasks 10a, 10b).

### D1 — AI answers read from signed-in tabs (was bet C2, Task 11)
Reading an AI engine's answer and citations from a tab the user is signed into, with signed selector
packs. Highest ToS and account-ban risk. Until it is planned, `run_ai_search` is API-only and its
`via` is always `api` (Decision 8).
- **Design notes (was Decision 10).**
  - A second pack kind, **AI answer packs** (`ai-answers.json` + `.sig`), verified by the same
    `verifyPack` steps (size, Ed25519 signature over exact bytes, then parse) against
    `SERP_PACK_PUBLIC_KEYS`. Cross-kind confusion is impossible by schema: the AI pack requires
    `kind: 'ai-answers'`; the strict `SelectorPackSchema` refuses any `kind` key.
  - Updates are **user-initiated only**, as for SERP packs: "Check for AI pack updates" in the
    setting and the palette; nothing is fetched at start-up. Removing an engine in a newer pack
    reaches a user on their next check; the setting shows the pack in use and its publish date.
  - **Publisher:** AI packs are signed with the SERP pack key and published beside the SERP pack
    (`AI_PACK_REMOTE_URL`, the `SERP_PACK_REMOTE_URL` release-asset pattern) **only if the owner
    agrees to maintain them** (Q12). Until a publisher is named and the gate passes for one engine,
    the bundled pack has no engines.
  - The reader would run in a new isolated world `AI_ANSWER_WORLD_ID = 1_302` (reserved; Phase 11
    Decision 17 notes it; it would join `NON_AGENT_WORLD_IDS` in `specs/agent-page-tools.spec.ts`)
    and **only read**: frost navigates the tab to the engine's query URL from the pack (engines that
    take the query in the URL only); it never types, clicks, submits or signs in. Signed out, a
    challenge page or a consent wall answers `unavailable` with a reason ("Sign in to Perplexity in
    a tab first").
  - What the tab sends: an ordinary navigation on the browse partition with the user's cookies for
    that engine (so the engine sees their account) and the approved query in the URL (so it may land
    in the engine's history and logs). The approval card and the setting's risk text say both.
  - Former task outline: `specs/ai-answer-pack.{spec,schema}.ts` (`AI_PACK_FILE`, `AI_PACK_DIR`,
    `AI_PACK_REMOTE_URL`, the unpackaged-only `frost-e2e-ai-pack-key` / `frost-e2e-ai-pack-url`
    switches in `PACKAGED_FORBIDDEN_SWITCHES`, `AI_READ_LIMITS` (poll 500 ms, `doneStableMs` 1 500,
    `timeoutMs` 60 000, text and citation caps), `AiAnswerPackSchema` strict and capped as
    `SelectorPackSchema`); the second kind in `serp-selector-pack.feature.md`; a bundled pack with no
    engines; `ai-search/{pack-store,read-script,tab-runner}.ts`; tests for forged and stale packs,
    kinds never crossing, update by user action only, a read-only and bounded reader, signed-out
    answers, the tab path off by default, and `pnpm sign:selectors --kind ai-answers`.
- **Legal / ToS questions (owner, in writing under `docs/research/`; "unclear" counts as no).**

  | # | Question | Gates | How to resolve |
  |---|---|---|---|
  | L1 | Do OpenAI's consumer Terms of Use allow a user's own browser to read ChatGPT answers shown in their signed-in session, when the navigation is made programmatically on the user's approval? (Recalled from general knowledge, unverified: the terms forbid "automatically or programmatically" extracting output.) | D1, engine `chatgpt` | Read the current Terms of Use and Service Terms at openai.com/policies; if still ambiguous, ask OpenAI support in writing. Default: not allowed. |
  | L2 | Same for Perplexity's consumer terms (automated access, scraping of answers). | D1, engine `perplexity` | Read perplexity.ai's Terms of Service; Perplexity sells an API (Task 8), which is the sanctioned path. Default: not allowed. |
  | L3 | Same for Google AI Mode, given Google's Terms of Service on automated access and `google.com/robots.txt`. Note the precedent: Phase 6 project runs already load Google result pages programmatically in a visible tab. | D1, engine `google-ai-mode` | Owner re-reads the Google ToS and the Phase 6 precedent and decides whether AI Mode is the same case. |

- **Kill criteria.**

  | Id | Bet | Kill / narrow when | Checked |
  |---|---|---|---|
  | K-C2 | C2 | L1–L3 not answered "allowed" for an engine: **that engine is never in a published pack**. After launch: a pack for an engine breaks more than twice in 8 weeks, or a user reports an account warning linked to it: **publish a pack without the engine and say so in the release notes**. Pack updates are user-initiated, so a removal reaches each user on their next "Check for AI pack updates"; the setting shows the pack's publish date so a stale pack is visible. There is no remote kill switch. | Gate; then ongoing |
  | K-C3 | C2 | In owner QA of 20 queries per engine, more than 2 reads are partial (answer still streaming when read): **do not enable the engine**. | D1 review |

- **Open questions.**

  | # | Question | Task | How to resolve |
  |---|---|---|---|
  | Q11 | AI engines' query-URL support (does each accept the query in the URL and start answering without a click?). | D1 | Manual check by the owner after the gate; an engine that needs a click is not supported (D1). |
  | Q12 | **Who publishes AI packs?** Signing and hosting them (same key and release assets as SERP packs) commits the project to tracking three engines' layouts. | D1 | Owner decision in writing; without a named publisher D1 is not planned and `AI_PACK_REMOTE_URL` is not defined. |

### D2 — The `uule` experiment (was Task 10c)
An opt-in, clearly labelled Google location parameter, recorded honestly. Undocumented and may break
silently. Until it is planned, Phase 10's parameter editor gets no city field from this phase, and
nothing writes `location: { via: 'uule', … }` (the value stays reserved in `SearchParamsSchema`,
Decision 7).
- **Design notes (was Decision 11's `uule` bullet).** A setting `serp.uuleExperiment` (off by
  default, labelled "Undocumented Google parameter: may stop working without notice"). When on,
  Phase 10's parameter editor offers a city field. The label lives in **main's tab state**: the
  editor calls `location.navigateWithUule({ tabId, city })`, main builds the URL, records
  `{ encoded, label }` for that tab and navigates. The SERP service sets
  `location: { via: 'uule', label }` only while the tab's committed URL carries exactly that `uule`
  value (the canonical URL drops unknown parameters, so the label cannot come from it); any other
  navigation clears it.
- Former task outline: `UULE_EXPERIMENT_SETTING_KEY`, a pure `uuleFor(name)`, `UULE_LIMITS` (city
  ≤ 128, printable) and the warning string in `location-profiles.spec.ts`; `location/uule.ts`; the
  city field in Phase 10's `SerpEditor.tsx`, shown only with the setting on; tests for off by
  default, the encoding (fixtures from Q9's notes), the label recorded by main, and the label held
  only while the URL carries it.

- **Kill criterion.**

  | Id | Bet | Kill / narrow when | Checked |
  |---|---|---|---|
  | K-E | A′ | The `uule` experiment: in owner spot checks, Google ignores it for 3 of 5 test cities: **remove the experiment** (it is undocumented and may break silently). | after D2 ships |

- **Open question.**

  | # | Question | Task | How to resolve |
  |---|---|---|---|
  | Q9 | `uule` encoding (canonical location names, the length prefix) — undocumented. | D2 | Public write-ups only as data; owner spot checks (K-E); keep behind the experiment flag. |
