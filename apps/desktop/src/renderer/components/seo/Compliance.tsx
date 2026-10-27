import { useEffect, useState, type ReactNode } from 'react';
import type { A11yImpactGroup, AccessibilityReport, SecurityReport, SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import {
  A11Y_IMPACT_LABELS,
  A11Y_RUN_MESSAGES,
  A11Y_SCORED_IMPACTS,
  A11Y_TIMEOUT_MS,
  HEADER_STATE_LABELS,
  INSECURE_RESOURCE_LABELS,
  SECURITY_VERDICT_LABELS,
  type AccessibilityRunState,
  type SecurityVerdict,
} from '@app/specs/seo-compliance.spec';
import type { A11yViolation, InsecureResource } from '@app/specs/seo-snapshot.spec';
import { OpenTabIcon } from '../../icons';
import { actions } from '../../ipc';
import { a11yView, countLabel, elapsedSeconds, headersUnknownNote, headerTone, impactCounts, nodesShown, runButtonLabel, runProgress, securitySignals, securitySummary, type A11yView } from '../../compliance-view';
import type { Tone } from '../../indexability-view';
import { formatCount, openableUrl } from '../../seo-view';
import { Flash, PanelIssues, useFlash } from './actions';
import { A11yArt, AccessibilityIcon, ElementIcon, HeadersIcon, LocalHostIcon, MixedContentIcon, PlayIcon, ShieldCheckIcon, ShieldOffIcon, ShieldWarnIcon, StopwatchIcon } from './compliance-icons';
import { PageText } from './parts';

// Compliance (acceptance `seo-compliance.feature.md`, Panel): the page's security (a verdict card,
// the ranked security issues, the security headers as text, the mixed content list) and its
// accessibility check (run on request: progress, then the violations grouped by impact, each rule
// expandable to its elements). Every page- or server-derived value is React text (`PageText`); help
// URLs open only through "Open in new tab" (`browser.openBackgroundTab`, http(s) only).

const VERDICT_ICON: Readonly<Record<SecurityVerdict, typeof ShieldCheckIcon>> = { secure: ShieldCheckIcon, attention: ShieldWarnIcon, insecure: ShieldOffIcon, local: LocalHostIcon };

function Card({ title, icon, aside, children, testId }: { readonly title: string; readonly icon: ReactNode; readonly aside?: ReactNode; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <section className="seo-section seo-index-card" data-testid={testId}>
      <header className="seo-section-head">
        <h3 className="seo-section-title seo-index-title">
          <span className="seo-index-title-icon" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Pill({ tone, children, testId }: { readonly tone: Tone; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <span className="seo-pill" data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

// ---- Security ------------------------------------------------------------------------------------

function SecurityVerdictCard({ security }: { readonly security: SecurityReport }) {
  const Icon = VERDICT_ICON[security.verdict];
  return (
    <section className="seo-verdict seo-sec-verdict" data-testid="seo-security-verdict" data-verdict={security.verdict}>
      <div className="seo-verdict-head">
        <span className="seo-verdict-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="seo-verdict-text">
          <span className="seo-eyebrow">Security</span>
          <span className="seo-verdict-label" data-testid="seo-security-verdict-label">
            {SECURITY_VERDICT_LABELS[security.verdict]}
          </span>
        </span>
      </div>
      <p className="seo-verdict-summary">{securitySummary(security)}</p>
      <ul className="seo-signals" aria-label="Security signals">
        {securitySignals(security).map((signal) => (
          <li key={signal.id} className="seo-signal" data-signal={signal.id} data-tone={signal.tone} data-testid={`seo-security-signal-${signal.id}`}>
            <span className="seo-signal-dot" aria-hidden="true" />
            <span className="seo-signal-label">{signal.label}</span>
            <span className="seo-signal-value">{signal.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HeadersCard({ security }: { readonly security: SecurityReport }) {
  const note = headersUnknownNote(security);
  return (
    <Card title="Security headers" icon={<HeadersIcon />} testId="seo-security-headers">
      {note ? (
        <p className="seo-index-source" data-testid="seo-security-headers-unknown">
          {note}
        </p>
      ) : null}
      <ul className="seo-sec-headers">
        {security.headers.map((row) => (
          <li key={row.name} className="seo-sec-header" data-testid="seo-security-header" data-name={row.name} data-state={row.state}>
            <span className="seo-sec-header-name">{row.label}</span>
            <Pill tone={headerTone(row)} testId="seo-security-header-state">
              {row.fromMeta ? `${HEADER_STATE_LABELS[row.state]} (meta)` : HEADER_STATE_LABELS[row.state]}
            </Pill>
            {row.values.length > 0 ? (
              <span className="seo-sec-header-values">
                {row.values.map((value, index) => (
                  <PageText key={index} value={value} className="seo-mono" lines={3} testId="seo-security-header-value" />
                ))}
              </span>
            ) : null}
            {row.note ? (
              <span className="seo-sec-header-note" data-testid="seo-security-header-note">
                <PageText value={row.note} lines={2} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ResourceList({ resources, active }: { readonly resources: readonly InsecureResource[]; readonly active: boolean }) {
  return (
    <ul className="seo-mixed-list">
      {resources.map((resource, index) => (
        <li key={index} className="seo-mixed-row" data-testid="seo-mixed-row" data-kind={resource.kind} data-active={active}>
          <span className="seo-flag-chip" data-tone={active ? 'error' : 'warn'}>
            {INSECURE_RESOURCE_LABELS[resource.kind]}
          </span>
          <PageText value={resource.url} className="seo-mono" testId="seo-mixed-url" />
          <span className="seo-mixed-tag">&lt;{resource.tag}&gt;</span>
        </li>
      ))}
    </ul>
  );
}

function MixedCard({ security }: { readonly security: SecurityReport }) {
  const { mixed } = security;
  const listed = mixed.active.length + mixed.passive.length;
  const aside = security.https && listed > 0 ? <span className="seo-badge">{formatCount(mixed.total)}</span> : null;
  return (
    <Card title="Mixed content" icon={<MixedContentIcon />} testId="seo-mixed" aside={aside}>
      {!security.https ? (
        <p className="seo-empty-line seo-index-empty" data-testid="seo-mixed-na">
          Only an https page can have mixed content.
        </p>
      ) : listed === 0 ? (
        <p className="seo-empty-line seo-index-empty seo-all-clear-line" data-testid="seo-mixed-none">
          Every subresource the page asks for is https.
        </p>
      ) : (
        <>
          {mixed.active.length > 0 ? (
            <>
              <p className="seo-row-label seo-index-sub">Blocked by browsers (scripts, styles, frames)</p>
              <ResourceList resources={mixed.active} active />
            </>
          ) : null}
          {mixed.passive.length > 0 ? (
            <>
              <p className="seo-row-label seo-index-sub">Upgraded or blocked (images, media)</p>
              <ResourceList resources={mixed.passive} active={false} />
            </>
          ) : null}
          {mixed.total > listed ? <p className="seo-note">and {formatCount(mixed.total - listed)} more.</p> : null}
        </>
      )}
      {mixed.truncated ? <p className="seo-note">The page is very large: frost stopped looking after the first elements.</p> : null}
    </Card>
  );
}

// ---- Accessibility -------------------------------------------------------------------------------

/** Re-renders every quarter second while `on` (the running check's elapsed time); answers now. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function RunProgress({ startedAt }: { readonly startedAt: number }) {
  const now = useNow(true);
  const fill = Math.round(runProgress(startedAt, now) * 1000) / 10;
  return (
    <div className="seo-a11y-progress" data-testid="seo-a11y-progress" role="status" aria-live="polite">
      <svg className="seo-a11y-progress-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="seo-a11y-progress-track" x="0" y="0" width="100" height="4" rx="2" />
        <rect className="seo-a11y-progress-fill" x="0" y="0" width={Math.max(fill, 3)} height="4" rx="2" />
      </svg>
      <span className="seo-a11y-progress-text">
        {A11Y_RUN_MESSAGES.running} {elapsedSeconds(startedAt, now)} s of at most {A11Y_TIMEOUT_MS / 1_000} s
      </span>
    </div>
  );
}

function NodeList({ rule }: { readonly rule: A11yViolation }) {
  const [all, setAll] = useState(false);
  const { shown, hidden, beyond } = nodesShown(rule.nodes.length, rule.nodeTotal, all);
  return (
    <>
      <ol className="seo-a11y-nodes" aria-label="Affected elements">
        {rule.nodes.slice(0, shown).map((node, index) => (
          <li key={index} className="seo-a11y-node" data-testid="seo-a11y-node">
            <span className="seo-a11y-node-head">
              <ElementIcon className="seo-inline-icon" />
              <PageText value={node.selector || '(no selector)'} className="seo-mono seo-a11y-selector" testId="seo-a11y-selector" />
            </span>
            {node.summary ? <span className="seo-a11y-summary">{node.summary}</span> : null}
          </li>
        ))}
      </ol>
      {hidden > 0 || all ? (
        <button type="button" className="seo-link-button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${formatCount(rule.nodes.length)}`}
        </button>
      ) : null}
      {beyond > 0 ? <p className="seo-note">and {countLabel(beyond, 'more element', 'more elements')} on the page, not listed.</p> : null}
    </>
  );
}

function RuleRow({ rule, flash }: { readonly rule: A11yViolation; readonly flash: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = `seo-a11y-rule-${rule.id}`;
  const openable = rule.helpUrl !== '' && openableUrl(rule.helpUrl);
  return (
    <li className="seo-a11y-rule" data-testid="seo-a11y-rule" data-rule-id={rule.id} data-impact={rule.impact} data-open={open}>
      <button type="button" className="seo-a11y-rule-head" data-testid="seo-a11y-rule-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="seo-a11y-rule-text">
          <span className="seo-a11y-rule-help">
            <PageText value={rule.help || rule.id} lines={2} />
          </span>
          <span className="seo-a11y-rule-meta">
            <bdi className="seo-mono">{rule.id}</bdi> · {countLabel(rule.nodeTotal, 'element', 'elements')}
          </span>
        </span>
        <span className="seo-a11y-count" data-testid="seo-a11y-rule-count">
          {formatCount(rule.nodeTotal)}
        </span>
      </button>
      {open ? (
        <div className="seo-a11y-rule-body seo-issue-body" id={bodyId} data-testid="seo-a11y-rule-details">
          {rule.description ? <p className="seo-issue-copy">{rule.description}</p> : null}
          {rule.helpUrl !== '' ? (
            <div className="seo-a11y-help">
              <PageText value={rule.helpUrl} className="seo-mono" testId="seo-a11y-help-url" />
              <button
                type="button"
                className="seo-action"
                data-testid="seo-a11y-open-help"
                disabled={!openable}
                title={openable ? undefined : 'Only http and https addresses open in a tab'}
                onClick={() => void actions.openBackgroundTab(rule.helpUrl).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'))}
              >
                <OpenTabIcon />
                <span>Open in new tab</span>
              </button>
            </div>
          ) : null}
          <NodeList rule={rule} />
        </div>
      ) : null}
    </li>
  );
}

function ImpactGroup({ group, flash }: { readonly group: A11yImpactGroup; readonly flash: (message: string) => void }) {
  const scored = (A11Y_SCORED_IMPACTS as readonly string[]).includes(group.impact);
  return (
    <section className="seo-a11y-group" data-testid="seo-a11y-group" data-impact={group.impact}>
      <header className="seo-a11y-group-head">
        <span className="seo-a11y-impact" data-impact={group.impact}>
          {A11Y_IMPACT_LABELS[group.impact]}
        </span>
        <span className="seo-a11y-group-count">
          {countLabel(group.rules.length, 'rule', 'rules')} · {countLabel(group.nodeTotal, 'element', 'elements')}
        </span>
        {scored ? <span className="seo-a11y-scored">Scored</span> : null}
      </header>
      <ol className="seo-a11y-rules">
        {group.rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} flash={flash} />
        ))}
      </ol>
    </section>
  );
}

function Results({ report, flash }: { readonly report: Extract<AccessibilityReport, { status: 'done' }>; readonly flash: (message: string) => void }) {
  const counts = impactCounts(report);
  const groups = report.groups.filter((group) => group.rules.length > 0);
  return (
    <div className="seo-a11y-results" data-testid="seo-a11y-results">
      <ul className="seo-a11y-tally" aria-label="Violations by impact">
        {counts.map((count) => (
          <li key={count.impact} className="seo-a11y-tally-item" data-impact={count.impact} data-testid={`seo-a11y-count-${count.impact}`} data-count={count.rules}>
            <span className="seo-a11y-tally-value">{formatCount(count.rules)}</span>
            <span className="seo-a11y-tally-label">{A11Y_IMPACT_LABELS[count.impact]}</span>
          </li>
        ))}
      </ul>
      <p className="seo-note seo-a11y-totals" data-testid="seo-a11y-totals">
        {countLabel(report.passes, 'rule passed', 'rules passed')} · {countLabel(report.incomplete, 'needs', 'need')} a person to review · axe {report.axeVersion} · {formatCount(Math.round(report.durationMs))} ms
      </p>
      {groups.length === 0 ? (
        <p className="seo-empty-line seo-all-clear-line" data-testid="seo-a11y-clean">
          No violations of the checked rules. Automated checks find part of the problems; test with a keyboard and a screen reader too.
        </p>
      ) : (
        groups.map((group) => <ImpactGroup key={group.impact} group={group} flash={flash} />)
      )}
      {report.truncated ? <p className="seo-note">Showing {formatCount(groups.reduce((sum, g) => sum + g.rules.length, 0))} of {formatCount(report.violationTotal)} violated rules.</p> : null}
    </div>
  );
}

function AccessibilityCard({ tab, run, report, flash }: { readonly tab: TabState; readonly run: AccessibilityRunState; readonly report: AccessibilityReport; readonly flash: (message: string) => void }) {
  const view: A11yView = a11yView(run, report);
  const busy = view.kind === 'running' || view.kind === 'scoring';
  return (
    <Card title="Accessibility" icon={<AccessibilityIcon />} testId="seo-a11y">
      <div className="seo-a11y" data-testid="seo-a11y-state" data-state={view.kind}>
        {view.kind === 'idle' ? (
          <div className="seo-a11y-intro">
            <span className="seo-a11y-art" aria-hidden="true">
              <A11yArt />
            </span>
            <p className="seo-a11y-intro-text">{A11Y_RUN_MESSAGES.idle}</p>
          </div>
        ) : null}
        {view.kind === 'running' ? <RunProgress startedAt={view.startedAt} /> : null}
        {view.kind === 'scoring' ? (
          <p className="seo-note" role="status">
            {A11Y_RUN_MESSAGES.done}
          </p>
        ) : null}
        {view.kind === 'timed-out' ? (
          <p className="seo-a11y-problem" data-testid="seo-a11y-timed-out" role="status">
            <StopwatchIcon className="seo-inline-icon" />
            <span>{A11Y_RUN_MESSAGES['timed-out']}</span>
          </p>
        ) : null}
        {view.kind === 'failed' ? (
          <p className="seo-a11y-problem" data-testid="seo-a11y-failed" role="status">
            <span>{view.message}</span>
          </p>
        ) : null}
        {view.kind === 'invalid' ? (
          <p className="seo-a11y-problem" data-testid="seo-a11y-invalid" role="status">
            <span>The page returned accessibility results frost could not read safely.</span>
          </p>
        ) : null}
        <div className="seo-a11y-actions">
          <button type="button" className="panel-button panel-button-primary seo-a11y-run" data-testid="seo-a11y-run" data-running={busy} disabled={busy} onClick={() => void actions.runAccessibility(tab.id)}>
            <PlayIcon />
            <span>{runButtonLabel(view)}</span>
          </button>
          <span className="seo-a11y-hint">Critical and serious problems count toward the score once checked.</span>
        </div>
        {view.kind === 'results' ? <Results report={view.report} flash={flash} /> : null}
      </div>
    </Card>
  );
}

export function Compliance({ audit, tab, run }: { readonly audit: SeoAudit; readonly tab: TabState; readonly run: AccessibilityRunState }) {
  const [message, flash] = useFlash();
  const { security, accessibility } = audit.compliance;
  return (
    <div className="seo-index seo-compliance" data-testid="seo-compliance">
      <SecurityVerdictCard security={security} />
      <PanelIssues audit={audit} categories={['security']} clean="Every security check passed." testId="seo-security-issues" />
      <HeadersCard security={security} />
      <MixedCard security={security} />
      <AccessibilityCard tab={tab} run={run} report={accessibility} flash={flash} />
      <Flash message={message} testId="seo-compliance-flash" />
    </div>
  );
}
