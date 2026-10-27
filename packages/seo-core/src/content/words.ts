import { CONTENT_LIMITS, LANGUAGE_DETECT_MIN_SHARE, LANGUAGE_DETECT_MIN_WORDS, STOP_WORD_LANGUAGES, type ContentLanguageSource, type StopWordLanguage } from '@app/specs/seo-content.spec';
import { STOP_WORDS } from './stop-words';

// Words of a text, as the content analysis reads them (spec `seo-content.spec.ts`, n-grams):
// `Intl.Segmenter` word segments, normalised, grouped into runs that never span punctuation or a
// block boundary. Pure: used in the analysis worker for page text and in the chrome for the
// user's own query, so both read words the same way.

/** A word as read: its normalised form, and whether it may start or end an n-gram. */
export interface Word {
  readonly term: string;
  /** A stop-word, digits only, or one letter of a spaced script: never an n-gram's edge. */
  readonly weak: boolean;
}

/** The page's language for the analysis (`CONTENT_LANGUAGE_SOURCES`). */
export interface ContentLanguage {
  /** The primary subtag (`en`, `ja` …), lowercased; `null` when `unknown`. */
  readonly code: string | null;
  readonly source: ContentLanguageSource;
  /** Whether frost has a stop-word list for it (`STOP_WORD_LANGUAGES`). */
  readonly stopWords: boolean;
}

/** Scripts written without spaces between words: their n-grams are joined with no space. */
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]+$/u;
const DIGITS = /^[\p{N}.,]+$/u;
/** Non-word segments that do not break a run: white space (no line break), hyphens and apostrophes. */
const JOINER = /^[^\S\n]*(?:[-‐‑'’][^\S\n]*)?$/u;
const LETTERS = /[\p{L}\p{N}]+/gu;

const segmenters = new Map<string, Intl.Segmenter | null>();

/** A word segmenter for `lang` (an invalid tag: the runtime's default); `null` without `Intl.Segmenter`. */
function segmenterFor(lang: string | null, granularity: 'word' | 'sentence'): Intl.Segmenter | null {
  const key = `${granularity}:${lang ?? ''}`;
  if (segmenters.has(key)) return segmenters.get(key)!;
  let segmenter: Intl.Segmenter | null = null;
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    try {
      segmenter = new Intl.Segmenter(lang ?? undefined, { granularity });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity });
    }
  }
  if (segmenters.size > 64) segmenters.clear();
  segmenters.set(key, segmenter);
  return segmenter;
}

/** `value` lowercased for `lang` (`toLocaleLowerCase`; an unknown or invalid tag: `toLowerCase`). */
function lowerFor(value: string, lang: string | null): string {
  if (lang === null) return value.toLowerCase();
  try {
    return value.toLocaleLowerCase(lang);
  } catch {
    return value.toLowerCase();
  }
}

/**
 * A word's normalised form (spec `seo-content.spec.ts`, n-grams): NFKC, case-folded for `lang`
 * (`toLocaleLowerCase`, so Turkish `I` is `ı`), a combining dot above after `i` dropped (`İ` read
 * without its language), `ß` as `ss`, a typographic apostrophe (`’`) as `'`, cut to `maxWordChars`
 * code points.
 */
export function normaliseTerm(word: string, lang: string | null = null): string {
  const folded = lowerFor(word.normalize('NFKC'), lang).replace(/i\u0307/g, 'i').replace(/ß/g, 'ss').replace(/\u2019/g, "'");
  return folded.length <= CONTENT_LIMITS.maxWordChars ? folded : [...folded].slice(0, CONTENT_LIMITS.maxWordChars).join('');
}

/** Whether `term` is written in a script without spaces between words. */
export function isUnspaced(term: string): boolean {
  return UNSPACED.test(term);
}

/** The primary subtag of a language tag (`en-GB` → `en`), lowercased; `null` for none. */
export function primaryLanguage(lang: string | null | undefined): string | null {
  const primary = (lang ?? '').trim().split(/[-_]/)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,8}$/.test(primary) ? primary : null;
}

/** The stop-words of `code`, if frost has a list for it. */
export function stopWordsFor(code: string | null): ReadonlySet<string> | null {
  return code !== null && (STOP_WORD_LANGUAGES as readonly string[]).includes(code) ? STOP_WORDS[code as StopWordLanguage] : null;
}

