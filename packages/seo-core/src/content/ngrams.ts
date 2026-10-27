import { CONTENT_LIMITS, NGRAM_MIN_COUNT, NGRAM_PLACES, NGRAM_SIZES, type NgramPlace, type NgramSize } from '@app/specs/seo-content.spec';
import { hasPhrase, joinTerms, type Word } from './words';

// n-grams of the visible text (spec `seo-content.spec.ts`, n-grams): counts only, never scored.

/** One listed n-gram: its words, how often it occurs, and the page fields that hold it. */
export interface NgramRow {
  /** Its words, joined for display (`joinTerms`). */
  readonly text: string;
  readonly terms: readonly string[];
  readonly count: number;
  readonly in: Readonly<Record<NgramPlace, boolean>>;
}

export type NgramTables = Readonly<Record<NgramSize, readonly NgramRow[]>>;

/** The page fields an n-gram is looked up in: each a list of runs of normalised words (`fieldRuns`). */
export type NgramFields = Readonly<Record<NgramPlace, readonly (readonly string[])[]>>;

/**
 * The `ngramRows` most frequent n-grams of each size in `runs` (ties: first seen first), with at
 * least `NGRAM_MIN_COUNT` occurrences, none starting or ending with a weak word, each marked with
 * the `fields` that hold it.
 */
export function ngramTables(runs: readonly (readonly Word[])[], fields: NgramFields, rows: number = CONTENT_LIMITS.ngramRows): NgramTables {
  const tables = {} as Record<NgramSize, NgramRow[]>;
  for (const size of NGRAM_SIZES) {
    const counts = new Map<string, { terms: string[]; count: number; first: number }>();
    let seen = 0;
    for (const run of runs) {
      for (let i = 0; i + size <= run.length; i++) {
        const first = run[i]!;
        const last = run[i + size - 1]!;
        if (first.weak || last.weak) continue;
        const terms = run.slice(i, i + size).map((word) => word.term);
        const key = terms.join('\u0000');
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { terms, count: 1, first: seen++ });
      }
    }
    tables[size] = [...counts.values()]
      .filter((entry) => entry.count >= NGRAM_MIN_COUNT[size])
      .sort((a, b) => b.count - a.count || a.first - b.first)
      .slice(0, rows)
      .map((entry) => ({
        text: joinTerms(entry.terms),
        terms: entry.terms,
        count: entry.count,
        in: Object.fromEntries(NGRAM_PLACES.map((place) => [place, hasPhrase(fields[place], entry.terms)])) as Record<NgramPlace, boolean>,
      }));
  }
  return tables;
}
