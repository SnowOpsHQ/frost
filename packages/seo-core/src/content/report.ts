import { CONTENT_LIMITS, type NgramPlace, type TargetQueryPlace } from '@app/specs/seo-content.spec';
import type { PageSnapshot } from '../types';
import { described } from '../rules/head';
import { parseUrl } from '../util';
import { ngramTables, type NgramTables } from './ngrams';
import { readability, type Readability } from './readability';
import { measureSnippet, snippetText, type SnippetCut } from './widths';
import { contentLanguage, fieldRuns, primaryLanguage, stopWordsFor, wordRuns, type ContentLanguage } from './words';

// The Content panel's report (spec `seo-content.spec.ts`; acceptance `seo-content.feature.md`):
// built by `runAudit`, so in the analysis worker, from the validated snapshot only.

/**
 * The page's fields as runs of normalised words (`fieldRuns`: a run ends at punctuation and between
 * elements, so a phrase never spans two of them), each field at most `maxFieldWords` words.
 */
export type ContentFields = Readonly<Record<TargetQueryPlace | NgramPlace, readonly (readonly string[])[]>>;

export interface ContentReport {
  /** The snapshot carried visible text (an older extractor's did not). */
  readonly available: boolean;
  /** The visible text was cut (`VisibleTextSchema.truncated`): counts are of what was read. */
  readonly truncated: boolean;
  readonly language: ContentLanguage;
  /** Words read from the visible text. */
  readonly words: number;
  readonly ngrams: NgramTables;
  readonly readability: Readability;
  /** The page's title and description cut at the budgets; `null` when it has none. */
  readonly snippet: {
    readonly title: SnippetCut | null;
    readonly descriptionDesktop: SnippetCut | null;
    readonly descriptionMobile: SnippetCut | null;
  };
  readonly fields: ContentFields;
}

/** A URL's words: its host (without `www.`), then each decoded path segment, as runs; words split at `- _ . + ~ = &`. */
export function urlTerms(url: string, lang: string | null): string[][] {
  const parsed = parseUrl(url);
  if (!parsed) return [];
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the path as written.
  }
  const host = parsed.hostname.replace(/^www\./, '');
  return fieldRuns([host, ...path.split('/')].map((part) => part.replace(/[-_.+~=&]+/g, ' ')), lang);
}

/** The report of `s` (validated snapshot). */
export function contentReport(s: PageSnapshot): ContentReport {
  const text = s.visibleText?.text ?? '';
  const declared = primaryLanguage(s.lang);
  // Words are segmented for the declared language; a detected one only chooses the stop-words.
  const unfiltered = wordRuns(text, declared, null);
  const language = contentLanguage(s.lang, unfiltered.flat());
  const stop = stopWordsFor(language.code);
  const runs = stop ? unfiltered.map((run) => run.map((word) => (word.weak || !stop.has(word.term) ? word : { term: word.term, weak: true }))) : unfiltered;
  const lang = language.code;
  const title = s.titles[0]?.text ?? '';
  const description = described(s)?.text ?? '';
  const fields: ContentFields = {
    title: fieldRuns(title, lang),
    h1: fieldRuns(s.headings.filter((h) => h.level === 1).map((h) => h.text), lang),
    description: fieldRuns(description, lang),
    url: urlTerms(s.url, lang),
    'first-words': fieldRuns(text, lang, CONTENT_LIMITS.firstWords),
    headings: fieldRuns(s.headings.filter((h) => h.level > 1).map((h) => h.text), lang),
  };
  const measured = measureSnippet(title, description);
  return {
    available: s.visibleText !== undefined,
    truncated: s.visibleText?.truncated ?? false,
    language,
    words: runs.reduce((sum, run) => sum + run.length, 0),
    ngrams: ngramTables(runs, fields),
    readability: readability(text, lang),
    snippet: {
      title: snippetText(title) === '' ? null : measured.title,
      descriptionDesktop: snippetText(description) === '' ? null : measured.descriptionDesktop,
      descriptionMobile: snippetText(description) === '' ? null : measured.descriptionMobile,
    },
    fields,
  };
}
