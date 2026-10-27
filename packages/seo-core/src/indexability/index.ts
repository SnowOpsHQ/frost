import { ROBOTS_AGENTS, ROBOTS_PARSE_LIMITS, ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { NOT_INDEXABLE_RULES, type SeoRuleId } from '@app/specs/seo-rules.spec';
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { parseUrl, withoutFragment } from '../util';
import { parseLinkHeader, parseXRobotsTag, type LinkValue, type XRobotsTag } from './headers';
import { isValidHreflang } from './hreflang';
import type { CanonicalReport, HreflangEntry, HreflangReport, HttpReport, IndexabilityReport, RobotsAgentVerdict, RobotsReport } from './model';
import { matchRobots, parseRobotsTxt, robotsPathOf } from './robots';

// The page's indexability facts, read once per snapshot (memoised, like `analyseSchema`) so the
// `indexability` / `hreflang` rules and the panel share one pass (acceptance
// `seo-indexability.feature.md`). Everything here runs in the analysis worker, never on main's thread.

/** The facts without the verdict (the verdict depends on which rules fail: `indexabilityReport`). */
export type IndexabilityFacts = Omit<IndexabilityReport, 'verdict' | 'reasons'>;

const facts = new WeakMap<PageSnapshot, IndexabilityFacts>();

/** Crawlers whose `X-Robots-Tag` counts like the robots meta tags (`ROBOTS_META_NAMES` without the generic name). */
const X_ROBOTS_AGENTS: ReadonlySet<string> = new Set(ROBOTS_META_NAMES.filter((name) => name !== 'robots'));
const UNKNOWN: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_UNKNOWN_OUTCOMES);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `url` (resolved against `base`) without its fragment, or `null`. */
function key(url: string | null, base?: string): string | null {
  const parsed = parseUrl(url, base);
  return parsed ? withoutFragment(parsed) : null;
}

function httpReport(s: PageSnapshot): HttpReport | null {
  const response = s.response;
  if (!response) return null;
  const beyond = response.redirectTotal - response.redirects.length;
  return {
    url: response.url,
    source: response.source,
    status: response.status,
    headersAvailable: response.headersAvailable,
    headers: response.headers,
    redirects: response.redirects,
    redirectTotal: response.redirectTotal,
    serverRedirects: response.redirects.filter((hop) => !hop.internal).length + Math.max(0, beyond),
  };
}

/** The values of response header `name` (lowercase), in order; none without headers. */
export function headerValues(s: PageSnapshot, name: string): string[] {
  return s.response?.headersAvailable ? s.response.headers.filter((header) => header.name === name).map((header) => header.value) : [];
}

/** The `X-Robots-Tag` values that apply to indexing in search (every crawler, or one of `X_ROBOTS_AGENTS`) and carry one of `directives`. */
export function xRobotsWith(tags: readonly XRobotsTag[], directives: readonly string[]): XRobotsTag[] {
  return tags.filter((tag) => (tag.agent === null || X_ROBOTS_AGENTS.has(tag.agent)) && tag.directives.some((d) => directives.includes(d)));
}

/** The page's `Link` header values (parsed), at most `maxHreflang` of them. */
function linkValues(s: PageSnapshot): LinkValue[] {
  const values: LinkValue[] = [];
  for (const header of headerValues(s, 'link')) {
    values.push(...parseLinkHeader(header, SNAPSHOT_LIMITS.maxHreflang - values.length));
    if (values.length >= SNAPSHOT_LIMITS.maxHreflang) break;
  }
  return values;
}

function canonicalReport(s: PageSnapshot, links: readonly LinkValue[]): CanonicalReport {
  const first = s.canonicals[0];
  const html = first ? (first.resolved ?? (first.href || null)) : null;
  const headerLink = links.find((link) => link.rel.includes('canonical'));
  const header = headerLink ? (parseUrl(headerLink.target, s.url)?.href ?? headerLink.target) : null;
  const effective = html ?? header;
  const page = key(s.url);
  const effectiveKey = key(effective, s.url);
  const htmlKey = key(html, s.url);
  const headerKey = key(header, s.url);
  return {
    html,
    header,
    effective,
    elsewhere: effectiveKey !== null && page !== null && effectiveKey !== page,
    conflict: htmlKey !== null && headerKey !== null && htmlKey !== headerKey,
  };
}

function robotsReport(s: PageSnapshot): RobotsReport | null {
  const fetched = s.robots;
  if (!fetched) return null;
  const page = parseUrl(s.url);
  const path = page ? robotsPathOf(page) : '/';
  const file = fetched.outcome === 'ok' ? parseRobotsTxt(fetched.text) : null;
  const unknown = UNKNOWN.has(fetched.outcome);
  const agents: RobotsAgentVerdict[] = ROBOTS_AGENTS.map((agent) => {
    if (!file) return { agent, allowed: unknown ? null : true, groupAgents: [], groupLine: null, fallback: false, rule: null };
    const match = matchRobots(file, agent, path);
    return {
      agent,
      allowed: match.allowed,
      groupAgents: match.groups.flatMap((group) => group.agents),
      groupLine: match.groups[0]?.line ?? null,
      fallback: match.fallback,
      rule: match.rule && { allow: match.rule.allow, raw: match.rule.raw, line: match.rule.line },
    };
  });
  const base = fetched.finalUrl ?? fetched.url;
  return {
    url: fetched.url,
    finalUrl: fetched.finalUrl,
    outcome: fetched.outcome,
    status: fetched.status,
    redirects: fetched.redirects,
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    groupCount: file?.groups.length ?? 0,
    ruleCount: file?.ruleCount ?? 0,
    sitemaps: (file?.sitemaps ?? []).map((sitemap) => {
      const url = parseUrl(sitemap.raw, base);
      return { raw: sitemap.raw, url: url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null, line: sitemap.line };
    }),
    sitemapTotal: file?.sitemapTotal ?? 0,
    path,
    agents,
    text: fetched.text.slice(0, ROBOTS_PARSE_LIMITS.maxViewChars),
    textCut: fetched.text.length > ROBOTS_PARSE_LIMITS.maxViewChars,
  };
}

