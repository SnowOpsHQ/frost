import { HSTS_MIN_MAX_AGE_SECONDS, INSECURE_RESOURCE_LABELS, UNSAFE_REFERRER_POLICIES, type A11yImpact } from '@app/specs/seo-compliance.spec';
import type { InsecureResource } from '@app/specs/seo-snapshot.spec';
import { headerValues } from '../indexability';
import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact, formatCount } from '../util';
import { scriptSources } from './csp';
import { formatDuration } from './headers';
import { analyseAccessibility, analyseSecurity, hstsActive } from './index';

// The `security` and `accessibility` rules (catalog `specs/seo-compliance.spec.ts`, spread into
// `SEO_RULE_SPECS`; acceptance `seo-compliance.feature.md`, Rules). A header rule passes when main
// has no headers for the page ("unknown" in the panel); the accessibility rules pass until
// a check has run on the page shown.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

const resourceSample = (resource: InsecureResource): string => `${INSECURE_RESOURCE_LABELS[resource.kind]} (<${resource.tag}>): ${resource.url}`;

function mixedCheck(which: 'active' | 'passive'): Check {
  return (s) => {
    const mixed = analyseSecurity(s).mixed;
    const list = mixed[which];
    // Upgraded by the CSP (`upgraded`, not listed here), or a cut CSP might upgrade them: no failure.
    if (list.length === 0 || mixed.upgradeUnknown) return null;
    const kinds = [...new Set(list.map((resource) => INSECURE_RESOURCE_LABELS[resource.kind]))].join(', ');
    return details([fact('Resources', formatCount(list.length)), fact('Kinds', kinds), ...(mixed.truncated ? [fact('Scan', 'Stopped early: there may be more')] : [])], list.map(resourceSample), list.length);
  };
}

function a11yCheck(impact: A11yImpact): Check {
  return (s) => {
    const report = analyseAccessibility(s);
    if (report.status !== 'done') return null;
    const group = report.groups.find((g) => g.impact === impact);
    if (!group || group.rules.length === 0) return null;
    return details(
      [fact('Rules', formatCount(group.rules.length)), fact('Elements', formatCount(group.nodeTotal))],
      group.rules.map((rule) => `${rule.id}: ${rule.help} (${formatCount(rule.nodeTotal)})`),
      group.rules.length,
    );
  };
}

export const COMPLIANCE_CHECKS = {
  'https-missing': (s) => {
    const f = analyseSecurity(s);
    return !f.https && !f.loopback ? details([fact('URL', s.url), fact('Scheme', 'http')]) : null;
  },
  'mixed-content-active': mixedCheck('active'),
  'mixed-content-passive': mixedCheck('passive'),
  'hsts-missing': (s) => {
    const f = analyseSecurity(s);
    if (!f.https || !f.headersKnown || hstsActive(f)) return null;
    const value = headerValues(s, 'strict-transport-security')[0];
    return details([fact('Strict-Transport-Security', value === undefined ? 'Not sent' : f.hsts === null ? `${value} (not valid)` : value)]);
  },
  'hsts-short-max-age': (s) => {
    const f = analyseSecurity(s);
    if (!hstsActive(f) || f.hsts!.maxAge >= HSTS_MIN_MAX_AGE_SECONDS) return null;
    return details([fact('max-age', `${formatCount(f.hsts!.maxAge)} seconds (${formatDuration(f.hsts!.maxAge)})`), fact('At least', `${formatCount(HSTS_MIN_MAX_AGE_SECONDS)} seconds (180 days)`)]);
  },
  'csp-missing': (s) => {
    const f = analyseSecurity(s);
    if (f.cspPolicies.length > 0 || !f.headersKnown) return null;
    return details([fact('Content-Security-Policy', 'Not sent'), fact('Meta policy', 'None')]);
  },
  'csp-unsafe-inline': (s) => {
    const f = analyseSecurity(s);
    if (!f.inlineScriptsAllowed) return null;
    const lists = f.cspPolicies.map((policy) => scriptSources(policy)).filter((sources) => sources !== null);
    return details([fact('Policies', formatCount(f.cspPolicies.length))], lists.map((sources) => sources.join(' ')));
  },
  'nosniff-missing': (s) => {
    const f = analyseSecurity(s);
    if (!f.headersKnown || f.nosniff) return null;
    const value = headerValues(s, 'x-content-type-options')[0];
    return details([fact('X-Content-Type-Options', value ?? 'Not sent')]);
  },
  'clickjacking-unprotected': (s) => {
    const f = analyseSecurity(s);
    if (!f.headersKnown || f.frameOptionsProtect || f.frameAncestors || f.cspCut) return null;
    const value = headerValues(s, 'x-frame-options')[0];
    return details([fact('X-Frame-Options', value ?? 'Not sent'), fact('frame-ancestors', 'Not set')]);
  },
  'referrer-policy-missing': (s) => {
    const f = analyseSecurity(s);
    if (f.referrerPolicy !== null || (!f.headersKnown && s.security.metaReferrer === null)) return null;
    const value = headerValues(s, 'referrer-policy')[0];
    return details([fact('Referrer-Policy', value === undefined ? 'Not sent' : `${value} (no known value)`), fact('Meta referrer', s.security.metaReferrer ?? 'None')]);
  },
  'referrer-policy-unsafe': (s) => {
    const f = analyseSecurity(s);
    if (f.referrerPolicy === null || !(UNSAFE_REFERRER_POLICIES as readonly string[]).includes(f.referrerPolicy)) return null;
    return details([fact('Policy', f.referrerPolicy), fact('Set by', f.referrerFrom === 'meta' ? '<meta name="referrer">' : 'Referrer-Policy header')]);
  },
  'a11y-critical': a11yCheck('critical'),
  'a11y-serious': a11yCheck('serious'),
} as const satisfies Record<string, Check>;
