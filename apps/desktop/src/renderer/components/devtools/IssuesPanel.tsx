import { useMemo, useState } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
import { ISSUE_SORT_KEYS, type IssueSortKey } from '@app/specs/devtools.spec';
import { SEO_PANELS, type SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { panelForCategory, sortIssues } from '../../devtools-view';
import { ErrorGlyph, InfoGlyph, WarningGlyph } from '../../icons';

// The Issues tab (spec `devtools.feature.md`, Issues): every finding of the audit the sidebar shows,
// in one table sortable by severity, rule and category; a row opens the SEO sidebar on its panel.

const SORT_LABELS: Readonly<Record<IssueSortKey, string>> = { severity: 'Severity', rule: 'Rule', category: 'Category' };
const SEVERITY_LABELS: Readonly<Record<string, string>> = { error: 'Error', warning: 'Warning', info: 'Info' };

export function IssuesPanel({ audit, onOpenPanel }: { readonly audit: SeoAuditResponse | null; readonly onOpenPanel: (panel: SeoPanelId) => void }) {
  const [sort, setSort] = useState<{ readonly key: IssueSortKey; readonly ascending: boolean }>({ key: 'severity', ascending: true });
  const findings = audit?.status === 'ready' ? audit.audit.findings : [];
  const sorted = useMemo(() => sortIssues(findings, sort.key, sort.ascending), [findings, sort]);
  if (audit === null) return <p className="devtools-empty">Open a web page to see its issues.</p>;
  if (audit.status === 'pending') return <p className="devtools-empty">Auditing this page…</p>;
  if (audit.status !== 'ready') return <p className="devtools-empty">This page has no audit.</p>;
  if (findings.length === 0) return <p className="devtools-empty" data-testid="devtools-issues-none">No issues: every check passed.</p>;
  return (
    <div className="devtools-table-wrap devtools-issues" data-testid="devtools-issues">
      <table className="devtools-table devtools-issue-table">
        <thead>
          <tr>
            {ISSUE_SORT_KEYS.map((key) => (
              <th key={key} scope="col" aria-sort={sort.key === key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
                <button
                  type="button"
                  className="devtools-sort"
                  data-testid="devtools-issue-sort"
                  data-key={key}
                  onClick={() => setSort((was) => ({ key, ascending: was.key === key ? !was.ascending : true }))}
                >
                  {SORT_LABELS[key]}
                  {sort.key === key ? (sort.ascending ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
            <th scope="col">Issue</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((finding) => {
            const panel = panelForCategory(finding.category);
            const label = SEO_PANELS.find((p) => p.id === panel)?.label ?? panel;
            return (
              <tr key={finding.ruleId} className={`devtools-row devtools-severity-${finding.severity}`} data-testid="devtools-issue" data-rule={finding.ruleId} data-severity={finding.severity} data-panel={panel}>
                <td>
                  <span className="devtools-level">{finding.severity === 'error' ? <ErrorGlyph /> : finding.severity === 'warning' ? <WarningGlyph /> : <InfoGlyph />}</span> {SEVERITY_LABELS[finding.severity] ?? finding.severity}
                </td>
                <td>
                  <code>{finding.ruleId}</code>
                </td>
                <td>{finding.category}</td>
                <td>
                  <button type="button" className="devtools-link" data-testid="devtools-issue-open" title={`Open the ${label} panel`} onClick={() => onOpenPanel(panel)}>
                    {finding.title}
                  </button>
                </td>
                <td className="devtools-issue-details">
                  {finding.details.facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}
                  {finding.details.count !== undefined ? `${finding.details.facts.length > 0 ? ' · ' : ''}${finding.details.count} found` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
