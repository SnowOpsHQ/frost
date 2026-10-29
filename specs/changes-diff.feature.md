# Feature: capture snapshots and the region diff

Spec: `specs/capture.spec.ts` (`CAPTURE_SNAPSHOT_VERSION`, `PAGE_REGIONS`, `DIFF_REGIONS`,
`DIFF_REGION_LABELS`, `CAPTURE_WORLD_ID`, `CAPTURE_LIMITS`, `DIFF_ENGINE_VERSION`, `DIFF_LIMITS`,
`DIFF_FIELDS`, `DIFF_FIELD_LABELS`, `CHANGE_KINDS`, `TOTAL_COUNTERS`, the shapes),
`specs/capture-snapshot.schema.ts` (`CaptureSnapshotSchema`, `ChangeSchema`, `InlineSegmentSchema`,
`SnapshotDiffSchema`) and `specs/serp-search-params.schema.ts` (`SearchParamsSchema`). Phase 6
Task 2; the storage is `capture-db.feature.md`. Implemented by `packages/change-intel`
(`@app/change-intel`): pure TypeScript, no Electron, DOM, Node or Zod, so main and the chrome can
both run it. Each scenario maps to one named test in `packages/change-intel/src/__tests__/`.

## Regions
Where a heading, link or text block sits is the **nearest ancestor ARIA landmark** of its element
(the element itself counts). Walking up from the element, the first ancestor that is a landmark
decides:
- `main`, or any element with `role=main` → `main`;
- `nav`, or `role=navigation` → `nav`;
- `aside`, or `role=complementary` → `aside`;
- `header`, or `role=banner` → `header`, but a `header` element inside an `article`, `aside`,
  `main`, `nav` or `section` is not a landmark (it heads that section, not the page): it is passed,
  and the walk goes on up;
- `footer`, or `role=contentinfo` → `footer`, with the same scoping as `header`.

An explicit `role` wins over the element's own (`<div role=navigation>` is `nav`; `<nav role=none>`
is no landmark). With no landmark ancestor the content is `other` when the document has a main
landmark, and `main` when it has none (a page without landmarks is all main content). These rules
run in the region extraction (Task 3, `CAPTURE_WORLD_ID`), which applies `CAPTURE_LIMITS` and its
deadline (`extractBudgetMs`, `maxNodeVisits`), and answers `partial` when it stops early.

Diff regions (`DIFF_REGIONS`) add the page-wide parts, in this order: `head`, `http`,
`structured-data`, the six page regions, then `audit`. Every change names one, and the Changes panel
groups by it under `DIFF_REGION_LABELS`.

## The snapshot (`CaptureSnapshot`, version 1)
- `url` (the page, `http(s)`), `takenAt` (the audit's time), `partial` (the audit or the region
  extraction stopped early).
- `http`: `status` (`null` when unknown), `xRobotsTag`, `indexable`.
- `head`: `title`, `metaDescription`, `canonical`, `robotsMeta`, `lang`, `viewport`, `ogTitle`,
  `ogDescription`, `ogImage` (each `null` when absent), and `hreflang` (`{hreflang, href}`).
- `audit`: `score` (0–100) and `findings`, the failing rules' ids, sorted and unique. A capture
  keeps only the rules that read the page itself, and scores those (`changes-capture.feature.md`,
  Page rules): timing, accessibility, served-HTML and checks results are not part of a version.
- `structuredData`: `types` (sorted, unique) and the JSON-LD `blocks`, each with its types, the
  SHA-256 of its whole canonical JSON, and that JSON cut to `maxJsonLdBlockChars`.
- `headings` (`level`, `text`, `region`) and `links` (`total`, `internal`, `external`,
  `nofollow`, and the `list` of `{href, text, rel, region}`), in document order.
- `images`: `total` and `missingAlt`.
- `regions`: for **every** page region, `words`, `textHash`, `blocks` (non-empty normalised text
  blocks, in document order) and `truncated`.

Every list and string is capped by `CAPTURE_LIMITS`; the schema is strict and refuses anything else.

**Text is normalised by the extractor** (Task 3), before main or the diff sees it: lone surrogates
replaced with U+FFFD, Unicode NFC, whitespace runs collapsed to one space, trimmed, empty blocks
dropped. The diff compares strings
exactly and assumes this; it does not normalise again.

