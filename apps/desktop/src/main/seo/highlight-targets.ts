import type { SeoAudit } from '@app/seo-core';
import type { DifficultSentenceReason } from '@app/specs/seo-content.spec';
import { MAX_TEXT_HIGHLIGHT_TARGETS } from '@app/specs/seo-limits.spec';
import type { HighlightKind, TextHighlightTarget } from '@app/specs/seo-sidebar.spec';

// The texts a text highlight mode boxes (spec `seo-sidebar.spec.ts`, `TextHighlightTarget`;
// acceptance `seo-content.feature.md`, Highlight). Main reads them from its own ready audit; the
// chrome never sends page text to paint. Pure.

const SENTENCE_KIND: Readonly<Record<DifficultSentenceReason, HighlightKind>> = { long: 'long-sentence', complex: 'complex-sentence' };

/** `sentences`: the audit's difficult sentences (excerpts, in page order) by reason, at most `MAX_TEXT_HIGHLIGHT_TARGETS`. */
export function sentenceHighlightTargets(audit: SeoAudit): TextHighlightTarget[] {
  const report = audit.content.sentences;
  if (report.status !== 'ok') return [];
  return report.difficult.items.slice(0, MAX_TEXT_HIGHLIGHT_TARGETS).map((item) => ({ text: item.text, kind: SENTENCE_KIND[item.reason] }));
}
