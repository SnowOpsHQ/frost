# Feature: capture snapshots and the region diff

Spec: `specs/capture.spec.ts` (`CAPTURE_SNAPSHOT_VERSION`, `PAGE_REGIONS`, `DIFF_REGIONS`,
`DIFF_REGION_LABELS`, `CAPTURE_WORLD_ID`, `CAPTURE_LIMITS`, `DIFF_ENGINE_VERSION`, `DIFF_LIMITS`,
`DIFF_FIELDS`, `DIFF_FIELD_LABELS`, `CHANGE_KINDS`, `TOTAL_COUNTERS`, the shapes),
`specs/capture-snapshot.schema.ts` (`CaptureSnapshotSchema`, `ChangeSchema`, `InlineSegmentSchema`,
`SnapshotDiffSchema`) and `specs/capture-search-params.schema.ts` (`SearchParamsSchema`). Phase 6
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
- `audit`: `score` (0–100) and `findings`, the failing rules' ids, sorted and unique.
- `structuredData`: `types` (sorted, unique) and the JSON-LD `blocks`, each with its types, the
  SHA-256 of its whole canonical JSON, and that JSON cut to `maxJsonLdBlockChars`.
- `headings` (`level`, `text`, `region`) and `links` (`total`, `internal`, `external`,
  `nofollow`, and the `list` of `{href, text, rel, region}`), in document order.
- `images`: `total` and `missingAlt`.
- `regions`: for **every** page region, `words`, `textHash` (SHA-256 of its normalised text),
  `blocks` (non-empty normalised text blocks, in document order) and `truncated`.

Every list and string is capped by `CAPTURE_LIMITS`; the schema is strict and refuses anything else.

**Identity.** A version's identity is its snapshot without `takenAt`:
`snapshotIdentityJson(snapshot)` is that canonical JSON, and main hashes it for `snapshot_hash`, so
recapturing an unchanged page reuses the lane's version (Task 1).

**Canonical JSON** (`canonicalJson(value)`): object keys sorted (UTF-16 code-unit order) at every
depth, no whitespace, `undefined` properties left out as JSON does. It throws a `CanonicalJsonError`
naming the path for anything JSON cannot say exactly: a non-finite number, `undefined` (in an array or
as the value), a function, a symbol, a bigint, an object that is not plain (a `Date`, a `Map`…), and
a cycle. A value shared twice without a cycle is fine.

## How each part is compared (`diffSnapshots(before, after)`)
`before === null` is a first version: the diff is against `EMPTY_CAPTURE_SNAPSHOT` (no tags, no
lists, empty regions), and every scalar of `after` counts as new, so everything is `added`.
- **Head, HTTP and the score** by value. `null` → a value is `added`, a value → `null` is
  `removed`, two different values are `changed` with both. `status`, `score` and `indexable` are
  written as text (`"200"`, `"87"`, `"true"`). Fields: `title`, `meta-description`, `canonical`,
  `robots-meta`, `lang`, `viewport`, `og-title`, `og-description`, `og-image` (region `head`),
  `status`, `x-robots-tag`, `indexable` (`http`), `score` (`audit`).
- **Hreflang** by code (`hreflang`, region `head`): the alternates of each code are matched in
  order; a matched pair with another `href` is `changed`. `context` is the code, before/after the
  `href`.
- **Findings** by rule id (`finding`, region `audit`): a rule that newly fails is `added`, one that
  no longer fails `removed`.
- **Headings**, per page region, by an LCS on `(level, text)`. Within one run of edits between
  unchanged headings, the k-th removed and the k-th added heading are one `changed` heading when
  they have the same level; the rest are removed and added. A heading that moves is removed where it
  was and added where it is. `context` is its tag (`h2`).
- **Links**, per page region, as a multiset by `href`: the links with one `href` are matched in
  order, so a reordered link is no change and a link that moves to another region is removed from
  one and added to the other. A matched pair whose text or `rel` differs is `changed`. `context` is
  the `href`; before/after is the anchor text, followed by ` (rel=<rel>)` when it has a `rel`.
  Added and changed links come in the new page's order, then removed ones in the old page's.
- **Text blocks**, per page region, by an LCS on exact strings. Within one run of edits, removed
  and added blocks are paired greedily in order (each removed block takes the first later unpaired
  added block) when the Jaccard index of their word sets (lowercased runs of letters and digits) is at least
  `similarity`. A pair is one `changed` block with `segments` (`inlineDiff`); unpaired blocks are
  removed or added. Every text change's `context` is the nearest unchanged block before its run,
  cut to `contextChars` (`null` at the start of the region). Then a `words` change when the region's
  word count differs (before/after as text; `added` on a first version).
- **Structured data**: `types` by set (`structured-data-type`); blocks by hash
  (`structured-data-block`): a block whose hash both sides have is unchanged; the others are grouped
  by their type set, matched in order within a group as `changed` (before/after the block text),
  and the rest added or removed. `context` is the block's types, joined by `, `.
- **Totals** (region `audit`): `links-total` for each of `total`, `internal`, `external`,
  `nofollow`, and `images` for `total` and `missing-alt`, each a change only when it differs (any
  value on a first version). `context` names the counter (`TOTAL_COUNTERS`).

`url`, `takenAt`, `partial`, `textHash` and `truncated` are not compared.

