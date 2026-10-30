import type { Finding, SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { modelPageUrl, PAGE_AUDIT_LIMITS as L, PAGE_TITLE_MAX_CHARS } from '@app/specs/agent-page-tools.spec';
import { renderProfileSummary, type AuditRenderProfile } from '@app/specs/render-profile.spec';
import { READABILITY_FORMULAS, READABILITY_UNAVAILABLE_MESSAGES } from '@app/specs/seo-content.spec';
import { JS_VERDICT_LABELS, SERVED_UNAVAILABLE_MESSAGES } from '@app/specs/seo-javascript.spec';
import { SOCIAL_TAGS } from '@app/specs/seo-limits.spec';

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

/**
 * Shortens lists until `build(kept)`'s JSON fits `budget`. `kept[i]` is how many entries list `i`
 * keeps (a list is cut from its end); the lists are cut in order, each until the output fits or it
 * is empty, then the next, so the lowest-value list goes first.
 */
function fitToBudget<R>(sizes: readonly number[], build: (kept: readonly number[]) => R, budget: number): R {
  const kept = [...sizes];
  let built = build(kept);
  let length = JSON.stringify(built).length;
  for (let i = 0; i < kept.length; i += 1) {
    while (length > budget && kept[i]! > 0) {
      // Step by the overshoot's share of the list, at least one.
      const share = Math.max(1, Math.ceil(((length - budget) / length) * kept[i]!));
      kept[i] = Math.max(0, kept[i]! - share);
      built = build(kept);
      length = JSON.stringify(built).length;
    }
  }
  return built;
}

/** Drops entries from the end of `list` (keeping at least none) until `build(list)`'s JSON fits `budget`. */
function trimToBudget<T, R>(list: readonly T[], build: (kept: readonly T[], omitted: number) => R, budget: number): R {
  return fitToBudget([list.length], ([kept]) => build(list.slice(0, kept), list.length - kept!), budget);
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
    url: clip(modelPageUrl(audit.url) ?? audit.url, L.maxUrlChars),
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

/** The first `keep` social sharing tags of `SOCIAL_TAGS` (`null`: the page has none), each value cut to `maxFactChars`. */
function socialOf(social: SeoAudit['page']['social'], keep: number): Record<string, string | null> {
  return Object.fromEntries(SOCIAL_TAGS.slice(0, keep).map((tag) => [tag, clipOrNull(social[tag], L.maxFactChars)]));
}

/**
 * The Content panel's facts: the language and where it came from, the words read, the readability
 * formula's name, score and band (or why there is none), the sentence statistics and at most
 * `maxDifficultSentencesForModel` difficult-sentence excerpts (the page's own text: untrusted).
 */
function contentSummary(content: SeoAudit['content'], keepDifficult: number): Record<string, unknown> {
  const { readability, sentences } = content;
  return {
    available: content.available,
    truncated: content.truncated,
    language: { code: content.language.code, source: content.language.source },
    words: content.words,
    readability:
      readability.status === 'ok'
        ? { status: 'ok', formula: Object.values(READABILITY_FORMULAS).find((formula) => formula.id === readability.formula)?.name ?? readability.formula, score: readability.score, band: readability.band }
        : { status: 'not-available', reason: READABILITY_UNAVAILABLE_MESSAGES[readability.reason] },
    sentences:
      sentences.status === 'ok'
        ? {
            status: 'ok',
            sentences: sentences.sentences,
            averageWords: sentences.averageWords,
            longestWords: sentences.longestWords,
            longCount: sentences.longCount,
            complexWordShare: sentences.complexWordShare,
            difficultTotal: sentences.difficult.total,
            difficult: sentences.difficult.items.slice(0, keepDifficult).map((item) => ({ text: clip(item.text, L.maxFactChars), words: item.words, reason: item.reason })),
          }
        : { status: 'not-available', reason: sentences.reason },
  };
}

/** The served-versus-rendered verdict: `pending` and `unavailable` said plainly, else the verdict and how many fields differ. */
function javascriptSummary(report: SeoAudit['javascript']): Record<string, unknown> {
  if (report.status === 'pending') return { status: 'pending', note: 'frost is still comparing the served HTML with the rendered page; ask again in a few seconds.' };
  if (report.status === 'unavailable') return { status: 'unavailable', reason: report.reason, note: SERVED_UNAVAILABLE_MESSAGES[report.reason].replace('{status}', String(report.httpStatus ?? 'an error')) };
  return { status: report.status, verdict: report.verdict, verdictLabel: JS_VERDICT_LABELS[report.verdict], changedFields: report.changed, partial: report.partial };
}

/**
 * `page_data`'s data for a ready audit: the page's facts (title, meta description, canonical,
 * robots, language, headings outline, link and image counts, its internal links with their anchor
 * text, structured-data types, hreflang, social sharing tags, a content summary and the
 * served-versus-rendered JavaScript verdict),
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
  const entries = hreflang.entries.slice(0, L.maxHreflang).map((entry) => ({ value: clip(entry.value, 64), href: clip(entry.resolved ?? entry.href, L.maxUrlChars), valid: entry.valid }));
  const reasons = audit.indexability.reasons.slice(0, L.maxReasons).map((reason) => clip(reason, L.maxFactChars));
  const outline = page.headings.slice(0, L.maxHeadings).map((heading) => ({ level: heading.level, text: clip(heading.text, L.maxHeadingChars) }));
  const links = internalLinksOf(audit);
  const difficultSentences = audit.content.sentences.status === 'ok' ? Math.min(audit.content.sentences.difficult.items.length, L.maxDifficultSentencesForModel) : 0;
  // One entry per `PAGE_DATA_TRIM_ORDER` step, in that order: how many entries each list starts with.
  const sizes = [outline.length, entries.length, difficultSentences, L.maxSocialFields, links.list.length, types.length, reasons.length];
  return fitToBudget(
    sizes,
    ([keepOutline, keepHreflang, keepDifficult, keepSocial, keepLinks, keepTypes, keepReasons]) => {
      const cut = { hreflang: entries.length - keepHreflang!, difficultSentences: difficultSentences - keepDifficult!, social: L.maxSocialFields - keepSocial!, schemaTypes: types.length - keepTypes!, reasons: reasons.length - keepReasons! };
      const trimmed = Object.fromEntries(Object.entries(cut).filter(([, count]) => count > 0));
      return {
        url: clip(modelPageUrl(page.url) ?? page.url, L.maxUrlChars),
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
        structuredData: { types: types.slice(0, keepTypes), entityCount: audit.schema.entityCount, issueCount: audit.schema.issues.length },
        hreflang: { total: hreflang.total, hasXDefault: hreflang.hasXDefault, hasSelf: hreflang.hasSelf, entries: entries.slice(0, keepHreflang) },
        indexability: { verdict: audit.indexability.verdict, indexable: audit.indexable, reasons: reasons.slice(0, keepReasons), httpStatus: audit.indexability.http?.status ?? null },
        social: socialOf(page.social, keepSocial!),
        content: contentSummary(audit.content, keepDifficult!),
        javascript: javascriptSummary(audit.javascript),
        renderProfile: profileName(renderProfile),
        partial: page.partial,
        internalLinks: { ...links, list: links.list.slice(0, keepLinks), omitted: links.omitted + (links.list.length - keepLinks!) },
        headings: { total: page.headingTotal, outline: outline.slice(0, keepOutline), omitted: outline.length - keepOutline! + (page.headings.length - outline.length) },
        ...(Object.keys(trimmed).length > 0 ? { trimmed } : {}),
      };
    },
    L.budgetChars,
  );
}

interface InternalLinks {
  readonly analysed: number;
  readonly internal: number;
  readonly distinct: number;
  readonly list: readonly { text: string; href: string }[];
  readonly omitted: number;
}

/**
 * The page's internal links as `page_data` lists them: distinct addresses (fragment dropped) in page
 * order with the first anchor text seen for each (collapsed, cut), capped and trimmed to
 * `internalLinksBudgetChars`. Read from the audit's link list (the first `links.analysed` links), so
 * `analysed` and `distinct` say what the list covers.
 */
export function internalLinksOf(audit: SeoAudit): InternalLinks {
  const seen = new Set<string>();
  const links: { text: string; href: string }[] = [];
  for (const link of audit.page.linkList) {
    if (link.kind !== 'internal') continue;
    let href: string;
    try {
      const parsed = new URL(link.href);
      parsed.hash = '';
      href = parsed.href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ text: clip(link.text.replace(/\s+/g, ' ').trim(), L.maxLinkTextChars), href: clip(href, L.maxUrlChars) });
  }
  const listed = links.slice(0, L.maxInternalLinks);
  return trimToBudget(listed, (kept, omitted) => ({ analysed: audit.page.links.analysed, internal: audit.page.links.internal, distinct: links.length, list: kept, omitted: omitted + (links.length - listed.length) }), L.internalLinksBudgetChars);
}
