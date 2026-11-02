/**
 * Content analysis and the snippet editor (Phase 2.5 Task 3; acceptance `seo-content.feature.md`).
 * Plain values with no Zod, so the chrome renderer can use them (its strict Trusted Types CSP blocks
 * Zod's eval probe). The Zod inputs of the `content.*` procedures and the snapshot's visible-text
 * part are in `seo-content.schema.ts`.
 *
 * Clean-room: the thresholds, wording, stop-word lists and budgets are frost's own, written from
 * SEO practice and public sources (the readability formulas are published, public formulas, cited where they are defined).
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
 * split word by word. Each word is NFKC-normalised, then case-folded for matching: lowercased for the
 * page's language when it is known (`toLocaleLowerCase(lang)`, so Turkish `I` is `ı`), else
 * `toLowerCase`; a combining dot above (U+0307) after `i` is dropped (Turkish `İ` read without its
 * language) and `ß` is `ss`. The target query is folded the same way, for the same language. A run of words stops at a block boundary (`\n`) and at punctuation between
 * words (any non-word segment with a character other than white space, a hyphen or an apostrophe),
 * so an n-gram never spans a sentence, a list item or a heading.
 *
 * n-grams are 1, 2 and 3 consecutive words of one run. A word that is only digits, a stop-word
 * (`STOP_WORD_LANGUAGES`), or a single letter of a script written with spaces never starts or ends
 * an n-gram, and is never a 1-gram on its own (it can sit inside a 3-gram: "state of play"). A word
 * longer than `CONTENT_LIMITS.maxWordChars` code points is cut to that length and is weak too (a
 * run of letters that long is not a word anyone searches for).
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
  /** Code points of a word kept (longer ones are cut and weak). */
  maxWordChars: 64,
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
 * Readability is scored for the languages frost has a stop-word list for (`READABILITY_LANGUAGES`),
 * each with the published formula made for it. Every formula has one shape:
 *
 *     base − wordsPerSentence × (words / sentences) − syllablesPerWord × (syllables / words)
 *
 * so `READABILITY_FORMULAS` holds the coefficients, a name and the bands of each language, and one
 * function scores them all. Words are the word-like segments (`Intl.Segmenter`; digits-only words
 * left out); sentences are `Intl.Segmenter` sentence segments (block boundaries end one) holding at
 * least one word. The score is shown rounded to one decimal, with the band it falls in (first
 * match, `min` inclusive). A language outside the list, or fewer than `readabilityMinWords` words,
 * has no score ("not available"); its sentence statistics (below) are still given.
 *
 * Syllables come from frost's heuristic for the language (`syllables` in seo-core), not a
 * dictionary, so they are **approximate**: the score is a guide and two similar texts can differ by a
 * point or two. Tests pin the heuristic's behaviour, not the languages' linguistics. Per word (the
 * letters only; at least one syllable for a word with any):
 *
 * - **English:** words of three letters or fewer are one; else the groups of vowels (`a e i o u y`,
 *   a leading `y` not counted), less a silent final `e` (not in `-le` after a consonant), less a
 *   final `-es` / `-ed` after a letter that does not voice it (`-es` after anything but
 *   `s x z c g ch sh`, `-ed` after anything but `t d`).
 * - **Spanish:** the vowels are `a e i o u á é í ó ú ü`, and `y` only at the end of a word (`muy`,
 *   `hoy`); the `u` of `qu` / `gu` before `e i é í` is silent. A group of vowels is one syllable
 *   (a diphthong or triphthong: a weak `i u ü y` beside any vowel) unless two strong vowels meet
 *   (`a e o`, or an accented `í ú`), which are a hiatus and start a new syllable (`país`, `leer`).
 * - **French:** the vowels are `a e i o u y` and their accented forms; the `u` of `qu` / `gu` before
 *   `e i é è ê y` is silent. A group of vowels is one syllable, except that an `é è ë ï ü ö ä â`
 *   after another vowel starts a new one (`aérer`, `haïr`). A final `e` or `es` after a consonant
 *   is mute and not counted (`table`, `femme`), unless it is the word's only vowel.
 * - **German:** the vowels are `a e i o u ä ö ü y`; the `u` of `qu` is silent. A diphthong or a long
 *   vowel written twice is one syllable (`ei ai ey ay au eu äu oi ie aa ee oo`); any other two vowels
 *   side by side are two (`Theater`). A final `e` is counted (`Schule`). Compounds are one word.
 *
 * Formula sources (published formulas; coefficients as printed in the sources named):
 *
 * - English, Flesch 1948: R. Flesch, "A new readability yardstick", Journal of Applied Psychology
 *   32(3), 221–233; 206.835 − 1.015·ASL − 84.6·ASW.
 * - Spanish, Szigriszt-Pazos 1993: F. Szigriszt Pazos, "Sistemas predictivos de legibilidad del
 *   mensaje escrito: fórmula de perspicuidad", doctoral thesis, Universidad Complutense de Madrid;
 *   206.835 − 62.3·(syllables/words) − (words/sentences). Bands: the INFLESZ scale, I. M.
 *   Barrio-Cantalejo et al., "Validación de la Escala INFLESZ para evaluar la legibilidad de los
 *   textos dirigidos a pacientes", Anales del Sistema Sanitario de Navarra 31(2), 2008, 135–152.
 * - French, Kandel & Moles 1958: L. Kandel and A. Moles, "Application de l'indice de Flesch à la
 *   langue française", Cahiers Études de Radio-Télévision 19, 253–274; 207 − 1.015·ASL − 0.736 per
 *   100 words' syllables (73.6·ASW), as printed in T. François and C. Fairon, EMNLP 2012. Bands:
 *   Flesch's published interpretation table (`FLESCH_SCALE_BANDS`).
 * - German, Amstad 1978: T. Amstad, "Wie verständlich sind unsere Zeitungen?", doctoral thesis,
 *   Universität Zürich; 180 − ASL − 58.5·ASW ("Flesch-Amstad"). Bands: Flesch's table
 *   (`FLESCH_SCALE_BANDS`).
 *
 * All four coefficient sets were confirmed against a published source, so every language in the list
 * has a score. The band names are frost's own wording of each published scale.
 */
