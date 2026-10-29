# Feature: capturing a page into its versioned history

Spec: `specs/changes.spec.ts` (`CAPTURE_REFUSALS`, `CAPTURE_REFUSAL_MESSAGES`, `CAPTURE_BUSY`,
`CAPTURE_STALE_RETRIES`, `REGION_EXTRACT_LIMITS`, `CAPTURE_BLOCK_ELEMENTS`,
`CAPTURE_PAGE_CATEGORIES`, `CAPTURE_CONTEXT_CATEGORIES`, `CAPTURE_EXCLUDED_RULES`, the input and
answer types) and `specs/changes.schema.ts` (`CaptureInputSchema`, `HistoryInputSchema`,
`VersionInputSchema`, `DiffInputSchema`, `PagesInputSchema`, the answer schemas,
`RegionAnswerSchema`, `CHANGES_READ_API`). Phase 6 Task 3; the snapshot and its diff are
`changes-diff.feature.md`, the storage `capture-db.feature.md`. Implemented by
`apps/desktop/src/main/changes/` (`regions.ts`, `snapshot.ts`, `service.ts`, `serp-params.ts`) and
`packages/ipc-contract/src/changes-{router,service}.ts`.

## The region extraction (`regions.ts`)
`extractRegions` is one self-contained function, serialised with `CAPTURE_LIMITS`,
`REGION_EXTRACT_LIMITS` and `CAPTURE_BLOCK_ELEMENTS` into a script and run with
`executeJavaScriptInIsolatedWorld(CAPTURE_WORLD_ID, …)`. It only reads the DOM; nothing the page
defines reaches it, and it changes nothing on the page.
- **Regions** follow `changes-diff.feature.md`, Regions. Each element's landmark is worked out once,
  from its parent's (memoised), so a deep tree costs one step per element. An explicit, non-empty
  `role` decides by its first token (`main`, `navigation`, `complementary`, `banner`,
  `contentinfo`; any other role is no landmark). A `header` or `footer` element is scoped (no
  banner or contentinfo) inside an `article`, `aside`, `main`, `nav` or `section` element **or** an
  element whose role is `article`, `complementary`, `main`, `navigation` or `region` (HTML-AAM). The
  page has a main landmark when one of its first `maxMainScan` `main` elements, or of its first
  `maxMainScan` elements whose `role` names `main`, is one.
- **Hidden** (simplified from Phase 2): an element with the `hidden` attribute on it or an
  ancestor, or one Chromium reports without a box (`checkVisibility()` false) that is not a
  `display: contents` wrapper. Hidden headings are not kept; hidden subtrees are not walked for text,
  nor read for a heading's or a link's text.
  Links are counted whether shown or not (as Phase 2 does).
- **Headings**: shown `h1`–`h6` in document order, at most `maxHeadings`, text read node by node
  (bounded) and normalised, then cut to `maxHeadingChars`.
