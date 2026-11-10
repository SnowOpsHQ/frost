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
**Pending the owner's note.** The question: is "robots.txt and `Crawl-delay` honoured, no override,
1 request/s default, identifying user-agent token" an acceptable default for an open-source tool?
Task 6a builds exactly that default (below) but records **no** approval: until the owner's written
note exists under `docs/research/`, `CRAWL_AVAILABLE` stays `false` and main refuses to start or
resume a crawl (`crawl-gate-ships-closed`). The change that adds the note flips the gate.

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
Code: `packages/seo-core/src/crawl/crawl-delay.ts` (`crawlDelayFor`, `crawlRobotsRules`, pure),
`apps/desktop/src/main/crawl/scope.ts` (`normaliseCrawlUrl`, `createCrawlScope`,
`createQueryVariantCap`), `politeness.ts` (`createPoliteness`, an injected clock and timer) and
`fetch.ts` (`createCrawlLane`, `createCrawlFetcher(deps).forRun(settings).fetchPage(url, signal)`);
the redirect-policy hook in `apps/desktop/src/main/seo/fetcher.ts`; the exact-origin robots lookup in
`robots-fetch.ts`. Tests: `packages/seo-core/src/crawl/__tests__/crawl-delay.test.ts`,
`apps/desktop/src/main/crawl/__tests__/crawl-{scope,politeness,fetch}.test.ts` and
`apps/desktop/src/main/seo/__tests__/fetcher.test.ts` (the hook), all with fake clocks, fake hops,
resolvers and robots, loopback names only.

### Crawl-delay (Q13)
`Crawl-delay` is not in RFC 9309; crawlers that read it disagree on its edge cases. frost's rule:
- the value is **seconds**, whole or decimal (`5`, `0.5`, `.5`, `2.`); anything else (a sign, a unit
  such as `5s`, an exponent, a word, empty) is ignored, as if the line were absent; `0` is a valid
  value that raises nothing;
