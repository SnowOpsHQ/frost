import type { ExtractedSnapshot, PageContext } from '@app/specs/seo-snapshot.spec';
import { CRAWL_RULE_IDS } from '@app/specs/site-crawl.spec';
import { runAudit } from '../audit';
import { RULES } from '../rules';
import type { SeoAudit, SeoRule } from '../types';

// The crawl's rule set (spec `site-crawl.spec.ts`, `CRAWL_RULE_IDS`, `CRAWL_SCORE_LABEL`; acceptance
// `site-crawl.feature.md`, The audit; plan Decision 6 and Decision 3 K-B2). A crawled page is audited
// with these rules only, so its score is the served-HTML score, never the sidebar's health score.

const CRAWL: ReadonlySet<string> = new Set(CRAWL_RULE_IDS);

/** The catalogue's rules listed in `CRAWL_RULE_IDS`, in catalogue order. */
export const CRAWL_RULES: readonly SeoRule[] = RULES.filter((rule) => CRAWL.has(rule.id));

/** The served-HTML audit of a crawled page: its snapshot with its context, no speed measurement, no served comparison, `CRAWL_RULES` only. */
export function crawlAudit(snapshot: ExtractedSnapshot, context: PageContext): SeoAudit {
  return runAudit({ ...snapshot, ...context, performance: null, served: null }, CRAWL_RULES);
}
