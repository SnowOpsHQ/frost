# Feature: SERP overlay

Spec: `specs/serp.spec.ts` (`SERP_WORLD_ID`, `SERP_READ_LIMITS`, `SERP_READ_TIMEOUT_MS`,
`SERP_ANALYSIS_TIMEOUT_MS`, `SERP_UNREADABLE_REASONS`, `SERP_READ_FAILURES`,
`SERP_UNREADABLE_MESSAGES`, `SERP_DEVICES`, `SERP_DEVICE_LABELS`, `SERP_DEVICE_OF_PRESET`,
`SERP_PARAM_LIMITS`, `SERP_FEATURE_TYPES`), `specs/serp-search-params.schema.ts`
(`SearchParamsSchema`), `specs/serp-snapshot.schema.ts` (`SerpReadSchema`, `SerpSnapshotSchema`)
and the selector pack (`specs/serp-selector-pack.spec.ts`, `serp-selector-pack.schema.ts`). Phase 3
Task 3 (Reading and Analysis; Task 4 adds Router and Outlines); review focus
`serp-reader-is-bounded`. Each line maps to one named test.

## Decisions
- **Only pages the user loads.** frost reads a result page only when the user has loaded it in a
  tab; it never requests a search engine itself. Detection is the URL alone.
- **Detection is exact.** `http:` / `https:` only; the host one of an engine's `hosts` exactly
  (lowercase, a trailing dot ignored, the port ignored); the pathname one of its `paths` exactly; a
  query parameter present with a non-blank value. So `google.com/maps`, `bing.com/images/search`,
  `duckduckgo.com/?q=` and a subdomain of a listed host are not result pages. `html.duckduckgo.com`
  submits its form as a POST, so its result URL can carry no `q`: no query, no match.