/**
 * The runs of words in `text` (segmented for `lang`): each run is the words between two breaks
 * (punctuation, a `\n`). `stop` marks stop-words weak. Without `Intl.Segmenter`, runs of letters
 * and digits, one run per line.
 */
export function wordRuns(text: string, lang: string | null, stop: ReadonlySet<string> | null): Word[][] {
  const runs: Word[][] = [];
  let run: Word[] = [];
  const end = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  const add = (raw: string) => {
    const term = normaliseTerm(raw, lang);
    const unspaced = isUnspaced(term);
    // A word cut to `maxWordChars` is never an n-gram's edge either.
    const long = raw.length > CONTENT_LIMITS.maxWordChars && [...raw].length > CONTENT_LIMITS.maxWordChars;
    const weak = long || DIGITS.test(term) || (stop?.has(term) ?? false) || (!unspaced && [...term].length === 1);
    run.push({ term, weak });
  };
  const segmenter = segmenterFor(lang, 'word');
  if (!segmenter) {
    for (const line of text.split('\n')) {
      for (const match of line.matchAll(LETTERS)) add(match[0]);
      end();
    }
    return runs;
  }
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) add(segment.segment);
    else if (!JOINER.test(segment.segment)) end();
  }
  end();
  return runs;
}

/** Every word of `text` in order (runs flattened). */
export function wordsOf(text: string, lang: string | null, stop: ReadonlySet<string> | null = null): Word[] {
  return wordRuns(text, lang, stop).flat();
}

/**
 * The normalised words of `texts` (each a separate element: a heading, a URL path segment …) as
 * runs (`wordRuns`: a run never spans punctuation or two texts), at most `max` words in all.
 */
export function fieldRuns(texts: string | readonly string[], lang: string | null, max: number = CONTENT_LIMITS.maxFieldWords): string[][] {
  const runs: string[][] = [];
  let left = max;
  for (const text of typeof texts === 'string' ? [texts] : texts) {
    for (const run of wordRuns(text, lang, null)) {
      if (left <= 0) return runs;
      const terms = run.slice(0, left).map((word) => word.term);
      runs.push(terms);
      left -= terms.length;
    }
  }
  return runs;
}

/** The sentences of `text` (segmented for `lang`): `Intl.Segmenter` sentence segments; without it, lines. */
export function sentencesOf(text: string, lang: string | null): string[] {
  const segmenter = segmenterFor(lang, 'sentence');
  if (!segmenter) return text.split(/\n|(?<=[.!?])\s+/);
  return [...segmenter.segment(text)].map((segment) => segment.segment);
}

/**
 * The page's language for the analysis: the declared primary subtag, else a detected stop-word
 * language (`LANGUAGE_DETECT_MIN_WORDS`, `LANGUAGE_DETECT_MIN_SHARE`), else unknown.
 */
export function contentLanguage(lang: string | null, words: readonly Pick<Word, 'term'>[]): ContentLanguage {
  const declared = primaryLanguage(lang);
  if (declared !== null) return { code: declared, source: 'declared', stopWords: stopWordsFor(declared) !== null };
  if (words.length >= LANGUAGE_DETECT_MIN_WORDS) {
    let best: { code: StopWordLanguage; share: number } | null = null;
    for (const code of STOP_WORD_LANGUAGES) {
      const list = STOP_WORDS[code];
      const share = words.filter((word) => list.has(word.term)).length / words.length;
      if (share >= LANGUAGE_DETECT_MIN_SHARE && (best === null || share > best.share)) best = { code, share };
    }
    if (best) return { code: best.code, source: 'detected', stopWords: true };
  }
  return { code: null, source: 'unknown', stopWords: false };
}

/** `terms` shown as one phrase: no space between words of unspaced scripts, one space otherwise. */
export function joinTerms(terms: readonly string[]): string {
  let out = '';
  terms.forEach((term, i) => {
    if (i > 0 && !(isUnspaced(terms[i - 1]!) && isUnspaced(term))) out += ' ';
    out += term;
  });
  return out;
}

/** Whether `needle` occurs as consecutive terms within one of `runs`. */
export function hasPhrase(runs: readonly (readonly string[])[], needle: readonly string[]): boolean {
  return runs.some((run) => hasSequence(run, needle));
}

/** Whether `needle` occurs in `haystack` as consecutive terms. */
export function hasSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
