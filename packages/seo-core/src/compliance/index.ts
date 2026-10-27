import {
  A11Y_IMPACTS,
  ACTIVE_RESOURCE_KINDS,
  SECURITY_HEADER_LABELS,
  SECURITY_HEADERS,
  UNSAFE_REFERRER_POLICIES,
  type A11yImpact,
  type InsecureResourceKind,
  type SecurityHeaderName,
  type SecurityVerdict,
} from '@app/specs/seo-compliance.spec';
import type { SeoRuleId, SeoSeverity } from '@app/specs/seo-rules.spec';
import type { A11yViolation, PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { headerValues } from '../indexability';
import { parseUrl, withoutFragment } from '../util';
import { allowsInlineScripts, frameAncestors, frameAncestorsProtect, parseCsp, scriptSources, upgradesInsecureRequests, type CspPolicy } from './csp';
import { formatDuration, frameOptionsProtect, headerReferrerPolicy, isNosniff, metaReferrerPolicy, parseHsts } from './headers';
import type { A11yImpactGroup, AccessibilityReport, ComplianceReport, MixedContent, SecurityFacts, SecurityHeaderRow, SecurityReport } from './model';

export {
  allowsInlineScripts,
  cspDirective,
  frameAncestors,
  frameAncestorsProtect,
  parseCsp,
  parseCspPolicy,
  scriptSources,
  sourcesAllowInline,
  upgradesInsecureRequests,
  type CspDirective,
  type CspPolicy,
  type CspSource,
} from './csp';
export { formatDuration, frameOptionsProtect, headerReferrerPolicy, isNosniff, metaReferrerPolicy, parseHsts, type Hsts } from './headers';
export type { A11yImpactGroup, AccessibilityReport, ComplianceReport, MixedContent, SecurityFacts, SecurityHeaderRow, SecurityReport } from './model';

// The page's security and accessibility facts (acceptance `seo-compliance.feature.md`), read once per
// snapshot (memoised, like `analyseIndexability`) so the `security` / `accessibility` rules and the
// panel share one pass. Everything here runs in the analysis worker, on validated data.

const ACTIVE: ReadonlySet<InsecureResourceKind> = new Set(ACTIVE_RESOURCE_KINDS);

/** Whether `kind` is active (blockable) mixed content (`ACTIVE_RESOURCE_KINDS`); else passive. */
export function isActiveKind(kind: InsecureResourceKind): boolean {
  return ACTIVE.has(kind);
}

/** Whether `hostname` (`URL.hostname`) is this computer (`LOOPBACK_HOST_PATTERNS`). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/**
 * The snapshot's http subresources (only on an https page): split into active and passive, or all
 * `upgraded` when an enforced policy has `upgrade-insecure-requests` (`upgrade`); `upgradeUnknown`
 * when a cut CSP header might have it (`cspCut`, and none was found).
 */
export function mixedContent(s: PageSnapshot, upgrade = false, cspCut = false): MixedContent {
  const https = parseUrl(s.url)?.protocol === 'https:';
  const list = https ? s.security.insecureResources : [];
  const kept = upgrade ? [] : list;
  return {
    active: kept.filter((resource) => isActiveKind(resource.kind)),
    passive: kept.filter((resource) => !isActiveKind(resource.kind)),
    upgraded: upgrade ? list : [],
    upgradeUnknown: !upgrade && cspCut && list.length > 0,
    total: https ? s.security.insecureResourceTotal : 0,
    truncated: https && s.security.resourcesTruncated,
  };
}

const facts = new WeakMap<PageSnapshot, SecurityFacts>();

/** The page's security facts (memoised per snapshot). */
export function analyseSecurity(s: PageSnapshot): SecurityFacts {
  const known = facts.get(s);
  if (known) return known;
  const url = parseUrl(s.url);
  const headersKnown = s.response?.headersAvailable === true;
  const hstsValue = headerValues(s, 'strict-transport-security')[0];
  const cspPolicies: CspPolicy[] = [...headerValues(s, 'content-security-policy').flatMap((value) => parseCsp(value, 'header')), ...s.security.metaCsp.flatMap((value) => parseCsp(value, 'meta'))];
  // A CSP header main had to cut (`CSP_CUT_IS_UNKNOWN`): what it might say further on is unknown.
  const cspCut = headersKnown && s.response!.headers.some((h) => h.name === 'content-security-policy' && h.truncated === true);
  const upgradeInsecure = upgradesInsecureRequests(cspPolicies);
  const meta = metaReferrerPolicy(s.security.metaReferrer);
  const header = headerReferrerPolicy(headerValues(s, 'referrer-policy'));
  // An enforced frame-ancestors (header policies only) overrides X-Frame-Options, even when open.
  const ancestors = frameAncestors(cspPolicies);
  const result: SecurityFacts = {
    url: s.url,
    https: url?.protocol === 'https:',
    loopback: url !== null && isLoopbackHost(url.hostname),
    headersKnown,
    responseSource: s.response?.source ?? null,
    hsts: hstsValue === undefined ? null : parseHsts(hstsValue),
    cspPolicies,
    inlineScriptsAllowed: !cspCut && allowsInlineScripts(cspPolicies),
    frameAncestorsSet: ancestors.length > 0,
    frameAncestors: ancestors.some(frameAncestorsProtect),
    upgradeInsecure,
    cspCut,
    frameOptionsProtect: ancestors.length === 0 && frameOptionsProtect(headerValues(s, 'x-frame-options')),
    nosniff: isNosniff(headerValues(s, 'x-content-type-options')),
    referrerPolicy: meta ?? header,
    referrerFrom: meta !== null ? 'meta' : header !== null ? 'header' : null,
    mixed: mixedContent(s, upgradeInsecure, cspCut),
  };
  facts.set(s, result);
  return result;
}

/** Whether HSTS is in effect for the page (an https page with a valid header and a max-age above 0). */
export function hstsActive(f: SecurityFacts): boolean {
  return f.https && f.hsts !== null && f.hsts.maxAge > 0;
}

function hstsNote(f: SecurityFacts): string | null {
  if (!f.hsts) return null;
  if (f.hsts.maxAge === 0) return 'max-age 0 (turns HSTS off)';
  return [`max-age ${formatDuration(f.hsts.maxAge)}`, f.hsts.includeSubDomains ? 'includeSubDomains' : null, f.hsts.preload ? 'preload' : null].filter((part) => part !== null).join(' · ');
}

/** The header table's rows (`SECURITY_HEADERS`), from the facts and the failing rules. */
function headerRows(s: PageSnapshot, f: SecurityFacts, failing: ReadonlySet<SeoRuleId>): SecurityHeaderRow[] {
  const row = (name: SecurityHeaderName): SecurityHeaderRow => {
    const label = SECURITY_HEADER_LABELS[name];
    const values = headerValues(s, name);
    const base = { name, label, values, fromMeta: false, note: null as string | null };
    // A meta tag stands in for a missing or unknown header (CSP, referrer).
    const metaValues = name === 'content-security-policy' ? s.security.metaCsp : name === 'referrer-policy' && s.security.metaReferrer !== null ? [s.security.metaReferrer] : [];
    if (name === 'strict-transport-security' && !f.https) return { ...base, state: 'not-applicable', note: 'Browsers ignore HSTS on pages not served over https.' };
    if (values.length === 0 && metaValues.length === 0) return { ...base, state: f.headersKnown ? 'missing' : 'unknown' };
    const fromMeta = values.length === 0;
    const shown = fromMeta ? metaValues : values;
    switch (name) {
      case 'strict-transport-security':
        return { ...base, values: shown, state: !hstsActive(f) ? 'weak' : failing.has('hsts-short-max-age') ? 'weak' : 'good', note: f.hsts ? hstsNote(f) : 'Not valid: browsers ignore it.' };
      case 'content-security-policy': {
        if (f.cspCut && !fromMeta) return { ...base, values: shown, state: 'unknown', note: 'Cut: the policy is longer than frost keeps (16 KB), so what it says about inline scripts, framing and upgrades is unknown.' };
        const inline = failing.has('csp-unsafe-inline');
        const scripts = f.cspPolicies.some((policy) => scriptSources(policy) !== null);
        const note = inline ? "Allows inline scripts ('unsafe-inline')" : scripts ? 'Restricts scripts' : 'Does not restrict scripts';
        const framing = f.frameAncestors ? ' · frame-ancestors set' : f.frameAncestorsSet ? ' · frame-ancestors allows framing' : '';
        return { ...base, values: shown, fromMeta, state: inline ? 'weak' : 'good', note: `${note}${framing}` };
      }
      case 'x-content-type-options':
        return { ...base, values: shown, state: f.nosniff ? 'good' : 'weak', note: f.nosniff ? null : 'Only nosniff has an effect.' };
      case 'x-frame-options':
        // A Content-Security-Policy frame-ancestors makes browsers ignore X-Frame-Options, whatever it allows.
        if (f.frameAncestorsSet)
          return f.frameAncestors
            ? { ...base, values: shown, state: 'good', note: 'Overridden by CSP frame-ancestors, which protects the page.' }
            : { ...base, values: shown, state: 'weak', note: 'Overridden by CSP frame-ancestors, which lets any site frame the page.' };
        return { ...base, values: shown, state: f.frameOptionsProtect ? 'good' : 'weak', note: f.frameOptionsProtect ? null : 'Does not block framing (DENY or SAMEORIGIN would).' };
      case 'referrer-policy': {
        const unsafe = f.referrerPolicy !== null && (UNSAFE_REFERRER_POLICIES as readonly string[]).includes(f.referrerPolicy);
        const plain = shown.length === 1 && shown[0]!.trim().toLowerCase() === f.referrerPolicy;
        const note =
          f.referrerPolicy === null ? 'No known policy value: browsers use their default.' : !fromMeta && f.referrerFrom === 'meta' ? `In effect: ${f.referrerPolicy} (set by a meta tag)` : plain ? null : `In effect: ${f.referrerPolicy}`;
        return { ...base, values: shown, fromMeta, state: f.referrerPolicy === null || unsafe ? 'weak' : 'good', note };
      }
      default:
        return { ...base, values: shown, state: 'good' };
    }
  };
  return SECURITY_HEADERS.map(row);
}

/** The security card's verdict (`SECURITY_VERDICTS`) from the failing security rules' severities. */
export function securityVerdict(f: Pick<SecurityFacts, 'https' | 'loopback'>, severities: readonly SeoSeverity[]): SecurityVerdict {
  if (severities.includes('error')) return 'insecure';
  if (severities.includes('warning')) return 'attention';
  // Local only while nothing above info fails.
  if (!f.https && f.loopback) return 'local';
  return 'secure';
}

/** The accessibility check's answer for this snapshot (`AccessibilityReport`): `not-run` without one, or for another URL. */
export function accessibilityReport(s: PageSnapshot): AccessibilityReport {
  const result = s.accessibility;
  if (result === undefined || result === null) return { status: 'not-run' };
  if (result === 'invalid') return { status: 'invalid' };
  const page = parseUrl(s.url);
  const checked = parseUrl(result.url);
  if (!page || !checked || withoutFragment(page) !== withoutFragment(checked)) return { status: 'not-run' };
  const byImpact = new Map<A11yImpact, A11yViolation[]>(A11Y_IMPACTS.map((impact) => [impact, []]));
  for (const rule of result.violations) byImpact.get(rule.impact)!.push(rule);
  const groups: A11yImpactGroup[] = A11Y_IMPACTS.map((impact) => {
    const rules = [...byImpact.get(impact)!].sort((a, b) => b.nodeTotal - a.nodeTotal);
    return { impact, rules, nodeTotal: rules.reduce((sum, rule) => sum + rule.nodeTotal, 0) };
  });
  return {
    status: 'done',
    url: result.url,
    axeVersion: result.axeVersion,
    ranAt: result.ranAt,
    durationMs: result.durationMs,
    groups,
    violationTotal: result.violationTotal,
    truncated: result.violationTotal > result.violations.length,
    passes: result.passes,
    incomplete: result.incomplete,
    inapplicable: result.inapplicable,
    partial: result.partial,
  };
}

const reports = new WeakMap<PageSnapshot, AccessibilityReport>();
/** `accessibilityReport`, memoised per snapshot (the rules and the audit share it). */
export function analyseAccessibility(s: PageSnapshot): AccessibilityReport {
  let report = reports.get(s);
  if (!report) {
    report = accessibilityReport(s);
    reports.set(s, report);
  }
  return report;
}

/**
 * The Compliance panel's data: the security facts with their verdict and header rows (`failing`: the
 * ids of the rules that fail, with their severities), and the accessibility report.
 */
export function complianceReport(s: PageSnapshot, failing: ReadonlyMap<SeoRuleId, SeoSeverity>, securityRules: ReadonlySet<SeoRuleId>): ComplianceReport {
  const f = analyseSecurity(s);
  const severities = [...failing].filter(([id]) => securityRules.has(id)).map(([, severity]) => severity);
  const security: SecurityReport = { ...f, verdict: securityVerdict(f, severities), headers: headerRows(s, f, new Set(failing.keys())) };
  return { security, accessibility: analyseAccessibility(s) };
}
