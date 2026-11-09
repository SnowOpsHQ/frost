# Feature: rank tracking — the read model

Spec: `specs/rankings.spec.ts` (`SerpObservation`, `SearchKeyOf`, `SiteMatch`, `RANK_OUTCOMES`,
`RankPoint`, `RankRow`, `SavedSearchRef`, `RankTable`, `RANK_RANGES` and `rangeStart`, `RANK_LIMITS`,
`RANK_CSV_KINDS`, `RANK_CSV_COLUMNS`, `RANK_HISTORY_CSV_COLUMNS`, `rankLabel`, `changeLabel`,
`RANK_HISTORY_NOTE` and `rankHistoryNote`, `COMPARE_MOVEMENTS` and the `SerpComparison` types), and
Decisions 3–7 and 15 of `docs/plans/phase-10-projects-rank-tracking.md`. Phase 10 Task 3. Implemented
by `packages/change-intel/src/rankings.ts` (`rankOf`, `rankSeries`, `rankTable`, `rankRowOf`, `rankCsvRows`) and
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

## The table read in parts (`rankRowOf`; Task 5)
- Main reads the table per search (Router, below), so the model also builds one row from its parts:
  `RankRowParts` = the search key, its saved search (or `null`), `recent` (its newest readings, at least
  the two newest, any order; only those of this series count, `SearchKeyOf` for older key versions)
  and `points` (the site's points over the range, already computed, any order). `latest`, `previous`,
  `change` and the competitors' points come from `recent`, whatever the range; `points` are the given
  points within the range (a reading once, oldest first, the newest `maxPointsPerSeries`) and `best` is
  over all of them. `null` with neither a reading nor a saved search. Total: garbage never throws.

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

## Router (Phase 10 Task 5)
Spec: `rankings.spec.ts` (`RANKINGS_REFUSALS`, `RankTableAnswer`, `RankSeriesAnswer`, `ReadingDate`,
`MAX_READING_DATES`, `MAX_RANK_TABLE_READ_BYTES`, `RankTableRow`, `ReadingDatesAnswer`, `CompareAnswer`, `CopyCsvAnswer`, `SaveCsvAnswer`) and
`rankings.schema.ts` (`RankTableInputSchema`, `RankSeriesInputSchema`, `ReadingDatesInputSchema`,
`CompareInputSchema`, `RankCsvInputSchema`; `RankTableSchema`, `RankSeriesSchema`,
`ReadingDatesSchema`, `SerpComparisonSchema` / `CompareAnswerSchema`, `CopyCsvAnswerSchema`,
`SaveCsvAnswerSchema`). Router: `packages/ipc-contract/src/rankings-router.ts` (`RankingsService` in
`rankings-service.ts`); main: `apps/desktop/src/main/changes/rankings.ts`, `rank-csv.ts`,
`rank-dialogs.ts`.
- Six procedures, each `publicProcedure.use(enforceSender)` then `requireRankings` (fails closed
  without the service: a masked internal error), a strict input and a strict answer schema: queries
  `rankings.table` (`projectId`, `range`, `tag?`), `rankings.series` (`projectId`, `searchKey`,
  `range`), `rankings.readingDates` (`projectId`, `searchKey`), `rankings.compare` (`projectId`, `a`,
  `b`); mutations `rankings.copyCsv` and `rankings.saveCsv` (`projectId`, `kind`, `range`, `tag?`).
  No input names a path, a file name, SQL or a reading's text; no procedure name says "query".
- **A live project only.** Every procedure first checks that `projectId` is a live project (Unfiled
  included: its readings rank with no site); otherwise it answers `not-found` (`copyCsv`: `null`)
  and reads nothing else. No procedure reads a row by id alone: `compare` reads each reading by id
  and refuses (`not-found`) unless both belong to that live project; `series` and `readingDates`
  read by the project and the search key.
- **The orphan sweep first.** Before reading, main deletes the project's **capture-sourced**
  readings whose capture is gone (`deleteOrphanReadings(projectId)`); a reading of another source
  (`serp-api`, no capture by design) is never an orphan. A failed sweep is logged and the read goes
  on (the reads skip such orphans too).
- **Every stored reading is parsed on read** with `StoredReadingSchema` (its `snapshot` with
  `SerpSnapshotSchema`), and must name the project asked for; a row that fails is skipped (never
  thrown, never answered). Saved searches are Phase 6's checked parameters (a row that is not is
  skipped), keyed by `SearchKeyOf` with no filters; the site and competitors are the project's
  stored domains (`siteMatchOf`; competitors by owner, subdomains on); a stored value that is not in
  its normalized form is ignored.
