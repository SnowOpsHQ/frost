import { SCORE_BANDS, SEO_SEVERITIES, SEVERITY_WEIGHTS, type ScoreBand, type SeoCategory, type SeoSeverity } from '@app/specs/seo-rules.spec';
import type { PanelStatus } from '@app/specs/seo-sidebar.spec';
import { RULES } from './rules';
import type { Finding, PageFacts, PageSnapshot, SeoAudit, SeoRule, SeverityCounts } from './types';
import { tokens } from './util';

// Running the rules over a snapshot, ranking the findings and scoring them (spec
// `seo-rules.spec.ts`, Health score; acceptance `seo-rules.feature.md`, Audit and score).

const SEVERITY_RANK: Readonly<Record<SeoSeverity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * The health score of `findings` (0–100): `round(100 × Π (1 − SEVERITY_WEIGHTS[severity]))` over
 * the failing rules, each rule once however many findings it has.
 */
export function scoreAudit(findings: readonly Pick<Finding, 'ruleId' | 'severity'>[]): number {
  const seen = new Set<string>();
  let remaining = 1;
  for (const finding of findings) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    remaining *= 1 - SEVERITY_WEIGHTS[finding.severity];
  }
  return Math.min(100, Math.max(0, Math.round(100 * remaining)));
}

/** The band a score falls in (`SCORE_BANDS`, first match). */
export function scoreBand(score: number): ScoreBand {
  return (SCORE_BANDS.find((band) => score >= band.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]!).id;
}

/** Errors first, then warnings, then info; each group in catalog order (stable). */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const order = new Map(RULES.map((rule, index) => [rule.id, index]));
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (order.get(a.ruleId) ?? 0) - (order.get(b.ruleId) ?? 0));
}

export function countSeverities(findings: readonly Finding[]): SeverityCounts {
  const counts = Object.fromEntries(SEO_SEVERITIES.map((severity) => [severity, 0])) as Record<SeoSeverity, number>;
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * A panel's rail dot: `error` if a finding in `categories` is an error, `warn` if one is a
 * warning, else `pass` (info never colours a dot).
 */
export function panelStatus(findings: readonly Pick<Finding, 'category' | 'severity'>[], categories: readonly SeoCategory[]): PanelStatus {
  const mine = findings.filter((finding) => categories.includes(finding.category));
  if (mine.some((finding) => finding.severity === 'error')) return 'error';
  if (mine.some((finding) => finding.severity === 'warning')) return 'warn';
  return 'pass';
}

/** What the On-Page panel shows, from the snapshot. */
export function pageFacts(s: PageSnapshot): PageFacts {
  const count = (kind: string) => s.links.filter((link) => link.kind === kind).length;
  return {
    url: s.url,
    title: s.titles[0] ?? null,
    titleTotal: s.titleTotal,
    description: s.metaDescriptions[0] ?? null,
    descriptionTotal: s.metaDescriptionTotal,
    canonical: s.canonicals[0] ? (s.canonicals[0].resolved ?? s.canonicals[0].href) : null,
    canonicalTotal: s.canonicalTotal,
    robots: s.metaRobots.length > 0 ? s.metaRobots.join(', ') : null,
    ogUrl: s.ogUrl,
    lang: s.lang,
    viewport: s.viewport,
    headings: s.headings,
    headingTotal: s.headingTotal,
    wordCount: s.wordCount,
    textTruncated: s.textTruncated,
    links: {
      analysed: s.links.length,
      total: s.linkTotal,
      internal: count('internal'),
      external: count('external'),
      other: count('other'),
      nofollow: s.links.filter((link) => tokens(link.rel).includes('nofollow')).length,
    },
    images: { analysed: s.images.length, total: s.imageTotal, missingAlt: s.images.filter((image) => image.alt === null).length },
  };
}

/** Runs `rules` (default: every catalog rule) over `snapshot`: ranked findings, counts, score and page facts. */
export function runAudit(snapshot: PageSnapshot, rules: readonly SeoRule[] = RULES): SeoAudit {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const result = rule.check(snapshot);
    if (result === null) continue;
    findings.push({ ruleId: rule.id, category: rule.category, severity: rule.severity, title: rule.title, why: rule.why, fix: rule.fix, details: result });
  }
  const ranked = rankFindings(findings);
  const score = scoreAudit(ranked);
  return {
    url: snapshot.url,
    takenAt: snapshot.extractedAt,
    durationMs: snapshot.durationMs,
    score,
    band: scoreBand(score),
    counts: countSeverities(ranked),
    findings: ranked,
    page: pageFacts(snapshot),
  };
}
