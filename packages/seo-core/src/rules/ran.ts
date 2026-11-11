import { ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { SeoRuleId } from '@app/specs/seo-rules.spec';
import type { VitalMetric } from '@app/specs/seo-speed.spec';
import { analyseAccessibility, analyseSecurity } from '../compliance';
import { analyseIndexability } from '../indexability';
import { comparableReport } from '../javascript/report';
import { summaryOf } from '../performance/rules';
import type { PageSnapshot } from '../types';

// Whether a rule ran on the page: its input is known (acceptance `seo-rules.feature.md`, Audit and
// score, passed-counts-rules-that-ran). A rule without its input passes (`check` answers `null`),
// so only a rule that ran and found nothing counts as passed; a rule that does not apply to the
// page (HSTS or mixed content over http) is not counted either. A rule not listed always runs.

type Ran = (snapshot: PageSnapshot) => boolean;

const UNKNOWN: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_UNKNOWN_OUTCOMES);

/** The response's status is known (an `in-page` response has none). */
const statusKnown: Ran = (s) => s.response?.status != null;
/** The redirects were recorded (`navigation` and `in-page` responses have none). */
const redirectsKnown: Ran = (s) => s.response?.source === 'network' || s.response?.source === 'cache';
const headersKnown: Ran = (s) => s.response?.headersAvailable === true;
const cspKnown: Ran = (s) => headersKnown(s) || analyseSecurity(s).cspPolicies.length > 0;
/** No cut CSP header (`cspCut`) leaves what the policy says unknown. */
const cspWhole: Ran = (s) => cspKnown(s) && !analyseSecurity(s).cspCut;
/** An https page (mixed content does not apply over http) with no resources of the kind, or no cut CSP header that might upgrade them. */
const mixedKnown =
  (which: 'active' | 'passive'): Ran =>
  (s) => {
    const f = analyseSecurity(s);
    return f.https && (f.mixed[which].length === 0 || !f.mixed.upgradeUnknown);
  };
/** Framing is known: headers, and no cut CSP header (a frame-ancestors after the cut would override X-Frame-Options). */
const framingKnown: Ran = (s) => {
  const f = analyseSecurity(s);
  return f.headersKnown && !f.cspCut;
};
const referrerKnown: Ran = (s) => headersKnown(s) || s.security.metaReferrer !== null;
const hstsApplies: Ran = (s) => headersKnown(s) && analyseSecurity(s).https;
/** robots.txt was read, or there is none to obey. */
const robotsRead: Ran = (s) => !!s.robots && s.robots.outcome !== 'pending' && !UNKNOWN.has(s.robots.outcome);
const robotsSettled: Ran = (s) => !!s.robots && s.robots.outcome !== 'pending';
const measured: Ran = (s) => !!s.performance;
const vital =
  (metric: VitalMetric): Ran =>
  (s) =>
    !!s.performance && summaryOf(s.performance).vitals.find((v) => v.metric === metric)?.value != null;
const a11yChecked: Ran = (s) => analyseAccessibility(s).status === 'done';
const compared: Ran = (s) => comparableReport(s) !== null;

const RAN: Partial<Readonly<Record<SeoRuleId, Ran>>> = {
  'http-status-redirect': statusKnown,
  'http-status-client-error': statusKnown,
  'http-status-server-error': statusKnown,
  'http-redirect-chain': redirectsKnown,
  'x-robots-noindex': headersKnown,
  'x-robots-noindex-other-bot': headersKnown,
  'x-robots-nofollow': headersKnown,
  'canonical-header-conflict': headersKnown,
  'canonical-elsewhere': (s) => analyseIndexability(s).canonical.html !== null || headersKnown(s),
  'robots-txt-blocks-googlebot': robotsRead,
  'robots-txt-blocks-all': robotsRead,
  'robots-txt-no-sitemap': robotsRead,
  'robots-txt-unreachable': robotsSettled,
  'lcp-poor': vital('lcp'),
  'lcp-needs-improvement': vital('lcp'),
  'cls-poor': vital('cls'),
  'cls-needs-improvement': vital('cls'),
  'inp-poor': vital('inp'),
  'inp-needs-improvement': vital('inp'),
  'fcp-poor': vital('fcp'),
  'fcp-needs-improvement': vital('fcp'),
  'ttfb-poor': vital('ttfb'),
  'ttfb-needs-improvement': vital('ttfb'),
  'page-weight-heavy': measured,
  'request-count-high': measured,
  'dom-size-large': measured,
  'uncompressed-text-resources': measured,
  'render-blocking-scripts': (s) => !!s.blockingScripts,
  'mixed-content-active': mixedKnown('active'),
  'mixed-content-passive': mixedKnown('passive'),
  'hsts-missing': hstsApplies,
  'hsts-short-max-age': hstsApplies,
  'csp-missing': cspKnown,
  'csp-unsafe-inline': cspWhole,
  'nosniff-missing': headersKnown,
  'clickjacking-unprotected': framingKnown,
  'referrer-policy-missing': referrerKnown,
  'referrer-policy-unsafe': referrerKnown,
  'a11y-critical': a11yChecked,
  'a11y-serious': a11yChecked,
  'js-canonical-changed': compared,
  'js-robots-changed': compared,
  'js-title-changed': compared,
  'js-content-added': compared,
  'js-links-added': compared,
  'links-broken': (s) => !!s.checks?.links,
  'links-internal-redirect': (s) => !!s.checks?.links,
  'sitemap-page-not-listed': (s) => s.checks?.sitemaps?.listed != null,
  'sitemap-unreachable': (s) => !!s.checks?.sitemaps,
  'hreflang-no-return-link': (s) => !!s.checks?.hreflang,
};

/** Whether rule `id` had its input on `snapshot` (a rule with a finding always did). */
export function ruleRan(id: SeoRuleId, snapshot: PageSnapshot): boolean {
  return RAN[id]?.(snapshot) ?? true;
}
