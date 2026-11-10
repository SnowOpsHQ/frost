# Feature: Content analysis and the snippet editor

Spec: `specs/seo-content.spec.ts` (`VISIBLE_TEXT_LIMITS`, `VISIBLE_TEXT_BLOCKS`, `NGRAM_*`,
`CONTENT_LIMITS`, `STOP_WORD_LANGUAGES`, the language detection, `FLESCH`, `FLESCH_BANDS`,
`READABILITY_FORMULAS` (Phase 8), `SENTENCE_LIMITS` (Phase 8), the target query,
`SNIPPET_BUDGETS_PX`, `SNIPPET_FONT`, the width rules, the drafts, `CONTENT_TABLES`, Copy as HTML),
`specs/seo-content.schema.ts` (the `content.*` inputs), `specs/seo-snapshot.spec.ts` (`VisibleTextSchema`),
`specs/seo-rules.spec.ts` (the catalog) and `specs/seo-sidebar.spec.ts` (`SEO_PANELS`;
`HIGHLIGHT_MODES` `sentences`, `HIGHLIGHT_STYLES`, `TextHighlightTarget`, Phase 8), `specs/seo-limits.spec.ts`
(`MAX_TEXT_HIGHLIGHT_TARGETS`, `MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET`, Phase 8). Phase 2.5 Task 3.
Each line maps to one named test.

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
- **Scenario: failed-notes-read-keeps-the-known-query** — a notes read the database fails answers
  no notes and leaves the page's already-known target query (`targetQueryOf`) as it was.

## Panel (`content-view.test.ts`)
- **Scenario: ngram-bar-classes** — a row's bar width is an SVG attribute from its count, never a style.
- **Scenario: width-meter** — the meter's state (`fits`, `over`) and label.
- **Scenario: draft-slots** — a new draft takes the first free slot; none past `MAX_SNIPPET_VARIANTS`.
- **Scenario: on-page-length-verdict-uses-width** — On-Page's "too long" is the width cut, not 60
  characters; "too short" stays the character minimum.
- **Scenario: content-inputs-capped** — the chrome cuts the query and drafts at their caps, never
  splitting a surrogate pair.
- **Scenario: count-labels** — the counts' wording. (The preview's address line, host › decoded path
  segments, is `serpPreview`'s since Phase 11 Task 3: `breadcrumb-falls-back-to-url`.)
- **Scenario: readability-view-formula-and-band** (Phase 8) — the readability section names the
  formula that scored the page (`READABILITY_FORMULAS`' `name`: Flesch reading ease, Szigriszt-Pazos,
  Kandel-Moles, Flesch-Amstad) with its band, never "Flesch, for English text" for another language.
- **Scenario: sentence-stats-view** — the sentence count, words per sentence, the longest sentence
  and how many are long (over `longSentenceWords`), and the complex-word share as a percentage in a
  formula language (none in another); "not available" without text.
- **Scenario: difficult-sentence-items** — each difficult sentence is a row of its excerpt (inert
  text), a reason chip ("Long" / "Complex") and its word count; the heading counts every difficult
  sentence ("Difficult sentences (n)"), and "and N more" says how many the list leaves out.

## Search Console targets (Phase 9 Task 5; SL-020; `content-gsc-targets.test.ts`, jsdom)
Spec: `specs/gsc-targets.spec.ts` (`GSC_TARGET_SUGGESTIONS`, `GSC_TARGET_CHECK_DELAY_MS`,
`GSC_TARGETS_COPY`), `specs/gsc.spec.ts` (`GSC_LIMITS.maxTargetPages`, `GSC_TARGET_PAGES_READ_ROWS`,
`normalizeGscQuery`) and `specs/gsc.schema.ts` (`GscTargetPagesQuerySchema`,
`GscTargetPagesAnswerSchema`); main's read is in `gsc.feature.md` (Search targets).
- **Under the target query, only when connected.** With Search Console unconfigured, not connected
  (or `gsc.watch` not answered yet), or a page that is not `http(s)`, nothing is added and nothing is
  read: the panel is as before. Connected, the target query section gains two parts.
- **Suggestions** are the page's top queries: the existing `gsc.topQueries` (page scope, the Search
  Console panel's range from its shared store, no country or device filter), at most
  `GSC_TARGET_SUGGESTIONS` (5), each with its clicks and "Use as target". "Use as target" puts the
  query in the field and saves it at once through `content.setTarget`, carrying the generation the
  notes were read in (the notes-generation rule above). The current target is marked instead.
  No queries: "Google hides rare queries".