**`textHash`** is the lowercase hex SHA-256 of the UTF-8 bytes of H: every normalised block the walk
reached in the region, uncut and in document order (also past `maxBlocksPerRegion` and
`maxRegionChars`), joined with `\n`, then cut to its first `maxHashedRegionChars` UTF-16 units (a
final lone high surrogate dropped). When the region is not `truncated`, H is exactly
`blocks.join('\n')`, and an empty region hashes the empty string. Main computes it (Task 3), from
the text the extraction answers.

**Identity.** `snapshotIdentityJson(snapshot)` is the canonical JSON main hashes for
`snapshot_hash` (Task 1: an equal hash reuses the lane's version). It leaves out what is not the
page's content or what the diff does not compare (`takenAt`, `partial`, `url`, which the lane fixes,
and each region's `truncated`), and puts in a fixed order every list the diff compares regardless of
order: links by `(href, text, rel, region)`, hreflang by `(hreflang, href)`, JSON-LD blocks by
`(hash, types, text)`, and headings grouped by region (in `PAGE_REGIONS` order, document order kept
within a region). Text blocks keep their order. So identity and diff agree:
- equal identities always diff to no changes;
- different identities always diff to at least one change, except when the new side is `partial` or
  has a `truncated` region and the only differences are removals the diff declines to report (see
  Partial snapshots); that diff is `partial`.

**Canonical JSON** (`canonicalJson(value)`): object keys sorted (UTF-16 code-unit order) at every
depth, no whitespace, `undefined` properties left out as JSON does. It throws a `CanonicalJsonError`
naming the path for anything JSON cannot say exactly: a non-finite number, `undefined` (in an array or
as the value), a function, a symbol (as a value or a key), a bigint, an object that is not plain (a
`Date`, a `Map`…), an array with own properties that are not indices, and a cycle. A value shared
twice without a cycle is fine.

## How each part is compared (`diffSnapshots(before, after)`)
`before === null` is a first version: the diff is against `EMPTY_CAPTURE_SNAPSHOT` (no tags, no
lists, empty regions), and every scalar of `after` counts as new, so everything is `added`.
- **Head, HTTP and the score** by value. `null` → a value is `added`, a value → `null` is
  `removed`, two different values are `changed` with both. `status`, `score` and `indexable` are
  written as text (`"200"`, `"87"`, `"true"`). Fields: `title`, `meta-description`, `canonical`,
  `robots-meta`, `lang`, `viewport`, `og-title`, `og-description`, `og-image` (region `head`),
  `status`, `x-robots-tag`, `indexable` (`http`), `score` (`audit`).
- **Hreflang** (`hreflang`, region `head`): equal `(code, href)` alternates are matched first (as
  many as both sides have); the rest are matched by code, in order, as `changed`; what is left is
  added or removed. `context` is the code, before/after the `href`.
- **Findings** by rule id (`finding`, region `audit`): a rule that newly fails is `added`, one that
  no longer fails `removed`.
- **Headings**, per page region, by an LCS on `(level, text)`. Within one run of edits between
  unchanged headings, the k-th removed and the k-th added heading are one `changed` heading when
  they have the same level; the rest are removed and added. A heading that moves is removed where it
  was and added where it is. `context` is its tag (`h2`).
- **Links**, per page region, as a multiset: equal `(href, text, rel)` links are matched first, so
  a reordered or swapped link is no change; the rest are matched by `href`, in order, as `changed`
  (other text or `rel`); what is left is added or removed. A link that moves to another region is
  removed from one and added to the other. `context` is the `href`; before/after is the anchor text,
  followed by ` (rel=<rel>)` when it has a `rel`.
- **Text blocks**, per page region, by an LCS on exact strings. Within one run of edits, removed
  and added blocks are paired greedily in order: each removed block takes the first later unpaired
  added block whose word set has a Jaccard index of at least `similarity` with its own. Candidates
  are found through an index from words to the run's added blocks, so a removed block that shares
  no word with any of them costs about its own word count. Words are `Intl.Segmenter` word segments
  (locale `und`, so CJK, Thai and combining marks segment properly), lowercased. A pair is one
  `changed` block with `segments` (`inlineDiff`); unpaired blocks are removed or added. Every text
  change's `context` is the nearest unchanged block before its run, cut to `contextChars` (`null`
  at the start of the region). Because pairing keeps document order, edits that cross (block A
  edited and moved after an edited block B) pair only one of them; the other is removed and added.
  Then a `words` change when the region's word count differs (before/after as text; `added` on a
  first version), and a `hidden-text` change when the region's `textHash` differs but no text
  change was reported for it (the difference is past the kept blocks): before/after are the first
  12 hex digits of each hash.