- **Search parameters by the pack's names.** The query is the first query name present with a
  non-blank value, whitespace collapsed, cut to `maxQueryChars`. `gl` and `hl` are the first of
  their names present with a well-formed value (letters, digits, `-`, `_`, at most
  `maxLocaleChars`), lowercased; otherwise `null`. The page is 1 unless the pack's page parameter
  holds a whole number: an offset counts from `offsetBase` in steps of `perPage` (Google's `start`
  from 0, Bing's `first` from 1), a page parameter is the number itself; the result is clamped to
  1 … `maxPage`. The device is the tab's render profile's (`SERP_DEVICE_OF_PRESET`: no emulation is
  `desktop`).
- **One fixed reader, the pack as JSON arguments.** `readSerp` is serialised with
  `String(readSerp)` and its arguments `JSON.stringify`'d (never a selector spliced into code), and
  runs only in the tab's isolated SERP world (`SERP_WORLD_ID`).
- **Fail closed, never guess.** Every selector in the layout is checked first (an invalid one:
  `bad-selector`); the `results` anchor must match (`no-container`); a `required` block that takes
  no result, or a page where no block takes any, is `no-results`. There is no heuristic fallback.
- **What is read.** Text only (text nodes, `script`/`style`/`template`/`noscript` skipped, whitespace
  collapsed, at most `maxTextReadChars` read and `maxTitleChars` kept) and the resolved `href` of an
  HTML link (`http:` / `https:`, at most `maxUrlChars`; an SVG link's animated `href` object, a
  `javascript:` link or an over-long one is no link). Organic results and ads need a link; any item
  needs a title or a link.
- **Precedence.** Blocks are read in pack order. An item is skipped when it lies inside a container
  of another block that is itself inside this block's container (the most specific block wins), or
  when it is, or is inside, an item already taken (pack order, then document order: nested matches
  count once).
- **Document order.** The items taken are sorted by document order (`compareDocumentPosition`);
  consecutive items of one block and container form one answered block, with the union of their
  boxes (document coordinates) when they have them.
- **Bounded** (review focus `serp-reader-is-bounded`). At most `maxContainersPerBlock` containers
  per block, `maxResults` results and `maxBlocks` blocks (past them: `truncated`), `maxNodesVisited`
  node visits and `budgetMs` of time (past them: `timeout`, with what was read). Every DOM read is
  inside `try`/`catch`: an item that throws is skipped. The answer is validated again in the worker.
- **The analysis runs in a worker of its own.** `serp-analysis.cjs` (`worker_threads`, no Electron)
  validates the answer and the search parameters, assigns ranks, positions and feature slots,
  counts the composition and groups the organic results by registrable domain, then validates the
  snapshot. One job at a time; past `SERP_ANALYSIS_TIMEOUT_MS` the worker is terminated
  (`timeout`) and the next job spawns a new one; a crash is `invalid-answer`.
- **Positions.** `rank` is a result's place among all results on the page; `position` counts organic
  results (1 … n) and, separately, ads; each feature block takes a `featureSlot` in document order.
  Positions are the page's own (page 2 starts at 1 again; `params.page` says which page).
- **Ownership.** The page's organic results by registrable domain: count, share of the organic
  results, positions, best position; sorted by count, then best position. Ads are not counted (paid
  placements, and their links usually go through the engine's redirect).

## Detection (`apps/desktop/src/main/serp/__tests__/engines.test.ts`)
- `serp-params-per-engine` — Google `q`/`gl`/`hl`/`start` (page 3 at `start=20`), Bing `q`/`cc`/`setlang`/`first` (page 2 at `first=11`), DuckDuckGo `q`/`kl` (no `hl`, page 1); values lowercased; an engine's label and id; the URL kept.
- `serp-params-normalised` — the query collapsed, trimmed and capped; a blank `gl`/`hl` falls to the next name; a malformed or over-long one is `null`; a page that is not a whole number is 1; a huge one is clamped to `maxPage`; every result valid against `SearchParamsSchema`.
- `serp-non-serp-never-matched` — `google.com/maps`, `bing.com/images/search`, an empty or blank `q`, no `q`, a subdomain or a suffix of a listed host, a path prefix, `ftp:` / `file:` / `javascript:` URLs, a malformed or over-long URL are `null`; case and a trailing dot on the host still match.
- `serp-device-from-render-profile` — no emulation and the desktop preset are `desktop`, the phone `mobile`, the tablet `tablet`; the device is recorded in the parameters.

## Reading (`read-script.test.ts`, under jsdom, on synthetic fixtures in `__tests__/fixtures/`)
- `serp-reader-reads-fixtures` — on each engine's synthetic page the blocks come back in document order with their types, titles and links: Google's ads, featured snippet, organic results around related questions and videos, knowledge panel and related searches; Bing's ads, answer, organic and related searches; DuckDuckGo's ad and organic results.
- `serp-reader-dedupes-nested` — a featured snippet's link is not also organic; nested organic matches count once; an element two blocks match goes to the earlier block.
- `serp-unreadable-never-guesses` — a page without the results anchor is `no-container`; a page whose required block takes nothing (results present but in an unknown layout) is `no-results`, as is one where no block takes anything; nothing is guessed.
- `serp-reader-bad-selector` — an invalid `results`, `container`, `item`, `link` or `title` selector is `bad-selector`, before any page element is read.
- `serp-reader-time-budget` — a budget of 0 ms, or a node budget the page exceeds, is `timeout` with what was read; nothing past it is read.
- `serp-reader-is-bounded` — a hostile page (100,000 results, a megabyte title, throwing getters, SVG and `javascript:` links, over-long URLs) gives an answer within `SERP_READ_LIMITS` that `SerpReadSchema` accepts, or `timeout`; it never throws.
- `serp-read-script-is-data` — the script embeds the layout and limits as JSON (a hostile selector string stays a string), and `runSerpRead` runs it once in `SERP_WORLD_ID`.
- `serp-bundled-pack-reads-fixtures` — the bundled, signed pack reads each engine's fixture into a ready snapshot, and the unreadable fixture as unreadable.

## Analysis (`serp-analyse.test.ts`, `serp-analyzer.test.ts`)
- `serp-analyse-positions` — ranks over all results; organic positions 1 … n and ad positions in their own count; feature slots in document order; composition counts every type and lists the features in order; the snapshot passes `SerpSnapshotSchema`.
- `serp-ownership-share` — organic results grouped by registrable domain (`www.` and subdomains together), with count, share, positions and best position, sorted by count then best position; ads and results without a domain are not counted.
- `serp-analyse-unreadable` — a reader failure is `unreadable` with its reason and the parameters; garbage, an over-cap answer, invalid parameters or pack version are `invalid-answer`.
- `serp-analysis-in-worker` — jobs run one at a time in one worker; past `SERP_ANALYSIS_TIMEOUT_MS` the worker is terminated, the job is `timeout`, and the next job spawns a new worker; a crash is `invalid-answer`; the worker's code imports no Electron.
- `serp-worker-answers-each-job` — the worker entry answers `{ id, raw, params, packVersion }` with `{ id, result }` (garbage is `invalid-answer`) and drops a message without a numeric id.
- `serp-analysis-build-entry` — the Forge Vite build has the `serp-analysis` entry (`src/main/serp/serp-worker.ts`, the main config and target), so `.vite/build/serp-analysis.cjs` sits beside `main.cjs`.