- **The query→page check** runs for the saved target query (`GSC_TARGET_CHECK_DELAY_MS` after it last
  changed), when connected: `gsc.targetPages` over the same range lists the top
  `GSC_LIMITS.maxTargetPages` (10) pages of the property Google showed for it, this page marked, and
  says this page's place among all the pages read ("#37 of the 120") or that it is not among them.
  No pages: `no-data`, "Google hides rare queries".
- **Both are information only.** No rule, score or colour depends on them: another page leading for
  the target query is stated as a fact, in the same neutral style as this page leading.
- Queries and page URLs from Google are inert, bidi-isolated text (`<bdi dir="auto">`); a page URL is
  never a link.
- **Scenario: suggestions-only-when-connected** — unconfigured, not connected or not yet answered:
  no section and no `gsc.topQueries` / `gsc.targetPages` call; connected: the page's top queries (at
  most 5) with "Use as target", read with the panel's range.
- **Scenario: use-as-target-calls-setTargetQuery-with-generation** — "Use as target" fills the field
  and calls `content.setTarget` with the page, the query and the notes' generation (the one they were
  read in), at once; the suggestion is then marked as the target.
- **Scenario: target-pages-list-marks-this-page** — for the saved target query, `gsc.targetPages` is
  read with the page, the query and the panel's range; its pages are listed with this page marked and
  its place stated; outside the top 10, the place is still stated; not among them, that is said; no
  pages: "Google hides rare queries".
- **Scenario: another-page-leads-is-a-fact-not-a-rule** — whether this page or another leads, the list
  has the same classes and no tone or colour attribute; the words say it is information, not a target.

## Highlight (Phase 8 Task 2)
The Content panel owns the `sentences` mode (`HIGHLIGHT_PANELS`): its "Highlight on page" toggle,
shown when the audit has difficult sentences, boxes them on the page, each line fragment of a
sentence boxed in its reason's colour (`long-sentence`, `complex-sentence`), labelled on its first
line. It goes off as every overlay does: leaving the Content panel, collapsing the sidebar, the page
changing. Main hands the painter the excerpts of the tab's own ready audit
(`sentenceHighlightTargets`, at most `MAX_TEXT_HIGHLIGHT_TARGETS`); the chrome never sends page text
to paint (`seo.setHighlight` takes the mode only). The painter runs in the isolated SEO world, finds
each excerpt across the page's text nodes (white space runs as one space, as the extractor reads
them; bidi and zero-width characters matched as they are), and draws boxes from the match's
`Range.getClientRects()` in its closed shadow root: no page node, attribute or style changes. The
texts travel into the script as JSON data, never as code. Excerpts no longer on the page are counted
and said in the overlay (`TEXT_HIGHLIGHT_UNMATCHED_NOTE`).
- **Scenario: plan-text-highlight-finds-excerpts** (`highlight.test.ts`) — an excerpt is found across
  text nodes (split mid-word and at inline elements), with the page's white space runs (and the
  excerpt's) read as one space, at its first occurrence; a second, equal excerpt takes the next one.
- **Scenario: plan-text-highlight-unmatched-counted** — excerpts not in the page's text (rewritten,
  or empty) are counted, never matched elsewhere; bidi and zero-width characters must match exactly.
- **Scenario: text-highlight-capped** — at most `MAX_TEXT_HIGHLIGHT_TARGETS` texts are planned and
  carried by the script, each boxed with at most `MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET` rects.
- **Scenario: text-highlight-script-is-self-contained** — `highlightScript('sentences', …)` evaluates
  in a fresh context with no module scope and draws; the stringified `planTextHighlight` gives the
  same plan as the imported one; hostile excerpts (quotes, `</script>`, U+2028, bidi controls) are
  JSON data in the script; no markup, stylesheet, `eval` or Node API.
- **Scenario: text-highlight-leaves-the-page-untouched** (`extract-dom.test.ts`, the stringified
  script) — while drawn and after `off`: no attribute, style, text or node change in the page outside
  the overlay's one host, whose shadow root is closed; the page's DOM is as before after `off`.
- **Scenario: text-highlight-walk-budgeted** — a page with more than `maxTextNodes` text nodes: the
  walk stops at the cap (or the budget), the overlay settles within the budget and draws what it found.
- **Scenario: sentences-highlight-takes-targets-from-the-audit** (`panels.test.ts`) — the controller
  paints with the targets of the tab's ready audit (`sentenceHighlightTargets`); without a ready audit,
  or with no difficult sentence, `seo.setHighlight(tab, 'sentences')` is `false` and nothing is painted.
- **Scenario: sentences-highlight-resets-on-navigation** — an in-page navigation to another URL turns
  it off and removes it; a new document turns it off.
- **Scenario: sentence-highlight-targets** (`highlight.test.ts`) — the audit's difficult
  sentences become targets of kind `long-sentence` / `complex-sentence`, in order, capped; none
  for an audit without sentence statistics.

