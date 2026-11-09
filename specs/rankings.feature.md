# Feature: rank tracking — the read model

Spec: `specs/rankings.spec.ts` (`SerpObservation`, `SearchKeyOf`, `SiteMatch`, `RANK_OUTCOMES`,
`RankPoint`, `RankRow`, `SavedSearchRef`, `RankTable`, `RANK_RANGES` and `rangeStart`, `RANK_LIMITS`,
`RANK_CSV_KINDS`, `RANK_CSV_COLUMNS`, `RANK_HISTORY_CSV_COLUMNS`, `rankLabel`, `changeLabel`,
`RANK_HISTORY_NOTE` and `rankHistoryNote`, `COMPARE_MOVEMENTS` and the `SerpComparison` types), and
Decisions 3–7 and 15 of `docs/plans/phase-10-projects-rank-tracking.md`. Phase 10 Task 3. Implemented
by `packages/change-intel/src/rankings.ts` (`rankOf`, `rankSeries`, `rankTable`, `rankCsvRows`) and
`compare.ts` (`compareSerps`): pure TypeScript over the Zod-free shapes (no I/O, no Zod, no `URL`, no
hash, no `*.schema.ts`), so main (Task 5) and any later reader compute positions the same way for any
source. Each scenario maps to one named test in `packages/change-intel/src/__tests__/rankings.test.ts`
or `compare.test.ts`.

## Inputs
- **Readings** are `SerpObservation`s, whatever their `source` (`capture` now, `serp-api` in Phase 12):
  the source never changes a point. Main has already parsed each row with `StoredReadingSchema`; the
  model still takes **any** array and never throws: a value that is not an observation (no string
  `id` or `searchKey`, no finite `observedAt`, no `params` object) is skipped, a second observation
  with an `id` already seen is skipped, and a snapshot that is not a `ready` reading with a results
  list reads as `unreadable`.
- **The site** is a `SiteMatch` main computes from the project's stored domain (`owner` = Phase 3's
  `ownerDomain`, `host` = the domain as set, `subdomains` = the project's switch), or `null` when the
  project has none. **Competitors** are `SiteMatch`es too (subdomains on), at most
  `MAX_PROJECT_COMPETITORS` (the first ones; a repeated `host` counts once), keyed by `host`.
- **Saved searches** are `SavedSearchRef`s with the key main computed for them (`SearchKeyOf` with no
  filters), in the order the project lists them.

## What a position is (Decision 6)
- The site's **best organic position on the page read**: the smallest `position` of an `organic`
  result that matches the site. Ads never count; SERP features never count as a position.
- `alsoIn`: the SERP feature types (`featured-snippet`, `ai-overview`, …) with a result that matches
  the site, in page order, each once — listed as "also in", whatever the outcome.
- `organicRead`: the organic results on the page read; `page`: the reading's result page
  (`params.page`; 1 when it is not a positive whole number).
- Outcomes (`RANK_OUTCOMES`): `ranked` (a match); `not-found` (no match and `ownership.complete`: every
  organic result was read; shown `> n`, n = `organicRead`); `unknown` (no match, and a reader cap cut
  organic results, or the reading says nothing of it); `unreadable` (the reading is `unreadable` or
  not a reading); `no-site` (no site set: whatever the reading, no position is computed and `alsoIn` is
  empty).
- A page-2+ reading keeps its page: `rankLabel` shows `p2 · 3` (or `p2 · > 10`), never an absolute
  rank.

## Whose result it is (Decision 7)
- **A result without a domain never matches**, in either mode: Phase 3 gives `domain: null` to a link
  it could not use (an engine redirect it could not unwrap or decode), so such a result is never the
  site's, whatever its `url` says.
- **Include subdomains on** (the default): a result matches when its `domain` (Phase 3's owner domain,
  already on every result) equals `site.owner` (compared lowercase, one trailing dot ignored).
- **Off**: a result matches when its URL's **host** equals `site.host`, after removing **one** leading
  `www.` from both: `example.com` matches `www.example.com` (and the reverse), not `shop.example.com`
  nor `www.www.example.com`. The model has no `URL` global (plain ECMAScript), so it takes the host from
  the result's `url` with a small string parser: the text after `scheme://` up to the first `/`, `?` or
  `#`, without any `user@` part (everything up to the **last** `@`) or `:port`, lowercase, one trailing
  dot removed; that text holding a `\` gives no host (`URL` never writes one there, and parsers
  disagree on it). That is exact for the stored URLs, which Phase 3 already wrote through `URL`
  (`href`: a lowercase, punycode host), and a result whose `url` is `null` or has no host never
  matches. So another host dressed up as the site never matches: `https://example.com@evil.com/`,
  `https://example.com\@evil.com/`, `https://example.com;@evil.com/`, `https://evil.com/p@example.com`,
  `https://evil.com/?x=@example.com`. The result's `domain` is not used here:
  it is the owner, not the host.
