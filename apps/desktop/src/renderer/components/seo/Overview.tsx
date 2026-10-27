import { useState } from 'react';
import type { Finding, SeoAudit } from '@app/seo-core';
import { NOT_INDEXABLE_LABEL, SCORE_BANDS, SEO_CATEGORIES, SEO_CATEGORY_LABELS, SEO_RULE_SPECS, SEO_SEVERITIES, type SeoCategory } from '@app/specs/seo-rules.spec';
import { OVERVIEW_TOP_ISSUES } from '@app/specs/seo-sidebar.spec';
import { CheckCircleIcon, ChevronIcon } from '../../icons';
import { formatCount } from '../../seo-view';
import { PageText, SEVERITY_LABEL, SeverityGlyph } from './parts';

// Overview (spec `seo-sidebar.feature.md`, Sidebar): the health score ring with its band, the
// counts by severity, and the ranked issues, each expandable to why it matters, how to fix it and
// the offending values.

const RING_RADIUS = 42;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The score as a ring: the arc's length is the score (an SVG attribute, never a style). */
export function ScoreRing({ score, band }: { readonly score: number; readonly band: SeoAudit['band'] }) {
  const arc = (Math.max(0, Math.min(100, score)) / 100) * RING_LENGTH;
  return (
    <div className="seo-ring" data-band={band}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="seo-ring-track" cx="50" cy="50" r={RING_RADIUS} />
        <circle className="seo-ring-arc" cx="50" cy="50" r={RING_RADIUS} strokeDasharray={`${arc} ${RING_LENGTH}`} transform="rotate(-90 50 50)" />
      </svg>
      <span className="seo-ring-value" data-testid="seo-score" data-band={band}>
        {score}
      </span>
    </div>
  );
}

function plural(n: number, [one, many]: [string, string]): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** A search-result style preview, drawn by frost from the page's title, URL and description (text only). */
function SearchPreview({ audit }: { readonly audit: SeoAudit }) {
  const { page } = audit;
  let crumbs = page.url;
  try {
    const url = new URL(page.url);
    crumbs = [url.host, ...url.pathname.split('/').filter((part) => part !== '')].join(' › ');
  } catch {
    // Shown as is.
  }
  const title = page.title?.text || '(no title)';
  return (
    <section className="seo-section seo-preview" data-testid="seo-preview" aria-label="Search result preview">
      <header className="seo-section-head">
        <h3 className="seo-section-title">Search preview</h3>
      </header>
      <PageText value={crumbs} className="seo-preview-url" />
      <PageText value={title} className="seo-preview-title" />
      {page.description?.text ? (
        <PageText value={page.description.text} className="seo-preview-description" lines={2} />
      ) : (
        <span className="seo-preview-description seo-missing">No meta description: search engines will pick text from the page.</span>
      )}
    </section>
  );
}