## Keyphrase highlight (Phase 11 Task 2)
Each n-gram row of "Frequent words and phrases" has a highlight toggle (pressed while that phrase is
the tab's `keyphrase`, `TabState.highlightPhrase`), and a non-empty target query has "Highlight on
page": a click first saves the query (waiting for any save already sent), then asks for it. The chrome names the phrase (`seo.setHighlight` with `phrase`); main boxes it only when
it is one of its ready audit's n-grams (any size) or the page's stored target query, else `false`,
and hands the painter its own copy: the phrase's text, its normalised words (`terms`, as `wordRuns`
reads them) and the page's declared language. The painter is Phase 8's `planTextHighlight` with its
"every occurrence" option: it segments the page's text with `Intl.Segmenter` for that language,
normalises each word as the audit does, and boxes each run of words equal to `terms` (white space,
one hyphen or one apostrophe between them, never punctuation), at most `MAX_KEYPHRASE_MATCHES` in
page order. Matching is by whole word: `cat` never matches inside `category`, and a Japanese phrase
only where the segmenter puts its word boundaries. No occurrence left: the overlay says so
(`KEYPHRASE_UNMATCHED_NOTE`). It goes off like every overlay (leaving the panel, the page changing).
- **Scenario: plan-text-highlight-every-occurrence-capped** (`highlight.test.ts`) — with the option,
  every whole-word occurrence of the phrase is a span, in page order, across text nodes and case and
  width differences, capped at the option's maximum; without it the planner is Phase 8's.
- **Scenario: keyphrase-whole-words-only** — `cat` matches `Cat` and `cat` but not `category` or
  `concat`; a phrase does not match across punctuation; a Japanese phrase matches at segmenter word
  boundaries only.
- **Scenario: keyphrase-highlight-leaves-page-untouched** (`extract-dom.test.ts`, the stringified
  script) — while drawn and after `off`: the only change is the overlay's one host, its shadow root
  closed; the page's DOM is as before after `off`.
- **Scenario: ngram-row-highlight-toggle** (`content-view.test.ts`) — a row's toggle is pressed only
  for the tab's `keyphrase` with that phrase; pressing it asks for `keyphrase` with the row's text,
  pressing it again for `off`.
- **Scenario: highlight-keyphrase-from-ngram** (`seo-content.e2e.ts`) — a loopback article: an
  n-gram row's toggle boxes every whole-word occurrence of the phrase on the page (not the longer
  word holding it); the toggle is pressed; leaving the panel removes the boxes and leaves the page's
  `<html>` as it was.

## Result preview facts (Phase 11 Task 3, Decision 4; SL-053, SL-054)
Spec: `seo-content.spec.ts` (`SERP_PREVIEW_VARIANTS`, `SERP_PREVIEW_LIMITS`, `SERP_PREVIEW_BUDGETS_PX`,
the source orders `SERP_SITE_NAME_SOURCES` / `SERP_BREADCRUMB_SOURCES` / `SERP_DATE_SOURCES`,
`SERP_PREVIEW_NOTE`, `SERP_PREVIEW_TOGGLES`, `SNIPPET_JSONLD_SOURCES`, `SUGGESTED_JSONLD_SHAPE`),
`seo-content.schema.ts` (`CopyPreviewJsonLdInputSchema`), `seo-limits.spec.ts` (`SOCIAL_TAGS` +=
`article:published_time`, `article:modified_time`).
- The standard previews show a site-name line (with a frost-drawn monogram, never a favicon), an
  address line of the host and the breadcrumb trail, and, before the description, the date and the
  rating, each from the audit alone (`serpPreview`). Rich variants (Top stories, Video, Recipe) are
  frost's own text cards, each under `SERP_PREVIEW_NOTE`; a variant the page has no node for is
  disabled with its reason. Every fact is inert, bidi-isolated text.
- The toggles and the site-name override live in the panel's state for the session only; drafts
  still store a title and a description only (no migration).
- **Scenario: site-name-prefers-website-schema** (`serp-preview.test.ts`) — a WebSite node's `name`
  wins over `og:site_name`; an override wins over both; cut at `maxSiteNameChars`.
- **Scenario: site-name-falls-back-to-og-then-host** — without a named WebSite, `og:site_name`;
  without that, the host without `www.`.
- **Scenario: breadcrumb-from-breadcrumblist** — ListItems (nested or by `@id`) ordered by position,
  named by `name` or their item's `name`, with absolute URLs only; at most `maxCrumbs` steps of
  `maxCrumbChars`; the address line is cut by width.