export const FLESCH = { base: 206.835, wordsPerSentence: 1.015, syllablesPerWord: 84.6 } as const;
export const READABILITY_LANGUAGES = ['en', 'es', 'fr', 'de'] as const;
export type ReadabilityLanguage = (typeof READABILITY_LANGUAGES)[number];
export const READABILITY_FORMULA_IDS = ['flesch', 'szigriszt-pazos', 'kandel-moles', 'amstad'] as const;
export type ReadabilityFormulaId = (typeof READABILITY_FORMULA_IDS)[number];
export interface ReadabilityBand {
  /** The band holds scores from here up to the next band's `min`. */
  readonly min: number;
  readonly label: string;
}
/** Flesch's interpretation table, as worded for English text. */
export const FLESCH_BANDS = [
  { min: 90, label: 'Very easy' },
  { min: 80, label: 'Easy' },
  { min: 70, label: 'Fairly easy' },
  { min: 60, label: 'Plain English' },
  { min: 50, label: 'Fairly difficult' },
  { min: 30, label: 'Difficult' },
  { min: Number.NEGATIVE_INFINITY, label: 'Very difficult' },
] as const satisfies readonly ReadabilityBand[];
/** The same table (same edges) without the English wording, for the French and German formulas. */
export const FLESCH_SCALE_BANDS = [
  { min: 90, label: 'Very easy' },
  { min: 80, label: 'Easy' },
  { min: 70, label: 'Fairly easy' },
  { min: 60, label: 'Standard' },
  { min: 50, label: 'Fairly difficult' },
  { min: 30, label: 'Difficult' },
  { min: Number.NEGATIVE_INFINITY, label: 'Very difficult' },
] as const satisfies readonly ReadabilityBand[];
/** The INFLESZ scale (Barrio-Cantalejo 2008) for the Szigriszt-Pazos score: five bands. */
export const INFLESZ_BANDS = [
  { min: 80, label: 'Very easy' },
  { min: 65, label: 'Quite easy' },
  { min: 55, label: 'Normal' },
  { min: 40, label: 'Somewhat difficult' },
  { min: Number.NEGATIVE_INFINITY, label: 'Very difficult' },
] as const satisfies readonly ReadabilityBand[];
export interface ReadabilityFormula {
  readonly id: ReadabilityFormulaId;
  readonly name: string;
  readonly base: number;
  readonly wordsPerSentence: number;
  readonly syllablesPerWord: number;
  readonly bands: readonly ReadabilityBand[];
}
export const READABILITY_FORMULAS: Readonly<Record<ReadabilityLanguage, ReadabilityFormula>> = {
  en: { id: 'flesch', name: 'Flesch reading ease', ...FLESCH, bands: FLESCH_BANDS },
  es: { id: 'szigriszt-pazos', name: 'Szigriszt-Pazos', base: 206.835, wordsPerSentence: 1, syllablesPerWord: 62.3, bands: INFLESZ_BANDS },
  fr: { id: 'kandel-moles', name: 'Kandel-Moles', base: 207, wordsPerSentence: 1.015, syllablesPerWord: 73.6, bands: FLESCH_SCALE_BANDS },
  de: { id: 'amstad', name: 'Flesch-Amstad', base: 180, wordsPerSentence: 1, syllablesPerWord: 58.5, bands: FLESCH_SCALE_BANDS },
};
export const READABILITY_UNAVAILABLE = ['language', 'too-short', 'no-text'] as const;
export type ReadabilityUnavailable = (typeof READABILITY_UNAVAILABLE)[number];
export const READABILITY_UNAVAILABLE_MESSAGES: Readonly<Record<ReadabilityUnavailable, string>> = {
  language: 'Not available: frost has a readability formula for English, Spanish, French and German.',
  'too-short': 'Not available: too little text to score.',
  'no-text': 'Not available: frost could not read this page’s text.',
};