- Competitors are matched the same way (their `SiteMatch`), from the same readings, so adding one shows
  its history at once.

## Series, change and best
- A **series** is the readings of one search key, oldest first by `observedAt` (then `id`), at most the
  newest `RANK_LIMITS.maxPointsPerSeries` of the range.
- **The range** (`RANK_RANGES`): a point is in range when `observedAt >= rangeStart(range, now)`
  (`now` minus 7, 30, 90 or 365 days; `all` keeps every point). The options' type requires `now`
  whenever `range` is set (`RankRangeOptions`), so a caller cannot ask for a range and silently get
  every point; at run time an unknown range or a `now` that is not a finite number still keeps every
  point rather than throwing.
- `latest` and `previous` are the two newest readings of the search, **whatever the range**, so
  "change since the last check" means the same in every range; `points` are the range's (the newest
  `maxPointsPerSeries`), and `best` is the best `ranked` position over **every** reading in the range,
  taken before that cut.
- **Change** (`changeLabel`): only between two `ranked` points, `previous.position −
  latest.position` (positive: moved up; `+2`, `-3`, `0`); `ranked → not-found` is `lost`;
  `not-found → ranked` is `new`; anything else (`unknown`, `unreadable`, `no-site` on either side, or a
  single reading) has no change (`null`, shown empty).

## The search key and its version (Decision 4)
- A reading is filed under its stored `searchKey` when its `searchKeyVersion` is `SEARCH_KEY_VERSION`
  or absent. A reading of **any other version** is filed under the key its stored `params` and
  `filters` have today: the model calls the injected `SearchKeyOf` (main's: SHA-256 hex of
  `searchIdentityJson(params, filters, searchHostOf(params.url))`; hashing and `URL` stay in main). With
  no `SearchKeyOf`, or when it answers `null`, throws or answers no string, the reading keeps its stored
  key (its own series). The stored key is never rewritten (readings are append-only).
- A row takes its `params` and `filters` from its newest reading (a saved search with no reading: its
  own).

## The table (Decision 5)
- Rows: every saved search first, in the order given (a second saved search with a key already listed
  is skipped), each with its readings if any; then every search seen only in readings, newest latest
  reading first (then key). At most `RANK_LIMITS.maxRows` rows; `truncated` says when more were cut.
- `tag`: when set, only saved searches carrying that tag (searches seen only in readings have no tags).
- `competitors` of a row: each competitor `host` → its point on the row's latest reading, `null` with
  no reading.

## CSV rows (`rankCsvRows`; Task 5 formats them)
- Plain arrays of strings and numbers, the header first; no cell escaping or formula guard here
  (Task 5 applies `csvCell` to string cells). Number cells (page, position, change, best, organic
  results read, competitor positions) stay numbers: Task 5 writes them as numbers without the formula
  guard, so a negative change is `-3`, not `'-3`. Dates are ISO 8601 UTC (`toISOString`); a time that is not a valid date is
  an empty cell. Filters are `name=value` pairs joined by a space, tags joined by `; `.
- `table`: `RANK_CSV_COLUMNS`, then one column per competitor host (first seen order over the rows),
  one line per row: outcome id, position (a number, or empty), change (a number, `new`, `lost` or
  empty), best, the latest point's URL and time; a competitor cell is its position when `ranked`, else
  empty.
- `history`: `RANK_HISTORY_CSV_COLUMNS`, one line per point of each row (oldest first): time, outcome,
  position, organic results read, URL and `alsoIn` joined by `; `.

