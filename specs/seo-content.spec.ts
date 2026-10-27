/**
 * Content analysis and the snippet editor (Phase 2.5 Task 3; acceptance `seo-content.feature.md`).
 * Plain values with no Zod, so the chrome renderer can use them (its strict Trusted Types CSP blocks
 * Zod's eval probe). The Zod inputs of the `content.*` procedures and the snapshot's visible-text
 * part are in `seo-content.schema.ts`.
 *
 * Clean-room: the thresholds, wording, stop-word lists and budgets are frost's own, written from
 * SEO practice and public sources (the Flesch formula is a published, public-domain formula).
 */
import type { SeoRuleSpec } from './seo-rules.spec';

// ---- Visible text (the extractor) ------------------------------------------------------------

/**
 * The extractor keeps the page's visible text (the same text nodes its word count reads) for the
 * content analysis, up to `maxVisibleTextChars` UTF-16 code units (never splitting a surrogate pair).
 * Text nodes are joined as written; a block boundary (`VISIBLE_TEXT_BLOCKS`, or a `<br>`) between
 * two of them adds one `\n`, so words of different blocks never run together and an n-gram or a
 * sentence never spans two blocks. The walk's node, character and time budgets are the word count's
 * (`SNAPSHOT_LIMITS.maxTextNodes`, `maxTextScanChars`, `EXTRACT_BUDGET_MS`): keeping the text costs
 * no extra walk. `truncated` when the text was cut here or the walk stopped early.
 */
export const VISIBLE_TEXT_LIMITS = {
  maxVisibleTextChars: 100_000,
} as const;

/** The elements whose start or end is a block boundary in the kept text (lowercase local names). */
export const VISIBLE_TEXT_BLOCKS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
] as const;

// ---- n-grams ---------------------------------------------------------------------------------

/**
 * Words: `Intl.Segmenter` word segments that are `isWordLike`, segmented for the page's language
 * (`<html lang>`, else the runtime's default), so Chinese, Japanese and Thai text without spaces is
 * split word by word. Each word is NFKC-normalised and lowercased (`toLowerCase`, not
 * locale-specific). A run of words stops at a block boundary (`\n`) and at punctuation between
 * words (any non-word segment with a character other than white space, a hyphen or an apostrophe),
 * so an n-gram never spans a sentence, a list item or a heading.
 *
 * n-grams are 1, 2 and 3 consecutive words of one run. A word that is only digits, a stop-word
 * (`STOP_WORD_LANGUAGES`), or a single letter of a script written with spaces never starts or ends
 * an n-gram, and is never a 1-gram on its own (it can sit inside a 3-gram: "state of play").
 * Words of scripts written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) are
 * joined with no space when shown; the others with one space.
 *
 * Each size lists its `ngramRows` most frequent n-grams (ties: first seen first), each seen at least
 * `NGRAM_MIN_COUNT[size]` times. Counts are information, not targets: frost never scores density,
 * and no rule passes or fails on how often a word appears.
 */
export const NGRAM_SIZES = [1, 2, 3] as const;
export type NgramSize = (typeof NGRAM_SIZES)[number];
export const NGRAM_MIN_COUNT: Readonly<Record<NgramSize, number>> = { 1: 1, 2: 2, 3: 2 };
export const CONTENT_LIMITS = {
  /** Rows listed per n-gram size. */
  ngramRows: 25,
  /** Words kept per page field the checklist reads (title, H1s, description, URL, headings). */
  maxFieldWords: 400,
  /** Words of the visible text the "first words" place reads. */
  firstWords: 100,
  /** Terms of a target query used (after stop-words are dropped). */
  maxQueryTerms: 10,
  /** Fewer words than this and readability is "not available" (`too-short`). */
  readabilityMinWords: 100,
} as const;

/**
 * Languages frost ships a stop-word list for (primary language subtags; the lists are frost's own,
 * a hundred or so of the most common function words each: `packages/seo-core/src/content/stop-words.ts`).
 * Any other language gets no stop-word filtering: its n-grams include function words.
 */
export const STOP_WORD_LANGUAGES = ['en', 'es', 'fr', 'de'] as const;
export type StopWordLanguage = (typeof STOP_WORD_LANGUAGES)[number];

/**
 * The page's language for the analysis: the primary subtag of `<html lang>` (lowercased), when it
 * has one (`declared`). Without one, a language of `STOP_WORD_LANGUAGES` is `detected` when at least
 * `LANGUAGE_DETECT_MIN_WORDS` words were read and at least `LANGUAGE_DETECT_MIN_SHARE` of them are
 * that language's stop-words (the highest share wins); otherwise it is `unknown`.
 */
