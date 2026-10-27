import { CONTENT_LIMITS, FLESCH, FLESCH_BANDS, READABILITY_LANGUAGES, type ReadabilityUnavailable } from '@app/specs/seo-content.spec';
import { sentencesOf, wordsOf } from './words';

// Readability (spec `seo-content.spec.ts`, Readability): Flesch reading ease for English, with
// frost's syllable heuristic. Pure; run in the analysis worker.

export type Readability =
  | {
      readonly status: 'ok';
      /** Flesch reading ease, one decimal (may fall outside 0–100 for extreme text). */
      readonly score: number;
      /** `FLESCH_BANDS` label. */
      readonly band: string;
      readonly words: number;
      readonly sentences: number;
      readonly syllables: number;
    }
  | { readonly status: 'not-available'; readonly reason: ReadabilityUnavailable };

const VOWEL_GROUP = /[aeiouy]+/g;
/** `-es` is a syllable after these (`boxes`, `wishes`, `pages`, `places`). */
const VOICED_ES = /(?:[sxzgc]|ch|sh)es$/;

/**
 * Syllables in an English word (frost's heuristic): vowel groups (`a e i o u y`, a leading `y`
 * not one), less a silent final `e` (not `-le` after a consonant), less a final `-es` / `-ed`
 * whose `e` is silent (`-es` not after `s x z c g ch sh`, `-ed` not after `t d`); at least one.
 */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w === '') return 0;
  if (w.length <= 3) return 1;
  const body = w.startsWith('y') ? w.slice(1) : w;
  let count = (body.match(VOWEL_GROUP) ?? []).length;
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) count -= 1;
  else if (/[^aeiouy]es$/.test(w) && !VOICED_ES.test(w)) count -= 1;
  else if (/[^aeiouy]ed$/.test(w) && !/[td]ed$/.test(w)) count -= 1;
  return Math.max(1, count);
}

/** `FLESCH_BANDS`' label for `score` (first band whose `min` it reaches). */
export function fleschBand(score: number): string {
  return FLESCH_BANDS.find((band) => score >= band.min)!.label;
}

/** Flesch reading ease of the counts (one decimal). */
export function fleschReadingEase(words: number, sentences: number, syllableCount: number): number {
  const score = FLESCH.base - FLESCH.wordsPerSentence * (words / sentences) - FLESCH.syllablesPerWord * (syllableCount / words);
  return Math.round(score * 10) / 10;
}

const LETTER_WORD = /\p{L}/u;

/** Readability of `text` in language `code` (`READABILITY_LANGUAGES` only; see the spec). */
export function readability(text: string, code: string | null): Readability {
  if (text.trim() === '') return { status: 'not-available', reason: 'no-text' };
  if (code === null || !(READABILITY_LANGUAGES as readonly string[]).includes(code)) return { status: 'not-available', reason: 'language' };
  let words = 0;
  let sentences = 0;
  let syllableCount = 0;
  for (const sentence of sentencesOf(text, code)) {
    const inSentence = wordsOf(sentence, code).filter((word) => LETTER_WORD.test(word.term));
    if (inSentence.length === 0) continue;
    sentences += 1;
    words += inSentence.length;
    for (const word of inSentence) syllableCount += syllables(word.term);
  }
  if (words < CONTENT_LIMITS.readabilityMinWords) return { status: 'not-available', reason: 'too-short' };
  const score = fleschReadingEase(words, sentences, syllableCount);
  return { status: 'ok', score, band: fleschBand(score), words, sentences, syllables: syllableCount };
}