// ---- Sentences --------------------------------------------------------------------------------

/**
 * Sentence statistics, for any language (information, never a rule: no finding and no score depends
 * on them, as for n-grams). Sentences and words are read as for readability (a sentence counts when
 * it holds a word with a letter, so CJK text is counted in `Intl.Segmenter` words). The report has
 * the number of sentences, the average and longest length in words (average to one decimal), how many
 * are longer than `longSentenceWords`, and, in a `READABILITY_LANGUAGES` language only, the share of
 * words with at least `complexWordSyllables` syllables (0 to 1, three decimals; `null` in any other
 * language, which has no syllable heuristic). A text with no word is "not available" (`no-text`).
 *
 * A sentence is **difficult** when it has more than `longSentenceWords` words (reason `long`) or,
 * in a `READABILITY_LANGUAGES` language, at least `difficultSentenceMinWords` words and its own
 * formula score (the language's formula on that sentence alone, unrounded) is below
 * `difficultSentenceScore` (reason `complex`; `long` wins when both hold). `difficult.total` counts
 * them all; `difficult.items` lists the first `maxDifficultSentences` in page order, each the
 * sentence trimmed and cut to `maxSentenceExcerptChars` UTF-16 code units (never splitting a
 * surrogate pair) with the sentence's full word count.
 */
export const SENTENCE_LIMITS = {
  longSentenceWords: 25,
  difficultSentenceMinWords: 12,
  difficultSentenceScore: 30,
  maxDifficultSentences: 20,
  maxSentenceExcerptChars: 300,
  complexWordSyllables: 3,
} as const;
export const DIFFICULT_SENTENCE_REASONS = ['long', 'complex'] as const;
export type DifficultSentenceReason = (typeof DIFFICULT_SENTENCE_REASONS)[number];

