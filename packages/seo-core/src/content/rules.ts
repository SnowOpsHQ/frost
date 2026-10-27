import { SNIPPET_BUDGETS_PX, type SnippetTextKind } from '@app/specs/seo-content.spec';
import type { FindingDetails, PageSnapshot } from '../types';
import { described } from '../rules/head';
import { details, fact } from '../util';
import { formatPx, snippetText, truncateToWidth } from './widths';

// The width rules (spec `seo-content.spec.ts`, `TITLE_WIDTH_RULE`, `DESCRIPTION_WIDTH_RULE`): they
// replace Phase 2's character maximums. The kept text is measured with frost's width table.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

/** Facts for a text over its budget: the value, its width, the budget and what a result shows; `null` within it. */
function overBudget(label: string, value: string, budget: number, kind: SnippetTextKind): FindingDetails | null {
  const text = snippetText(value);
  if (text === '') return null;
  const cut = truncateToWidth(text, budget, kind);
  if (!cut.truncated) return null;
  return details([fact(label, text), fact('Width', formatPx(cut.width)), fact('Budget', `about ${formatPx(budget)}`), fact('A result shows', cut.shown)]);
}

export const CONTENT_CHECKS = {
  'title-too-wide': (s) => overBudget('Title', s.titles[0]?.text ?? '', SNIPPET_BUDGETS_PX.titleDesktop, 'title'),
  'meta-description-too-wide': (s) => overBudget('Description', described(s)?.text ?? '', SNIPPET_BUDGETS_PX.descriptionDesktop, 'description'),
} as const satisfies Record<string, Check>;
