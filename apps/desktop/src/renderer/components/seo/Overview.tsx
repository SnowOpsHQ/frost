import { useState } from 'react';
import type { Finding, SeoAudit } from '@app/seo-core';
import { AI_READINESS_COPY } from '@app/specs/ai-readiness.spec';
import type { TabState } from '@app/specs/browser.spec';
import { PAGE_TYPE_COPY } from '@app/specs/page-type.spec';
import { NOT_INDEXABLE_LABEL, SCORE_BANDS, SEO_CATEGORIES, SEO_CATEGORY_LABELS, SEO_RULE_SPECS, SEO_SEVERITIES, type SeoCategory } from '@app/specs/seo-rules.spec';
import { OVERVIEW_TOP_ISSUES, type SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { aiTileView } from '../../ai-readiness-view';
import { usePageIntent } from '../../hooks/usePageIntent';
import { useProbes } from '../../hooks/useSerp';
import { CheckCircleIcon, ChevronIcon } from '../../icons';
import { intentNote, pageTypeView } from '../../page-type-view';
import { intentChip } from '../../serp-view';
import { formatCount } from '../../seo-view';
import { HighlightToggle } from './actions';
import { AiChecksCard } from './AiChecksCard';
import { AiScoreSummary } from './AiReadiness';
import { PageText, Section, SEVERITY_LABEL, SeverityGlyph } from './parts';

// Overview (spec `seo-sidebar.feature.md`, Sidebar): the health score ring with its band, the
// counts by severity, and the ranked issues, each expandable to why it matters, how to fix it and
// the offending values. Phase 9 Task 8 adds the AI-readiness tile (`ai-readiness.feature.md`: the
// score of the Visibility panel's section, and a button that opens it) and the "Page" card
// (`page-type.feature.md`: the page type worked out on this device, and the target query's intent).
// Task 11 adds the "AI judgment" card under it (`ai-checks.feature.md`, UI; one line while AI checks are off).

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

/** The AI-readiness score as a tile: the Visibility panel's ring and basis, and the way there. */
function AiReadinessTile({ audit, tab, onOpenPanel }: { readonly audit: SeoAudit; readonly tab: TabState; readonly onOpenPanel: (panel: SeoPanelId) => void }) {
  const probes = useProbes(tab.id);
  return (
    <section className="seo-section ai-tile" data-testid="ai-readiness-tile" aria-label={AI_READINESS_COPY.tileTitle}>
      <AiScoreSummary ring={aiTileView(audit, probes)} eyebrow={AI_READINESS_COPY.tileTitle} />
      <button type="button" className="seo-link-button ai-tile-open" data-testid="ai-readiness-open" onClick={() => onOpenPanel('visibility')}>
        {AI_READINESS_COPY.openLabel}
      </button>
    </section>
  );
}

/** The target query's intent, classified on this device only when one is set and intent is ready. */
function PageIntentRow({ url, notesGeneration }: { readonly url: string; readonly notesGeneration?: number }) {
  const { target, intentState, answer } = usePageIntent(url, notesGeneration);
  const chip = intentChip(answer);
  const note = intentNote(target, intentState);
  if (target === null) return null;
  return (
    <div className="page-intent" data-testid="page-intent" data-state={chip.kind === 'ready' ? 'ready' : (intentState ?? 'unknown')}>
      <span className="seo-eyebrow">{PAGE_TYPE_COPY.intentLabel}</span>
      {chip.kind === 'ready' ? (
        <p className="page-intent-row serp-intent">
          <span className="serp-intent-chip" data-testid="page-intent-label" title={chip.definition}>
            {chip.label}
          </span>
          <span className="serp-intent-confidence">
            <span className="visually-hidden">Confidence </span>
            {chip.confidence}
          </span>
          <PageText value={target} className="serp-intent-query" />
        </p>
      ) : note ? (
        <p className="seo-note">{note}</p>
      ) : null}
    </div>
  );
}

/** The "Page" card: what kind of page this is, how sure frost is, and the signals that decided. */
function PageCard({ audit, notesGeneration }: { readonly audit: SeoAudit; readonly notesGeneration?: number }) {
  const view = pageTypeView(audit.pageType);
  return (
    <Section title={PAGE_TYPE_COPY.title} testId="page-card">
      <div className="page-type-head">
        <span className="page-type-label" data-testid="page-type" data-type={audit.pageType.type}>
          {view.label}
        </span>
        <span className="page-type-confidence" data-testid="page-type-confidence" data-confidence={view.confidence}>
          {view.confidenceLabel}
        </span>
      </div>
      {view.note ? (
        <p className="seo-note" data-testid="page-type-note">
          {view.note}
        </p>
      ) : null}
      {view.signals.length > 0 ? (
        <ul className="page-type-signals" aria-label={PAGE_TYPE_COPY.signalsLabel}>
          {view.signals.map((signal) => (
            <li key={signal.signal} className="page-type-signal" data-testid="page-type-signal" data-signal={signal.signal} data-agrees={signal.agrees}>
              <span className="page-type-signal-label">{signal.label}</span>
              <span className="page-type-signal-type">{signal.type}</span>
              <span className="seo-mono">{signal.evidence}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="seo-note">{PAGE_TYPE_COPY.note}</p>
      <PageIntentRow url={audit.url} notesGeneration={notesGeneration} />
    </Section>
  );
}

export function Overview({
  audit,
  tab,
  onOpenPanel,
  notesGeneration,
}: {
  readonly audit: SeoAudit;
  readonly tab: TabState;
  /** Opens another panel of the sidebar (the AI-readiness tile opens Visibility). */
  readonly onOpenPanel: (panel: SeoPanelId) => void;
  /** Main's content notes generation (`BrowserState.contentNotesGeneration`), for the target query. */
  readonly notesGeneration?: number;
}) {
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
      <AiReadinessTile audit={audit} tab={tab} onOpenPanel={onOpenPanel} />
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
      {/* Links, headings and lazy images outlined on the page at once (Phase 11, `all`). */}
      <div className="seo-panel-tools">
        <HighlightToggle tab={tab} mode="all" label="Highlight everything" testId="seo-highlight-all" />
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
      <PageCard audit={audit} notesGeneration={notesGeneration} />
      <AiChecksCard audit={audit} tab={tab} />
      <SearchPreview audit={audit} />
      <CategoryGrid audit={audit} />
    </div>
  );
}