function hreflangReport(s: PageSnapshot, links: readonly LinkValue[], canonical: CanonicalReport): HreflangReport {
  const selves = new Set([key(s.url), key(canonical.effective, s.url)].filter((value) => value !== null));
  const raw: Omit<HreflangEntry, 'duplicate'>[] = [];
  const add = (value: string, href: string, resolved: string | null, source: HreflangEntry['source']) => {
    const resolvedKey = key(resolved);
    raw.push({ value, href, resolved, source, valid: isValidHreflang(value), self: resolvedKey !== null && selves.has(resolvedKey), relative: !HAS_SCHEME.test(href.trim()) });
  };
  for (const link of s.hreflang) add(link.hreflang, link.href, link.resolved, 'html');
  let headerTotal = 0;
  for (const link of links) {
    if (link.hreflang === null || !link.rel.includes('alternate')) continue;
    headerTotal++;
    add(link.hreflang, link.target, parseUrl(link.target, s.url)?.href ?? null, 'header');
  }
  const counts = new Map<string, number>();
  for (const entry of raw) counts.set(entry.value.trim().toLowerCase(), (counts.get(entry.value.trim().toLowerCase()) ?? 0) + 1);
  const entries = raw.map((entry) => ({ ...entry, duplicate: (counts.get(entry.value.trim().toLowerCase()) ?? 0) > 1 }));
  return {
    entries,
    total: s.hreflangTotal + headerTotal,
    hasXDefault: entries.some((entry) => entry.value.trim().toLowerCase() === 'x-default'),
    hasSelf: entries.some((entry) => entry.self),
  };
}

/** The snapshot's indexability facts (memoised per snapshot). Pure; bounded by the snapshot's caps. */
export function analyseIndexability(s: PageSnapshot): IndexabilityFacts {
  const cached = facts.get(s);
  if (cached) return cached;
  const links = linkValues(s);
  const canonical = canonicalReport(s, links);
  const result: IndexabilityFacts = {
    http: httpReport(s),
    robotsMeta: s.metaRobots,
    xRobotsTag: headerValues(s, 'x-robots-tag').map(parseXRobotsTag),
    canonical,
    robots: robotsReport(s),
    hreflang: hreflangReport(s, links, canonical),
  };
  facts.set(s, result);
  return result;
}

/** The crawlers a list of `X-Robots-Tag` values addresses (`all crawlers` for the generic one). */
export function xRobotsAgents(tags: readonly XRobotsTag[]): string {
  return [...new Set(tags.map((tag) => tag.agent ?? 'all crawlers'))].join(', ');
}

/** The verdict and its reasons, given the facts and the rules that failed (`NOT_INDEXABLE_RULES`). */
export function indexabilityReport(s: PageSnapshot, failing: ReadonlySet<SeoRuleId>, noindexFor: readonly string[]): IndexabilityReport {
  const base = analyseIndexability(s);
  const reasons: string[] = [];
  for (const id of NOT_INDEXABLE_RULES) {
    if (!failing.has(id)) continue;
    switch (id) {
      case 'robots-noindex':
        reasons.push(`A robots meta tag asks not to index it (${noindexFor.join(', ')})`);
        break;
      case 'x-robots-noindex':
        reasons.push(`The X-Robots-Tag header asks not to index it (${xRobotsAgents(xRobotsWith(base.xRobotsTag, ['noindex', 'none']))})`);
        break;
      case 'robots-txt-blocks-googlebot': {
        const rule = base.robots?.agents.find((agent) => agent.agent === 'Googlebot')?.rule;
        reasons.push(rule ? `robots.txt blocks Googlebot (line ${rule.line}: Disallow: ${rule.raw})` : 'robots.txt blocks Googlebot');
        break;
      }
      default:
        reasons.push(`The server answered HTTP ${base.http?.status ?? '?'}`);
    }
  }
  if (reasons.length > 0) return { ...base, verdict: 'not-indexable', reasons };
  if (failing.has('canonical-elsewhere') && base.canonical.effective) return { ...base, verdict: 'canonicalised', reasons: [`Its canonical points to ${base.canonical.effective}`] };
  return { ...base, verdict: 'indexable', reasons: [] };
}

export { parseLinkHeader, parseXRobotsTag, type LinkValue, type XRobotsTag } from './headers';
export { isValidHreflang, parseHreflangCode, type HreflangCode } from './hreflang';
export { groupsFor, matchRobots, normaliseRobotsPath, parseRobotsTxt, productToken, robotsPathOf, robotsPatternMatches, type RobotsFile, type RobotsGroup, type RobotsMatch, type RobotsRule } from './robots';
export type * from './model';
