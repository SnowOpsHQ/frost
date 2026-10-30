# Feature: Content analysis and the snippet editor

Spec: `specs/seo-content.spec.ts` (`VISIBLE_TEXT_LIMITS`, `VISIBLE_TEXT_BLOCKS`, `NGRAM_*`,
`CONTENT_LIMITS`, `STOP_WORD_LANGUAGES`, the language detection, `FLESCH`, `FLESCH_BANDS`,
`READABILITY_FORMULAS` (Phase 8), `SENTENCE_LIMITS` (Phase 8), the target query,
`SNIPPET_BUDGETS_PX`, `SNIPPET_FONT`, the width rules, the drafts, `CONTENT_TABLES`, Copy as HTML),
`specs/seo-content.schema.ts` (the `content.*` inputs), `specs/seo-snapshot.spec.ts` (`VisibleTextSchema`),
`specs/seo-rules.spec.ts` (the catalog) and `specs/seo-sidebar.spec.ts` (`SEO_PANELS`). Phase 2.5
Task 3. Each line maps to one named test.

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
  `meta-description-too-wide` (info) replace `title-too-long` and `meta-description-too-long`. The
  minimums (`title-too-short`, `meta-description-too-short`) are widths too since the review: under
  `TITLE_MIN_CHARS` (or `DESCRIPTION_MIN_CHARS`) average lowercase Latin letters wide, so a
  full-width (CJK) title passes between about 15 and 29 characters, where a character minimum and
  a width maximum left it no passing length. On-Page's meter still counts characters and shows the
  guide range, but its "Too short" and "Too long" come from the widths.
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
  Browsing Data keeps them (they are work, not history) unless its "Also remove target queries and
  snippet drafts" checkbox, unchecked by default, is ticked. The panel deletes each one, and "Delete
  all notes" (the panel's button, and the palette's action) deletes every one after a native
  confirmation main shows (`CLEAR_CONTENT_NOTES`). Migration `0004` creates its tables only if they
  are missing, so a profile that ran the pre-merge build (which recorded them as `0003`) migrates.
- **Main counts the deletions of every note.** Its notes generation goes up by one each time every
  note is deleted, by Clear Browsing Data (box ticked) or "Delete all notes". The chrome sees it in
  `BrowserState.contentNotesGeneration` and in every `content.getNotes` answer. When it changes, an
  open panel drops its pending edits and reads its notes again. Each write (`content.setTarget`,
  `saveVariant`, `deleteVariant`) carries the generation its notes were read in, and main refuses a
  write from any other generation, so an edit still in flight cannot bring a deleted note back.
- **Copy as HTML goes through main**, like the other copy commands: `content.copySnippetHtml` reads
  the page's values from main's own ready audit (only the one the panel shows) or the stored draft,
  escapes them and writes them with Electron's `clipboard`. The chrome never touches the clipboard.
- **Command palette.** The panel registers its actions (see Command palette below), including
  "Delete all content notes…".

## Visible text (`extract-dom.test.ts`)
- **Scenario: visible-text-blocks** — the text of shown elements is kept, blocks separated by `\n`,
  inline elements joined as written; `script`, `style`, hidden elements are left out.
- **Scenario: visible-text-block-of-inline-text** — a break comes wherever the nearest block ancestor
  (`closest` of the block elements) of two text nodes differs: `<div><p><span>alpha</span></p>beta</div>`
  is `alpha\nbeta`; text in inline siblings of one block stays joined.
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
Phase 8 Task 1 added Spanish, French and German formulas, and the sentence statistics. Syllable
counts are heuristic and approximate in every language (see the spec); the scenarios pin what the
heuristic does, not what a linguist would count. No rule, finding or score depends on any of it.
- **Scenario: syllable-heuristic** — the English heuristic's counts for a fixed word list.
- **Scenario: syllable-heuristic-es** — Spanish: diphthongs, hiatus, silent `u` after `q` / `g`, final `y`.
- **Scenario: syllable-heuristic-fr** — French: mute final `e` / `es`, silent `u`, a new syllable at `é` / `ï` after a vowel.
- **Scenario: syllable-heuristic-de** — German: diphthongs and doubled vowels are one, other vowel pairs two, a final `e` counts.
- **Scenario: flesch-reading-ease** — the formula on a known text, its band; `FLESCH_BANDS` edges.
- **Scenario: readability-formulas-per-language** — a known text in each of English, Spanish, French
  and German: the formula id, the score and the band (INFLESZ for Spanish); the formula table's
  coefficients and band edges are the published ones.