- **Structured data**: `types` by set (`structured-data-type`); blocks (`structured-data-block`):
  equal blocks (hash, types and text) are matched first; the rest are grouped by their type set,
  and within a group each new block is paired with the most similar old one (Jaccard of their word
  sets; the earliest on a tie) as `changed` (before/after the block text); the rest are added or
  removed. `context` is the block's types, joined by `, `.
- **Totals** (region `audit`): `links-total` for each of `total`, `internal`, `external`,
  `nofollow`, and `images` for `total` and `missing-alt`, each a change only when it differs (any
  value on a first version). `context` names the counter (`TOTAL_COUNTERS`).

`url`, `takenAt`, `partial` and `truncated` are not compared.

**Partial snapshots.** The diff is `partial` when either side is `partial` or has a `truncated`
region: it may miss changes. When the new side is cut short, what it lacks at its end may only
have been cut, so the diff does not report it as removed:
- text blocks of a region whose new side is `truncated` (or the snapshot `partial`);
- headings, when the new snapshot is `partial` or holds `maxHeadings`;
- links, when the new snapshot is `partial` or holds `maxLinks`.
In those lists, per region, the old items left unmatched after the last old item that is matched
(unchanged or paired) are not reported. A paragraph inserted at the top of a full region is one
added block, not an added block plus the last block "removed".

**Inline diffs** (`inlineDiff(a, b)`): an LCS over tokens: `Intl.Segmenter` word segments (words,
punctuation, and whitespace runs merged into one token), so the segments put together give back `a`
(`same` + `del`) and `b` (`same` + `ins`). The common start and end are taken off first. Within each
run of edits, deletions come before insertions; a whitespace-only `same` between two edits is folded
into both, and adjacent segments of one op are merged. Over `maxInlineWords` tokens on a side the
answer is `[del a, ins b]` (an empty side left out); since `maxInlineWords²` is `maxLcsCells`, only
the diff's work budget can refuse a side within it (same answer). Equal inputs are one `same`
segment (none when both are empty).

## Change order
Changes come in `DIFF_REGIONS` order, then `DIFF_FIELDS` order within a region, then document
order within a field. For an LCS list that is the edit script's order, and within one run of edits:
a removed item where it was; a pair where its removed item was, after any added items that come
before its partner; then the remaining added items. For a multiset or set (links, hreflang,
findings, types, structured-data blocks): added and changed items in the new order, then removed
ones in the old order. The same two snapshots always give the same diff, whatever the key order of
the objects passed in.

## Bounds and the fallback
- **One LCS** fills at most `maxLcsCells` cells, counted after the common start and end are taken
  off. Over it, that list is compared as a **multiset**: an item the other side also has (matched
  by count) is unchanged wherever it is, the rest are one run of edits (removed in the old order,
  added in the new), and runs have no context. Under v1's caps a page's lists fit (300 × 300 blocks
  is 90 000 cells); the fallback guards larger lists and the work budget.
- **Pairing** one run of blocks spends at most `maxLcsCells`: each removed block costs its word
  count plus the index postings it visits; past that, the rest of the run stays removed and added.
