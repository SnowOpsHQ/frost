# Feature: Site crawl

Spec: `specs/site-crawl.spec.ts` (`CRAWL_AVAILABLE`, `CRAWL_LIMITS`, `CRAWL_INTERVAL_MS`,
`MAX_CRAWL_DELAY_MS`, `CRAWL_ROBOTS_HOOK_MARGIN_MS`, `CRAWL_ROBOTS_PARSE_WAIT_MS`, `CRAWL_KEEP_HEADERS`, `CRAWL_SEPARATE_HEADERS`,
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
  `from_sitemap` with no inlink, listed in discovery order and counted. `enqueue(…, { done })` marks
  that URL done in the same transaction as the discoveries (a page's completion is one write).
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
back-off, `Retry-After`, `Crawl-delay`) belongs to the crawl fetcher, not the run: within one session
it survives a pause, a resume and a new run; only the user's interval is the run's. Across a restart
the crawl fetcher starts empty, so the run stores each paced host's next allowed start (`waitUntil`, the
later of its `Retry-After` and its last start plus its effective interval, a learned `Crawl-delay`
included) and its back-off on the run (`crawl_runs.pacing`, migration `0246`, `CRAWL_PACING_LIMITS`):
as it starts, **whenever the pacing changes** (council review, item 5: after a fetch call that set or
cleared a back-off, took a `Retry-After`, or learned or changed a `Crawl-delay`; `Politeness.changes`),
**before every request that starts under an interval raised by either** (council review round 2, item
B; `Politeness.startRaises`: the snapshot counts that request's start as now, the write is awaited
inside the host's slot after the project check, and only then is the start stamped and the request
sent; a write that fails sends nothing and fails the run), and as it pauses (any reason: the user, a
quit, a slow-down). A call at the run's own interval changes nothing, so a crawl with no `Crawl-delay`
and no back-off writes no pacing per page; one with them writes it about once per fetch call (its calls
are seconds apart). So a crash or kill (no pause written; start-up pauses the run left `running`)
loses none of it, even with a request in flight.
Resume seeds the pacing from it before the first request, so a run resumes backed off and not before
the stored time (a stored time more than
`CRAWL_PACING_LIMITS.maxWaitMs` ahead is honoured only that far). It is bounded
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
- `crawl-slow-before-request-never-shortens-the-interval` — (council review round 2, item A; K-B1) a
  call's start is stamped right before its request, after every async check in the host's slot
  (`beforeRequest`, the project lookup), never as the slot opens: with one call's check taking the
  interval less 200 ms on the fake clock and the next call's none, consecutive network starts are still
  at least the effective interval apart (the lane's floor is not what holds them), and each call's
  `startedAt` is its request's own start.
- `crawl-is-polite-per-host` — two hosts redirecting into a third: both calls end `redirected` with
  the target, nothing is requested from the third host (nor its robots.txt) inside them, and the third
  host's pages, fetched on their own, are paced as one host; an `http` → `https` redirect on one host
  is followed in the call, and `http` and `https` pages of that host are paced as one host, one call in
  flight.
- `crawl-pacing-survives-runs` — a run backed off by a 429 is paused; a new run (or a resume) of the
  same crawl fetcher still waits the backed-off interval from the last start (at its own interval).
- `crawl-pacing-survives-a-restart` — five 429s in a row with `Retry-After: 60` pause the run
  (`slow-down`); the stored pacing holds the host's `waitUntil` (the 429's time + 60 s) and its back-off
  (5). After a restart (a new crawl fetcher, crawler and service on the same database), Resume within
  the minute sends the first request exactly at the stored time, never before; a 429 there pauses the run
  again at once (the back-off came back), and the next restart's Resume waits the full backed-off
  interval (the interval × 2⁵) from that request's start.
