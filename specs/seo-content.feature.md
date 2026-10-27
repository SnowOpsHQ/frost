# Feature: Content analysis and the snippet editor

Spec: `specs/seo-content.spec.ts` (`VISIBLE_TEXT_LIMITS`, `VISIBLE_TEXT_BLOCKS`, `NGRAM_*`,
`CONTENT_LIMITS`, `STOP_WORD_LANGUAGES`, the language detection, `FLESCH`, `FLESCH_BANDS`, the
target query, `SNIPPET_BUDGETS_PX`, `SNIPPET_FONT`, the width rules, the drafts, `CONTENT_TABLES`,
Copy as HTML), `specs/seo-content.schema.ts` (the `content.*` inputs), `specs/seo-snapshot.spec.ts`
(`VisibleTextSchema`), `specs/seo-rules.spec.ts` (the catalog) and `specs/seo-sidebar.spec.ts`
(`SEO_PANELS`). Phase 2.5 Task 3. Each line maps to one named test.

## Decisions
- **A rail panel of its own, "Content"** (after On-Page), not an On-Page sub-section: On-Page is
  already the long "what search engines read" list, and the editor needs room. It holds, in order,
  the snippet preview and drafts, the target query checklist, the n-grams and readability. Its rail
  dot covers the `title`, `meta-description` and `content` rules (also On-Page's).
- **Everything page-derived is analysed in the worker.** The extractor keeps the visible text it
  already walks for the word count (no second walk; same node, character and time budgets) up to
  `maxVisibleTextChars`, with a `\n` at block boundaries. The worker validates it with the snapshot
  (`VisibleTextSchema`) and `runAudit` adds `audit.content` (`contentReport`): the language, the
  n-gram tables, readability, the page title's and description's widths and cuts, and each page
  field's normalised words (title, H1s, description, URL, the first words, subheadings), capped.
  Main never reads any of it. The chrome only matches the user's own text against what the worker
  produced: the target query against those word lists (`queryChecklist`), and a draft's width
  (`measureSnippet`, same table). Neither touches page text beyond the audit's bounded values.
- **Information, not targets.** n-gram counts and the checklist are shown as facts. No rule, score
  or colour depends on keyword density or on the target query.
- **Widths replace the character maximums.** `title-too-wide` (warning) and
  `meta-description-too-wide` (info) replace `title-too-long` and `meta-description-too-long`; the
  minimums stay. On-Page's meter still counts characters and shows the guide range, but its "Too
  long" now comes from the width.
- **The width table is data, made at build time.** `apps/desktop/scripts/measure-snippet-font.mjs`
  runs in Electron (`env -u ELECTRON_RUN_AS_NODE`), measures each character with canvas
  `measureText` in `SNIPPET_FONT.family` at both sizes, and writes
  `packages/seo-core/src/content/snippet-font.ts`. Nothing is measured at runtime.
- **The previews are drawn by frost**, as text, with a neutral glyph (no favicon or other remote
  resource is fetched into the chrome). They are not to scale: the text shown is cut where a result
  would cut it (the pixel budget), and a meter shows the width against the budget.
- **Notes are local and the user's own.** The target query and drafts are stored in `@app/db`
  (`CONTENT_TABLES`, migration `0004_seo_content_notes`), per page URL without its fragment, each
  value checked on the way in and out, at most `MAX_CONTENT_NOTE_URLS` URLs per table. Clear
  Browsing Data keeps them (they are work, not history); the panel deletes each one.
- **Copy as HTML goes through main**, like the other copy commands: `content.copySnippetHtml` reads
  the page's values from main's own ready audit (only the one the panel shows) or the stored draft,
  escapes them and writes them with Electron's `clipboard`. The chrome never touches the clipboard.
- **No command-palette actions yet**: the palette's registry is a parallel task; its actions are
  wired when the two are merged.

## Visible text (`extract-dom.test.ts`)
- **Scenario: visible-text-blocks** — the text of shown elements is kept, blocks separated by `\n`,
  inline elements joined as written; `script`, `style`, hidden elements are left out.
- **Scenario: visible-text-capped** — text over `maxVisibleTextChars` is cut there (`truncated`), never
  splitting a surrogate pair; the word count still counts the whole walk.
- **Scenario: visible-text-schema** — the snapshot schema accepts it, and refuses text over the cap
  or an unknown key (`snapshot.test.ts`).

## Words and n-grams (`content.test.ts`)
- **Scenario: ngrams-latin** — 1-, 2- and 3-grams with counts, most frequent first (ties: first
  seen), stop-words and digits never at an edge, runs broken at punctuation and blocks.
- **Scenario: ngrams-stop-words** — English, Spanish, French and German stop-words are filtered;
  a language without a list keeps them; the language is `declared`, `detected` or `unknown`.
- **Scenario: ngrams-cjk** — Chinese and Japanese text without spaces is segmented into words; their
  n-grams are joined without spaces.
- **Scenario: ngrams-thai** — Thai text without spaces is segmented into words.
- **Scenario: ngram-presence** — each row says whether its words appear, in order, in the title, H1,
  meta description and URL.
- **Scenario: ngrams-are-information** — no rule fails, and the score is unchanged, however often a
  word is repeated.
- **Scenario: report-without-visible-text** — a snapshot without visible text (an older extractor)
  has empty tables and `no-text` readability; its snippet widths are still measured.

## Readability (`content.test.ts`)
- **Scenario: syllable-heuristic** — the heuristic's counts for a fixed word list.
- **Scenario: flesch-reading-ease** — the formula on a known text, its band; `FLESCH_BANDS` edges.
- **Scenario: readability-not-available** — another language, too few words or no text say why.

## Target query (`content.test.ts`)
- **Scenario: query-terms** — stop-words dropped (unless only stop-words), duplicates dropped, capped.
- **Scenario: query-checklist** — per place: the terms present, `all` / `some` / `none`, and the phrase.

## Widths (`snippet-width.test.ts`)
- **Scenario: width-table-is-generated-data** — the table names `SNIPPET_FONT`, has both sizes and
  every printable ASCII character, with plausible advances.
- **Scenario: text-width** — a width is the sum of its characters' advances; missing characters use
  the full-width or average fallback.
- **Scenario: truncate-at-budget** — a text within the budget is kept; a wider one is cut between
  words with `SNIPPET_ELLIPSIS`, its width with the ellipsis within the budget.
- **Scenario: snippet-measure** — title and description widths against each budget, and their cuts.
- **Scenario: snippet-html-escaped** — Copy as HTML's text escapes `& < > " '`, collapses white space,
  and leaves out empty values.

## Rules (`rules.test.ts`)
- **Scenario: title-too-wide** — fails for a title wider than the budget (facts: width, budget, what
  shows), passes for a narrow one even past 60 characters, and for a capped huge title fails.
- **Scenario: meta-description-too-wide** — the same against the desktop description budget.
- **Scenario: width-rules-replace-character-maximums** — the catalog has no `title-too-long` or
  `meta-description-too-long`; the minimums stay; a long title fails once.

## Store (`content-notes.test.ts`, `migrations.test.ts`)
- **Scenario: content-tables-migrate** — migration `0004` creates `CONTENT_TABLES` matching the schema.
- **Scenario: target-query-round-trip** — set, read, replace and clear (`''`) a query; URLs are
  stored without their fragment; a non-`http(s)` URL or an over-long query is refused.
- **Scenario: variants-round-trip** — save drafts in slots, read them in slot order, overwrite and
  delete one; out-of-range slots and over-long values are refused.
- **Scenario: tampered-rows-are-skipped** — rows edited outside frost (bad URL, slot, over-long
  values) are not returned.
- **Scenario: notes-are-pruned** — past `MAX_CONTENT_NOTE_URLS` URLs, the least recently changed go.
- **Scenario: notes-survive-clear-browsing-data** — Clear Browsing Data (the session repository's)
  keeps every target query and draft, and its dialog says they are kept (`CLEAR_BROWSING_DATA`).

## Router (`content-router.test.ts`)
- **Scenario: content-procedures-enforce-sender** — every `content.*` procedure rejects a foreign
  sender before the service runs, and fails closed without the service.
- **Scenario: content-inputs-are-validated** — strict inputs: an unknown key, an over-long value,
  a non-`http(s)` URL or a bad slot never reaches the service.
- **Scenario: content-procedures-call-service** — valid inputs reach the service unchanged; Copy as
  HTML passes `page` or `{ slot }`.

## Copy (`content-service.test.ts`)
- **Scenario: copy-snippet-html-page** — the page's own title and description from the ready audit
  the panel shows, escaped; nothing for another audit or without one.
- **Scenario: copy-snippet-html-variant** — a stored draft of the audit's URL; nothing for an empty slot.
- **Scenario: content-service-survives-a-closed-database** — with the database closed, reads answer
  no notes and writes `false`; the failure is logged in main, never sent to the chrome.

## Panel (`content-view.test.ts`)
- **Scenario: ngram-bar-classes** — a row's bar width is an SVG attribute from its count, never a style.
- **Scenario: width-meter** — the meter's state (`fits`, `over`) and label.
- **Scenario: draft-slots** — a new draft takes the first free slot; none past `MAX_SNIPPET_VARIANTS`.
- **Scenario: on-page-length-verdict-uses-width** — On-Page's "too long" is the width cut, not 60
  characters; "too short" stays the character minimum.
- **Scenario: content-inputs-capped** — the chrome cuts the query and drafts at their caps, never
  splitting a surrogate pair.
- **Scenario: breadcrumb-and-labels** — the preview's address line (host › decoded path segments) and
  the counts' wording.

## End to end (`seo-content.e2e.ts`)
- **Scenario: content-panel-on-article** — a loopback article: the Content rail item, its n-grams,
  readability and the stop-word note.
- **Scenario: target-query-persists** — the query and its checklist; after a relaunch on the same
  profile the query is still there.
- **Scenario: snippet-editor-previews** — the page's previews cut a wide title at the budget with an
  ellipsis; a draft updates the previews live and persists; Copy as HTML writes escaped HTML.
- **Scenario: content-page-text-is-inert** — markup and bidi overrides in the page's text and title
  render as text in the panel; nothing runs, no element is created from them.