/** Each category's checks at a glance: passed, or its worst finding's severity and how many failed. */
function CategoryGrid({ audit }: { readonly audit: SeoAudit }) {
  const rows = SEO_CATEGORIES.map((category: SeoCategory) => {
    const findings = audit.findings.filter((f) => f.category === category);
    const worst = SEO_SEVERITIES.find((severity) => findings.some((f) => f.severity === severity));
    return { category, findings: findings.length, worst };
  });
  return (
    <section className="seo-section" aria-label="Checks by category">
      <header className="seo-section-head">
        <h3 className="seo-section-title">Checks</h3>
      </header>
      <ul className="seo-categories" data-testid="seo-categories">
        {rows.map((row) => (
          <li key={row.category} className="seo-category" data-status={row.worst ?? 'pass'} data-category={row.category} data-count={row.findings}>
            <span className="seo-category-dot" aria-hidden="true" />
            <span className="seo-category-name">{SEO_CATEGORY_LABELS[row.category]}</span>
            {row.worst ? <span className="seo-category-state">{plural(row.findings, ['issue', 'issues'])}</span> : <span className="visually-hidden">passed</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One ranked issue: its heading row toggles the details. */
export function Issue({ finding }: { readonly finding: Finding }) {
  const [open, setOpen] = useState(false);
  const detailsId = `seo-issue-${finding.ruleId}`;
  const lead = finding.details.facts[0];
  return (
    <li className="seo-issue" data-testid="seo-issue" data-rule-id={finding.ruleId} data-severity={finding.severity} data-open={open}>
      <button type="button" className="seo-issue-head" data-testid="seo-issue-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
        <SeverityGlyph severity={finding.severity} />
        <span className="seo-issue-text">
          <span className="seo-issue-title">{finding.title}</span>
          <span className="seo-issue-meta">
            {SEO_CATEGORY_LABELS[finding.category]}
            {lead ? (
              <>
                {' · '}
                <PageText value={lead.value} className="seo-issue-lead" />
              </>
            ) : null}
          </span>
        </span>
        <ChevronIcon className="seo-chevron" />
      </button>
      {open ? (
        <div className="seo-issue-body" id={detailsId} data-testid="seo-issue-details">
          <p className="seo-issue-label">Why it matters</p>
          <p className="seo-issue-copy" data-testid="seo-issue-why">
            {finding.why}
          </p>
          <p className="seo-issue-label">How to fix</p>
          <p className="seo-issue-copy" data-testid="seo-issue-fix">
            {finding.fix}
          </p>
          {finding.details.facts.length > 0 ? (
            <dl className="seo-facts" data-testid="seo-issue-facts">
              {finding.details.facts.map((fact) => (
                <div className="seo-fact" key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    <PageText value={fact.value} lines={2} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {finding.details.samples.length > 0 ? (
            <ul className="seo-samples" data-testid="seo-issue-samples" aria-label="Examples">
              {finding.details.samples.map((sample, index) => (
                <li key={index}>
                  <PageText value={sample} className="seo-mono" />
                </li>
              ))}
              {finding.details.count !== undefined && finding.details.count > finding.details.samples.length ? (
                <li className="seo-samples-more">and {formatCount(finding.details.count - finding.details.samples.length)} more</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function Overview({ audit }: { readonly audit: SeoAudit }) {
  const [all, setAll] = useState(false);
  const band = SCORE_BANDS.find((b) => b.id === audit.band)!;
  const shown = all ? audit.findings : audit.findings.slice(0, OVERVIEW_TOP_ISSUES);
  const passed = SEO_RULE_SPECS.length - audit.findings.length;
  const blocking = audit.counts.error + audit.counts.warning;
  return (
    <div className="seo-overview" data-testid="seo-overview">
      <section className="seo-score-card">
        <ScoreRing score={audit.score} band={audit.band} />
        <div className="seo-score-text">
          <span className="seo-eyebrow">Health score</span>
          <span className="seo-band" data-band={audit.band} data-testid="seo-band" data-indexable={audit.indexable}>
            {audit.indexable ? band.label : NOT_INDEXABLE_LABEL}
          </span>
          {audit.indexable ? null : (
            <span className="seo-score-summary seo-not-indexable" data-testid="seo-not-indexable">
              <PageText value={audit.indexability.reasons.join(' · ')} lines={2} />
            </span>
          )}
          <span className="seo-score-summary">
            {blocking === 0 ? 'No errors or warnings' : `${plural(blocking, ['issue', 'issues'])} to fix`} · {plural(passed, ['check', 'checks'])} passed
          </span>
        </div>
      </section>
      {audit.page.partial ? (
        <p className="seo-partial" data-testid="seo-partial">
          This page is very large: frost read part of it before its time limit, so some lists are incomplete.
        </p>
      ) : null}
      <div className="seo-counts" role="list" aria-label="Issues by severity">
        {SEO_SEVERITIES.map((severity) => (
          <span key={severity} className="seo-count" role="listitem" data-severity={severity} data-testid={`seo-count-${severity}`} data-count={audit.counts[severity]}>
            <SeverityGlyph severity={severity} />
            <span className="seo-count-value">{formatCount(audit.counts[severity])}</span>
            <span className="seo-count-label">{audit.counts[severity] === 1 ? SEVERITY_LABEL[severity][0] : SEVERITY_LABEL[severity][1]}</span>
          </span>
        ))}
      </div>
      <section className="seo-issues">
        <header className="seo-section-head">
          <h3 className="seo-section-title">{audit.findings.length === 0 ? 'Issues' : 'Top issues'}</h3>
          {audit.findings.length > 0 ? <span className="seo-badge">{formatCount(audit.findings.length)}</span> : null}
        </header>
        {audit.findings.length === 0 ? (
          <div className="seo-all-clear" data-testid="seo-all-clear">
            <CheckCircleIcon />
            <span>Every on-page check passed.</span>
          </div>
        ) : (
          <ol className="seo-issue-list">
            {shown.map((finding) => (
              <Issue key={finding.ruleId} finding={finding} />
            ))}
          </ol>
        )}
        {audit.findings.length > OVERVIEW_TOP_ISSUES ? (
          <button type="button" className="seo-link-button" data-testid="seo-show-all" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${formatCount(audit.findings.length)} issues`}
          </button>
        ) : null}
      </section>
      <SearchPreview audit={audit} />
      <CategoryGrid audit={audit} />
    </div>
  );
}
