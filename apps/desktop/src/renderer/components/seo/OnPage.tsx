import type { SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { DESCRIPTION_MAX_CHARS, DESCRIPTION_MIN_CHARS, TITLE_MAX_CHARS, TITLE_MIN_CHARS, type SeoCategory } from '@app/specs/seo-rules.spec';
import { formatCount, lengthIndicator } from '../../seo-view';
import { HighlightToggle } from './actions';
import { FactRow, LengthMeter, PageText, Section } from './parts';

// On-Page (spec `seo-sidebar.feature.md`, Sidebar): what search engines read from the page —
// title and description with their lengths, the URL and indexing tags, the heading outline, word
// count, and the link and image summaries. Everything is the audit's bounded snapshot facts.

/** `n issue(s)` for a section whose categories have findings; nothing when it is clean. */
function IssueBadge({ audit, categories }: { readonly audit: SeoAudit; readonly categories: readonly SeoCategory[] }) {
  const mine = audit.findings.filter((finding) => categories.includes(finding.category));
  if (mine.length === 0) return null;
  const worst = mine.some((f) => f.severity === 'error') ? 'error' : mine.some((f) => f.severity === 'warning') ? 'warning' : 'info';
  return (
    <span className="seo-badge" data-severity={worst}>
      {mine.length === 1 ? '1 issue' : `${mine.length} issues`}
    </span>
  );
}

function Measured({ label, value, total, min, max, testId }: { readonly label: string; readonly value: SeoAudit['page']['title']; readonly total: number; readonly min: number; readonly max: number; readonly testId: string }) {
  const text = value?.text ?? '';
  const indicator = lengthIndicator(value?.length ?? null, min, max);
  return (
    <div className="seo-measured" data-testid={testId}>
      <div className="seo-measured-head">
        <span className="seo-row-label">{label}</span>
        {total > 1 ? <span className="seo-chip">{formatCount(total)} found</span> : null}
      </div>
      {text === '' ? (
        <span className="seo-missing seo-measured-value" data-testid={`${testId}-value`} data-missing="true">
          {total === 0 ? 'Missing' : 'Empty'}
        </span>
      ) : (
        <PageText value={text} lines={3} className="seo-measured-value" testId={`${testId}-value`} />
      )}
      <LengthMeter length={value?.length ?? 0} min={min} max={max} indicator={indicator} testId={`${testId}-length`} />
    </div>
  );
}

function Stat({ label, value, testId, tone }: { readonly label: string; readonly value: number; readonly testId: string; readonly tone?: 'warn' }) {
  return (
    <div className="seo-stat" data-tone={tone && value > 0 ? tone : undefined}>
      <span className="seo-stat-value" data-testid={testId}>
        {formatCount(value)}
      </span>
      <span className="seo-stat-label">{label}</span>
    </div>
  );
}

export function OnPage({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const page = audit.page;
  const levels = [1, 2, 3, 4, 5, 6].map((level) => page.headings.filter((h) => h.level === level).length);
  return (
    <div className="seo-onpage" data-testid="seo-onpage">
      <Section title="Search appearance" badge={<IssueBadge audit={audit} categories={['title', 'meta-description']} />}>
        <Measured label="Title" value={page.title} total={page.titleTotal} min={TITLE_MIN_CHARS} max={TITLE_MAX_CHARS} testId="seo-fact-title" />
        <Measured label="Meta description" value={page.description} total={page.descriptionTotal} min={DESCRIPTION_MIN_CHARS} max={DESCRIPTION_MAX_CHARS} testId="seo-fact-description" />
      </Section>

      <Section title="URL and indexing" badge={<IssueBadge audit={audit} categories={['url', 'canonical', 'indexing', 'language', 'mobile']} />}>
        <dl className="seo-rows">
          <FactRow label="URL" value={page.url} testId="seo-fact-url" mono />
          <FactRow label="Canonical" value={page.canonical} testId="seo-fact-canonical" mono />
          <FactRow label="Meta robots" value={page.robots} testId="seo-fact-robots" />
          <FactRow label="Language" value={page.lang} testId="seo-fact-lang" />
          <FactRow label="Viewport" value={page.viewport} testId="seo-fact-viewport" />
        </dl>
      </Section>

      <Section title="Headings" badge={<IssueBadge audit={audit} categories={['headings']} />} testId="seo-headings-section">
        <div className="seo-heading-counts" aria-label="Headings by level">
          {levels.map((count, index) => (
            <span key={index} className="seo-heading-count" data-empty={count === 0}>
              <span className="seo-tag">H{index + 1}</span>
              {formatCount(count)}
            </span>
          ))}
        </div>
        {page.headings.length > 0 ? (
          <div className="seo-panel-tools">
            <HighlightToggle tab={tab} mode="headings" label="Highlight on page" testId="seo-highlight-headings" />
          </div>
        ) : null}
        {page.headings.length === 0 ? (
          <p className="seo-empty-line">No headings on this page.</p>
        ) : (
          <ol className="seo-outline" data-testid="seo-headings">
            {page.headings.map((heading, index) => (
              <li key={index} className={`seo-outline-item seo-outline-level-${heading.level}`} data-testid="seo-heading" data-level={heading.level}>
                <span className="seo-tag" data-level={heading.level}>
                  H{heading.level}
                </span>
                {heading.text === '' ? <span className="seo-missing">Empty heading</span> : <PageText value={heading.text} />}
              </li>
            ))}
          </ol>
        )}
        {page.headingTotal > page.headings.length ? <p className="seo-note">Showing the first {formatCount(page.headings.length)} of {formatCount(page.headingTotal)} headings.</p> : null}
      </Section>

      <Section title="Content" badge={<IssueBadge audit={audit} categories={['content']} />}>
        <div className="seo-stats seo-stats-1">
          <Stat label={page.textTruncated ? 'words (at least)' : 'words'} value={page.wordCount} testId="seo-fact-words" />
        </div>
      </Section>

      <Section title="Links" badge={<IssueBadge audit={audit} categories={['links']} />}>
        <div className="seo-stats">
          <Stat label="Internal" value={page.links.internal} testId="seo-links-internal" />
          <Stat label="External" value={page.links.external} testId="seo-links-external" />
          <Stat label="Nofollow" value={page.links.nofollow} testId="seo-links-nofollow" />
          <Stat label="Other" value={page.links.other} testId="seo-links-other" />
        </div>
        <p className="seo-note" data-testid="seo-links-total">
          {page.links.analysed < page.links.total
            ? `First ${formatCount(page.links.analysed)} of ${formatCount(page.links.total)} links analysed.`
            : `${formatCount(page.links.total)} ${page.links.total === 1 ? 'link' : 'links'} on the page.`}
        </p>
      </Section>

      <Section title="Images" badge={<IssueBadge audit={audit} categories={['images']} />}>
        <div className="seo-stats">
          <Stat label="Images" value={page.images.total} testId="seo-images-total" />
          <Stat label="Missing alt" value={page.images.missingAlt} testId="seo-images-missing-alt" tone="warn" />
        </div>
        {page.images.analysed < page.images.total ? <p className="seo-note">Alt text checked on the first {formatCount(page.images.analysed)} images.</p> : null}
      </Section>
    </div>
  );
}