export const LANGUAGE_DETECT_MIN_WORDS = 50;
export const LANGUAGE_DETECT_MIN_SHARE = 0.2;
export const CONTENT_LANGUAGE_SOURCES = ['declared', 'detected', 'unknown'] as const;
export type ContentLanguageSource = (typeof CONTENT_LANGUAGE_SOURCES)[number];

// ---- Readability ------------------------------------------------------------------------------

/**
 * Flesch reading ease, for English only (the formula and its bands were made for English text):
 *
 *     206.835 − 1.015 × (words / sentences) − 84.6 × (syllables / words)
 *
 * Words are the word-like segments above (digits-only words left out); sentences are
 * `Intl.Segmenter` sentence segments (block boundaries end one) holding at least one word.
 * Syllables come from frost's heuristic (`syllables` in seo-core), not a dictionary: per word,
 * words of three letters or fewer are one; else the groups of vowels (`a e i o u y`, a leading `y` not counted), less a silent final `e` (not in
 * `-le` after a consonant), less a final `-es` / `-ed` after a letter that does not voice it (`-es`
 * after anything but `s x z c g ch sh`, `-ed` after anything but `t d`); at least one. The score is
 * shown rounded to one decimal, with the band it falls in (first match, `min` inclusive). Any other
 * language, or fewer than `readabilityMinWords` words, is "not available".
 */
export const FLESCH = { base: 206.835, wordsPerSentence: 1.015, syllablesPerWord: 84.6 } as const;
export const READABILITY_LANGUAGES = ['en'] as const;
export const FLESCH_BANDS = [
  { min: 90, label: 'Very easy' },
  { min: 80, label: 'Easy' },
  { min: 70, label: 'Fairly easy' },
  { min: 60, label: 'Plain English' },
  { min: 50, label: 'Fairly difficult' },
  { min: 30, label: 'Difficult' },
  { min: Number.NEGATIVE_INFINITY, label: 'Very difficult' },
] as const;
export const READABILITY_UNAVAILABLE = ['language', 'too-short', 'no-text'] as const;
export type ReadabilityUnavailable = (typeof READABILITY_UNAVAILABLE)[number];
export const READABILITY_UNAVAILABLE_MESSAGES: Readonly<Record<ReadabilityUnavailable, string>> = {
  language: 'Not available: frost only has a readability formula for English.',
  'too-short': 'Not available: too little text to score.',
  'no-text': 'Not available: frost could not read this page’s text.',
};

// ---- Target query -----------------------------------------------------------------------------

/**
 * A target query, typed by the user, stored locally per page URL (`seo_target_queries`). Its terms
 * are its words as above, stop-words dropped (unless that leaves none), duplicates dropped, at most
 * `maxQueryTerms`. The checklist says, for each place, which terms it holds (a term is present when
 * the place has the same word) and whether it holds the whole query as one phrase (its words, stop
 * words included, in order). Status: `all` terms, `some`, or `none`. It is a checklist, not a
 * score: frost never passes or fails a page on it.
 */
export const TARGET_QUERY_MAX_CHARS = 200;
export const TARGET_QUERY_PLACES = ['title', 'h1', 'url', 'first-words', 'headings'] as const;
export type TargetQueryPlace = (typeof TARGET_QUERY_PLACES)[number];
export const TARGET_QUERY_PLACE_LABELS: Readonly<Record<TargetQueryPlace, string>> = {
  title: 'Title',
  h1: 'H1',
  url: 'URL',
  'first-words': `First ${CONTENT_LIMITS.firstWords} words`,
  headings: 'Subheadings (H2–H6)',
};
export const QUERY_PRESENCE = ['all', 'some', 'none'] as const;
export type QueryPresence = (typeof QUERY_PRESENCE)[number];

/** The places an n-gram row marks it present in (as the checklist matches a phrase). */
export const NGRAM_PLACES = ['title', 'h1', 'description', 'url'] as const;
export type NgramPlace = (typeof NGRAM_PLACES)[number];

// ---- Pixel widths -----------------------------------------------------------------------------

/**
 * Result snippets are cut by width, not characters. These budgets are approximations, rounded, from
 * public measurements of desktop and mobile result pages (results are drawn in a common sans-serif:
 * titles at about 20 px, descriptions at about 14 px); search engines change their layouts and do
 * not publish limits, so treat them as a guide, not a rule of the engine. frost has no separate
 * figure for mobile titles: the mobile preview cuts the title at the desktop budget too.
 */