- **Links**: `document.links` (`a[href]`, `area[href]`): the `href` resolved against the base URL
  (as written, trimmed, if it does not resolve), cut to `maxUrlChars`; the text (else `aria-label`,
  an image's `alt`, an `area`'s `alt`, `title`), normalised and cut to `maxAnchorChars`; `rel`
  lowercased and normalised. The list keeps `maxLinks`. The totals count every link: `total` is the
  page's count; `internal` / `external` follow Phase 2's `LinkSchema` kinds (an `http(s)` link to the
  page's site, `www.` aside, is internal; any other `http(s)` link external; other schemes neither),
  and `nofollow` counts `rel` tokens, over at most `maxLinkScan` links until the deadline (`partial`
  when cut).
- **Text blocks.** The walk goes through the body's text nodes in document order. A text node
  belongs to its nearest ancestor among `CAPTURE_BLOCK_ELEMENTS` (or the body) and to its parent's
  region. Consecutive text nodes with the same block and region are one text block; a text node with
  another block or region, a `br` or an `hr` starts the next. So a block's text is never counted
  twice: `<div>a<p>b</p>c</div>` is three blocks, `a`, `b` and `c`. `script`, `style`, `noscript`,
  `template`, `svg`, `math`, `iframe` and `object` subtrees are skipped, as are hidden ones.
- **Normalisation** (`changes-diff.feature.md`): in each block a lone surrogate (not Unicode, so it
  has no UTF-8 spelling) is replaced with U+FFFD, then the text is Unicode NFC, whitespace runs
  collapsed to one space, trimmed; an empty block is dropped. Headings and anchor text are
  normalised the same.
- **Per region**: `words` (`Intl.Segmenter` word segments that are `isWordLike`, Phase 2's count,
  over every block reached), the kept `blocks` (each cut to `maxBlockChars`; kept until
  `maxBlocksPerRegion` or `maxRegionChars`, the block that would cross it and every later one not
  kept), `truncated`, and `text`: H of the `textHash` rule (every block reached, uncut, joined with
  `\n`, cut to `maxHashedRegionChars`). Once H is cut it is closed: nothing more is appended, and a
  cut inside a surrogate pair drops its high half. Since blocks hold no lone surrogate, H never ends
  in one otherwise. Main hashes `text` with `node:crypto`; the extraction never hashes.
- **Bounds**: the walk visits at most `maxNodeVisits` nodes and reads at most `maxScanChars`
  characters; everything stops at `extractBudgetMs` from the start. Stopping early answers what was
  read with `partial: true`, and every region `truncated`. Main gives up on an extraction after
  `extractTimeoutMs` (`extract-failed`), and parses the answer with `RegionAnswerSchema` (anything
  else is `extract-failed`).

- **Known limit:** shadow DOM is not read. Text, headings and links inside a shadow root (open or
  closed) are not captured, as the Phase 2 extractor does not read them either.

## The snapshot (`snapshot.ts`)
`buildCaptureSnapshot(audit, regions, hash)` builds a `CaptureSnapshot` from:
- the audit: the HTTP status (`null` unless 100–999), `X-Robots-Tag` (the header values, joined
  with `, `), `indexable`, the failing rule ids (sorted, unique) and `score` of the **page rules**
  only (below), title, meta description,
  canonical, robots meta, `lang`, viewport, Open Graph title, description and image, hreflang (the
  head's and the `Link` header's, each `{code, resolved href}`), the structured-data types (every
  entity's, nested ones too, sorted and unique) and JSON-LD blocks (each block's entities' types;
  `hash` the SHA-256 of the block's canonical JSON when it parses, else of its text as kept; `text`
  that canonical JSON, else the text, cut to `maxJsonLdBlockChars`), and the image totals;
- the regions: headings, links (list and totals) and each region's text (`textHash` from `hash`).

**Page rules.** A capture keeps the findings of rules that read the page itself: the snapshot, the
response and robots.txt (`CAPTURE_PAGE_CATEGORIES`). The rules of `CAPTURE_CONTEXT_CATEGORIES` (the
speed measurement's, the accessibility run's, the served HTML's), but for
`CAPTURE_PAGE_RULES_IN_CONTEXT_CATEGORIES`, and the link, sitemap and hreflang checks' rules
(`CHECKS_RULE_SPECS`) are left out (`CAPTURE_EXCLUDED_RULES`): they vary between two loads of an
unchanged page, which would make a new version each time. `score` is seo-core's `scoreAudit` over
the kept findings, so it is not the audit's score on screen when a left-out rule fails.

Everything is normalised and cut to the caps here, so a real page always fits the schema; `partial`
is the audit's or the extraction's. A snapshot whose canonical JSON is over
`MAX_SNAPSHOT_JSON_BYTES` is shrunk until it fits: each round cuts the largest part (a region's
blocks, the link list, the headings, the JSON-LD texts or the hreflang list) to three quarters.
The regions that lost blocks are `truncated`, the snapshot `partial`. A snapshot that still fails
`CaptureSnapshotSchema` is `invalid-page`.

`laneKeyFor(url, renderProfile, searchParams)` is the SHA-256 of
`canonicalJson({ url, renderProfile, searchParams })`, the URL stored as `@app/db` stores it
(`http(s)`, no userinfo, no `#fragment`). `identityHash(snapshot)` is the SHA-256 of
`snapshotIdentityJson(snapshot)`.

## The service (`service.ts`)
`capture(tabId, { projectId?, source?, searchParams? })`; the IPC passes only `projectId`, a
project's capture run (Task 6) also `source: 'project'` and the query's `searchParams`. Otherwise
the source is `manual` and the search parameters are `searchParamsOf(tabId, page)`: Phase 3's for
the tab's result page, `null` for any other page (`changes-diff.feature.md`, Search parameters).
1. A second capture of a tab while one runs answers `busy`.
2. The tab must be open (`no-tab`) and active (`not-active`). Its URL must fit a snapshot (at most
   `maxUrlChars` in its stored form; else `invalid-page`, since the audit holds it cut). It must have
   a **settled** ready audit of its current URL, fragment aside, taken after its latest load
   (`no-audit`):
   - **after its latest load**: main keeps each tab's load times (`changes/loads.ts`): a new
     document (`did-navigate`), the end of a load (`did-finish-load`), or a main-frame move to another
     URL in the page (`did-navigate-in-page`; not a fragment-only move). The auditor keeps the last
     load's audit on screen through a same-URL reload, so an audit taken at or before the latest load
     is that one;
   - **settled**: not the provisional first audit, analysed while robots.txt was still on its way
     (its `robots` outcome `pending`).

   The project (default Unfiled) must be live (`no-project`).
3. The regions are extracted (`extract-failed`). If the tab is no longer active, or its audit or
   page changed meanwhile, the capture is refused (`not-active` / `no-audit`).
4. The snapshot is built and parsed (`invalid-page`). The render profile is recorded by the rule
   below (the audit's profile, or `null`, with its `partial`); the search parameters as canonical JSON.
5. Through one write queue (captures are written one at a time): read the lane's head. An equal
   identity hash appends a capture of it with no diff. Otherwise the new version is diffed against
   the head's snapshot (`diffSnapshots(null, …)` when the head's snapshot does not read back), and
   appended with that diff (canonical JSON, `DIFF_ENGINE_VERSION`, summary, `changeCount`); with no
   head, with none. A `stale` append reads the head again and retries once (`CAPTURE_STALE_RETRIES`);
   any other failure is `store-failed`, unless the project was deleted meanwhile (`no-project`).
   **A capture cut short** (`partial`, or a region `truncated`) whose diff against the head's
   readable snapshot has no change is one more capture of the head version: a page read in part
   does not make a new version only because it was read in part.

It never rejects: each failure is a refusal and one log line, which never holds page text. A
database error is logged by its code or name only (its message holds the query's parameters).

Reads parse everything the database answers with the Zod schemas: `history` skips a version whose
render profile or search parameters do not parse (a diff summary that does not parse is `null`);
`version` answers `null` for a snapshot that does not parse or is of another snapshot version;
`diff` answers the stored diff of that pair when it is of `DIFF_ENGINE_VERSION`, of their lane, and
parses, else computes it (`null` when the versions are in different lanes or either is unreadable);
`pages` answers the captured pages. A database failure answers empty (or `null`) and logs.
`ChangesReadService` (`listPages`, `history`, `getVersion`, `diff`) is the same reads, each answer
parsing with its `CHANGES_READ_API` output schema.

## The render profile recorded (`profile-in-effect.ts`; captures and screenshots)
One rule for a capture's and a screenshot's render profile: the profile **set on the tab** when the
page was read is recorded (canonical JSON), whatever its status, with `partial` when it may not all
have been in effect on what was read: it was set or changed after the page loaded (`needsReload`), or
it is still `applying`, or it `failed`. No profile is `null`.
- A capture takes it from its audit (`AuditRenderProfile`: the browser's same rule, at the audit's
  time; `partial` is `renderProfilePartial`).
- A screenshot takes it from the tab as it captures (`TabState.renderProfile`, through
  `tabProfileInEffect`: `partial` = `needsReload` or a status other than `active`).
- A profile that does not fit its schema: a capture is refused (`invalid-page`); a screenshot records
  none, with a log line.
- Limit: `ci_screenshots` has no `partial` column (no migration for it): a screenshot's row records
  the profile only, so a partial or failed one reads back as the profile. The screenshot service's
  log says when it recorded a partial one.

## Router (`changes.*`)
`capture` (mutation: `CaptureInputSchema` → `CaptureAnswer`), `history` (`HistoryInputSchema` →
`HistoryAnswer`), `version` (`VersionInputSchema` → `VersionAnswer`), `diff` (`DiffInputSchema` →
`DiffAnswer`) and `pages` (`PagesInputSchema` → `PagesAnswer`). Each starts
`publicProcedure.use(enforceSender)`, then `requireChanges` (a context without the service fails
closed), then its strict input.

## Scenarios
### Router (`packages/ipc-contract/src/__tests__/changes-router.test.ts`)
- **Scenario: every-changes-procedure-enforces-sender** — every `changes.*` procedure refuses a
  foreign origin, whatever its input, without calling the service; without the service each fails
  with a masked internal error.
- **Scenario: changes-inputs-are-validated** — bad tab ids, malformed project and version ids,
  non-`http(s)` or over-long URLs, out-of-range limits, malformed cursors and extra keys are
  `BAD_REQUEST`, and the service is not called.
- **Scenario: changes-procedures-call-service** — valid inputs reach the service as parsed, and its
  answers pass through unchanged.

### Regions (`apps/desktop/src/main/changes/__tests__/regions.test.ts`)
- **Scenario: regions-follow-landmark-rules** — against jsdom documents: nested landmarks (the
  nearest wins), a `header` inside an `article` is not a banner, `role` wins over the element,
  `role=none` removes a landmark, content outside landmarks is `other` with a main landmark and
  `main` without one; headings and links carry their regions; hidden headings and text are left out.
- **Scenario: header-and-footer-are-scoped-by-roles-too** — a `header` in `role=main` and a `footer`
  in `role=article` are not the page's banner and contentinfo; a main landmark behind more than
  `maxMainScan` other roles is still found.
- **Scenario: lone-surrogates-and-hidden-heading-text** — lone surrogates in blocks, headings and
  anchors become U+FFFD (`'abc\uD800'` → `'abc\uFFFD'`), and a heading's or a link's hidden
  descendants are not read.
- **Scenario: hashed-text-stops-at-its-cut** — H cut inside a surrogate pair drops the high half,
  and no later block is appended.
- **Scenario: regions-script-is-self-contained** — `REGIONS_SCRIPT` runs on its own (no module
  scope); `runRegions` runs it in `CAPTURE_WORLD_ID` only; `parseRegionAnswer` answers `null` for
  anything `RegionAnswerSchema` refuses.
- **Scenario: text-blocks-are-not-double-counted** — nested blocks give one block per run of text,
  `br` splits, text is NFC-normalised and whitespace collapsed, words are counted per region, and
  `text` is `blocks.join('\n')`.
- **Scenario: regions-are-bounded** — a hostile DOM (100 000 elements, deep nesting, a huge text
  node, thousands of links and headings) answers `partial`, within every cap, and parses with
  `RegionAnswerSchema`. The caps are checked with a budget large enough that the deadline never
  falls first (the test does not depend on the runner's speed); the deadline is checked on its own,
  with a budget already spent: the same DOM answers `partial`, every region truncated, without
  walking it.

### Snapshot (`snapshot.test.ts`)
- **Scenario: snapshot-builder-fits-the-schema** — a real audit (`runAudit` over a rich page
  fixture) and a region answer build a snapshot `CaptureSnapshotSchema` accepts, with the audit's
  head, HTTP, findings, structured data and image totals, the regions' lists and hashed texts; an
  audit at and over every cap still fits; a snapshot over `MAX_SNAPSHOT_JSON_BYTES` is shrunk to fit.
- **Scenario: snapshot-builder-cuts-to-the-caps** — head values, hreflang and JSON-LD past their caps
  are cut to them; a snapshot over `MAX_SNAPSHOT_JSON_BYTES` is shrunk, largest part first, to fit,
  with every region's hash still over all its text.
- **Scenario: every-rule-is-classified** — `CAPTURE_PAGE_CATEGORIES` and `CAPTURE_CONTEXT_CATEGORIES`
  are every category, each once; the measured speed rules, the accessibility, served-HTML and checks
  rules are left out; `render-blocking-scripts` and every other page rule are kept.
- **Scenario: timing-findings-do-not-make-versions** — an audit whose speed, accessibility, checks or
  served-HTML rules fail builds the same snapshot (and identity) as one where they pass; the score is
  `scoreAudit` of the kept findings.
- **Scenario: lane-key-is-canonical** — the lane key ignores key order and the URL's fragment and
  userinfo, and differs for another URL, render profile or search parameters.

### Search parameters of a tab (`serp-params.test.ts`)
- **Scenario: serp-state-to-search-params** — a `ready` state of the page answers its
  `snapshot.params`, an `unreadable` one its `params` (`null` when it has none); `not-serp`,
  `pending`, `disabled`, a state of another page or another tab, and anything that does not fit
  (garbage, parameters failing `SearchParamsSchema`) answer `null`.
- **Scenario: serp-params-are-late-bound** — the holder answers `null` for every tab until it is bound
  to a `SerpReadApi`, then that API's answer for the tab and page; a read API that throws is `null`.

### Load times (`loads.test.ts`)
- **Scenario: load-times-follow-the-main-frame** — `did-navigate`, `did-finish-load` and a main-frame
  `did-navigate-in-page` to another URL set the tab's load time; a fragment-only move and a
  subframe's move do not.

### Service (`service.test.ts`, on a real session database)
- **Scenario: capture-needs-a-ready-audit** — a pending or unavailable audit, an audit of another
  URL, a tab that is not active, no tab, and a missing project are refused, and nothing is stored.
- **Scenario: capture-waits-for-a-settled-audit-of-this-load** — an audit taken at or before the
  tab's latest load, or a provisional one (robots.txt `pending`), is `no-audit`, and nothing is read
  or stored; a settled audit taken after the load is captured.
- **Scenario: long-urls-are-invalid-pages** — a tab whose URL is longer than `maxUrlChars` is
  `invalid-page` (logged), not left at `no-audit`.
- **Scenario: partial-capture-without-changes-reuses-version** — a partial capture whose only
  difference is a link it did not reach is a capture of the head version; a partial capture that
  changed text makes a new one.
- **Scenario: project-tombstoned-mid-capture** — a project deleted while its capture runs answers
  `no-project`, and nothing is stored.
- **Scenario: capture-records-profile-and-params** — the capture and version record the audit's
  render profile and `partial`, and the search parameters (`searchParamsOf`, or the run's), and the
  lane key is `laneKeyFor` of them.
- **Scenario: capture-records-the-serp-tabs-params** — a manual capture of a tab whose SERP state is a
  ready reading of its page records Phase 3's parameters (`searchParamsOf` is asked with the tab and
  its stored page URL); a capture of a tab that is not a result page records `null`.
- **Scenario: one-search-shares-a-lane** — a run's capture of a search (its parameters given) and a
  manual capture of the same page whose SERP state reads the same search land in one lane: one
  version, two captures.
- **Scenario: profile-in-effect-rule** — one rule for both: an `active` loaded profile is not
  partial; `needsReload`, `applying` and `failed` are partial and still recorded; none is `null`; a
  profile that does not fit its schema does not read back. Test:
  `apps/desktop/src/main/changes/__tests__/profile-in-effect.test.ts` `profile-in-effect-rule`.
- **Scenario: unchanged-page-reuses-version** — a second capture of the same page is a new capture
  of the same version, with no diff.
- **Scenario: changed-page-stores-diff** — a changed page makes a new version whose stored diff
  (canonical JSON, `DIFF_ENGINE_VERSION`) is `diffSnapshots` of the two, and history shows its summary.
- **Scenario: stale-head-retries-once** — a lane that moves between the head read and the append is
  read again and appended once more; a lane that keeps moving is `store-failed`.
- **Scenario: unreadable-head-diffs-from-empty** — a head whose snapshot does not read back is
  diffed from the empty snapshot, and the new version is stored with that diff.
- **Scenario: capture-busy-per-tab** — a second capture of a tab while one runs is `busy`; another
  tab is not; after the first ends the tab can be captured again.
- **Scenario: capture-never-rejects** — a throwing extraction, an extraction that never settles, a
  throwing audit or store each answer a refusal and log one line without page text (a database
  error by its code, never its message).
- **Scenario: region-answer-is-validated** — a garbage answer, an oversized one, extra keys, and an
  untruncated region whose text is not its blocks are `extract-failed`.
- **Scenario: diff-needs-same-lane** — two versions of one lane diff (the stored diff, or one
  computed for another pair); versions of two lanes answer `null`.
- **Scenario: tampered-json-is-skipped** — a version whose stored snapshot, render profile or
  search parameters do not parse is `null` or skipped; a stored diff that does not parse is
  computed afresh.
- **Scenario: read-api-schemas-parse-answers** — every `ChangesReadService` answer parses with its
  `CHANGES_READ_API` output schema, and every operation has a description and both schemas.
