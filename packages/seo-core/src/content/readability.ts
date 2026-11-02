import {
  CONTENT_LIMITS,
  FLESCH_BANDS,
  READABILITY_FORMULAS,
  READABILITY_LANGUAGES,
  type ReadabilityBand,
  type ReadabilityFormula,
  type ReadabilityFormulaId,
  type ReadabilityLanguage,
  type ReadabilityUnavailable,
} from '@app/specs/seo-content.spec';
import { sentencesOf, wordsOf } from './words';

// Readability (spec `seo-content.spec.ts`, Readability): a reading-ease score per language
// (Flesch, Szigriszt-Pazos, Kandel-Moles, Amstad: one shape, different coefficients) with frost's
// syllable heuristics, which are approximate. Pure; run in the analysis worker.

export type Readability =
  | {
      readonly status: 'ok';
      /** Which formula scored it (`READABILITY_FORMULAS`' `id` for the page's language). */
      readonly formula: ReadabilityFormulaId;
      /** The formula's reading-ease score, one decimal (may fall outside 0–100 for extreme text). */
      readonly score: number;
      /** The formula's band label. */
      readonly band: string;
      readonly words: number;
      readonly sentences: number;
      readonly syllables: number;
    }
  | { readonly status: 'not-available'; readonly reason: ReadabilityUnavailable };

const VOWEL_GROUP = /[aeiouy]+/g;
/** `-es` is a syllable after these (`boxes`, `wishes`, `pages`, `places`). */
const VOICED_ES = /(?:[sxzgc]|ch|sh)es$/;

/** English (frost's heuristic; see the spec). */
function syllablesEn(word: string): number {
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

const LETTERS_ONLY = /[^\p{L}]/gu;
const ES_VOWELS = /[aeiouáéíóúüy]+/g;
/** Spanish vowels that make a hiatus beside another strong one. */
const ES_STRONG = /[aeoáéíóú]/;
const FR_VOWELS = /[aeiouyàâäéèêëîïôöùûüÿœæ]+/g;
/** French vowels that start a new syllable after another vowel (`aérer`, `haïr`). */
const FR_BREAK = /[éèëïüöäâ]/;
const DE_VOWELS = /[aeiouäöüy]+/g;
/** German pairs sounded as one syllable. */
const DE_ONE_SOUND = new Set(['ei', 'ai', 'ey', 'ay', 'au', 'eu', 'äu', 'oi', 'ie', 'aa', 'ee', 'oo']);

function syllablesEs(word: string): number {
  // `y` is a vowel only at the end of a word; the `u` of `que qui gue gui` is silent.
  const w = word.toLowerCase().replace(LETTERS_ONLY, '').replace(/([qg])u(?=[eéií])/g, '$1').replace(/y(?!$)/g, 'j');
  if (w === '') return 0;
  let count = 0;
  for (const [group] of w.matchAll(ES_VOWELS)) {
    count += 1;
    for (let i = 1; i < group.length; i++) if (ES_STRONG.test(group[i - 1]!) && ES_STRONG.test(group[i]!)) count += 1;
  }
  return Math.max(1, count);
}

function syllablesFr(word: string): number {
  const w = word.toLowerCase().replace(LETTERS_ONLY, '').replace(/([qg])u(?=[eiéèêy])/g, '$1');
  if (w === '') return 0;
  let count = 0;
  for (const [group] of w.matchAll(FR_VOWELS)) {
    count += 1;
    for (let i = 1; i < group.length; i++) if (FR_BREAK.test(group[i]!)) count += 1;
  }
  if (/[^aeiouyàâäéèêëîïôöùûüÿœæ]es?$/.test(w)) count -= 1;
  return Math.max(1, count);
}

function syllablesDe(word: string): number {
  const w = word.toLowerCase().replace(LETTERS_ONLY, '').replace(/qu/g, 'q');
  if (w === '') return 0;
  let count = 0;
  for (const [group] of w.matchAll(DE_VOWELS)) {
    for (let i = 0; i < group.length; i++) {
      count += 1;
      if (DE_ONE_SOUND.has(group.slice(i, i + 2))) i += 1;
    }
  }
  return Math.max(1, count);
}

/**
 * Syllables in a word of `language` (frost's heuristics, approximate; their rules are in the spec,
 * Readability). Zero for a word with no letter, otherwise at least one.
 */
export function syllables(word: string, language: ReadabilityLanguage = 'en'): number {
  switch (language) {
    case 'es':
      return syllablesEs(word);
    case 'fr':
      return syllablesFr(word);
    case 'de':
      return syllablesDe(word);
    default:
      return syllablesEn(word);
  }
}

/** The readability language of a language code (`READABILITY_LANGUAGES`), if frost has a formula for it. */
export function readabilityLanguage(code: string | null): ReadabilityLanguage | null {
  return code !== null && (READABILITY_LANGUAGES as readonly string[]).includes(code) ? (code as ReadabilityLanguage) : null;
}

/** The band of `bands` holding `score` (first band whose `min` it reaches). */
function bandOf(bands: readonly ReadabilityBand[], score: number): string {
  return bands.find((band) => score >= band.min)!.label;
}

/** `FLESCH_BANDS`' label for `score`. */
export function fleschBand(score: number): string {
  return bandOf(FLESCH_BANDS, score);
}

/** The band label of `score` on `language`'s scale. */
export function readabilityBand(language: ReadabilityLanguage, score: number): string {
  return bandOf(READABILITY_FORMULAS[language].bands, score);
}

/** `formula`'s reading-ease score for the counts, unrounded. */
export function readingEase(formula: ReadabilityFormula, words: number, sentences: number, syllableCount: number): number {
  return formula.base - formula.wordsPerSentence * (words / sentences) - formula.syllablesPerWord * (syllableCount / words);
}

/** Flesch reading ease of the counts (one decimal). */
export function fleschReadingEase(words: number, sentences: number, syllableCount: number): number {
  return Math.round(readingEase(READABILITY_FORMULAS.en, words, sentences, syllableCount) * 10) / 10;
}

const LETTER_WORD = /\p{L}/u;

/** The normalised words of `sentence` that hold a letter (digits-only words are not words here). */
export function letterWords(sentence: string, code: string | null): string[] {
  return wordsOf(sentence, code)
    .map((word) => word.term)
    .filter((term) => LETTER_WORD.test(term));
}

/** Readability of `text` in language `code` (`READABILITY_LANGUAGES` only; see the spec). */
export function readability(text: string, code: string | null): Readability {
  if (text.trim() === '') return { status: 'not-available', reason: 'no-text' };
  const language = readabilityLanguage(code);
  if (language === null) return { status: 'not-available', reason: 'language' };
  let words = 0;
  let sentences = 0;
  let syllableCount = 0;
  for (const sentence of sentencesOf(text, code)) {
    const inSentence = letterWords(sentence, code);
    if (inSentence.length === 0) continue;
    sentences += 1;
    words += inSentence.length;
    for (const word of inSentence) syllableCount += syllables(word, language);
  }
  if (words < CONTENT_LIMITS.readabilityMinWords) return { status: 'not-available', reason: 'too-short' };
  const formula = READABILITY_FORMULAS[language];
  const score = Math.round(readingEase(formula, words, sentences, syllableCount) * 10) / 10;
  return { status: 'ok', formula: formula.id, score, band: bandOf(formula.bands, score), words, sentences, syllables: syllableCount };
}