export const SNIPPET_BUDGETS_PX = {
  titleDesktop: 580,
  descriptionDesktop: 920,
  descriptionMobile: 680,
} as const;

/**
 * The face and sizes the character-width table was measured with
 * (`apps/desktop/scripts/measure-snippet-font.mjs`, run in Electron: canvas `measureText` of each
 * character in `SNIPPET_FONT.family`, at each size). The table is committed as data
 * (`packages/seo-core/src/content/snippet-font.ts`). A text's width is the sum of its characters'
 * advances (no kerning). A character missing from the table is `wideEm` em wide when it is a
 * full-width one (CJK ideographs, kana, Hangul, full-width forms), else the table's average
 * lowercase Latin letter. On Linux the family resolves to a metric-compatible face.
 */
export const SNIPPET_FONT = {
  family: 'Arial',
  titlePx: 20,
  descriptionPx: 14,
  wideEm: 1,
} as const;
export const SNIPPET_TEXT_KINDS = ['title', 'description'] as const;
export type SnippetTextKind = (typeof SNIPPET_TEXT_KINDS)[number];

/**
 * Cutting a text to a budget: the longest prefix that, with `SNIPPET_ELLIPSIS`, fits; then back to
 * the last white space in it, if there is one past half of the prefix (results cut between words);
 * trailing white space and punctuation (`, ; : - –`) are dropped before the ellipsis.
 */
export const SNIPPET_ELLIPSIS = '…';

/**
 * The width rules (Phase 2.5 Task 3) **replace** Phase 2's `title-too-long` and
 * `meta-description-too-long` (characters were the proxy until widths were measured): a long title
 * or description fails once, on its width. The character minimums (`title-too-short`,
 * `meta-description-too-short`) stay: a short text is about saying too little, not about space.
 * The kept text (at most `SNAPSHOT_LIMITS.maxTextChars`) is measured; a text cut by that cap is far
 * wider than any budget.
 */
export const TITLE_WIDTH_RULE = {
  id: 'title-too-wide',
  category: 'title',
  severity: 'warning',
  title: 'Title is wider than a result shows',
  condition: `The first title with text is wider than about ${SNIPPET_BUDGETS_PX.titleDesktop} px at the result title size (frost’s width table).`,
  why: 'Desktop results cut titles at a width, so the end of a wide title (often the brand or a key detail) is replaced by an ellipsis.',
  fix: 'Put the most important words first, and shorten or narrow the title until the preview shows it whole.',
} as const satisfies SeoRuleSpec;

export const DESCRIPTION_WIDTH_RULE = {
  id: 'meta-description-too-wide',
  category: 'meta-description',
  severity: 'info',
  title: 'Meta description is wider than a result shows',
  condition: `The first meta description with text is wider than about ${SNIPPET_BUDGETS_PX.descriptionDesktop} px at the result description size (frost’s width table).`,
  why: 'Desktop results show about two lines of a description, and mobile results less, so the end of a long description is cut.',
  fix: 'Lead with the key point and trim the description until the desktop preview shows it whole.',
} as const satisfies SeoRuleSpec;

// ---- Snippet drafts ---------------------------------------------------------------------------

/**
 * Title and description drafts, stored locally per page URL (`seo_snippet_variants`), in up to
 * `MAX_SNIPPET_VARIANTS` numbered slots. Longer input is cut in the chrome and refused by main.
 */
export const MAX_SNIPPET_VARIANTS = 6;
export const SNIPPET_VARIANT_TITLE_MAX_CHARS = 300;
export const SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS = 1_000;

/**
 * Target queries and drafts are kept for at most this many page URLs each (the least recently
 * changed beyond it are deleted after each write). They are the user's own work, so Clear Browsing
 * Data keeps them; each one is deleted from the panel (clear the query, delete a draft).
 */
export const MAX_CONTENT_NOTE_URLS = 500;

/** The `@app/db` tables of this task (migration `0004_seo_content_notes`; also in `SESSION_TABLES`). */
export const CONTENT_TABLES = ['seo_snippet_variants', 'seo_target_queries'] as const;

/**
 * "Copy as HTML" (`content.copySnippetHtml`): main writes, with Electron's `clipboard`, the page's
 * own title and description (from the ready audit the panel shows) or a stored draft's, as
 *
 *     <title>…</title>
 *     <meta name="description" content="…">
 *
 * each value's white space collapsed and trimmed, `& < > " '` escaped (`&amp; &lt; &gt; &quot; &#39;`);
 * a line whose value is empty is left out, and with both empty nothing is written.
 */
export const SNIPPET_HTML_SOURCES = ['page', 'variant'] as const;
