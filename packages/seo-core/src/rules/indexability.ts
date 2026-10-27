import { ROBOTS_OUTCOME_LABELS, ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { analyseIndexability, xRobotsAgents, xRobotsWith, type NoindexScope } from '../indexability';
import type { RobotsAgentVerdict } from '../indexability/model';
import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact, formatCount } from '../util';

// The indexability and hreflang rules (catalog `specs/seo-rules.spec.ts`, Indexability and hreflang;
// acceptance `seo-indexability.feature.md`, Rules). Each reads `analyseIndexability`'s facts: a
// rule about the response, headers or robots.txt passes when main collected nothing about it.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

const UNKNOWN: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_UNKNOWN_OUTCOMES);

/** The response's final status if it is in `[min, max]`. */
function statusIn(s: PageSnapshot, min: number, max: number): number | null {
  const status = analyseIndexability(s).http?.status ?? null;
  return status !== null && status >= min && status <= max ? status : null;
}

function statusCheck(min: number, max: number): Check {
  return (s) => {
    const status = statusIn(s, min, max);
    return status === null ? null : details([fact('Status', String(status)), fact('URL', analyseIndexability(s).http!.url)]);
  };
}

function verdictOf(s: PageSnapshot, agent: RobotsAgentVerdict['agent']): RobotsAgentVerdict | undefined {
  return analyseIndexability(s).robots?.agents.find((verdict) => verdict.agent === agent);
}

/** Facts for a blocked crawler: the rule and the group it came from. */
function blockedFacts(verdict: RobotsAgentVerdict, path: string) {
  return [
    fact('Rule', verdict.rule ? `Disallow: ${verdict.rule.raw}` : 'Disallow'),
    fact('Line', verdict.rule ? String(verdict.rule.line) : '?'),
    fact('Group', verdict.groupAgents.length > 0 ? `User-agent: ${verdict.groupAgents.join(', ')}` : 'None'),
    fact('Path', path),
  ];
}

function xRobotsCheck(directives: readonly string[], scope: NoindexScope = 'all'): Check {
  return (s) => {
    const tags = xRobotsWith(analyseIndexability(s).xRobotsTag, directives, scope);
    return tags.length > 0 ? details([fact('Applies to', xRobotsAgents(tags)), ...tags.map((tag) => fact('X-Robots-Tag', tag.value))]) : null;
  };
}

export const INDEXABILITY_CHECKS = {
  'http-status-redirect': statusCheck(300, 399),
  'http-status-client-error': statusCheck(400, 499),
  'http-status-server-error': statusCheck(500, 599),
  'http-redirect-chain': (s) => {
    const http = analyseIndexability(s).http;
    if (!http || http.serverRedirects <= 1) return null;
    const hops = http.redirects.filter((hop) => !hop.internal);
    return details([fact('Redirects', formatCount(http.serverRedirects)), fact('Final URL', http.url)], hops.map((hop) => `${hop.status} ${hop.url} → ${hop.location}`), http.serverRedirects);
  },
  'x-robots-noindex': xRobotsCheck(['noindex', 'none'], 'verdict'),
  'x-robots-noindex-other-bot': xRobotsCheck(['noindex', 'none'], 'other'),
  'x-robots-nofollow': xRobotsCheck(['nofollow', 'none']),
  'robots-txt-blocks-googlebot': (s) => {
    const verdict = verdictOf(s, 'Googlebot');
    return verdict && verdict.allowed === false ? details(blockedFacts(verdict, analyseIndexability(s).robots!.path)) : null;
  },
  'robots-txt-blocks-all': (s) => {
    const all = verdictOf(s, '*');
    const googlebot = verdictOf(s, 'Googlebot');
    if (!all || all.allowed !== false || googlebot?.allowed === false) return null;
    return details(blockedFacts(all, analyseIndexability(s).robots!.path));
  },
  'robots-txt-unreachable': (s) => {
    const robots = analyseIndexability(s).robots;
    if (!robots || !UNKNOWN.has(robots.outcome)) return null;
    return details([fact('robots.txt', robots.url), fact('Result', ROBOTS_OUTCOME_LABELS[robots.outcome]), ...(robots.status === null ? [] : [fact('Status', String(robots.status))])]);
  },
  'robots-txt-no-sitemap': (s) => {
    const robots = analyseIndexability(s).robots;
    return robots && robots.outcome === 'ok' && robots.sitemapTotal === 0 ? details([fact('robots.txt', robots.finalUrl ?? robots.url), fact('Sitemap lines', 'None')]) : null;
  },
  'canonical-elsewhere': (s) => {
    const canonical = analyseIndexability(s).canonical;
    if (!canonical.elsewhere || canonical.effective === null) return null;
    return details([fact('Canonical', canonical.effective), fact('From', canonical.html !== null ? '<link rel="canonical">' : 'HTTP Link header'), fact('Page', s.url)]);
  },
  'canonical-header-conflict': (s) => {
    const canonical = analyseIndexability(s).canonical;
    return canonical.conflict ? details([fact('HTML canonical', canonical.html ?? ''), fact('Header canonical', canonical.header ?? '')]) : null;
  },

  'hreflang-invalid-code': (s) => {
    const bad = analyseIndexability(s).hreflang.entries.filter((entry) => !entry.valid);
    return bad.length > 0 ? details([fact('Invalid values', formatCount(bad.length))], bad.map((entry) => `${entry.value || '(empty)'} → ${entry.href}`), bad.length) : null;
  },
  'hreflang-missing-self': (s) => {
    const hreflang = analyseIndexability(s).hreflang;
    return hreflang.entries.length > 0 && !hreflang.hasSelf ? details([fact('Annotations', formatCount(hreflang.entries.length)), fact('Page', s.url)]) : null;
  },
  'hreflang-no-x-default': (s) => {
    const hreflang = analyseIndexability(s).hreflang;
    return hreflang.entries.length > 0 && !hreflang.hasXDefault ? details([fact('Annotations', formatCount(hreflang.entries.length)), fact('x-default', 'None')]) : null;
  },
  'hreflang-duplicate': (s) => {
    const duplicates = analyseIndexability(s).hreflang.entries.filter((entry) => entry.duplicate);
    if (duplicates.length === 0) return null;
    const values = new Set(duplicates.map((entry) => entry.value.trim().toLowerCase()));
    return details([fact('Repeated values', [...values].join(', '))], duplicates.map((entry) => `${entry.value} → ${entry.href}`), duplicates.length);
  },
  'hreflang-relative-url': (s) => {
    const relative = analyseIndexability(s).hreflang.entries.filter((entry) => entry.relative);
    return relative.length > 0 ? details([fact('Relative URLs', formatCount(relative.length))], relative.map((entry) => `${entry.value} → ${entry.href || '(empty)'}`), relative.length) : null;
  },
} as const satisfies Record<string, Check>;