- the line belongs to the group of the `user-agent` lines before it, grouped exactly as the robots
  parser groups them (`parseRobotsTxt`: a `crawl-delay` line between two `user-agent` lines does not
  end the group's agents; one before any `user-agent` line belongs to no group);
- the groups are chosen like `groupsFor`: every group naming `CRAWL_ROBOTS_TOKEN` (merged), else every
  `*` group;
- **several values in the chosen groups: the largest wins** (the politest reading; first-wins would
  let a later, stricter line be ignored);
- the result is in milliseconds, rounded up, capped at `MAX_CRAWL_DELAY_MS` (10 s); none (`null`)
  when no valid value applies. Google ignores `Crawl-delay`; frost honours it anyway (Decision 6).

### Pacing is per host name (Task 6a security review, lead ruling)
Pacing and the one-call-in-flight rule are keyed by **host name** (lowercased, trailing dot dropped),
not origin: `http` and `https`, or two ports, of one host share one pacing state (stricter than the
plan's "per origin"). A redirect hop to **another host name** is never followed inside a fetch call:
the call ends `redirected` (a fetched outcome), the row keeps the redirect (`finalUrl` = the target,
the hop in its chain) and Task 6b queues the target as a page of its own (depth + 1) under that host's
pacing; hops on the same host name are followed at once after the hook. The pacing state (last start,
back-off, `Retry-After`, `Crawl-delay`) belongs to the crawl fetcher, not the run: it survives a pause,
a resume and a new run; only the user's interval is the run's. It is bounded
(`CRAWL_LIMITS.maxPacedHosts`): a host is forgotten only once its longest possible wait (the largest
interval at full back-off, raised to its `Crawl-delay`) and its `Retry-After` have passed; past the cap
a new host is not fetched (`deferred`, the run pauses with `slow-down`, the URL stays queued).

### Scenarios
- `crawl-delay-parsed` — `crawlDelayFor(text, CRAWL_ROBOTS_TOKEN)`: the `frost-crawl` group's value,
  else the `*` group's (a `frost-crawl` group with no value gives none even when `*` has one); `3` is
  3 000 ms, `0.5` is 500 ms; absent, negative (`-1`), non-numeric (`soon`, `5s`, `1e3`) give none; the
  largest of several wins; 60 is capped at 10 000 ms; the group follows the parser's grouping.
- `crawl-is-polite` (K-B1) — with a fake clock, for **every** interval choice from 500 to 4 000 ms:
  never two fetch calls in flight to one origin, and consecutive fetch-call starts on one origin at
  least the effective interval apart (calls of different lengths, some longer than the interval).
  Through the crawl fetcher, a page that redirects twice on its origin is one fetch call: its hops
  follow each other at once (not spaced by the interval, bounded by `maxRedirects`), and the next
  call still waits the full interval after that call **started**. The lane's own floor
  (`CRAWL_FETCHER_LIMITS`) never delays the crawl's pacing.
- `crawl-is-polite-per-host` — two hosts redirecting into a third: both calls end `redirected` with
  the target, nothing is requested from the third host (nor its robots.txt) inside them, and the third
  host's pages, fetched on their own, are paced as one host; an `http` → `https` redirect on one host
  is followed in the call, and `http` and `https` pages of that host are paced as one host, one call in
  flight.
- `crawl-pacing-survives-runs` — a run backed off by a 429 is paused; a new run (or a resume) of the
  same crawl fetcher still waits the backed-off interval from the last start (at its own interval).
- `crawl-politeness-bounds-never-start-early` — over hundreds of calls to more hosts than
  `maxPacedHosts`, with back-off, `Retry-After` and `Crawl-delay` active, no start is ever earlier than
  the host's full state requires, the table never exceeds its cap, and a full table refuses a new host
  instead of forgetting one too soon.
- `crawl-keeps-a-learned-crawl-delay` — a later robots.txt lookup with no answer or an unknown outcome
  keeps the `Crawl-delay` an earlier one taught; a known answer (a file without one, no file) changes it.
- `crawl-honours-crawl-delay-and-retry-after` — the effective interval rises to the site's
  `Crawl-delay` (capped at 10 s), never below the user's choice; a 429 or 503 with `Retry-After` in
  seconds or as an HTTP date makes the next call wait it (from when it was received), capped at
  `CRAWL_LIMITS.maxRetryAfterMs`; a past date or a malformed value waits nothing extra; a
  `Retry-After` on a 200 is ignored.
- `crawl-backs-off-and-pauses` — each 429 or 503 in a row doubles the interval; any other answer
  resets it; the `CRAWL_LIMITS.backoffAfter`-th (5th) in a row answers `slowDown` (the run pauses with
  `CRAWL_SLOW_DOWN_MESSAGE`, reason `slow-down`, in Task 6b).
- `crawl-honours-robots` — a URL robots.txt disallows for `frost-crawl` is answered
  `blocked-by-robots` and never requested; the `frost-crawl` group is used, else `*`; a file with
  `User-agent: frost-crawl` / `Disallow: /` blocks every URL although `*` allows them; robots.txt the
  crawl cannot read (an unknown outcome) lets the page be crawled at the default interval with the
  `robots-txt-unreachable` flag (the start-origin rule); "no robots.txt" outcomes allow everything.
  Each page carries the crawl's verdict and Googlebot's, from the same file.
- `crawl-robots-matches-the-bare-token` — requests carry the browse user agent with ` frost-crawl/1`
  appended; robots.txt `User-agent: frost-crawl` / `Disallow: /` refuses the crawl; a
  `User-agent: mozilla` / `Disallow: /` group is **not** applied (the header starts with `Mozilla`);
  every robots match and the `Crawl-delay` lookup receive `CRAWL_ROBOTS_TOKEN` (or `googlebot` for
  the second verdict), never the header.
- `crawl-scope-host-site-path` — `host`: the start's host name, either scheme, on the start's own port
  or a default port (80, 443) only (lead ruling; another port is out of scope); `site`: any host with
  the start's registrable domain (the same port rule); `path`: the start's host under the start's
  directory (the same port rule); include
  prefixes (any one must match, when given) and exclude prefixes (none may match) apply to the path
  and query, literally (`*` is a plain character); the start URL itself is always in scope.
- `crawl-strips-tracking-params` — `CRAWL_TRACKING_PARAMS` (any case) are removed and the remaining
  query is kept byte for byte, in order; the fragment is dropped, the host lowercased, a default port
  removed; a non-`http(s)` URL, one with credentials or one longer than `maxUrlChars` is no crawl URL.
- `crawl-caps-query-variants` — at most `maxQueryVariantsPerPath` (20) distinct query strings are
  admitted per path (each URL is offered once: the frontier is the seen-set); the URL without a query
  is always admitted; the counter holds a bounded number of paths.
- `crawl-private-start-is-origin-only` — a start on `127.0.0.1:3000`: every request's `page` is the
  start URL; a URL on another private host, another port of the same host or another scheme is out
  of scope and never requested; `127.0.0.1:9229` is never requested; robots.txt is looked up with the
  exact-origin rule.
- `crawl-redirects-pass-the-crawl-policy` — a page redirecting to a same-host path robots.txt
  disallows (`blocked-by-robots`), to an out-of-scope public host (`out-of-scope`), to an excluded
  path (`out-of-scope`), and to another private host (`private-redirect`): each hop is refused by the
  hook before it is requested (`redirect-refused`), and the page is recorded with the refusal and the
  refused target; a hop to a port the scope does not allow is `out-of-scope`; a `127.0.0.1:3000` page redirecting to `127.0.0.1:9229` is refused with no request
  to `:9229` at all, not even `/robots.txt` (scope and the address rule are decided before any robots
  lookup); an in-scope, allowed hop is followed in the same call.
- `crawl-robots-fetch-is-origin-only` — with the exact-origin rule, `127.0.0.1:3000/robots.txt`
  redirecting to `127.0.0.1:9229` is not followed (no request reaches `:9229`): the robots outcome is
  `private-redirect` (no robots.txt), never `unreachable`; a robots answer cached for another caller
  that followed such a redirect is not reused (the two lookups are cached apart); without the rule
  the sidebar's lookup behaves as before.
- `crawl-redirect-robots-timeout-refuses-the-hop` — (each case a same-host `http` → `https` hop, so
  another robots.txt) a redirect target whose robots answer is
  `timeout`, and one whose lookup is still unanswered at `ROBOTS_FETCH_LIMITS.timeoutMs` +
  `CRAWL_ROBOTS_HOOK_MARGIN_MS`: the hop is refused and the page recorded `robots-timeout`, never a
  page fetch `timeout` (the hook's wait is not the page's deadline); a target whose robots answer is
  `server-error`, `unreachable`, `bad-redirect` or `no-location` (each its own case) follows the
  start-origin rule: the hop is followed and the page carries the `robots-txt-unreachable` flag.
- `crawl-keeps-the-headers-it-needs` — every page request asks for `CRAWL_KEEP_HEADERS` and only
  those come back (`set-cookie`, `server` never); repeated `X-Robots-Tag` values stay apart
  (`CRAWL_SEPARATE_HEADERS`); the body is read up to `CRAWL_LIMITS.maxBodyBytes` (`truncated` past
  it).
- `crawl-user-agent-identifies` — every page request sends the browse session's user agent with
  ` frost-crawl/1` appended (once), the served-HTML `Accept`, and `page` = the start URL.

### The redirect-policy hook (fetcher, `fetcher.test.ts`)
- `fetcher-redirect-hook` — without a hook a redirect is followed as before; the hook is asked
  after the fetcher's own checks (a private or unresolvable target never reaches it) with the
  resolved next URL; `false` or a rejection ends the call `redirect-refused` (status and final URL
  the redirect's, the next URL never requested); the time the hook takes is not counted in the
  call's `timeoutMs`; an abort while the hook runs ends the call `aborted` at once.
- `fetcher-redirect-hook-is-capped-and-re-resolved` — a hook unanswered at
  `FETCHER_LIMITS.maxRedirectHookMs` (at least the robots wait plus `CRAWL_ROBOTS_HOOK_MARGIN_MS`)
  refuses the hop; a name that resolved public before the hook and private after it is refused
  `private-redirect` before the hop is requested.

## Runs, frontier, resume and the served-HTML audit (Task 6b)
Code: `packages/seo-core/src/crawl/{served-to-page,crawl-context,crawl-rules}.ts` (pure),
`apps/desktop/src/main/crawl/analyse.ts` (the crawl worker's jobs), `frontier.ts`, `sitemaps.ts`,
`crawler.ts`, `service.ts` and `index.ts` (main's setup; Task 7 wires the service to IPC), with
`ServedParseInput.skipExtraText` in `served-parse.ts`, the job kinds `crawl`, `crawl-robots` and
`crawl-sitemap` in `analysis-worker.ts`, the project cleanup in `changes/projects.ts` and
`sync/service.ts`, and the crawl arm of `deletedProjectsWithRows`. Tests:
`apps/desktop/src/main/crawl/__tests__/crawl-{runs,service,projects,sync,worker,audit-parity}.test.ts`,
`packages/seo-core/src/crawl/__tests__/served-to-page.test.ts` and
`packages/db/src/site-crawl/__tests__/site-crawl-runs.test.ts`: fake page fetchers and fake sitemap
fetches (no network, no timer), the real session database, the crawl worker's code in-process.

### The run
- One crawl at a time, app-wide. A run takes the oldest queued URL of its frontier (read from SQLite
  `CRAWL_LIMITS.frontierWindow` at a time), checks its project is live, fetches it (Task 6a) and writes
  its row as the page ends; then its links, its discoveries, its frontier entry and the run's counts.
- The frontier (SQLite) is the queue, the seen-set, the authority for inlinks and sitemap orphans, and
  for the per-path query-variant cap: a resumed run, or a new crawler after a restart, counts what the
  run holds. A known URL is recorded again (an inlink) at any depth or query; a new one only within
  `CRAWL_LIMITS.maxDepth`, in scope, and under `maxQueryVariantsPerPath` variants of its path.
- Links are discovered from a `crawled` page that answered 2xx (those the served parse kept, at most
  `SNAPSHOT_LIMITS.maxLinks`); the first `maxLinksStoredPerPage` are stored (`internal`: in the run's
  scope). `outlinks` counts the `http(s)` links kept; `linksCut` marks a page with more than the parse
  keeps (`linkTotal` keeps the real count). `nofollow` links are followed (robots.txt governs crawling).
- Outcomes: an HTML answer (`SERVED_HTML_TYPES`, or no media type, as the served audit reads it) goes
  to the crawl worker (`crawled`, or `parse-failed`); another type is `not-html`, never parsed;
  `redirected` is recorded and its target queued at depth + 1 (a link of the redirecting page); a
  refusal or a failure is recorded as such; `deferred` records nothing, leaves the URL queued and pauses
  the run (`slow-down`); a `slowDown` answer is recorded, then the run pauses (`slow-down`,
  `CRAWL_SLOW_DOWN_MESSAGE`).
- The run ends `done` when the frontier is empty, or `maxPages` rows are recorded (`max-pages` while
  URLs are still queued); `paused` (`user`, `quit`, `slow-down`); `cancelled` (`user`, or
  `project-deleted`); `failed` (`error`, a database failure). Once stopped, nothing more is fetched or
  written: a fetch or a parse under way is left to end on its own and its answer dropped.

### Scenarios
- `crawl-respects-max-pages-and-depth` — a 16-page chain records depths 0–10 and never fetches the
  rest (`done`); `maxPages` 5 on a start linking 30 pages records exactly five rows and ends `done`
  with reason `max-pages` and 26 still queued.
- `crawl-html-only` — PDF, PNG and JSON answers are recorded `not-html` (status and media type kept,
  no title, score, findings or verdict) and never sent to the worker or read for links; an answer with
  no media type is parsed as HTML.
- `crawl-resumes-from-frontier` — quitting while a page is fetched pauses the run (`quit`) with that
  page unrecorded and still queued; after a restart (a new service on the same database) Resume
  fetches it and the rest, never a recorded page again, and the run ends `done`.
- `crawl-pause-and-resume-by-the-user` — Pause stops the run (`paused`, `user`) and awaits it; only
  Resume continues it; Pause or Cancel of a run that is not running answers `not-running`.
- `crawl-never-resumes-on-start` — a paused run stays paused through a restart's recovery, a status
  read and another run's start and end; nothing of it is fetched.
- `crawl-running-at-start-becomes-paused` — runs left `running` (a crash) or `queued` become `paused`
  (`interrupted`) at start-up; nothing is fetched and no run is active.
- `crawl-links-cut-recorded` — a page with 1 200 links: `linkTotal` 1 200, `linksCut`, `outlinks`
  1 000, 200 link rows, and 1 000 discovered (never one past the parse's cap).
- `crawl-redirected-target-enqueued` — a page redirecting to another host in scope is recorded
  `redirected` (status, `finalUrl` the target) and the target fetched as its own page, one click deeper,
  with one inlink.
- `crawl-deferred-and-slow-down-pause-the-run` — `deferred`: no row, the URL queued, the run paused
  (`slow-down`), never resumed by itself; after Resume, a 429 that says slow down is recorded and the
  run pauses again.
- `crawl-query-variants-counted-from-the-frontier` — 30 variants of one path admit 20; a later page's
  new variants are refused and its known ones counted as inlinks; a restart counts the same rows.
- `crawl-cancels-when-its-project-is-gone` — a project tombstoned mid-run (by sync) while a fetch call
  waits: the call asks again inside its paced slot (`beforeRequest`) and sends nothing, the run ends
  `cancelled` (`project-deleted`) and the project's runs are deleted.
- `crawl-before-request-is-asked-in-the-paced-slot` — `beforeRequest` is asked after the robots.txt and
  pacing waits, right before the request; `false` ends the call `aborted` with nothing sent.
- `crawl-in-memory-state-bounded` (K-B3) — over a 10 000-page fake site on 300 hosts of one site (the
  worker faked), fetched through the real per-host pacing on a fake clock, at every page's peak (its
  links held) and end: the frontier window, the page's links and the paced hosts together stay under
  `CRAWL_LIMITS.maxInMemoryEntries`, the window under `frontierWindow`, the pacing table reaches
  `maxPacedHosts` and never passes it; counts, never heap.
- `crawl-frontier-knows-urls-and-query-variants`, `crawl-page-counts-by-outcome` — the repository's
  seen-set lookup (chunked), the per-path variant count (one path's queries only) and a run's counts
  by outcome (a resumed run's counts come from its rows).

### Sitemap seeding
Every sitemap request is a crawl request (Task 6b review): it goes through the run's own page fetch, so
it passes the run's scope (a private start's exact origin included) before anything is requested,
robots.txt for `CRAWL_ROBOTS_TOKEN`, the per-host pacing (`Crawl-delay` learned first, each answer
reported, one call in flight per host) and the redirect hook (each hop checked before it is requested;
a hop to another host is followed as a new crawl request through the same checks). Only the caps
(`SITEMAP_LIMITS`) and `Accept` (`CRAWL_SITEMAP_ACCEPT`) are the sitemap's. Each file is parsed once in
the crawl worker and its URLs handed out `sitemapUrlsPerJob` at a time, then released.
- `crawl-sitemap-seeds` — with `sitemaps` on, a fresh run reads robots.txt's `Sitemap:` line, the index
  and its files (the check's parser in the crawl worker), and queues their URLs at depth 1, source `sitemap` (no inlink, in
  scope only, tracking parameters stripped), after the start URL; a URL also linked is no orphan, the
  others are; at most the run's `maxPages` URLs are seeded; with `sitemaps` off nothing is requested.
- `crawl-sitemap-falls-back-to-sitemap-xml` — robots.txt without a `Sitemap:` line: `/sitemap.xml` of
  the start's origin. Seeding runs on a fresh start only (a resume continues from the frontier).
- `crawl-sitemap-private-start-stays-on-its-origin` — a start on `127.0.0.1:3000` whose robots.txt lists
  `http://127.0.0.1:9229/x` and whose `/sitemap.xml` answers 302 to `:9229`: no request reaches `:9229`
  (nor its robots.txt), nothing is seeded.
- `crawl-sitemap-honours-crawl-delay-and-retry-after` — `Crawl-delay: 10` spaces sitemap requests at
  least 10 s apart; a 503 with `Retry-After: 30` holds the host's next request 30 s.
- `crawl-sitemap-disallowed-by-robots-is-not-fetched` — a sitemap robots.txt disallows for
  `frost-crawl`, and one on another site, are never requested.
- `crawl-sitemap-read-once-in-windows`, `crawl-sitemap-window-cache` — a file longer than one window is
  sent to the worker once, parsed once, handed out in windows and released; a window for a file not held
  is refused.
- `crawl-sitemap-window-timeout-stops-seeding-with-a-note` — a window past the worker's deadline stops
  seeding: one log line, and the run's note (`CRAWL_RUN_NOTES.sitemapTimeout`, the view's `note`); the
  crawl goes on.

### The crawl worker
- `crawl-parse-carries-no-extra-text` — the crawl job's parse sets `skipExtraText`: no `sourceText`,
  no `sourceTruncated`, no `leadText`; the sidebar's parse keeps both; the job's answer holds only the
  score, verdict, findings, title, canonical, word count, `linkTotal` and the `http(s)` links.
- `crawl-job-is-checked-in-the-worker` — a job that is not `CrawlPageJobSchema` (an unknown key, a body
  over `maxBodyBytes`, a non-web URL) is `parse-failed`; robots.txt that is not main's fetch reads as none.
- `crawl-robots-parsed-in-the-worker` — robots.txt is parsed in the worker into plain data (groups,
  sitemaps, `Crawl-delay`); main matches with it for the bare `CRAWL_ROBOTS_TOKEN` (and `googlebot`).
- `crawl-robots-unparsed-is-blocked` — robots.txt fetched `ok` whose parse fails (the worker failed or
  timed out) is read as blocked: the page is recorded `blocked-by-robots` and not requested (never
  "unknown"); the failed parse is not cached, so the next page asks the worker again.
- `crawl-worker-is-separate` — the crawl's jobs go to a worker instance of its own (the same bundle,
  its own deadline `CRAWL_ANALYSIS_TIMEOUT_MS`): a crawl job that has not answered never delays a
  sidebar audit; a crawl job past its deadline is `parse-failed`.

### The snapshot adapter, the context and the audit
- `served-to-page-snapshot-maps-fields` — `servedToPageSnapshot` copies every served field the plan
  lists, maps images (`src`, `alt`, no layout values), defaults the fetch's time and duration, no
  social tag, an empty security value and no microdata or RDFa, omits hidden headings, blocking
  scripts and visible text (and the served snapshot's lead text, noscript and node count); the result
  parses with `PageSnapshotSchema`, `imageTotal` included; `served-to-page-snapshot-keeps-caps`.
- `crawl-context-from-the-fetch` — `crawlContext`: `ResponseMeta` with the final URL, `source:
  'network'`, the status, the kept headers the allowlist names (`retry-after` left out, `X-Robots-Tag`
  values apart), the redirect hops (`internal: false`); robots.txt as main fetched it; no accessibility,
  no checks; `crawl-context-caps-what-it-keeps` (value caps, values per header, hops).
- `crawl-rules-are-the-crawl-rule-ids`, `crawl-audit-reads-only-crawl-rules` — `CRAWL_RULES` is the
  catalogue's rules in `CRAWL_RULE_IDS`, in catalogue order; the crawl audit reports no other rule.
- `crawl-audit-matches-sidebar-on-static-pages` (K-B2) — over static fixture pages (frost's own HTML:
  a complete page, a bare one, repeated head tags, canonical conflicts, hreflang and JSON-LD problems,
  URL shapes, headers, statuses and robots.txt answers), the crawl worker's audit and the sidebar's
  rendered audit (the extractor over jsdom, then the worker's audit, with the same response and
  robots.txt) report the same crawl rules, and every crawl rule fires somewhere.
- `crawl-audit-never-adds-a-finding-on-hidden-or-microdata-pages` (K-B2) — with headings, words, an
  image and a link hidden by CSS, or microdata and RDFa, the crawl never reports a rule the sidebar does
  not; it may miss `h1-missing`, `content-thin` and the structured-data rules (JSON-LD only). K-B2
  removed `h1-multiple`, `h1-empty` and `heading-level-skipped` (`CRAWL_EXCLUDED_RULES`): hidden
  headings made them report what the sidebar does not.

### The service and the gate
- `crawl-gate-refuses-in-main` — as shipped (`CRAWL_AVAILABLE` `false`, and a packaged build ignoring
  the e2e switch), `start` and `resume` answer `unavailable` with `LEGAL_GATE_NOTE`; nothing is stored
  or fetched; the view carries `available: false`; cancel and delete still work.
- `crawl-start-checks-its-input` — settings `CrawlSettingsSchema` refuses (an unknown key, a private
  start with `site` scope, not an object) are `invalid-settings`; a project that is not live, or a run
  that does not exist, is `not-found`.
- `crawl-one-at-a-time` — a second start while one runs is `busy`, and of two starts at once one runs.
- `crawl-settings-unreadable-is-not-resumable` — a run whose stored settings no longer parse is listed
  (`settings: null`), never resumed (`not-resumable`, as a `done` run is), and still deletable.
- `crawl-start-racing-a-project-delete` — a delete that arrives while a start (or a resume) is claiming
  the slot waits for it, then stops its run; the run checks its project before discovering or seeding
  anything: no fetch, no rows.
- `crawl-delete-of-a-running-run-waits-for-it` — deleting the running run cancels it, awaits its end and
  leaves none of its rows.

### Deleting a project deletes its crawls (plan Decision 6)
- `project-delete-removes-its-crawls` — a project whose only data is a crawl, one run finished and one
  running: its delete cancels and awaits the running crawl, then deletes every run with its pages,
  links and frontier; a fetch answering late writes nothing.
- `project-delete-interrupted-is-finished-at-start-up` — a delete interrupted after the tombstone by a
  crash while its crawl ran (the run left `running`): start-up pauses it (`interrupted`, never resumed),
  the project is listed by `deletedProjectsWithRows` (its only rows a crawl's) and start-up's
  `purgeDeleted` deletes its crawls.
- `deleted-projects-with-rows-lists-crawl-only-projects` — the crawl arm of `deletedProjectsWithRows`.
- `synced-tombstone-deletes-crawls-at-pull` — no restart, no capture run: a project tombstone pulled by
  sync while the project has, in turn, a running crawl, a paused one, a finished one, and one on its
  final fetch: once the pull completes no crawl row is left and no crawl runs.
- `synced-tombstone-crawl-cleanup-never-fails-the-pass` — a cleanup that fails is one log line of its
  own; the pass still counts and is not logged as failed.

## Pages and Site structure (Task 7)
*UI scenarios, `CRAWL_PAGE_FILTERS`, `CRAWL_PAGE_SORTS`, `CRAWL_CSV_COLUMNS` and the sheet's rule-set
note: Task 7.*