- `crawl-pacing-survives-a-crash` — (council review, item 5) a 429 with `Retry-After: 60` is stored on
  the run as it is answered; the app is then killed (no pause written, the run left `running`). At the
  next start the run is paused (`interrupted`), and Resume sends its first request exactly at the
  stored time (the 429's time + 60 s), never before.
- `crawl-pacing-stored-before-the-request` — (council review round 2, item B) a page starts under a
  `Crawl-delay: 10` learned this session and the app is killed with its request in flight (no answer,
  no pause written): the run's stored pacing already holds that request's start + 10 s. At the next
  start the run is paused (`interrupted`), and Resume, two seconds after the kill, sends its first
  request exactly at the stored time, never before.
- `crawl-pacing-stored-before-a-redirect-hop` — (council review round 3, item H) robots.txt on
  `http://example.com` allows the start and sets no delay; its same-host redirect to `https://` learns
  `Crawl-delay: 10` from that origin's robots.txt in the redirect hook, and the app is killed with the
  HTTPS request in flight: the run's stored pacing already holds the call's start + 10 s (written
  before the hop was followed, `CrawlFetchOptions.beforeHop`). After start-up (`interrupted`), Resume
  two seconds on sends its first request exactly at the stored time. A pacing write that fails there
  refuses the hop (the HTTPS URL is never requested) and the run ends `failed` (`error`), no row written.
- `crawl-pacing-changes-only-when-a-snapshot-would` — (council review, item 5; round 2, item B)
  `Politeness.changes` moves for a 429 / 503 (back-off, `Retry-After`), for the answer that clears a
  back-off, and for a `Crawl-delay` learned, changed or dropped; never for a start, calls at the run's
  own interval, a `Crawl-delay` learned again unchanged, or a `restore`. `startRaises(host)` is true
  while the host's interval is raised, and `snapshot(host)` counts that host's start as now.
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
  crawl cannot read (an unknown outcome) refuses the page, `robots-unreachable`, never requested
  (council review, item 2: this replaces the start-origin rule that crawled it, flagged); "no
  robots.txt" outcomes (`CRAWL_ROBOTS_ALLOW_ALL_OUTCOMES`: a 4xx, a missing file, too many redirects)
  allow everything.
  Each page carries the crawl's verdict and Googlebot's, from the same file.
- `crawl-robots-unreachable-refuses-the-page` — (council review, item 2; RFC 9309 §2.3.1.4) robots.txt
  the crawl cannot read means everything is disallowed, for the crawl only (the sidebar's "unknown"
  verdict and its `robots-txt-unreachable` finding do not change). Each of `ROBOTS_UNKNOWN_OUTCOMES`
  (`server-error`, `unreachable`, `timeout`, and the redirect failures `bad-redirect` and
  `no-location`, which RFC 9309 counts as unreachable), a lookup still unanswered at
  `ROBOTS_FETCH_LIMITS.timeoutMs` + `CRAWL_ROBOTS_HOOK_MARGIN_MS` (recorded as `timeout`), and a lookup
  that fails, refuses the page: the start URL on its own origin and a page on another origin alike are
  answered `robots-unreachable` (verdicts `unknown`) and never requested (on the start URL's origin the
  crawler then records nothing and pauses the run: round 2, item D, `crawl-robots-unreachable-pauses-the-run`;
  on another origin it records the refusal and goes on: round 3, item G). `unavailable` and `forbidden` (no robots.txt) allow the page.
- `crawl-robots-private-redirect-is-unreadable` — (council review round 2, item C) in the crawl only,
  a robots.txt whose redirect the fetcher refused (`private-redirect`) is robots.txt the crawl could not
  read (`CRAWL_ROBOTS_UNREADABLE_OUTCOMES`), not "no robots.txt": a public site's robots.txt redirecting
  to `10.0.0.5`, and a private start's robots.txt redirecting to another port, each refuse the page
  (`robots-unreachable`, verdicts `unknown`), and only robots.txt is requested. `too-many-redirects`,
  `unavailable` and `forbidden` still allow the page; the sidebar's lookup still answers
  `private-redirect` and reads it as before (`ROBOTS_ALLOW_ALL_OUTCOMES` is unchanged).
- `crawl-robots-parse-has-its-own-wait` — (council review, item 1) the robots lookup's wait
  (`ROBOTS_FETCH_LIMITS.timeoutMs` + `CRAWL_ROBOTS_HOOK_MARGIN_MS`) covers the lookup only; a
  robots.txt fetched `ok` is parsed within a wait of its own, `CRAWL_ROBOTS_PARSE_WAIT_MS`. A
  `Disallow: /` file whose parse never answers is refused `blocked-by-robots` (verdict `blocked`,
  `unparsed`) once that wait is up, and one whose parse is queued behind a worker job longer than the
  lookup's wait is refused by its own rules when it answers: in both the page is never requested, and a
  late or stalled parse is never read as "unknown".
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
- `crawl-scope-prefixes-compare-the-normalised-path` — (council review, item 6; RFC 3986 §6.2.2) before
  any prefix is compared, the URL's path and query are percent-normalised: an escape of an unreserved
  character (ALPHA, DIGIT, `-`, `.`, `_`, `~`) is decoded and every escape left gets upper-case hex.
  The request and the frontier key use the same normal form (`normaliseCrawlUrl`), and a prefix typed
  with escapes is normalised the same way. Exclude `/admin` refuses `/%61dmin/` and `/%61%64min/x`;
  `/%2Fadmin` (a reserved escape) is never decoded and stays in scope. The comparison stays
  **case-sensitive**, because paths are: exclude `/admin` does not refuse `/Admin/` or `/%61%44min/`.
- `crawl-strips-tracking-params` — `CRAWL_TRACKING_PARAMS` (any case) are removed and the remaining
  query is kept in order, byte for byte apart from the percent-normalisation above (`%20`, `+` and
  every reserved escape stay); the fragment is dropped, the host lowercased, a default port
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
  `private-redirect`, never `unreachable`, which the crawl reads as unreadable (round 2, item C: the
  page is refused `robots-unreachable` and never requested); a robots answer cached for another caller
  that followed such a redirect is not reused (the two lookups are cached apart); without the rule
  the sidebar's lookup behaves as before.
- `crawl-redirect-robots-timeout-refuses-the-hop` — (each case a same-host `http` → `https` hop, so
  another robots.txt) a redirect target whose robots answer is
  `timeout`, and one whose lookup is still unanswered at `ROBOTS_FETCH_LIMITS.timeoutMs` +
  `CRAWL_ROBOTS_HOOK_MARGIN_MS`: the hop is refused and the page answered `robots-unreachable`, never a
  page fetch `timeout` (the hook's wait is not the page's deadline); a target whose robots answer is
  `server-error`, `unreachable`, `bad-redirect` or `no-location` (each its own case) is refused the
  same way (council review, item 2: the hook's `robots-timeout` is folded into `robots-unreachable`,
  one rule for every robots.txt the crawl cannot read), and the target is never requested. An answer
  just inside the limit that allows the hop is followed.
- `crawl-redirect-robots-parse-stall-refuses-the-hop` — (council review, item 1) a same-host hop whose
  robots.txt is fetched `ok` but whose parse never answers is refused `blocked-by-robots` (the
  fetcher's own hook cap may end the wait first; the refusal is named before the wait starts), and the
  target is never requested.
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
- (Council review round 3, item J) A run is created with its normalised start URL already queued
  (depth 0, source `start`): the run and that frontier entry are one transaction
  (`CreateCrawlRunInput.start`), so a Pause, a quit or a kill before the crawler has done anything
  still leaves the start URL to Resume. A Resume whose start URL has never completed (its entry still
  `queued` and no row for it: stopped before it, or its robots.txt unreadable) queues it again and
  seeds sitemaps again (when the settings ask) before continuing; both are idempotent (the frontier
  dedupes, a seed adds no inlink, a known URL keeps its state and its done flag). (Council review round
  4, item N2) A run paused `slow-down` whose start URL never completed paused while seeding (a slow-down
  answer on the start is recorded and completed first; a `deferred` start comes after seeding ran): its
  Resume does not seed again and goes straight to the pages, so a site answering 429 / 503 on its
  sitemaps alone cannot hold the run paused for good. The stored reason tells it; no new column. A
  Resume after a `robots-unreachable` pause still seeds again.
- `crawl-start-url-queued-with-its-run` — (round 3, item J) a Pause while a new run reads its counts
  leaves the run `paused` with nothing fetched and the start URL `queued` (depth 0, no inlink); Resume
  crawls it and its link, and the run ends `done` with two pages. A kill there (the run left `queued`):
  start-up pauses it (`interrupted`), and Resume crawls the start the same way.
- `crawl-run-created-with-its-start-entry` — (round 3, item J; `site-crawl-runs.test.ts`) `createRun`
  with `start` writes the run (`queued` 1) and its start entry together; a `start` that is no crawl URL
  writes nothing, the run included.
- One crawl at a time, app-wide. A run takes the oldest queued URL of its frontier (read from SQLite
  `CRAWL_LIMITS.frontierWindow` at a time), checks its project is live, fetches it (Task 6a) and writes
  its row as the page ends; then its links, then its completion — its discoveries and its frontier entry
  marked done, in **one** transaction — and the run's counts.
- (Council review, item 3) A page stopped (Pause, a quit, a kill) after its row but before its
  completion stays `queued`: Resume fetches it again and replays it whole. The replay is idempotent:
  the row is replaced (one row per URL), its links replaced (a replay whose answer has no analysis —
  `not-html`, `parse-failed`, `redirected`, a refusal or a failure — removes the links the earlier
  answer stored: round 2, item F), the run's counts take the replaced row out
  before adding the new one, and its discoveries are recorded once — a completed page is never replayed
  and a page not completed has discovered nothing, so no `(page, link)` discovery adds an inlink twice.
- (Council review round 2, item E) The replay comes **before** the `maxPages` cap, which counts new
  pages only: a page that already has a row and is still queued (always the oldest queued entry, since
  one page is in flight at a time) is replayed and completed even when the run's rows have reached
  `maxPages`; only a page with no row is held back by the cap.
- The frontier (SQLite) is the queue, the seen-set, the authority for inlinks and sitemap orphans, and
  for the per-path query-variant cap: a resumed run, or a new crawler after a restart, counts what the
  run holds. A known URL is recorded again (an inlink) at any depth or query; a new one only within
  `CRAWL_LIMITS.maxDepth`, in scope, and under `maxQueryVariantsPerPath` variants of its path.
- `crawl-frontier-dedupes-percent-encoded-urls` — (council review, item 6) a page linking `/%61bout`
  and `/about` adds one frontier entry, `/about`, fetched once; `/%41bout` is `/About`, another page
  (paths are case-sensitive).
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
- (Council review round 2, item D; round 3, item G) `robots-unreachable` — robots.txt the crawl cannot
  read **on the start URL's origin** (scheme, host and port), for a queued page or a same-host redirect
  hop — **never completes the frontier entry**: no row is written, the URL stays `queued`, and
  the run pauses (`robots-unreachable`, `CRAWL_ROBOTS_UNREACHABLE_MESSAGE`: "frost could not read the
  site's robots.txt. Resume to try again."). A start URL whose robots.txt is never readable pauses at
  once instead of finishing. A brief failure (a robots.txt re-fetch answering 429 after the cache's
  TTL, cached as `server-error` for a minute) therefore pauses the run rather than marking the queue
  refused and done; Resume asks again (a Resume within that minute meets the cached failure and pauses
  again). A replayed page (item 3) that meets it keeps the row it already had, still counted: its
  entry stays queued, and the replay that completes it replaces the row. Sitemaps are unchanged: a
  sitemap request refused this way is skipped. On **any other origin** (another host's page, a
  cross-host redirect target, a same-host hop to another scheme or port) the page is a refusal like the
  others (round 3, item G): recorded `robots-unreachable` (nothing requested from that origin; a refused
  hop keeps its status and `finalUrl` the hop's target), counted `refused`, and its entry completed, so a
  host whose robots.txt never answers cannot hold the run paused for good.
- (Council review round 4, item N1) The **start origins** are the typed start URL's origin plus each
  origin the start landed on: its same-host hop target (the start row's `finalUrl`), its `redirected`
  target (another host, queued as its own page) and, in turn, where that target lands, the start URL
  and its `redirected` targets making a chain of at most five URLs. A site usually redirects the URL as
  typed (`http://` to `https://`, the apex the "Crawl site" button starts at to `www`), so its pages sit
  on a landing origin; each start origin pauses the run as the typed one does, and a page of the chain
  pauses it on any origin (its own hop target's robots.txt included). The set is learned from the
  chain's rows as they are written and rebuilt from them on Resume (no new column). It decides the
  pause only; scope is unchanged.
- The run ends `done` when the frontier is empty, or `maxPages` rows are recorded (`max-pages` while
  URLs are still queued); `paused` (`user`, `quit`, `slow-down`, `robots-unreachable`); `cancelled` (`user`, or
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
- `crawl-pause-mid-page-replays-its-completion` — (council review, item 3) a Pause while the start
  page's row is written leaves the page `queued` with nothing discovered; Resume fetches it again,
  discovers and fetches `/child`, and the run ends with one row per page, the links stored once, counts
  equal to the rows and each inlink counted once. A Pause while the page's discoveries are written
  finds the page complete (`done`): Resume never fetches it again.
- `crawl-replay-without-analysis-drops-its-old-links` — (council review round 2, item F) a page paused
  after its row and its two links were written stays `queued`; on Resume it answers a PDF: its row is
  replaced (`not-html`, no outlinks), the two links are removed, and the run ends `done` with one page.
- `crawl-page-cap-replays-a-recorded-page` — (council review round 2, item E) `maxPages: 1`, paused
  right after the start's `putPage`: the run is `paused` with the start's row written and the start
  still `queued`. Resume fetches the start again and completes it (its one link stored, `/child`
  discovered: `queued`, depth 1, one inlink); the cap then ends the run `done` (`max-pages`, 1 page,
  1 queued) with `/child` never fetched and no row for it.
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
- `crawl-robots-unreachable-pauses-the-run` — (council review round 2, item D) with the real crawl
  fetcher on a fake clock: robots.txt answers 429 (`server-error`) once two pages are crawled; the run
  pauses (`robots-unreachable`) with those two rows, no row for the next page, every other URL still
  `queued` and nothing refused. Resume while it still fails pauses again at once with nothing recorded;
  Resume with robots.txt readable crawls the rest and the run ends `done`, every row `crawled`. A start
  URL whose robots.txt is never readable pauses at once (nothing requested, the start still queued),
  and (round 3, item G) a run whose oldest queued page is on another host with an unreadable robots.txt
  records that page `robots-unreachable` (its entry done), crawls the rest and ends `done`.
- `crawl-robots-unreachable-off-the-start-origin-is-recorded` — (council review round 3, item G) a
  `site` crawl whose start links `https://legacy.example.com/` (robots.txt always 503) and a page that
  redirects to `http://example.com/moved` (robots.txt always 503): neither is requested, both are
  recorded `robots-unreachable` (the hop with its 301 and target) and done, every other page is crawled
  and the run ends `done` with two refused. A hop from another origin to the start origin, whose
  robots.txt cannot be read, pauses the run (`robots-unreachable`) with that page unrecorded and queued.
- `crawl-robots-unreachable-pauses-on-the-start-landing-origin` — (council review round 4, item N1) a
  start at `http://example.com/` hops (same host) to `https://example.com/`, whose robots.txt answers
  503 once two pages are crawled: the run pauses (`robots-unreachable`) with the rest queued, nothing
  refused. After a restart (a new crawl fetcher, crawler and service) Resume pauses again with nothing
  recorded; readable again, it crawls the rest and ends `done`. An apex start (`site` scope) whose
  answer redirects to `www` (a `redirected` row) pauses the same way when `www`'s robots.txt fails, and
  again after a restart.
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
- `crawl-sitemap-slow-down-pauses-the-run` — (council review, item 4) a sitemap request answered as a
  slow-down (the `backoffAfter`-th 429 / 503 in a row, or `deferred`) stops seeding and the seeder says
  so (`SitemapSeedReport.slowDown`): five robots.txt `Sitemap:` files each answering 429 leave the run
  `paused` (`slow-down`, `CRAWL_SLOW_DOWN_MESSAGE`) with no page fetched (the start URL still queued)
  and the host's back-off stored with the run's pacing.
- `crawl-sitemap-storage-failure-fails-the-run` — (council review round 3, item I) seeding skips a
  sitemap it cannot read (its fetch refused or failed, its parse failed), never a store that fails: a
  sitemap request under a learned `Crawl-delay: 10` whose pacing write fails (once) sends nothing, and
  the run ends `failed` (`error`) with no sitemap and no page requested; a frontier write that fails
  while a sitemap's URLs are seeded fails the run the same way.
- `crawl-sitemap-falls-back-to-sitemap-xml` — robots.txt without a `Sitemap:` line: `/sitemap.xml` of
  the start's origin. Seeding runs on a fresh start, and on a Resume while the start URL has never
  completed (round 3, item J) unless the run paused `slow-down` (round 4, item N2); otherwise a resume
  continues from the frontier.
- `crawl-resume-seeds-sitemaps-when-the-start-never-completed` — (council review round 3, item J) with
  robots.txt unreadable, the fallback sitemap is refused and the start URL pauses the run
  (`robots-unreachable`), nothing requested; robots.txt readable again, Resume reads the `Sitemap:` file
  first, then crawls the start and both seeded URLs (`done`, three pages; the linked one has one inlink,
  the other is an orphan). A Resume once the start has completed reads no sitemap.
- `crawl-resume-after-a-sitemap-slow-down-skips-seeding` — (council review round 4, item N2) every
  `/sitemap*` request answers 429 and pages answer 200: the five `Sitemap:` files pause the run
  (`slow-down`) with its start queued; Resume requests no sitemap, crawls the start and its link after
  the back-off, and the run ends `done` with two pages.
- `crawl-sitemap-private-start-stays-on-its-origin` — a start on `127.0.0.1:3000` whose robots.txt lists
  `http://127.0.0.1:9229/x` and whose `/sitemap.xml` answers 302 to `:9229`: no request reaches `:9229`
  (nor its robots.txt), nothing is seeded.
- `crawl-sitemap-honours-crawl-delay-and-retry-after` — `Crawl-delay: 10` spaces sitemap requests at
  least 10 s apart; a 503 with `Retry-After: 30` holds the host's next request 30 s.
- `crawl-sitemap-disallowed-by-robots-is-not-fetched` — a sitemap robots.txt disallows for
  `frost-crawl`, and one on another site, are never requested.
- `crawl-sitemap-robots-unreachable-is-not-fetched` — (council review, item 2) robots.txt answering
  503: the fallback `/sitemap.xml` is refused like any page (`robots-unreachable`), never requested;
  nothing is seeded.
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
- `crawl-sitemap-robots-parse-stall-is-blocked` — (council review, item 1) robots.txt fetched `ok`
  (`Disallow: /`, a `Sitemap:` line) whose crawl-worker parse never answers: the sitemap request is
  refused like any page; nothing but robots.txt is requested and nothing is seeded.
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
  own; the pass still counts and is not logged as failed. The projects' `purgeDeleted`, which the same
  pull then runs (whole-branch review, `sync-engine.feature.md`), fails on a line of its own too.

## Pages and Site structure (Task 7)
SL-096/097. Spec: `CRAWL_WATCH`, `CRAWL_STATUS_CLASSES`, `CRAWL_INDEXABLE_FILTERS`, `CRAWL_PAGE_FILTERS`,
`CRAWL_PAGE_SORTS`, `CRAWL_PAGES_LIMITS`, `CRAWL_TREE_LIMITS`, `CRAWL_READ_REFUSALS`,
`CRAWL_CLIENT_RENDERED_MAX_WORDS`, `CRAWL_PAGE_FLAGS` / `crawlPageFlags`, `CRAWL_CSV_COLUMNS`,
`CRAWL_CSV_READ_ROWS`, `CRAWL_CSV_FILE_NAME` / `crawlCsvFileName`, `CRAWL_CSV_SAVE_DIALOG`,
`CRAWL_VIEW_TEXT`, `CRAWL_REFUSAL_TEXT` (`site-crawl.spec.ts`); the `crawl.*` shapes in
`site-crawl.schema.ts` (`CrawlWatchViewSchema`, `CrawlServiceAnswerSchema`, `CrawlPageFilterSchema`,
`CrawlPagesInputSchema`, `CrawlPageListRowSchema`, `CrawlPagesAnswerSchema`, `CrawlStructureInputSchema`,
`CrawlTreeNodeSchema`, `CrawlStructureAnswerSchema`, `CrawlCsvInputSchema`, `CrawlCsvAnswerSchema`).

### Decisions
- **Paged in SQL.** The Pages view reads one page of rows at a time (at most
  `CRAWL_PAGES_LIMITS.maxPageSize`), filtered and sorted by main's repository; the path tree is read one
  level at a time (at most `CRAWL_TREE_LIMITS.maxChildren` nodes, the rest counted and said); the
  renderer never holds a run's full list. In-links and orphans come from the frontier (the authority).
- **The score is the crawl's.** The score column and the CSV's are headed `CRAWL_SCORE_LABEL`
  ("Served-HTML score"); the sheet names the crawl's rule set (the categories of `CRAWL_RULE_IDS`, and
  what `CRAWL_EXCLUDED_CATEGORIES` / `CRAWL_EXCLUDED_RULES` leave out, with their reasons). Nothing says
  "health score".
- **Gated in main, shown from main's view.** `start` and `resume` pass main's answer through (refused
  `unavailable` with `LEGAL_GATE_NOTE` while L6 is closed). The sheet disables Start and Resume with that
  note when main's view says `available: false`; it never reads `CRAWL_AVAILABLE`. Viewing, exporting
  and deleting runs are never gated.
- **Marks, not rendering.** A page with more links than the parse keeps is marked "links cut at 1 000";
  an HTML page answered 2xx with fewer than `CRAWL_CLIENT_RENDERED_MAX_WORDS` served words is marked
  "looks client-rendered" (lead ruling: the row keeps no script count yet, so the word count alone
  decides; Decision 6's "with scripts" is not checked). Each page has "Open in tab", the address bar's
  path (`browser.navigate`), and shows both robots.txt verdicts: the crawl's (`frost-crawl`) and
  Googlebot's, from the same file.
- **Bounded refreshes.** While a run runs, the sheet reads its pages and structure again at most every
  `CRAWL_REFRESH_MS` (another run or state: at once); main counts one change per page.

### The queries (`packages/db/src/site-crawl/__tests__/site-crawl-views.test.ts`)
- `crawl-pages-query-paged-and-filtered` — a run's pages come at most `maxPageSize` a page, with the total
  the filter selects; filters by status class (`2xx` … `5xx`, `none`), indexable (`yes`, `no`,
  `unknown`), a failing crawl rule (`finding`), an exact depth and "links cut", combined with AND, all in
  SQL; each row carries its in-links from the frontier and no run id; another run's pages never show.
- `crawl-pages-sorted-in-sql` — every `CRAWL_PAGE_SORTS` entry, ascending and descending; pages without
  the value sort last either way; ties keep the crawl's order.
- `crawl-structure-tree` — the root level lists the run's origins, a folder's level its path segments
  (query variants counted under their path, a folder's own page as `''`), most pages first; a prefix is a
  range on the `(run_id, url)` index (`/blog/` never takes `/blogs/`); a level past its limit sends the
  limit and counts the rest (`more`); the click-depth histogram counts pages per depth; orphans are
  sitemap URLs never linked (the frontier's `from_sitemap AND inlinks = 0`).

### Main (`apps/desktop/src/main/crawl/__tests__/crawl-ipc.test.ts`)
- `crawl-csv-written-by-main` — Export CSV asks main's own save dialog, parented to the sender's window
  and offering `crawlCsvFileName`; main writes `CRAWL_CSV_COLUMNS` (the score column headed
  `CRAWL_SCORE_LABEL`) and one line per page the filter selects, in its sort, every cell through
  `csvCell` (a formula-leading title gets its leading `'`; quotes and commas are quoted), CRLF;
  findings are rule ids, notes the page's marks, the fetch time ISO 8601.
- `crawl-csv-reads-in-chunks-and-writes-nothing-unasked` — main reads `CRAWL_CSV_READ_ROWS` rows per
  statement, by id, counting nothing; a cancelled dialog or anything but an absolute path writes nothing;
  a run that is gone is `not-found` before any dialog; a file that cannot be written is `write-failed`,
  logged without its path.
- `crawl-csv-dialog-first-then-a-fixed-set-streamed` — the dialog comes first; then one statement fixes
  the export's rows and order (`pageOrder`), and each batch is appended to the file as it is read; pages
  a running crawl writes meanwhile are not in it, and no row is duplicated or skipped.
- `crawl-csv-one-export-at-a-time` — a second export while one runs is refused `exporting`.
- `crawl-watch-long-polls-changes` — `watch` answers at once when the counter is past the version asked,
  else on the next change (a run created or updated, the running crawl's start or end; a page row alone
  is not one: the run's counts written after it are, one change per page), else, at the router's
  timeout, the current view.
- `crawl-watch-evicts-only-the-same-window` — at most `CRAWL_WATCH.maxPending` polls wait per sender
  window; one more answers that window's oldest early, never another window's.
- `crawl-ipc-passes-the-gate-through` — as shipped, `start` and `resume` answer `unavailable` with
  `LEGAL_GATE_NOTE` and the view says `available: false`; cancel and delete still work.
- `crawl-reads-answer-pages-and-structure` — `pages` and `structure` answer one run's page of rows and
  one tree level with its histogram and orphans (the first `maxOrphansShown` and their total); a run that
  is gone is `not-found`, a failing store `store-failed` (logged by code, never message).

### The router (`packages/ipc-contract/src/__tests__/crawl-router.test.ts`)
- `crawl-router-enforces-sender` — every `crawl.*` procedure (`status`, `watch`, `start`, `pause`,
  `resume`, `cancel`, `delete`, `pages`, `structure`, `exportCsv`) refuses another origin's sender and
  fails closed without the service.
- `crawl-router-inputs-bounded` — strict inputs: run ids are UUIDv7s; settings are
  `CrawlSettingsSchema`'s (no pattern field, no private start outside `host`); pages at most
  `maxPageSize`, from closed filter and sort lists (a finding only a crawl rule); a tree prefix an
  `http(s)` URL ending in `/`; the CSV takes no path or file name (the window id comes from the sender).
- `crawl-router-answers-are-checked` — an answer carrying anything more, or too many rows, is a masked
  internal error.
- `crawl-router-start-passes-the-gate-through` — main's `unavailable` answer and its note reach the
  renderer as sent.
- `crawl-watch-times-out-with-the-current-view` — after `CRAWL_WATCH.timeoutMs` the poll answers the
  current view; main is given the sender's window id (pending polls are counted per window).

### The crawl sheet (`apps/desktop/src/renderer/__tests__/crawl-view.test.ts`)
- `crawl-view-start-form-defaults-to-the-active-tab-site` — the start URL is the active tab's site (its
  origin's root) or the one asked for; scope `host`, no prefixes, `defaultMaxPages`, the default interval,
  sitemaps on; prefixes one per line, literal paths, at most `maxPrefixes`; max pages 1 to `maxPagesCap`.
- `crawl-view-gated-disabled` — with main's view `available: false`, Start and Resume are disabled with
  `LEGAL_GATE_NOTE`; delete, export and cancel stay.
- `crawl-view-injected-open-gate` — with `available: true` (injected), Start and Resume are enabled; a
  running crawl disables Start (busy) and offers Pause and Cancel; finished runs offer delete and export.
- `crawl-view-run-size-and-retention-note` — each run shows its pages, queued, refused and failed counts
  and its size ("X MB fetched": the page count shows once, in the progress line); the sheet says crawl
  data is deleted per run; a slow-down pause says why, and a `robots-unreachable` pause reads "Paused:
  frost could not read the site's robots.txt. Resume to try again." with Resume offered (round 2, item D).
- `crawl-view-status-line-clears-when-the-run-moves-on` — the sheet's status line about a run holds only
  while that run stays in the states it was said for: "Crawl started." while the run is not in main's view
  yet, queued or running; a run action's refusal while the run stays in the state it was asked in. Main's
  view showing the run in any other state (Done, Paused…) clears it. A line not about a run (a start
  refusal, a form problem) holds until the next one.
- `crawl-view-score-label-and-rule-set` — the score column is `CRAWL_SCORE_LABEL`; the rule-set note
  lists the categories used and what is left out with its reason; never "health score".
- `crawl-view-page-flags-and-open-in-tab` — "links cut at 1 000" and "looks client-rendered"; "Open in
  tab" closes the sheet and sends an `http(s)` URL to `browser.navigate`, nothing else.
- `crawl-view-pages-paging-and-filters` — a filter or sort change goes back to the first page; paging
  text and the previous and next offsets.
- `crawl-view-structure` — histogram bars as shares of the tallest; tree labels.
- `crawl-view-progress-long-poll` — each poll passes the last version seen; a failed poll and an answer
  with an unchanged version each rest `CRAWL_WATCH.retryMs` (never a spin); a closed sheet drops the
  poll in flight.
- `crawl-view-robots-verdicts-and-refresh` — the robots.txt column shows the `frost-crawl` and Googlebot
  verdicts; `refreshDelay` reads again at once for another run or state, at most every
  `CRAWL_REFRESH_MS` for new pages, never when nothing changed; a project covering its subdomains starts
  with the `site` scope.
- `crawl-view-answer-texts` — refusals in frost's words; `unavailable` is main's note.
- `crawl-palette-commands` — "Crawl this site…" (an `http(s)` tab: the sheet on its site) and "Show site
  crawl"; neither starts a crawl.
- `crawl-sheet-gated-disabled` — rendered with an injected main view `available: false`: the disclosure
  (`FETCH_DISCLOSURE`) and rule-set note show, Start and Resume are disabled with the note beside them,
  the run's size and the per-run deletion note show, export and delete stay enabled, the run's pages are
  asked for a page at a time with the score column labelled, a cut page is marked, both robots.txt
  verdicts show, the rule set's intro shows outside its details, and "Open in tab" closes the sheet and
  navigates through the address bar's path.
- `crawl-sheet-injected-open-view` — rendered with `available: true`: Start and Resume are enabled and
  send main the form's settings and the run id; main's refusal shows as its note; the Pages / Site
  structure switch is pressed buttons; Site structure shows the tree, the histogram and the orphans.
- `crawl-sheet-started-line-clears-once-the-run-is-done` — after Start, "Crawl started." shows while main's
  view has the run running and clears once the view shows it Done.
- `crawl-and-help-sheets-exclude-each-other` — a Help sheet opening closes the crawl sheet, and the crawl
  sheet opening (from a project's "Site crawl") closes the Help sheet; the project's site and, for a
  project covering its subdomains, the `site` scope fill the form.

### Entry points
- The palette's "Crawl this site…" and "Show site crawl" (`crawl-palette.ts`, registered by
  `CrawlSheet.tsx`, listed in `palette-all-features.test.ts`); a "Site crawl" button in a project's
  header (`SiteCrawlButton`, one line in `Projects.tsx`): the sheet on the project's site (`site` scope
  when the project covers its subdomains), a crawl started there belongs to the project. The sheet is one
  line in `App.tsx`, a Help-sheet frame over the page column: opening it closes Settings, Projects, the
  screenshot editor, History and the Help sheets (`useHelpSheet` subscribes `onCrawlOpened`); any of
  those opening closes it (a Help sheet's `show()` calls `closeCrawl()`, the menu's path included).

## End to end (Task 11: `apps/desktop/e2e/crawl.e2e.ts`)
Against `apps/desktop/e2e/crawl-fixtures.ts`: 50 pages served on loopback under the public-looking name
`crawl.frost-e2e.test` (`--host-resolver-rules` maps it, port included, so start URLs are on port 80;
`--frost-e2e-public-hosts` exempts it from the fetcher's private-address check, so it is crawled as a
public site with the `host` scope, not as a private start). robots.txt for `*`: `Disallow: /private/`,
`Crawl-delay: 1`, a `Sitemap:` line; four sections of nine articles, `/old` (301 to `/new`, same host),
`/missing` (404), `/noindex` (meta robots), `/private/secret` (disallowed), a PDF, and `/orphan` (only
in the sitemap). The site logs every request's arrival and end. One profile, apps relaunched on it; the
scenarios run in order. No network: every name maps to loopback.
- **crawl-gate-closed-as-shipped** — without `--frost-e2e-open-gates`: the sheet's Start is disabled
  with `LEGAL_GATE_NOTE` beside it, and a `crawl.start` sent straight through the IPC bridge answers
  `{ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE }`; nothing is fetched.
- **crawl-runs-pauses-across-a-restart-and-resumes** — with `--frost-e2e-open-gates=crawl`: started
  from the sheet (opened from the palette's "Show site crawl") at the sheet's fastest interval (500 ms)
  with sitemaps on; paused after a dozen fetch calls; the app quits and a new one starts on the same
  profile: the run is still `Paused` and nothing was fetched meanwhile; Resume runs it to `Done`. Every
  page but the disallowed one was fetched, and once only, except that the call still in flight when
  Pause was pressed may be fetched again (its answer is dropped by design: "Once stopped, nothing more is
  … written"); `/private/` was never requested.
- **crawl-pages-and-structure-show-the-site** — Pages lists all 50 rows on one page ("1–50 of 50"):
  `/missing` 404; `/noindex` 200, not indexable; `/private/secret` `blocked-by-robots` with both robots
  verdicts `blocked`; the PDF 200 with no audit; `/old` one row (its same-host hop followed in its call,
  so `/new` has no row of its own). The "Indexable: No" filter keeps the noindex page and drops the home
  page. Site structure shows the origin at the root, opens it to the sections, draws the depth histogram
  and lists `/orphan` among the orphans.
- **crawl-exports-csv-through-mains-dialog** — main's save dialog is answered in main (test-only,
  `dialog.showSaveDialog` replaced through `app.evaluate`, as `agent.e2e.ts` does), so main's own export
  runs: the file's header is `CRAWL_CSV_COLUMNS`, one CRLF line per page (50), each page once.
- **crawl-is-polite-on-the-wire** (K-B1) — from the site's log: the crawl's fetch calls are the
  requests whose user agent carries `frost-crawl/1` (pages and the sitemap; robots.txt comes from main's
  robots fetcher on the audit lane, with the browse user agent, and is not a crawl-lane call), with the
  redirect's second hop folded into its call. Never two calls in flight (each starts after the previous
  one's answer ended); `/old`'s hop to `/new` follows at once (well under the interval); consecutive call
  starts at least the effective interval apart, robots.txt's `Crawl-delay` (1 s) above the sheet's
  500 ms, less 200 ms for the arrival lag the site sees (the median within 50 ms of it). One host name,
  so per-host pacing is per origin here.
- **Observed** (Linux, 2026-11-10): 50 fetch calls, consecutive starts 999–1 002 ms apart (median
  1 000 ms) at the site; the gap across the quit and relaunch about 1.6 s; never two in flight. A fresh
  crawl fetcher after a restart has no pacing state, so the first call after Resume is not held by the
  last one before the quit; the restart itself took longer than the interval.
