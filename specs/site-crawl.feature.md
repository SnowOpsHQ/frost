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
*Scenarios for the frontier, max pages and depth, pause / resume / quit / crash, sitemap seeding,
the snapshot adapter, the context, the audit and project deletion: Task 6b.*

## Pages and Site structure (Task 7)
*UI scenarios, `CRAWL_PAGE_FILTERS`, `CRAWL_PAGE_SORTS`, `CRAWL_CSV_COLUMNS` and the sheet's rule-set
note: Task 7.*
