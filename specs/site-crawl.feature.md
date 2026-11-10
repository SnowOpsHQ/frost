# Feature: Site crawl

Spec: `specs/site-crawl.spec.ts` (`CRAWL_AVAILABLE`, `CRAWL_LIMITS`, `CRAWL_INTERVAL_MS`,
`MAX_CRAWL_DELAY_MS`, `CRAWL_ROBOTS_HOOK_MARGIN_MS`, `CRAWL_KEEP_HEADERS`, `CRAWL_SEPARATE_HEADERS`,
`CRAWL_SCOPES`, `CRAWL_PRIVATE_START_SCOPES`, `CRAWL_TRACKING_PARAMS`, `CRAWL_USER_AGENT_TOKEN`,
`CRAWL_ROBOTS_TOKEN`, `CRAWL_SCORE_LABEL`, `CRAWL_RUN_STATES`, `CRAWL_RUN_REASONS`,
`CRAWL_PAGE_OUTCOMES`, `CRAWL_ROBOTS_VERDICTS`, `CRAWL_FRONTIER_STATES`, `SITE_CRAWL_TABLES`,
`CRAWL_RULE_IDS`, `CRAWL_EXCLUDED_CATEGORIES`, `CRAWL_EXCLUDED_RULES`), `specs/site-crawl.schema.ts`
(`CrawlSettingsSchema`, `CrawlPageRowSchema`, `CrawlRunViewSchema`, `CrawlStatusViewSchema`) and
`specs/fetcher.spec.ts` (the crawl lane, `CRAWL_FETCHER_LIMITS`, `BoundedFetchRequest.allowRedirect`).
Phase 12 bet B (plan `docs/plans/phase-12-big-bets.md`, Decision 6): Task 5 is the contract, the lane
and the storage; Task 6a fetching, politeness and robots; Task 6b runs, the frontier and the audit;
Task 7 the Pages and Site structure views. Each line maps to one named test.

## Decisions
- **Served HTML only.** The crawler fetches each page's served HTML through a bounded-fetcher lane
  of its own and audits it with the served-HTML rule subset (`CRAWL_RULE_IDS`); it never renders a
  page. Its score is the "Served-HTML score" (`CRAWL_SCORE_LABEL`), never the sidebar's health score.
- **Off until L6.** Starting and resuming a crawl are gated by `CRAWL_AVAILABLE` (legal gate L6),
  `false` until the owner's note under `docs/research/` exists. Main refuses `start` and `resume` with
  `unavailable` while it is closed; the renderer reads `available` from main's crawl view. Viewing,
  exporting and deleting runs are not gated.
