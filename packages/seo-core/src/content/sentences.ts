import { READABILITY_FORMULAS, SENTENCE_LIMITS, type DifficultSentenceReason } from '@app/specs/seo-content.spec';
import { letterWords, readabilityLanguage, readingEase, syllables } from './readability';
import { sentencesOf } from './words';

// Sentence statistics (spec `seo-content.spec.ts`, Sentences): information about the page's
// sentences, never a rule. Pure; run in the analysis worker.

export interface DifficultSentence {
  /** The sentence, trimmed and cut to `maxSentenceExcerptChars` code units (no split surrogate pair). */
  readonly text: string;
  /** Words in the whole sentence. */
  readonly words: number;
  readonly reason: DifficultSentenceReason;
}

export type SentenceReport =
  | {
      readonly status: 'ok';
      readonly sentences: number;
      /** Words per sentence, one decimal. */
      readonly averageWords: number;
      readonly longestWords: number;
      /** Sentences longer than `longSentenceWords`. */
      readonly longCount: number;
      /** Share (0–1, three decimals) of words with `complexWordSyllables` or more; `null` without a syllable heuristic. */
      readonly complexWordShare: number | null;
      readonly difficult: {
        /** Every difficult sentence, uncapped. */
        readonly total: number;
        /** The first `maxDifficultSentences`, in page order. */
        readonly items: readonly DifficultSentence[];
      };
    }
  | { readonly status: 'not-available'; readonly reason: 'no-text' };

/** `sentence` trimmed and cut to the excerpt limit without splitting a surrogate pair. */
function excerpt(sentence: string): string {
  const trimmed = sentence.trim();
  const max = SENTENCE_LIMITS.maxSentenceExcerptChars;
  if (trimmed.length <= max) return trimmed;
  const code = trimmed.charCodeAt(max - 1);
  return trimmed.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trimEnd();
}

/** Sentence statistics of `text` in language `code` (see the spec, Sentences). */
export function sentenceReport(text: string, code: string | null): SentenceReport {
  const language = readabilityLanguage(code);
  const formula = language === null ? null : READABILITY_FORMULAS[language];
  let sentences = 0;
  let words = 0;
  let longest = 0;
  let longCount = 0;
  let complexWords = 0;
  let difficultTotal = 0;
  const items: DifficultSentence[] = [];
  for (const sentence of sentencesOf(text, code)) {
    const terms = letterWords(sentence, code);
    if (terms.length === 0) continue;
    sentences += 1;
    words += terms.length;
    longest = Math.max(longest, terms.length);
    let syllableCount = 0;
    if (language !== null) {
      for (const term of terms) {
        const count = syllables(term, language);
        syllableCount += count;
        if (count >= SENTENCE_LIMITS.complexWordSyllables) complexWords += 1;
      }
    }
    const long = terms.length > SENTENCE_LIMITS.longSentenceWords;
    if (long) longCount += 1;
    const complex = formula !== null && terms.length >= SENTENCE_LIMITS.difficultSentenceMinWords && readingEase(formula, terms.length, 1, syllableCount) < SENTENCE_LIMITS.difficultSentenceScore;
    if (!long && !complex) continue;
    difficultTotal += 1;
    if (items.length < SENTENCE_LIMITS.maxDifficultSentences) items.push({ text: excerpt(sentence), words: terms.length, reason: long ? 'long' : 'complex' });
  }
  if (sentences === 0) return { status: 'not-available', reason: 'no-text' };
  return {
    status: 'ok',
    sentences,
    averageWords: Math.round((words / sentences) * 10) / 10,
    longestWords: longest,
    longCount,
    complexWordShare: language === null ? null : Math.round((complexWords / words) * 1000) / 1000,
    difficult: { total: difficultTotal, items },
  };
}