// ---- Target query -----------------------------------------------------------------------------

/**
 * A target query, typed by the user, stored locally per page URL (`seo_target_queries`). Its terms
 * are its words as above, stop-words dropped (unless that leaves none), duplicates dropped, at most
 * `maxQueryTerms`. The checklist says, for each place, which terms it holds (a term is present when
 * the place has the same word) and whether it holds the whole query as one phrase (its words, stop
 * words included, in order) within one of its runs: a field is read as runs of words that end at
 * punctuation and between separate elements (each H1, each subheading, each URL path segment), so
 * "Foo | Bar" never holds the phrase "foo bar" and a phrase never spans two headings. Status: `all`
 * terms, `some`, or `none`. It is a checklist, not a
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
 *
 * Widths are summed per grapheme (`Intl.Segmenter`, `granularity: 'grapheme'`): a grapheme is as
 * wide as its first character, plus `averageLower` for each spacing mark (`Mc`, such as Devanagari
 * vowel signs) after it; everything else after the first character takes no width (nonspacing and
 * enclosing marks `Mn` / `Me`, joiners, variation selectors, the rest of an emoji ZWJ sequence: one
 * glyph). A first character missing from the table is `wideEm` em wide when it is full-width (CJK
 * ideographs, kana, Hangul, full-width forms), an emoji (`Extended_Pictographic`) or a regional
 * indicator (a flag), takes no width when it is `Mn` / `Me` or a format character, and is
 * `averageLower` wide otherwise. Cuts never split a grapheme.
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
 * or description fails once, on its width. The minimums (`title-too-short`,
 * `meta-description-too-short`) are widths too: narrower than `TITLE_MIN_CHARS` (or
 * `DESCRIPTION_MIN_CHARS`) average lowercase Latin letters at the result size (`minSnippetWidth` in
 * seo-core, from the table's `averageLower`: about 294 px for a title, 480 px for a description).
 * So every script has a passing range between the two: about 30–59 Latin letters, or 15–29
 * full-width characters, make a title that is neither too short nor too wide. The budget itself
 * fits (`width <= budget`).
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
 * changed beyond it are deleted after each write). They are the user's own work: Clear Browsing
 * Data keeps them unless its checkbox (`CLEAR_BROWSING_DATA.dialog.checkboxLabel`, unchecked by
 * default) is ticked. The panel deletes each one (clear the query, delete a draft), and "Delete all
 * notes" (`content.clearAllNotes`, also in the command palette) deletes every one after
 * `CLEAR_CONTENT_NOTES` confirms, in a native message box main shows.
 */
export const MAX_CONTENT_NOTE_URLS = 500;

/** "Delete all notes": the confirmation main shows (Cancel is the default and the cancel answer). */
export const CLEAR_CONTENT_NOTES = {
  dialog: {
    type: 'warning',
    message: 'Delete all content notes?',
    detail: 'This deletes every target query and snippet draft frost has stored, for every page. It cannot be undone.',
    buttons: ['Delete All Notes', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/** The `@app/db` tables of this task (migration `0004_seo_content_notes`; also in `SESSION_TABLES`). */
export const CONTENT_TABLES = ['seo_snippet_variants', 'seo_target_queries'] as const;

/**
 * "Copy as HTML" (`content.copySnippetHtml`): main writes, with Electron's `clipboard`, the page's
 * own title and description (from the ready audit the panel shows) or a stored draft's, as
 *
 *     <title>…</title>
 *     <meta name="description" content="…">
 *
 * each value's white space collapsed and trimmed, C0 and C1 control characters removed, `& < > " '`
 * escaped (`&amp; &lt; &gt; &quot; &#39;`) and the bidi controls (U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069) written as numeric character references (`&#x202E;`), so they are visible in the
 * copied markup and cannot reorder it; a line whose value is empty is left out, and with both empty
 * nothing is written.
 */
export const SNIPPET_HTML_SOURCES = ['page', 'variant'] as const;
