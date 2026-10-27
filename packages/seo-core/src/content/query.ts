import { CONTENT_LIMITS, TARGET_QUERY_PLACES, type QueryPresence, type TargetQueryPlace } from '@app/specs/seo-content.spec';
import { hasSequence, stopWordsFor, wordsOf } from './words';

// The target query checklist (spec `seo-content.spec.ts`, Target query). Pure: the chrome runs it
// on the user's query and the word lists the worker made from the page (`ContentReport.fields`);
// it reads no page text itself. A checklist, never a score.

export interface QueryTerms {
  /** The terms looked for: words, stop-words dropped (unless only stop-words), no duplicates, capped. */
  readonly terms: readonly string[];
  /** Every word of the query in order (stop-words too): the phrase. */
  readonly phrase: readonly string[];
}

export interface QueryPlaceCheck {
  readonly place: TargetQueryPlace;
  readonly terms: readonly { readonly term: string; readonly present: boolean }[];
  readonly presence: QueryPresence;
  /** The whole query, in order, is in the place. */
  readonly phrase: boolean;
}

/** `query`'s terms and phrase, read as page text is (`lang`: the page's language code). */
export function queryTerms(query: string, lang: string | null): QueryTerms {
  const stop = stopWordsFor(lang);
  const words = wordsOf(query, lang, stop);
  const phrase = words.map((word) => word.term);
  const strong = words.filter((word) => !(stop?.has(word.term) ?? false));
  const terms = [...new Set((strong.length > 0 ? strong : words).map((word) => word.term))].slice(0, CONTENT_LIMITS.maxQueryTerms);
  return { terms, phrase };
}

/** For each `TARGET_QUERY_PLACES` place: which of the query's terms it holds, and whether it holds the phrase. Empty for a query with no words. */
export function queryChecklist(query: string, fields: Readonly<Record<TargetQueryPlace, readonly string[]>>, lang: string | null): QueryPlaceCheck[] {
  const { terms, phrase } = queryTerms(query, lang);
  if (terms.length === 0) return [];
  return TARGET_QUERY_PLACES.map((place) => {
    const words = new Set(fields[place]);
    const found = terms.map((term) => ({ term, present: words.has(term) }));
    const present = found.filter((term) => term.present).length;
    return { place, terms: found, presence: present === terms.length ? 'all' : present > 0 ? 'some' : 'none', phrase: hasSequence(fields[place], phrase) };
  });
}