- **Scenario: readability-not-available** — another language (Italian: no score, but the sentence
  statistics are still given), too few words or no text say why.

## Sentences (`content.test.ts`)
- **Scenario: sentence-stats** — over a fixture: the sentence count, the average (one decimal) and
  longest length in words, and how many sentences are longer than 25 words.
- **Scenario: difficult-sentences-long-and-complex** — a sentence over 25 words is difficult
  (`long`); in a formula language so is one of 12 or more words whose own formula score is below 30
  (`complex`); short plain sentences and short dense ones (under 12 words) are not.
- **Scenario: difficult-sentences-capped-and-in-page-order** — the total counts them all; the list
  holds the first 20 in page order; an excerpt is at most 300 UTF-16 code units and never splits a
  surrogate pair; its word count is the sentence's.
- **Scenario: complex-word-share** — the share of words with three or more syllables in a formula
  language; `null` in any other.
- **Scenario: sentence-stats-cjk** — Japanese text is counted in segmenter words and sentences, with
  no score and no complex-word share.
- **Scenario: sentences-are-information** — however long and dense the sentences, the audit's
  findings and score are unchanged.

## Target query (`content.test.ts`)
- **Scenario: query-terms** — stop-words dropped (unless only stop-words), duplicates dropped, capped.
- **Scenario: query-checklist** — per place: the terms present, `all` / `some` / `none`, and the phrase.
- **Scenario: phrases-stay-within-a-run** — "Foo | Bar" does not hold the phrase "foo bar"; a phrase
  does not span two H1s or two URL path segments; an n-gram row is marked present the same way.
- **Scenario: case-folding-follows-the-language** — with the page's language, Turkish `İ`/`I` fold
  to `i`/`ı` on both sides; without it, `İ` still matches `i`; `ß` matches `ss`.
- **Scenario: long-words-are-capped** — a word longer than `maxWordChars` is cut and never an n-gram.

## Widths (`snippet-width.test.ts`)
- **Scenario: width-table-is-generated-data** — the table names `SNIPPET_FONT`, has both sizes and
  every printable ASCII character, with plausible advances.
- **Scenario: text-width** — a width is the sum of its characters' advances; missing characters use
  the full-width or average fallback.
- **Scenario: width-fallback-by-grapheme** — an emoji and a flag are one em; an emoji ZWJ sequence is
  one glyph; a nonspacing or enclosing mark takes no width, a spacing mark (`Mc`) the average; a cut
  never splits a grapheme.
- **Scenario: exact-budget-fits** — 29 full-width characters are exactly 580 px and fit; 30 do not.
- **Scenario: truncate-at-budget** — a text within the budget is kept; a wider one is cut between
  words with `SNIPPET_ELLIPSIS`, its width with the ellipsis within the budget.
