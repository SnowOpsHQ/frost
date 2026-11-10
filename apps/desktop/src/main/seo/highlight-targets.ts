import { wordsOf, type SeoAudit } from '@app/seo-core';
import { NGRAM_SIZES, type DifficultSentenceReason } from '@app/specs/seo-content.spec';
import { MAX_TEXT_HIGHLIGHT_TARGETS } from '@app/specs/seo-limits.spec';
import type { HighlightKind, TextHighlightTarget } from '@app/specs/seo-sidebar.spec';

// The texts a text highlight mode boxes (spec `seo-sidebar.spec.ts`, `TextHighlightTarget`;
// acceptance `seo-content.feature.md`, Highlight and Keyphrase highlight). Main reads them from its
// own ready audit (and, for a keyphrase, the page's stored target query); the chrome never sends page
// text to paint, only names a phrase main checks. Pure.

const SENTENCE_KIND: Readonly<Record<DifficultSentenceReason, HighlightKind>> = { long: 'long-sentence', complex: 'complex-sentence' };

/** `sentences`: the audit's difficult sentences (excerpts, in page order) by reason, at most `MAX_TEXT_HIGHLIGHT_TARGETS`. */
export function sentenceHighlightTargets(audit: SeoAudit): TextHighlightTarget[] {
  const report = audit.content.sentences;
  if (report.status !== 'ok') return [];
  return report.difficult.items.slice(0, MAX_TEXT_HIGHLIGHT_TARGETS).map((item) => ({ text: item.text, kind: SENTENCE_KIND[item.reason] }));
}

/**
 * `keyphrase` (Phase 11 Task 2): the phrase the chrome named, if main accepts it: one of the audit's
 * n-grams (any size; its text, as listed) or the page's stored target query (`storedQuery`, exactly).
 * The target is main's own copy: the text, its words as the audit reads them (an n-gram's `terms`;
 * the query's `wordsOf`) and the language they were read in (the page's declared one, or `null`, as
 * the audit segments the page's text). Anything else: `null`, nothing to paint.
 */
export function keyphraseHighlightTarget(audit: SeoAudit, phrase: string, storedQuery: string | null): TextHighlightTarget | null {
  const { content } = audit;
  const lang = content.language.source === 'declared' ? content.language.code : null;
  for (const size of NGRAM_SIZES) {
    const row = content.ngrams[size].find((candidate) => candidate.text === phrase);
    if (row) return { text: row.text, kind: 'keyphrase', terms: [...row.terms], lang };
  }
  if (storedQuery === null || storedQuery !== phrase) return null;
  const terms = wordsOf(storedQuery, lang).map((word) => word.term);
  return terms.length === 0 ? null : { text: storedQuery, kind: 'keyphrase', terms, lang };
}