**Inline diffs** (`inlineDiff(a, b)`): a word-level LCS over tokens that keep their whitespace (a
token is a run of whitespace or a run of anything else), so the segments put together give back `a`
(`same` + `del`) and `b` (`same` + `ins`). The common start and end are taken off first. Within each
run of edits, deletions come before insertions; a whitespace-only `same` between two edits is folded
into both, and adjacent segments of one op are merged. Over `maxInlineWords` tokens on a side, or
over `maxLcsCells`, the answer is `[del a, ins b]` (an empty side left out). Equal inputs are one
`same` segment (none when both are empty).

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
- **Pairing** one run of blocks compares at most `maxLcsCells` words (each comparison costs both
  blocks' word counts, plus one); past that, the rest of the run stays removed and added.
- **The whole diff** spends at most `maxWorkCells`: LCS cells, plus the words compared while pairing
  blocks, plus inline-diff cells. Regions are worked in change order. Once spent, further lists are
  compared as multisets, unpaired blocks stay removed and added, and inline diffs answer `[del, ins]`.
  A diff of two snapshots at every cap takes a few tens of milliseconds.
- **Changes**: every change found is counted in `summary` and `changeCount`; `changes` keeps the
  first `maxChanges` in change order, and `truncated` says some were left out. Inline segments are
  computed only for changes kept.
- **Text**: `before` and `after` are cut to `maxChangeTextChars` (ending in `…`, never splitting a
  surrogate pair); text context to `contextChars`; segments are only computed when both blocks fit
  in `maxChangeTextChars`.

## Search parameters
`SearchParamsSchema` is a strict object with every key present: `engine` (`SEARCH_ENGINE_IDS`),
`query` (trimmed, 1–`PROJECT_QUERY_MAX_CHARS`, no control characters), `country` (two lowercase
letters), `language` (a BCP 47-style tag, at most 35 characters), `location` (trimmed, 1–100, no
control characters) and `device` (`desktop` / `mobile`), each of the last four `null` when unset.
Nothing is normalised, so one search has one canonical JSON. `TODO(phase-3-merge)`: replaced by
Phase 3's `serp-search-params.schema.ts`, keeping stored rows readable.

## Scenarios
### Diff (`diff.test.ts`)
- **Scenario: regions-tag-every-change** — a pair of snapshots that differ in every field gives
  changes whose `region` is the field's region (head tags in `head`, the response in `http`, the
  score, findings and totals in `audit`, headings, links, text and words in their page region), and
  each page region's changes stay in it.
- **Scenario: unchanged-snapshots-diff-empty** — a snapshot diffed with itself, or with a copy that
  differs only in `takenAt`, `partial`, a `textHash` or `truncated`, has no changes, a zero summary,
  `changeCount` 0 and is not truncated.
- **Scenario: first-version-is-all-added** — every change of `diffSnapshots(null, s)` is `added`
  with `before` `null`: each heading, link, block, finding, type and JSON-LD block of `s`, and its
  scalars (`indexable: false`, the score, the totals) too. Diffed against `EMPTY_CAPTURE_SNAPSHOT`
  explicitly, the same items are added and only those scalars differ.
- **Scenario: diff-is-deterministic** — the same inputs twice give deep-equal diffs, and inputs
  with every object's keys shuffled give the same diff; changes are in region, field, then document
  order.
- **Scenario: diff-work-is-bounded** — two snapshots at every cap with all text different diff in
  under ~250 ms, keep at most `maxChanges` changes with `truncated` and a full summary; the same with
  lists over the caps uses the multiset fallback (reported by the work probe) and stays fast; a
  pair of near-identical regions at every cap spends at most `maxWorkCells`.
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
- **Scenario: structured-data-type-changes** — a new type is an added `structured-data-type`, a
  dropped one removed; a block of the same types with another hash is a `changed` block; a block of
  new types is added.
- **Scenario: findings-are-audit-changes** — a newly failing rule is an added `finding`, a fixed one
  removed, the score change is `changed`, all in `audit`; totals changes name their counter.
- **Scenario: change-text-is-capped** — a before/after over `maxChangeTextChars` is cut to it
  ending in `…`, and a surrogate pair at the cut is never split.

### Inline diff (`inline.test.ts`)
- **Scenario: inline-diff-merges-and-falls-back** — segments rebuild both sides; adjacent ops are
  merged, deletions precede insertions and whitespace between edits is folded in; a side over
  `maxInlineWords` tokens, or a middle over `maxLcsCells` cells, gives `[del a, ins b]`.

### Canonical JSON (`canonical-json.test.ts`)
- **Scenario: canonical-json-is-key-order-free** — objects with the same entries in any key order
  give one string, with no whitespace and sorted keys at every depth; `snapshotIdentityJson` ignores
  `takenAt`.
- **Scenario: canonical-json-rejects-non-json** — `NaN`, `Infinity`, `undefined` in an array, a
  function, a symbol, a bigint, a `Date` and a cycle each throw a `CanonicalJsonError` naming the
  path; a shared, acyclic object does not.

### Schemas (`schemas.test.ts`)
- **Scenario: search-params-schema-rejects-unknown-keys** — a valid value parses unchanged; an extra
  key, a missing key, an unknown engine, a blank or untrimmed query, an uppercase country, a bad
  language tag, a long location, a control character and an unknown device are each refused.
- **Scenario: capture-snapshot-schema-caps** — the valid fixture parses; a list one over its cap, a
  string one over its cap, unsorted findings, a missing region, a region over `maxRegionChars` and
  an unknown key are each refused; every diff the engine produces in these tests parses with
  `SnapshotDiffSchema`, and a diff whose numbers disagree does not.

### Purity (`purity.test.ts`)
- **Scenario: change-intel-is-pure** — no source file outside the tests imports anything but
  relative modules and `@app/specs/capture.spec` (Zod-free), and none touches `document`, `window`,
  `process`, `require` or `globalThis`.