- **Scenario: breadcrumb-falls-back-to-url** — no BreadcrumbList (or none with a named step): the
  URL's decoded path segments.
- **Scenario: date-from-article-schema** — an Article-family `datePublished`, else its `dateModified`,
  shown as `Mon D, YYYY` from the date as written.
- **Scenario: date-falls-back-to-article-published-time** — no Article date: `article:published_time`,
  then `article:modified_time`.
- **Scenario: rating-from-aggregate** — the first valid AggregateRating: value, best, count, stars.
- **Scenario: video-and-recipe-facts** — a VideoObject's name, duration (`m:ss`), upload date and
  thumbnail flag; a Recipe's name, total time (or prep + cook), yield and own rating; the variants
  each enables.
- **Scenario: invalid-dates-and-ratings-ignored** — a date that is not ISO 8601 (or not a real date)
  is skipped for the next source; a rating that is not a number, out of range or with
  `worstRating >= bestRating` is skipped; a non-integer count is dropped; a duration with years or
  months is not shown.
- **Scenario: suggested-jsonld-escapes-lt** — the suggested JSON-LD is the `SUGGESTED_JSONLD_SHAPE`
  graph from validated fields only, every `<` written `\u003c`; it parses back to the same values. Its
  trail lists every step (a deep URL's seven, though five are drawn), its site name is not the drawn
  cut, a modified date is `dateModified`, and the page is the effective canonical when there is one.
- **Scenario: article-time-tags-read** (seo-core `panels.test.ts`; `extract-dom.test.ts`) — the
  extractor reads `article:published_time` / `article:modified_time` like the other social tags; the
  audit carries them and the result preview reads them as its last date sources.
- **Scenario: article-time-tags-leave-capture-identity-unchanged** (`changes/__tests__/snapshot.test.ts`)
  — the same page with and without the article tags gives the same capture snapshot and identity.
- **Scenario: copy-jsonld-page-blocks** (`content-service.test.ts`) — `page` writes the page's blocks
  that fed the preview (formatted), not the others; `suggested` writes the suggested JSON-LD with the
  override and toggles applied; nothing when no block fed the preview.
- **Scenario: copy-jsonld-stale-audit-writes-nothing** — another audit than the one shown, another
  tab, or a pending one: `false`, nothing written.
- **Scenario: copy-preview-jsonld-input-bounded** (`content-router.test.ts`) — strict input: unknown
  keys, an unknown source, fields with `page`, an over-long or multi-line override are refused.
- **Scenario: preview-variant-cards** (`content-view.test.ts`) — each variant's card lines and
  whether it is offered, from the facts; the stars text; the toggles hide their parts.

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
  render as text in the panel; nothing runs, no element is created from them. (Phase 8) A difficult
  sentence holding markup shows as text in the difficult-sentence list.
- **Scenario: content-readability-depth** (Phase 8) — a Spanish article: the Szigriszt-Pazos score and
  its band, the sentence statistics and the difficult-sentence list.
- **Scenario: content-highlight-sentences-leaves-no-residue** (Phase 8) — a long English article served
  with a strict CSP: the toggle draws boxes; leaving the panel and navigating remove them; the page's
  DOM is as before (the checks of `seo-panels.e2e.ts`'s `highlight-links-leaves-no-residue`).
- **Scenario: content-gsc-suggestion-sets-target** (Phase 9; fake Google, configured for every launch
  and connected only here, at the end) — configured but not connected, no Search Console part and no
  read; connected, the page's top five queries with "Use as target" and the range note, read for this
  page with no country or device and no page read yet; "Use as target" fills the field, marks the row
  "Target" and is saved in main.
- **Scenario: content-target-pages-marks-this-page** (Phase 9) — for a target query set with "Use as
  target", the pages Google showed for it in the fake's order, this page alone marked "This page",
  its rank among them stated, the facts line; no tone and no link in the part; one page read for the
  query, with no page, country or device filter.
- **Scenario: serp-preview-schema-facts-and-variants** (Phase 11 Task 3) — a loopback article with
  WebSite, BreadcrumbList, NewsArticle (a date), AggregateRating, VideoObject and Recipe JSON-LD: the
  standard previews show the schema site name with its monogram, the trail, the date and the rating
  as text; a site-name override replaces the name for the session; the toggles hide parts; each
  variant card shows its facts under the note; no image is loaded into the chrome. A page without
  markup falls back to `og:site_name`, the URL trail and `article:published_time`, with the rich
  variants disabled.
- **Scenario: copy-jsonld** (Phase 11 Task 3) — "Copy JSON-LD" of the page writes the blocks that fed
  the preview; "Copy suggested JSON-LD" writes the suggested graph with the override, `<` as `\u003c`;
  both through main's clipboard.