- **Scenario: snippet-measure** — title and description widths against each budget, and their cuts.
- **Scenario: snippet-html-escaped** — Copy as HTML's text escapes `& < > " '`, collapses white space,
  and leaves out empty values.
- **Scenario: snippet-html-controls** — C0 and C1 controls are removed; bidi controls become numeric
  character references.

## Rules (`rules.test.ts`)
- **Scenario: title-too-wide** — fails for a title wider than the budget (facts: width, budget, what
  shows), passes for a narrow one even past 60 characters, and for a capped huge title fails.
- **Scenario: meta-description-too-wide** — the same against the desktop description budget.
- **Scenario: width-rules-replace-character-maximums** — the catalog has no `title-too-long` or
  `meta-description-too-long`; the minimums stay; a long title fails once; the description rule is
  `info` and the title rule a `warning`.
- **Scenario: cjk-title-has-a-passing-range** — a full-width title of 14 characters is too short, 15
  to 29 pass both rules, 30 is too wide; a full-width description likewise between the minimum and
  the budget.
- **Scenario: title-too-short** / **meta-description-too-short** (`seo-rules.feature.md`) — measured
  as widths: narrow Latin letters can be too short past 30 characters.

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
- **Scenario: clear-all-notes** — `clearAll()` deletes every target query and draft, of every URL.
- **Scenario: migration-tolerates-pre-merge-tables** — a profile that already has the content tables
  (recorded under the pre-merge id) migrates without error and keeps its rows.
- **Scenario: clear-browsing-data-content-notes-checkbox** (`clear-browsing-data.test.ts`) — the
  dialog's checkbox is unchecked by default; ticked, the content notes are cleared too; unticked
  (or cancelled), they are not.

## Router (`content-router.test.ts`)
- **Scenario: content-procedures-enforce-sender** — every `content.*` procedure rejects a foreign
  sender before the service runs, and fails closed without the service.
- **Scenario: content-inputs-are-validated** — strict inputs: an unknown key, an over-long value,
  a non-`http(s)` URL, a bad slot or a write without its generation never reaches the service.
- **Scenario: content-procedures-call-service** — valid inputs reach the service unchanged, each write
  with its generation; Copy as HTML passes `page` or `{ slot }`.

## Copy (`content-service.test.ts`)
- **Scenario: copy-snippet-html-page** — the page's own title and description from the ready audit
  the panel shows, escaped; nothing for another audit or without one.
- **Scenario: copy-snippet-html-variant** — a stored draft of the audit's URL; nothing for an empty slot.
- **Scenario: clear-all-notes-asks-first** — `clearAllNotes` deletes only after the confirmation
  (`CLEAR_CONTENT_NOTES`); cancelled, nothing is deleted.
- **Scenario: content-notes-generation** — each notes answer carries main's generation; a confirmed
  "Delete all notes" and Clear Browsing Data's deletion (`deleteAllNotes`) each raise it by one and
  tell the chrome; a cancelled one does neither.
- **Scenario: stale-note-write-refused** — a query, draft or draft deletion carrying an older
  generation is refused (`false`) and stores nothing; one carrying the current generation is kept.
- **Scenario: content-notes-generation-in-state** (`controller.test.ts`) — `BrowserState` reports
  main's generation, and a change bumps the state's version.
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

## Command palette (`apps/desktop/src/renderer/__tests__/content-palette.test.ts`)
Registered with `registerPaletteActions` (`command-palette.spec.ts`); the Content panel's jump is
this feature's own (`FEATURE_PANEL_JUMPS`), so the built-ins list no second one.
- "Open Content panel" (`panel.content`): the sidebar on the Content panel, focus on its rail item.
- "Set target query…": the sidebar on the Content panel with focus in the target query field (once
  the field is ready, within `TARGET_QUERY_FOCUS_WINDOW_MS`; a stale request never takes focus).
  Offered for a web page with a ready audit.
- "Copy snippet as HTML": the page's own title and description through `content.copySnippetHtml`
  (as the snippet editor's Copy as HTML), for the shown ready audit with a title or description.
- **Scenario: palette-content-actions** — the three actions, their groups, and what each runs.
- **Scenario: palette-content-availability** — the jump always; the query and the copy only for a
  web page with a ready audit, the copy only with a title or description.
- **Scenario: target-query-focus-request** — a request is taken once, and not after the window.
- **Scenario: palette-delete-all-notes** — "Delete all content notes…" asks main (which confirms) and
  says whether notes were deleted; it is always offered.

## End to end (`seo-content.e2e.ts`)
- **Scenario: content-panel-on-article** — a loopback article: the Content rail item, its n-grams,
  readability and the stop-word note.
- **Scenario: target-query-persists** — the query, its checklist and a draft of its own; after a
  relaunch on the same profile both are still there (independent of the other tests).
- **Scenario: delete-all-notes-and-clear-browsing-data** — Clear Browsing Data with its box unticked
  keeps the notes, ticked removes them; the panel's "Delete all notes" removes them after confirming.
- **Scenario: snippet-editor-previews** — the page's previews cut a wide title at the budget with an
  ellipsis; a draft updates the previews live and persists; Copy as HTML writes escaped HTML.
- **Scenario: clear-browsing-data-resets-open-content-panel** — with the panel open on a target query
  and a draft (and an edit not yet saved), Clear Browsing Data with its box ticked empties the open
  panel at once; the pending edit is not saved, and a later edit stores only itself.
- **Scenario: content-page-text-is-inert** — markup and bidi overrides in the page's text and title
  render as text in the panel; nothing runs, no element is created from them.
