import { FINDING_SAMPLE_LIMIT } from '@app/specs/seo-rules.spec';
import { JS_VERDICT_THRESHOLDS } from '@app/specs/seo-javascript.spec';
import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact, formatCount } from '../util';
import { comparableReport, type JsFieldDiff } from './report';

// The `javascript` rules (spec `seo-javascript.spec.ts`, `JAVASCRIPT_RULE_SPECS`; acceptance
// `seo-javascript.feature.md`, Rules): checked only on a complete comparison (`comparableReport`),
// so an unavailable, pending or partial served page never fails one.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

const NONE = '(none)';

/** Facts for a field that differs: what the served HTML and the rendered page hold; `null` when it is the same. */
function fieldChanged(snapshot: PageSnapshot, id: JsFieldDiff['id']): FindingDetails | null {
  const field = comparableReport(snapshot)?.fields.find((f) => f.id === id);
  if (!field || field.status === 'same') return null;
  return details([fact('Served HTML', field.served ?? NONE), fact('After JavaScript', field.rendered ?? NONE)]);
}

export const JAVASCRIPT_CHECKS = {
  'js-canonical-changed': (s) => fieldChanged(s, 'canonical'),
  'js-robots-changed': (s) => fieldChanged(s, 'robots'),
  'js-title-changed': (s) => {
    if (!comparableReport(s) || s.served?.status !== 'ready') return null;
    const served = s.served.snapshot.titles[0]?.text ?? '';
    const rendered = s.titles[0]?.text ?? '';
    if (served === rendered) return null;
    return details([fact('Served HTML', served || NONE), fact('After JavaScript', rendered || NONE)]);
  },
  'js-content-added': (s) => {
    const report = comparableReport(s);
    if (!report) return null;
    const { renderedWords, servedWords, wordShare } = report.metrics;
    if (renderedWords < JS_VERDICT_THRESHOLDS.minWords || wordShare < JS_VERDICT_THRESHOLDS.heavyShare) return null;
    return details([fact('Served HTML', `${formatCount(servedWords)} words`), fact('After JavaScript', `${formatCount(renderedWords)} words`), fact('Added by JavaScript', `${Math.round(wordShare * 100)}%`)]);
  },
  'js-links-added': (s) => {
    const report = comparableReport(s);
    if (!report || report.metrics.linksAdded === 0) return null;
    const { linksAdded, renderedLinks } = report.metrics;
    return details(
      [fact('Links only after JavaScript', formatCount(linksAdded)), fact('Links after JavaScript', formatCount(renderedLinks))],
      report.links.added.slice(0, FINDING_SAMPLE_LIMIT).map((item) => item.label),
      linksAdded,
    );
  },
} as const satisfies Record<string, Check>;