- **The whole diff** spends at most `maxWorkCells`: LCS cells, pairing, structured-data
  similarity (both blocks' word counts per comparison) and inline-diff cells. Regions are worked in
  change order. Once spent, further lists are compared as multisets, unpaired blocks stay removed
  and added, structured-data blocks pair in order, and inline diffs answer `[del, ins]`. A diff of
  two snapshots at every cap takes a few tens of milliseconds.
- **Changes**: every change found is counted in `summary` and `changeCount`; `changes` keeps the
  first `maxChanges` in change order, and `truncated` says some were left out. Inline segments are
  computed only for changes kept.
- **Text**: `before` and `after` are cut to `maxChangeTextChars` (ending in `…`, never splitting a
  surrogate pair); text context to `contextChars`; segments are only computed when both blocks fit
  in `maxChangeTextChars`, so they always rebuild the uncut before and after.

## Search parameters
Captures, screenshots and saved searches record **Phase 3's search parameters**
(`specs/serp-search-params.schema.ts`, `SearchParamsSchema`): `engine`, `engineLabel`, `query`, `gl`,
`hl`, `device` (`desktop` / `mobile` / `tablet`), `page`, `offset` and the canonical `url`, as Phase
3's `matchSerp` reads them from a result page's URL (normalised there: the query's whitespace
collapsed, `gl` and `hl` lowercased, only the known parameters in `url`), so one search has one
canonical JSON. The stored `search_params` columns stay nullable: a capture or screenshot of a page
that is not a result page records `null`.

Where they come from (`apps/desktop/src/main/changes/serp-params.ts`):
- **A tab's** (`searchParamsOf(tabId, pageUrl)`, a manual capture's and screenshot's, and a run's):
  Phase 3's `SerpReadApi.snapshot(tabId)`, late-bound (the changes and screenshots services are made
  before `setupSerp` runs; until it has, every answer is `null`). Only a finished reading counts: a
  `ready` state's `snapshot.params`, or an `unreadable` state's `params`; `not-serp`, `pending`,
  `disabled`, a state of another tab and anything that does not fit is `null`. The state must be of
  the page being captured: its `url` (the page's own URL, which every non-disabled `SerpState` has) in
  the stored form (`storedPageUrl`) must equal the capture's or screenshot's page, so a reading of
  the page before a navigation is never recorded. The parameters are checked with
  `SearchParamsSchema`. The capture's own settled-audit and URL checks still apply on top.
- **A saved search's**: `searchParamsForUrl(url, device)`: `matchSerp` with the bundled selector pack
  (verified once with its signature; `null` while it does not verify) (`projects.feature.md`, Saved
  searches).

Rows written in Phase 6's earlier shape (`country`, `language`, `location`) exist only in development
profiles (nothing was released); they no longer parse and are skipped where a row that does not
parse is skipped. There is no migration: captured rows are append-only by design.

## Scenarios
### Diff (`diff.test.ts`)
- **Scenario: regions-tag-every-change** — a pair of snapshots that differ in every field gives
  changes whose `region` is the field's region (head tags in `head`, the response in `http`, the
  score, findings and totals in `audit`, headings, links, text and words in their page region), and
  each page region's changes stay in it.
- **Scenario: unchanged-snapshots-diff-empty** — a snapshot diffed with itself, or with a copy that
  differs only in `takenAt`, `partial` or a region's `truncated`, has no changes, a zero summary,
  `changeCount` 0 and is not truncated; it is `partial` exactly when a side is partial or truncated.
- **Scenario: hidden-text-reports-changes-past-kept-blocks** — a region whose `textHash` changed
  while its blocks did not gives one `changed` `hidden-text` change with the first 12 hex digits of
  each hash; when a block changed too, there is no `hidden-text` change.
- **Scenario: first-version-is-all-added** — every change of `diffSnapshots(null, s)` is `added`
  with `before` `null`: each heading, link, block, finding, type and JSON-LD block of `s`, and its
  scalars (`indexable: false`, the score, the totals) too. Diffed against `EMPTY_CAPTURE_SNAPSHOT`
  explicitly, the same items are added and only those scalars differ.
- **Scenario: diff-is-deterministic** — the same inputs twice give deep-equal diffs, and inputs
  with every object's keys shuffled give the same diff; changes are in region, field, then document
  order.
- **Scenario: diff-work-is-bounded** — each within its work budget (measured at tens of ms; the test
  allows 5 s of wall clock for a loaded runner), and each diff parses with
  `SnapshotDiffSchema`: two snapshots at every cap with all text different keep `maxChanges`
  changes with `truncated` and a full summary; regions at their caps where every block shares 20
  words with every other (and none is similar enough) take the pairing fallback (reported by the
  work probe); lists over the caps take the multiset fallback; regions at their caps where every
  block is edited pair every block, with segments.
- **Scenario: pairing-survives-unrelated-blocks** — 25 deleted paragraphs followed by 35
  paragraphs of about 165 words, each with one word changed, give 25 removed blocks and 35
  `changed` blocks with segments: the unrelated paragraphs do not use up the pairing budget.
- **Scenario: truncated-side-reports-no-false-removals** — a paragraph inserted at the top of a
  region at its block cap (the new side `truncated`, its last old block pushed out) is one added
  block and no removed one, and the diff is `partial`; the same with a complete new side reports
  the last block removed.
