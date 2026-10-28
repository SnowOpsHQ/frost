import type { Finding, SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { PAGE_AUDIT_LIMITS as L, PAGE_TITLE_MAX_CHARS } from '@app/specs/agent-page-tools.spec';
import { renderProfileSummary, type AuditRenderProfile } from '@app/specs/render-profile.spec';

// `page_audit` and `page_data` (Phase 5 Task 5; acceptance `specs/agent-page-tools.feature.md`):
// what the model reads of main's audit of the chat tab's page. They summarise the ready audit (the
// page's own text in it is untrusted; the broker wraps it so), cut every string and list to
// `PAGE_AUDIT_LIMITS`, and trim the whole to `budgetChars` of JSON (least severe findings dropped
// first), so the broker's own cap rarely has to cut them. Neither reads the page: the audit holds
// what they report, and it does not keep the visible text (`page_text` reads that).

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const clipOrNull = (text: string | null | undefined, max: number): string | null => (typeof text === 'string' ? clip(text, max) : null);

/** A not-ready audit, said plainly as data (no page data in it). */
export function auditNotReady(response: Exclude<SeoAuditResponse, { status: 'ready' }>): Record<string, unknown> {
  return response.status === 'pending'
    ? { status: 'pending', note: 'frost is still auditing this page; ask again in a few seconds.' }
    : { status: 'unavailable', reason: response.reason, note: 'frost has no audit of this page.' };
}

function findingSummary(finding: Finding) {
  const { details } = finding;
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    category: finding.category,
    title: clip(finding.title, L.maxFindingTextChars),
    why: clip(finding.why, L.maxFindingTextChars),
    fix: clip(finding.fix, L.maxFindingTextChars),
    facts: details.facts.slice(0, L.maxFindingFacts).map((fact) => `${clip(fact.label, 80)}: ${clip(fact.value, L.maxSampleChars)}`),
    samples: details.samples.slice(0, L.maxFindingSamples).map((sample) => clip(sample, L.maxSampleChars)),
    ...(details.count !== undefined ? { count: details.count } : {}),
  };
}

function profileName(profile: AuditRenderProfile | null | undefined): string | null {
  return profile ? renderProfileSummary(profile.profile) : null;
}

/** Drops entries from the end of `list` (keeping at least none) until `build(list)`'s JSON fits `budget`. */
function trimToBudget<T, R>(list: readonly T[], build: (kept: readonly T[], omitted: number) => R, budget: number): R {
  let kept = list.length;
  let built = build(list, 0);
  let length = JSON.stringify(built).length;
  while (length > budget && kept > 0) {
    // Step by the overshoot's share of the list, at least one.
    const share = Math.max(1, Math.ceil(((length - budget) / length) * kept));
    kept = Math.max(0, kept - share);
    built = build(list.slice(0, kept), list.length - kept);
    length = JSON.stringify(built).length;
  }
  return built;
}

/**
 * `page_audit`'s data for a ready audit: score, band, indexability, severity counts, the findings
 * (most severe first, as the audit ranks them; at most `maxFindings`, then trimmed to the budget,
 * `findingsOmitted` saying how many were left out) and the page's key facts.
 */
export function summariseAudit(audit: SeoAudit, renderProfile?: AuditRenderProfile | null): Record<string, unknown> {
  const page = audit.page;
  const base = {
    status: 'ready',
    url: clip(audit.url, L.maxUrlChars),
    score: audit.score,
    band: audit.band,
    indexable: audit.indexable,
    indexability: audit.indexability.verdict,
    counts: { ...audit.counts },
    keyFacts: {
      title: clipOrNull(page.title?.text, PAGE_TITLE_MAX_CHARS),
      description: clipOrNull(page.description?.text, L.maxFactChars),
      canonical: clipOrNull(page.canonical, L.maxUrlChars),
      h1: page.headings
        .filter((heading) => heading.level === 1)
        .slice(0, 3)
        .map((heading) => clip(heading.text, L.maxHeadingChars)),
      wordCount: page.wordCount,
      httpStatus: audit.indexability.http?.status ?? null,
    },
    renderProfile: profileName(renderProfile),
    auditedAt: audit.takenAt,
  };
  const findings = audit.findings.slice(0, L.maxFindings).map(findingSummary);
  const cappedOut = audit.findings.length - findings.length;
  return trimToBudget(findings, (kept, omitted) => ({ ...base, findings: kept, findingsTotal: audit.findings.length, findingsOmitted: omitted + cappedOut }), L.budgetChars);
}

/**
 * `page_data`'s data for a ready audit: the page's facts (title, meta description, canonical,
 * robots, language, headings outline, link and image counts, structured-data types, hreflang),
 * the indexability verdict and its reasons, and the render profile the audit ran under.
 */
export function summarisePageData(audit: SeoAudit, renderProfile?: AuditRenderProfile | null): Record<string, unknown> {
  const page = audit.page;
  const types: string[] = [];
  for (const entity of audit.schema.entities) {
    for (const type of entity.types) {
      if (types.length >= L.maxSchemaTypes) break;
      const name = clip(type, 120);
      if (!types.includes(name)) types.push(name);
    }
  }
  const hreflang = audit.indexability.hreflang;
  const base = {
    url: clip(page.url, L.maxUrlChars),
    title: page.title ? { text: clip(page.title.text, PAGE_TITLE_MAX_CHARS), length: page.title.length } : null,
    titleCount: page.titleTotal,
    metaDescription: page.description ? { text: clip(page.description.text, L.maxFactChars), length: page.description.length } : null,
    metaDescriptionCount: page.descriptionTotal,
    canonical: clipOrNull(page.canonical, L.maxUrlChars),
    canonicalCount: page.canonicalTotal,
    robots: clipOrNull(page.robots, L.maxFactChars),
    noindexFor: page.noindexFor.slice(0, 10).map((name) => clip(name, 64)),
    lang: clipOrNull(page.lang, 64),
    viewport: clipOrNull(page.viewport, 200),
    wordCount: page.wordCount,
    links: { ...page.links },
    images: { ...page.images },
    structuredData: { types, entityCount: audit.schema.entityCount, issueCount: audit.schema.issues.length },
    hreflang: {
      total: hreflang.total,
      hasXDefault: hreflang.hasXDefault,
      hasSelf: hreflang.hasSelf,
      entries: hreflang.entries.slice(0, L.maxHreflang).map((entry) => ({ value: clip(entry.value, 64), href: clip(entry.resolved ?? entry.href, L.maxUrlChars), valid: entry.valid })),
    },
    indexability: {
      verdict: audit.indexability.verdict,
      indexable: audit.indexable,
      reasons: audit.indexability.reasons.slice(0, L.maxReasons).map((reason) => clip(reason, L.maxFactChars)),
      httpStatus: audit.indexability.http?.status ?? null,
    },
    renderProfile: profileName(renderProfile),
    partial: page.partial,
  };
  const outline = page.headings.slice(0, L.maxHeadings).map((heading) => ({ level: heading.level, text: clip(heading.text, L.maxHeadingChars) }));
  return trimToBudget(outline, (kept, omitted) => ({ ...base, headings: { total: page.headingTotal, outline: kept, omitted: omitted + (page.headings.length - outline.length) } }), L.budgetChars);
}