## Comparison (`compareSerps`)
- Two readings, A (the left pick) and B: two dates of one search or two searches. Per **owner domain**
  (`domain` of organic results, as Phase 3's ownership groups them) its best organic place on each side;
  movement (`COMPARE_MOVEMENTS`): on both, `up` (better on B), `down`, `same`, with `change` = A − B;
  only on B `new`; only on A `gone`. An unreadable side has no organic results.
- Rows sorted by B's position, then the `gone` rows by A's position, then by domain.
- `role`: `site` for the site's owner domain, `competitor` for a competitor's (the site wins a tie).
  The site's own points (`site.a`, `site.b`) use the full Decision 7 rule, `null` with no site.
- `features`: each SERP feature type on either page, each once, in order of first appearance (A's
  page order, then B's), with whether each side has it. A side's own `features` list its page's types
  the same way.
- Bounded: at most `RANK_LIMITS.maxRows` rows (the site's and competitors' rows are always kept), with
  `truncated`; never throws.

## Wording
- `rankLabel`: `3`, `p2 · 3`, `> 10`, `p2 · > 10`, `Unknown`, `Unreadable`, `No site set`, and
  `No reading` for a search without one. `changeLabel`: `+2`, `-3`, `0`, `new`, `lost`, empty.
- `RANK_HISTORY_NOTE` / `rankHistoryNote(policy)`: how far back history reaches under the project's
  retention (a reading lives as long as its capture, Decision 15), and that positions are as your
  signed-in browser profile sees them.

## Scenarios
- **Scenario: rank-of-ready-reading** — a ready reading with an ad and a featured snippet for the site
  before its organic results at 4 and 7 answers `ranked` 4 with that result's URL, `organicRead` the
  organic count, `alsoIn` `['featured-snippet']`; a reading where only an ad and a feature are the
  site's is `not-found` with the feature in `alsoIn`. (`rankings.test.ts`)
- **Scenario: rank-subdomain-rule** — subdomains on: `shop.example.com` counts for `example.com`; off:
  `www.example.com` and `example.com` match each other, `shop.example.com` and `www.www.example.com`
  do not, a port or `user@` in the URL is ignored; a result with no domain matches in neither mode;
  the five "evil host" URLs above match in neither mode. (`rankings.test.ts`)
- **Scenario: rank-not-found-vs-unknown** — no match with `ownership.complete` is `not-found` (`> n`),
  without it `unknown`. (`rankings.test.ts`)
- **Scenario: rank-unreadable** — an `unreadable` reading, and garbage in place of a snapshot, are
  `unreadable`, with no position. (`rankings.test.ts`)
- **Scenario: rank-no-site** — no site: `no-site`, no position, no `alsoIn`, whatever the reading.
  (`rankings.test.ts`)
- **Scenario: rank-page-two-keeps-page** — a page-2 reading answers its page-local position with
  `page: 2`, shown `p2 · 3`. (`rankings.test.ts`)
- **Scenario: rank-change-and-best** — ranked 5 → 3 is `+2`; 3 → 6 is `-3`; ranked → not-found `lost`;
  not-found → ranked `new`; unreadable or unknown on either side no change; `best` is the best ranked
  reading in range, even one older than the newest `maxPointsPerSeries` points; `latest`/`previous`
  ignore the range; a range without `now` does not type-check. (`rankings.test.ts`)
- **Scenario: rank-range-filters-points** — `rangeStart` per range; `7d` keeps only the last seven
  days' points; a series keeps at most `maxPointsPerSeries` (the newest). (`rankings.test.ts`)
- **Scenario: rank-table-saved-first-then-observed** — saved searches first in their order (one with no
  reading has `latest` `null`), then observed-only searches newest first; `tag` keeps tagged saved
  searches only; at most `maxRows`, with `truncated`. (`rankings.test.ts`)
- **Scenario: rank-competitor-columns** — each competitor's point on the latest reading, keyed by host,
  `null` without a reading; competitors cut to `MAX_PROJECT_COMPETITORS`. (`rankings.test.ts`)
- **Scenario: rank-ignores-serp-api-or-capture-alike** — the same snapshot from either source answers
  the same point, in the same series. (`rankings.test.ts`)
- **Scenario: rank-old-key-version-regrouped** — a reading of an older key version with a stale stored
  key joins the series its parameters and filters have today (through `SearchKeyOf`); without one it
  keeps its own; a throwing `SearchKeyOf` changes nothing. (`rankings.test.ts`)
- **Scenario: rank-model-is-total** — garbage observations, saved searches and options never throw,
  and duplicate ids count once. (`rankings.test.ts`)
- **Scenario: rank-csv-rows** — the table header is `RANK_CSV_COLUMNS` plus competitor hosts, cells are
  plain strings and numbers with ISO dates; the history export has one line per point under
  `RANK_HISTORY_CSV_COLUMNS`. (`rankings.test.ts`)
- **Scenario: rank-labels-and-history-note** — `rankLabel`, `changeLabel` and `rankHistoryNote` say
  what this file says. (`rankings.test.ts`)
- **Scenario: compare-two-readings** — per domain `up`, `down`, `same`, `new`, `gone` with `change`;
  features present on each side; site and competitors flagged; the site's points per side.
  (`compare.test.ts`)
- **Scenario: compare-is-bounded** — readings with hundreds of organic domains answer at most
  `maxRows` rows with `truncated`, keeping the site's and competitors' rows; garbage never throws.
  (`compare.test.ts`)