- **Scenario: text-edit-is-a-change-with-segments** — one word edited in a block is one `changed`
  `text` change in its region, with before, after, the preceding unchanged block as context (cut to
  `contextChars`) and segments that rebuild both sides.
- **Scenario: unrelated-text-is-remove-plus-add** — a block replaced by one sharing too few words is
  a `removed` and an `added` change, without segments; and a `words` change follows.
- **Scenario: heading-and-link-moves** — a heading that moves is removed and added; a heading
  retitled at the same level is `changed`; a reordered link is no change; a link moved from `nav` to
  `footer` is removed from `nav` and added to `footer`.
- **Scenario: link-text-change-is-changed** — the same `href` with new text (or a new `rel`) is one
  `changed` `link` change whose context is the `href`.
- **Scenario: duplicate-keys-match-exact-items-first** — links `[/ "Home", / "Logo"]` →
  `[/ "Logo"]` is one removed "Home"; swapping two links with one `href` is no change; hreflang
  alternates of one code match exactly first; JSON-LD `[Product "Alpha", Product "Beta"]` →
  `[Product "Beta v2"]` is `changed` Beta → Beta v2 plus removed Alpha.
- **Scenario: structured-data-type-changes** — a new type is an added `structured-data-type`, a
  dropped one removed; a block of the same types with another hash is a `changed` block; a block of
  new types is added.
- **Scenario: findings-are-audit-changes** — a newly failing rule is an added `finding`, a fixed one
  removed, the score change is `changed`, all in `audit`; totals changes name their counter.
- **Scenario: change-text-is-capped** — a before/after over `maxChangeTextChars` is cut to it
  ending in `…`, and a surrogate pair at the cut is never split.

### Inline diff (`inline.test.ts`)
- **Scenario: inline-diff-merges-and-falls-back** — segments rebuild both sides; adjacent ops are
  merged, deletions precede insertions and whitespace between edits is folded in; punctuation, CJK
  and Thai are their own tokens; a side over `maxInlineWords` tokens gives `[del a, ins b]`.

### Canonical JSON (`canonical-json.test.ts`)
- **Scenario: canonical-json-is-key-order-free** — objects with the same entries in any key order
  give one string, with no whitespace and sorted keys at every depth; `snapshotIdentityJson` ignores
  `takenAt`, `partial`, `url` and `truncated`, and the order of links, hreflang, JSON-LD blocks and
  of headings across regions, but not the order of headings within a region or of text blocks.
- **Scenario: canonical-json-rejects-non-json** — `NaN`, `Infinity`, `undefined` in an array, a
  function, a symbol, a symbol key, an array with a named property, a bigint, a `Date` and a cycle
  each throw a `CanonicalJsonError` naming the path; a shared, acyclic object does not.

### Identity (`identity.test.ts`)
- **Scenario: identity-and-diff-agree** — for many seeded random mutations of a rich fixture (every
  field, reorders the diff ignores, duplicates, moves between regions, `textHash`, `partial` and
  `truncated` flips), in both directions: equal identities give no changes; different identities
  give at least one change, except a diff whose new side is partial or truncated (then the diff
  is `partial`), and never when both sides are complete.

### Schemas (`schemas.test.ts`)
- **Scenario: search-params-refuse-the-old-shape** — Phase 3's search parameters parse unchanged;
  Phase 6's earlier shape (`country`, `language`, `location`), an extra or missing key, a `null`
  device and a non-`http(s)` URL are each refused (Phase 3's own cases are its
  `serp-search-params.schema.ts` tests).
- **Scenario: capture-snapshot-schema-caps** — the valid fixture parses; a list one over its cap, a
  string one over its cap, unsorted findings, a missing region, a region over `maxRegionChars` and
  an unknown key are each refused; every diff the engine produces in these tests parses with
  `SnapshotDiffSchema`, and a diff whose numbers disagree, whose summary does not match its
  untruncated changes, or whose segments sit on another change or do not rebuild it, does not.

### Purity (`purity.test.ts`)
- **Scenario: change-intel-is-pure** — no source file outside the tests imports (`import … from`,
  `export … from`, `import()`, either quote) anything but relative modules and
  `@app/specs/capture.spec` (Zod-free), and none touches `document`, `window`, `process`, `require`
  or `globalThis`. `tsconfig.src.json` type-checks the sources without Node's types (part of `lint`).