- **The table is read per search, bounded** (`MAX_RANK_TABLE_READ_BYTES`, `RankTableRow`):
  1. its rows' keys first: the saved searches (their order, a repeated key once, the tag's only),
     then the searches seen in readings (`readingSearches`, most recently observed first; none with a
     tag), at most `RANK_LIMITS.maxRows` (`truncated` when more);
  2. then, one row at a time: (a) its **two newest readings, whatever the range** (`readings` with
     `limit: 2`), so `latest`, `previous` and `change` never depend on the range nor on how many
     readings the rest of the project holds; (b) how many readings it has in the range
     (`countReadings`, the range pushed into SQL); (c) its **points in the range** (`readings` with
     `from = rangeStart(range, now)`, `limit: RANK_LIMITS.maxPointsPerSeries` and `maxBytes` = what is
     left of the table's byte budget), each reading parsed and reduced to the site's point at once
     (`rankOf`; the snapshot dropped); the row is then built by `rankRowOf` from its newest readings
     (competitors on the latest) and those points;
  3. the budget, `MAX_RANK_TABLE_READ_BYTES` (64 MiB of stored reading bytes over the whole table
     read), counts every reading loaded; once it is spent, the rows still to read get no points beyond
     their newest readings (those in the range);
  4. a row is `capped` when the store held more of its readings in the range than it answered for its
     points (or more than `maxPointsPerSeries`), counted on the rows the store answered **before** any
     was skipped as tampered, so a tampered reading never reads as a cut.
  Copy CSV and Save CSV… take the table from the same read. `series` reads at most
  `maxPointsPerSeries` readings of its search in the range. `readingDates` reads ids, times and
  statuses only (the repository's `readingDates`; no reading JSON), at most `MAX_READING_DATES`, so it
  may list a reading whose JSON is tampered: `compare` refuses that one.
- **Older key versions.** Every read takes a search's stored keys from `readingSearches`: its own,
  and older-version keys whose newest parameters and filters have its key today (`SearchKeyOf`); each
  reading is then filed by the model's rule.
- **Never rejects.** Every service method answers: a database failure is `store-failed` and one log
  line (the error's code or name, never its message: it may hold URLs or SQL). The answer then goes
  through its schema on the way out, so an answer carrying anything more is a masked internal error.

## Export (Phase 10 Task 5; Decision 14)
- **Through main.** `copyCsv` and `saveCsv` build the same table as `rankings.table` (the same
  project, range and tag), take `rankCsvRows(rows, kind)` and format them in main: string cells
  through `@app/seo-core` `csvCell` (the formula guard: a cell starting `=`, `+`, `-`, `@` (or tab or
  CR) gets a leading `'`; quoting per RFC 4180), number cells written as numbers without the guard
  (`-3` stays `-3`), lines joined by CRLF with a final CRLF. Page text (queries, URLs, domains) never
  reaches a spreadsheet as a formula.
- **Copy CSV** writes the text to the system clipboard in main (the chrome has no clipboard access)
  and answers the line count, the header aside; `null` (nothing written) for a project that is not
  live, a database failure, or no clipboard.
- **Save CSV…** asks for the file in **main's own save dialog**, parented to the window that asked
  (else the focused window; with none, app-modal), titled `RANK_CSV_SAVE_DIALOG.title[kind]` ("Save
  rankings as CSV" / "Save rank history as CSV"), with a CSV filter and overwrite confirmation, offering
  `rankCsvFileName(kind, now)` (`RANK_CSV_FILE_NAME`: `frost-rankings-YYYY-MM-DD.csv`,
  `frost-rank-history-YYYY-MM-DD.csv`) in the Downloads folder. The renderer never names a path or a
  file name. The table is read first (a project that is not live is refused before any dialog);
  cancelling, or a dialog answering anything but an absolute path, writes nothing (`cancelled`); the
  file is written only where the user chose, owner-only (`writeOwnerOnly`): opened without truncating
  (`O_WRONLY | O_CREAT`, created `0o600`), set to `0o600` (a file that already existed too; POSIX; a
  file system refusing it with `EPERM`, `ENOTSUP` or `EINVAL` is let be), and only then emptied and
  written, so any other failure leaves an existing file as it was. It answers `saved` with the line
  count; a write that fails is `write-failed` (one log line, never the path).

## The views (Phase 10 Task 6)
Spec: `rankings.spec.ts` (`RANK_TABLE_COLUMNS`, `RANK_RANGE_LABELS`, `DEFAULT_RANK_RANGE`,
`RANK_VIEW_TEXT`, `COMPARE_MOVEMENT_LABELS`, `RANKINGS_REFUSAL_MESSAGES`, and the wording above) and
`projects.spec.ts` (`PROJECT_VIEWS`). The Projects sheet's **Rankings** and **Compare** views
(`projects.feature.md`, The sheet), over the page column (the SEO sidebar left and the agent right are
unchanged). Pure view model: `apps/desktop/src/renderer/rankings-view.ts`; components:
`components/changes/Rankings.tsx`, `Compare.tsx`; IPC wrappers: `renderer/ipc.ts` (`rankingsActions`).
- **Untrusted text stays text.** Queries, titles, URLs and domains are React text (in a `<bdi>`), never
  HTML; a URL is a tooltip through `isolatedTooltip`. The trend line is an inline SVG `<polyline>` whose
  `points` are built from numbers only (the `ranked` points' positions and their indices), never from
  a string of the reading.
- **The table** (`rankings.table` with the view's range and tag): one row per tracked search (saved
  searches first, as main answers), columns `RANK_TABLE_COLUMNS` (search, engine, locale, device,
  filters, tags, position, change, best, trend, last checked), then one column per competitor (its
  domain, its position on the latest reading). Position is `rankLabel(latest)` (`3`, `p2 · 3`, `> 10`,
  `Unknown`, `Unreadable`, `No site set`, `No reading`); change is `changeLabel`; best is the best
  position in range (`—` with none); last checked the latest reading's time (`Never`). A row whose
  latest point is also in SERP features says so ("Also in …"). A row `capped` by main carries
  `RANK_VIEW_TEXT.capped` as its hint (`data-capped`). `truncated` says `RANK_VIEW_TEXT.truncated`.
- **Filters.** A range (`RANK_RANGES`, `RANK_RANGE_LABELS`, opening on `DEFAULT_RANK_RANGE`) and a tag
  (`All searches`, then the project's tags as main answers them). A tag the project no longer has is
  dropped from the request (all searches); the rows shown keep only searches carrying the tag. With a
  tag and no row: `RANK_VIEW_TEXT.noTagged`.
- **Empty states.** No site set (`site` `null`): "Set your site's domain to see its position", with a
  button (`rankings-open-settings`, Phase 10 Task 7) that opens the project's Settings view. No row
  with a reading: "No readings yet: capture a search or run Check rankings". Both may show.
- **History note.** When the project keeps limited history (retention `versions` or `days`) the view
  shows `rankHistoryNote(retention)`; with `forever` only `RANK_HISTORY_NOTE.profile` (positions are as
  the signed-in browser profile sees them), always.
- **Series.** Activating a row (its search button: click, Enter or Space) opens the series below the
  table (`rankings.series`, the same range): one line per reading, newest first, with its date, its
  position (`rankLabel`) and the URL of the site's result (inert text, or `—`), and "Also in …".
  **Open this result page** loads the row's canonical search URL (`params.url`) in the active tab
  through `browser.navigate` (the address bar's path and browse guards), only when it is `http(s)`,
  closing the sheet; it is disabled while a run is under way. Nothing else in the views navigates.
- **Export.** "Copy CSV" (`rankings.copyCsv`) and "Save CSV…" (`rankings.saveCsv`, main's own dialog)
  export the view's range and tag, as the table (`table`) or every reading (`history`), chosen in an
  Export select (`RANK_VIEW_TEXT.exportKinds`); the outcome goes to the sheet's status line
  (`Copied n rows as CSV.`, `Nothing was copied.`, `Saved n rows as CSV.`, `Nothing was saved.`, or the
  refusal's `RANKINGS_REFUSAL_MESSAGES`).
- **Compare.** Two pickers, A (left) and B, each a search (the table's rows) and a date of it
  (`rankings.readingDates`, newest first; an unreadable reading says so). They open on the first
  search, A on its second-newest reading and B on its newest. "Compare" (`rankings.compare`) is
  enabled with two different readings picked. The answer shows each side (search and date), the
  site's own position on each side, the domains (`compareViewRows`: A's and B's positions, `—` when
  absent, the movement `COMPARE_MOVEMENT_LABELS`, the site and competitors marked) and the SERP
  features on each side. `truncated` says `RANK_VIEW_TEXT.compareTruncated`.
- **Refusals.** A refused read shows `RANKINGS_REFUSAL_MESSAGES[reason]`; an IPC failure shows the
  `store-failed` wording. Nothing throws into the sheet. In Compare a refused table read or dates read
  says its own refusal (never "No readings yet"); a failed dates read clears that side's pick.
- **Compare keeps its state across a refresh.** When the project is read again (a run captured), the
  dates shown stay while they are read again, the picks stay while they are still among them, and the
  result stays; picks reset only for a changed search or a failed read. One search on both sides is one
  dates read. A comparison that answers after the picks changed is dropped.
- **Focus.** Closing a search's series gives focus back to the row button it was opened from.
- **Keyboard.** Every control is a real `<button>`, `<select>` or `<label>`ed input, in reading order;
  the view switch is a tablist; the trend SVG is `role="img"` with an `aria-label` from numbers.
- **Hooks** (e2e): `data-testid` `rankings-view`, `rankings-range`, `rankings-tag`, `rankings-row`
  (`data-key`, `data-outcome`, `data-capped`), `rankings-row-open`, `rankings-trend`, `rankings-series`,
  `rankings-series-point`, `rankings-open-result`, `rankings-export-kind`, `rankings-copy-csv`,
  `rankings-save-csv`, `rankings-no-site`, `rankings-no-readings`, `rankings-history-note`;
  `compare-view`, `compare-search-a`, `compare-date-a`, `compare-search-b`, `compare-date-b`,
  `compare-run`, `compare-row` (`data-domain`, `data-movement`, `data-role`), `compare-feature`.

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
- **Scenario: rank-table-reads-live-project-only** — `table`, `series`, `readingDates`, `compare` and
  the exports answer `not-found` (or `null`) for a deleted project, an unknown id and another project's
  readings; a live project's table holds only its own readings, with its retention, site, competitors
  and tags. (`apps/desktop/src/main/changes/__tests__/rankings.test.ts`)
- **Scenario: tampered-reading-skipped** — a stored reading whose JSON does not parse, whose snapshot
  fails `SerpSnapshotSchema` or whose row disagrees with its snapshot is skipped by the table, series,
  exports and compare (the row not `capped` for it), the rest answered; the dates may list it, never
  compare it. (`rankings.test.ts`)
- **Scenario: orphan-reading-ignored-and-swept** — a capture-sourced reading whose capture is gone is
  in no answer and is deleted by the read's sweep; a capture-less reading of another source is kept and
  read. (`rankings.test.ts`)
- **Scenario: compare-refuses-readings-of-another-project** — `compare` with a reading of another
  project (or a deleted one, or an unknown id) is `not-found`; two readings of the project compare.
  (`rankings.test.ts`)
- **Scenario: rankings-never-reject** — a database that throws gives `store-failed` (`null` for Copy
  CSV), one log line without the error's message. (`rankings.test.ts`)
- **Scenario: rank-csv-uses-csv-cell** — a query or URL starting `=`, `+`, `-`, `@` is written with a
  leading `'`; numbers (a negative change) are not; CRLF lines. (`rank-csv.test.ts`)
- **Scenario: rank-csv-copies-through-main** — Copy CSV writes main's clipboard and answers the line
  count; nothing written for a project that is not live. (`rank-csv.test.ts`)
- **Scenario: rank-csv-save-asks-for-the-path** — Save CSV… asks main's dialog (the offered name is
  `rankCsvFileName`), writes only to the chosen file, owner-only (a new file and an existing one); a
  refused mode change (`EPERM`) still writes; another failure leaves an existing file's content; Cancel
  writes nothing; no input names a path. (`rank-csv.test.ts`, `rankings-router.test.ts`)
- **Scenario: rank-table-latest-is-independent-of-history-size** — a saved search whose readings are
  older than the newest `MAX_READINGS_PER_READ` of the project still shows its latest, previous and
  change (in any range); a search with more than `maxPointsPerSeries` readings shows that many points
  and is `capped`. (`rankings.test.ts`)
- **Scenario: rank-table-read-is-bounded** — the points reads ask for no more than what is left of the
  byte budget and load no more than it; once it is spent the later rows keep their latest, get no
  points beyond their newest readings and are `capped`. (`rankings.test.ts`)
- **Scenario: rank-csv-bounded** — every read is of one search, at most `maxPointsPerSeries`; the table
  export has at most `RANK_LIMITS.maxRows` lines; series and dates are bounded. (`rank-csv.test.ts`)
- **Scenario: rank-row-from-parts** — `rankRowOf` builds a row from its newest readings and its points:
  latest and change whatever the range, points in range (a reading once, newest `maxPointsPerSeries`),
  best over them, competitors on the latest; total. (`packages/change-intel/src/__tests__/rankings.test.ts`)
- **Scenario: every-rankings-procedure-enforces-sender** — each procedure refuses a foreign sender
  before its input or service, and fails closed without the service. (`rankings-router.test.ts`)
- **Scenario: rankings-inputs-are-validated** — unknown keys (a `path`), bad ids, keys, ranges, kinds
  and tags never reach the service. (`rankings-router.test.ts`)
- **Scenario: rankings-answers-are-checked** — an answer with an extra field or out of bounds is a
  masked internal error. (`rankings-router.test.ts`)
- **Scenario: compare-is-bounded** — readings with hundreds of organic domains answer at most
  `maxRows` rows with `truncated`, keeping the site's and competitors' rows; garbage never throws.
  (`compare.test.ts`)
- **Scenario: rank-row-view** — a table row as the view shows it: each outcome's position label
  (`rankLabel`, `> n` when not found), the change text and its direction, best (`—` with none),
  locale, device, filters and tags, last checked (`Never`), competitors' positions in the project's
  order, "Also in", the capped hint, and the openable URL (`http(s)` only).
  (`apps/desktop/src/renderer/__tests__/rankings-view.test.ts`)
- **Scenario: trend-points-from-numbers** — the trend's `points` come from the `ranked` points'
  positions and indices only (digits, `.`, `,` and spaces, whatever the titles or URLs hold); best at
  the top; a single position is a dot; a series with no position draws nothing; its label is numbers.
  (`rankings-view.test.ts`)
- **Scenario: range-and-tag-filter** — the request carries a known range (else
  `DEFAULT_RANK_RANGE`) and a tag only while the project has it; the options list every range and
  `All searches` then the tags; the rows shown keep only those carrying the tag. (`rankings-view.test.ts`)
- **Scenario: history-note-follows-retention** — `versions` and `days` show `rankHistoryNote`,
  `forever` only the profile note; the empty states follow `site` and the readings.
  (`rankings-view.test.ts`)
- **Scenario: compare-view-rows** — comparison rows with each side's position (`—` when absent), the
  movement label (`Up 2`, `Down 1`, `Same`, `New`, `Gone`), roles; the feature rows; the side labels;
  the date options and the default picks; the Compare button's readiness. (`rankings-view.test.ts`)
- **Scenario: compare-shares-one-dates-read** — one search on both pickers reads its dates once (A the
  second-newest, B the newest); another search on B reads its own.
  (`apps/desktop/src/renderer/__tests__/rankings-components.test.ts`)
- **Scenario: compare-keeps-picks-on-refresh** — a refresh keeps the dates, picks and result while it
  reads, and keeps the picks still listed after. (`rankings-components.test.ts`)
- **Scenario: compare-drops-a-stale-answer** — a comparison answering after a pick changed is not shown.
  (`rankings-components.test.ts`)
- **Scenario: compare-says-refusals** — a refused table read shows `RANKINGS_REFUSAL_MESSAGES[reason]`,
  not the empty state; a refused dates read says so and Compare waits. (`rankings-components.test.ts`)
- **Scenario: series-close-returns-focus** — closing the series focuses its row's button.
  (`rankings-components.test.ts`)

## End to end (`apps/desktop/e2e/rankings.e2e.ts`; plan Task 11)
Over the built app, loopback only (`apps/desktop/e2e/rank-fixtures.ts`): frost's own synthetic result
pages on `search.frost-e2e.net` (a query's first request has the site third, every later request has
it second, a new domain third and another one down), a challenge page, and the signed test pack and
key of `serp-fixtures.ts` through the unpackaged-only `--frost-e2e-serp-pack-url` /
`--frost-e2e-serp-pack-key` seams. `--host-resolver-rules` maps the engine and the result domains (the
site `leafhouse-frost-e2e.net`, the competitor `brewguide-frost-e2e.net`, two others) to `127.0.0.1`,
all named in `--frost-e2e-public-hosts` (never `.example`, which is not public), and
`www.perplexity.ai`, `chatgpt.com`, `www.google.com` and then every other name (`MAP * ~NOTFOUND`) to
`~NOTFOUND`. The result domains are mapped to loopback so nothing of theirs reaches the network, but
nothing listens on their ports, so the fixture server cannot count a request for one. It records every
request on its own port: each scenario checks none was for a host other than the engine's, and the
scenarios that must send nothing check its count did not move. No run is started (saved
searches use the bundled pack's real engines): the disclosure, pacing and challenge stop are
unit-tested (`projects.feature.md`, Searches in a run).
- **Scenario: rankings-two-captures-show-change** — a project with the site and the competitor
  (Settings); the synthetic result page captured into it from the Changes panel, reloaded (a new
  order) and captured again: Rankings shows position `2`, change `+1` (up), a trend of two points
  (best 2, worst 3), the competitor's column at `1`, and the series lists both readings newest first.
- **Scenario: rankings-compare-two-dates** — Compare opens on the search with A the older reading and
  B the newer; the comparison shows the site `up` (role `site`), the competitor `same` (role
  `competitor`), a domain `new` and one `down`.
- **Scenario: rankings-copy-csv** — a second search whose query starts with `=` is captured; Copy CSV
  writes main's clipboard (read in main): CRLF lines, the header (`RANK_CSV_COLUMNS` then the
  competitor's host) and two rows; the `=` query is written `"'=…"` (guarded, quoted), the other row's
  position, change, best and competitor cells are plain numbers. (Titles are not exported, so the
  guarded cell is the query.)
- **Scenario: projects-bulk-add-with-tags** — Bulk add with three lines, one locale and two devices and
  a tag: three lines `added`, six saved searches each carrying the tag; Rankings lists them first
  (`No reading`) and, filtered by the tag, only them; the fixture server saw no request and no tab
  opened.
- **Scenario: serp-editor-applies-country-and-language** — on page 3 of a synthetic search, Edit
  search sets country and language: the tab loads the same origin (its port too) and path with the
  query and the pack's `gl`/`hl` names only, page 1 (`serp-panels.feature.md`, Edit search).
- **Scenario: serp-open-in-perplexity** — the panel's Perplexity button opens a background tab whose
  address is `aiDestinationUrl` of the tab's query; the result page stays in front; the host does not
  resolve, so the tab ends on its load error and nothing reached the fixture server
  (`serp-panels.feature.md`, Open in an AI engine).