- **Polite by construction.** One fetch call per origin at a time, at least `CRAWL_INTERVAL_MS.min`
  apart (the lane's floor) and at the effective interval in practice; robots.txt always honoured for
  the bare token `frost-crawl`, no override.
- **The user's data, deleted per run.** Runs, pages, links and the frontier live in SQLite
  (`SITE_CRAWL_TABLES`); deleting a run deletes its rows; deleting a project deletes its runs. Not
  part of Clear Browsing Data or project retention; never synced.

## L6 (owner's decision; Task 6a records it here)
*To be recorded by Task 6a: the owner's answer to "robots.txt and `Crawl-delay` honoured, no
override, 1 request/s default, identifying user-agent token" as an acceptable default.*

## Contract (Task 5: `packages/seo-core/src/crawl/__tests__/crawl-spec.test.ts`)
- `crawl-gate-ships-closed` — `CRAWL_AVAILABLE` is `false` in this build (L6 has no owner's note).
- `crawl-rule-ids-are-catalog-ids` — every id in `CRAWL_RULE_IDS` is in `SEO_RULE_SPECS`, once; none
  is in a category of `CRAWL_EXCLUDED_CATEGORIES` or in `CRAWL_EXCLUDED_RULES`; together the three
  cover the whole catalogue, each rule once.
- `crawl-lane-floor-is-the-minimum-interval` — `CRAWL_FETCHER_LIMITS.perOriginIntervalMs` is
  `CRAWL_INTERVAL_MS.min` (500 ms), with one call in flight per origin; the default interval is 1 s
  and every bound sits in its range.
- `crawl-outcomes-counted-once` — every page outcome is in exactly one of `CRAWL_FETCHED_OUTCOMES`,
  `CRAWL_REFUSED_OUTCOMES` (robots.txt, scope and the address rule: counted as `refused`) and
  `CRAWL_FAILED_OUTCOMES` (the fetch went wrong: counted as `failed`).
- `crawl-robots-token-is-the-user-agent-token` — `productToken(CRAWL_USER_AGENT_TOKEN)` is
  `CRAWL_ROBOTS_TOKEN`, both `frost-crawl`; the token is never read from a full user agent header
  (`productToken` of the header with ` frost-crawl/1` appended is not `frost-crawl`).

## Settings (Task 5: `apps/desktop/src/main/crawl/__tests__/crawl-settings.test.ts`)
- `crawl-settings-schema-bounds` — the defaults parse; the start URL is `http(s)` with no
  credentials, at most `maxUrlChars`; include and exclude are prefixes starting with `/` (literal,
  no white space), at most `maxPrefixes` of at most `maxPrefixChars` each; there is no regular
  expression field and unknown keys are refused; `maxPages` is 1 to `maxPagesCap`; the interval is
  `CRAWL_INTERVAL_MS.min` to `.max`. A start on a private host (`127.0.0.1:3000`, `localhost`,
  `dev.local`) is refused with the `site` or `path` scope and accepted with `host`; an IP-literal
  start refuses `site`.
- `crawl-status-view-carries-the-gate` — main's crawl view (`CrawlStatusViewSchema`) requires
  `available`, so the renderer learns the L6 gate from main, never from the constant.

## Storage (Task 5: `packages/db/src/site-crawl/__tests__/site-crawl.test.ts`)
- `site-crawl-migrations-create-schema` — `0240_site_crawl` and `0241_site_crawl_guards` are spread
  in `MIGRATIONS` right after Phase 11's block, in id order; they create exactly `SITE_CRAWL_TABLES`,
  column for column with the Drizzle schema, with their indexes (`(run_id, url)` on pages, links
  and the frontier) and triggers; the states, reasons, outcomes, verdicts and frontier states
  their `CHECK`s accept are exactly the spec's arrays.
- `crawl-repository-round-trips` — a run is created `queued` with its settings, read back, listed
  (all, and by project), moved through its states with its counts; a page row is inserted and
  replaced by URL, read back equal (`CrawlPageRowSchema`), paged; links are stored at most
  `maxLinksStoredPerPage` per page; the frontier queues each URL once per run (it is the run's
  seen-set), hands out queued URLs oldest first and marks them done.
- `crawl-startup-pauses-running-and-queued` — at start-up every `running` or `queued` run becomes
  `paused` (`interrupted`); paused, done, cancelled and failed runs do not change.
- `crawl-frontier-counts-inlinks-and-orphans` — the frontier is the authority for inlinks and
  orphans: a `link` discovery adds one inlink per discovering page (a URL twice on one page counts
  once), a `sitemap` seed sets `from_sitemap` and is no inlink, the start URL is neither; a URL met
  again while `queued` keeps the lower depth (a `done` one keeps its depth); orphans are
  `from_sitemap` with no inlink, listed in discovery order and counted.
- `crawl-reads-are-lenient` — on read, a finding id that is no longer a crawl rule (or a malformed
  finding) is dropped and the row stays; a run whose settings no longer parse is listed with
  `settings: null` (its `startUrl` kept) and can be deleted. Writes stay strict.
- `crawl-writes-rethrow-other-errors` — `putPage` and `enqueue` answer `false` / `0` only for "no
  such crawl run"; any other database error is thrown.
- `crawl-delete-run-purges-rows` — deleting a run deletes its pages, links and frontier, leaving
  other runs' rows; a raw delete of the run row cascades by trigger (the backstop); no page, link or
  frontier row can be written for a run that does not exist (a cancelled crawl that writes late
  writes nothing).
- `crawl-delete-project-runs-in-chunks` — `deleteRunsOfProject` deletes every run of the project and
  no other; each run's links, then pages and frontier, go `CRAWL_LIMITS.deleteChunkRows` rows per
  statement, yielding between statements, and the run row last; `projectsWithRuns` names the
  projects that still have runs.

## Fetching, politeness and robots (Task 6a)
*Scenarios for scope, robots, `Crawl-delay`, politeness, back-off, `Retry-After`, private starts and
the redirect-policy hook: Task 6a.*

## Runs, frontier, resume and the served-HTML audit (Task 6b)
*Scenarios for the frontier, max pages and depth, pause / resume / quit / crash, sitemap seeding,
the snapshot adapter, the context, the audit and project deletion: Task 6b.*

## Pages and Site structure (Task 7)
*UI scenarios, `CRAWL_PAGE_FILTERS`, `CRAWL_PAGE_SORTS`, `CRAWL_CSV_COLUMNS` and the sheet's rule-set
note: Task 7.*
