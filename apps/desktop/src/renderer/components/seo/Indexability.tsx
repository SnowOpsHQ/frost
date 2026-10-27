import { useState, type ReactNode } from 'react';
import type { CanonicalReport, HreflangReport, HttpReport, IndexabilityReport, RobotsReport, SeoAudit } from '@app/seo-core';
import { HREFLANG_RECIPROCITY_CHECKED, INDEXABILITY_VERDICT_LABELS, ROBOTS_ALLOW_ALL_OUTCOMES, type IndexabilityVerdict, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { BlockedIcon, CanonicalIcon, CheckCircleIcon, CodeIcon, ExchangeIcon, GlobeIcon, HopIcon, OpenTabIcon, RobotIcon, SitemapIcon } from '../../icons';
import { actions } from '../../ipc';
import { hreflangFlags, robotsFetchText, robotsGroupText, robotsRuleText, robotsVerdictLabel, sourceNote, statusText, statusTone, verdictSignals, verdictSummary, type Tone } from '../../indexability-view';
import { formatCount, openableUrl } from '../../seo-view';
import { Flash, PanelIssues, useFlash } from './actions';
import { FactRow, PageText, RawText } from './parts';
// Phase 2.5 Task 7 (`seo-checks.feature.md`): the Sitemaps check and hreflang return links.
import type { TabState } from '@app/specs/browser.spec';
import { IDLE_HREFLANG_RUN, IDLE_SITEMAP_RUN } from '@app/specs/seo-checks.spec';
import { checksFor } from '../../checks-view';
import { useChecks } from '../../hooks/useChecks';
import { HreflangChecks, SitemapChecks } from './SitemapChecks';

// Indexability (acceptance `seo-indexability.feature.md`, Panel): the verdict with its reasons and
// signals, the ranked indexability / hreflang / robots meta issues, then the evidence: the HTTP
// response (status, redirects, the kept headers), the robots directives, the canonical, robots.txt
// (how the fetch went, each crawler's verdict with the deciding rule, the sitemaps, the file itself)
// and the hreflang set. Every server- or page-derived value is React text (`PageText`, `<pre>`); URLs
// open only through "Open" buttons (`browser.openBackgroundTab`, http(s) only).

/** The panel's categories (`SEO_PANELS`). */
const CATEGORIES = ['indexing', 'indexability', 'hreflang'] as const;
const ALLOW_ALL: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_ALLOW_ALL_OUTCOMES);
/** hreflang rows shown before "Show all". */
const HREFLANG_FIRST_ROWS = 25;

const VERDICT_ICON: Readonly<Record<IndexabilityVerdict, typeof CheckCircleIcon>> = { indexable: CheckCircleIcon, 'not-indexable': BlockedIcon, canonicalised: CanonicalIcon, pending: RobotIcon };

/** A titled card with an icon in its heading. */
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

/** "Open in new tab" for a URL from the audit: a button, enabled only for http(s). */
function OpenButton({ url, label, flash, testId }: { readonly url: string | null; readonly label: string; readonly flash: (message: string) => void; readonly testId: string }) {
  const openable = url !== null && openableUrl(url);
  return (
    <button
      type="button"
      className="seo-action"
      data-testid={testId}
      disabled={!openable}
      title={openable ? undefined : 'Only http and https addresses open in a tab'}
      onClick={() => {
        if (url !== null) void actions.openBackgroundTab(url).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'));
      }}
    >
      <OpenTabIcon />
      <span>{label}</span>
    </button>
  );
}

function VerdictCard({ report }: { readonly report: IndexabilityReport }) {
  const Icon = VERDICT_ICON[report.verdict];
  return (
    <section className="seo-verdict" data-testid="seo-index-verdict" data-verdict={report.verdict}>
      <div className="seo-verdict-head">
        <span className="seo-verdict-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="seo-verdict-text">
          <span className="seo-eyebrow">Verdict</span>
          <span className="seo-verdict-label" data-testid="seo-index-verdict-label">
            {INDEXABILITY_VERDICT_LABELS[report.verdict]}
          </span>
        </span>
      </div>
      <p className="seo-verdict-summary">{verdictSummary(report.verdict)}</p>
      {report.reasons.length > 0 ? (
        <ul className="seo-verdict-reasons" data-testid="seo-index-reasons">
          {report.reasons.map((reason, index) => (
            <li key={index} data-testid="seo-index-reason">
              <PageText value={reason} lines={2} />
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="seo-signals" aria-label="Signals">
        {verdictSignals(report).map((signal) => (
          <li key={signal.id} className="seo-signal" data-signal={signal.id} data-tone={signal.tone} data-testid={`seo-index-signal-${signal.id}`}>
            <span className="seo-signal-dot" aria-hidden="true" />
            <span className="seo-signal-label">{signal.label}</span>
            <span className="seo-signal-value">{signal.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HttpCard({ http }: { readonly http: HttpReport | null }) {
  if (!http) {
    return (
      <Card title="HTTP response" icon={<ExchangeIcon />} testId="seo-index-http">
        <p className="seo-empty-line" data-testid="seo-index-http-none">
          frost saw no response for this tab (it was opened before frost started listening). Reload the page to see it.
        </p>
      </Card>
    );
  }
  const note = sourceNote(http);
  const tone = statusTone(http.status);
  return (
    <Card title="HTTP response" icon={<ExchangeIcon />} testId="seo-index-http" aside={<Pill tone={tone} testId="seo-index-status">{statusText(http.status)}</Pill>}>
      <div className="seo-http" data-source={http.source} data-status={http.status ?? ''}>
        {http.redirects.length > 0 ? (
          <ol className="seo-chain" data-testid="seo-index-chain" aria-label="Redirect chain">
            {http.redirects.map((hop, index) => (
              <li key={index} className="seo-chain-hop" data-testid="seo-index-hop" data-internal={hop.internal}>
                <Pill tone={hop.internal ? 'muted' : 'warn'}>{hop.internal ? 'Internal' : hop.status}</Pill>
                <PageText value={hop.url} className="seo-mono" />
                <HopIcon className="seo-chain-arrow" />
              </li>
            ))}
            <li className="seo-chain-hop seo-chain-final" data-testid="seo-index-final">
              <Pill tone={tone}>{http.status ?? '?'}</Pill>
              <PageText value={http.url} className="seo-mono" />
            </li>
          </ol>
        ) : (
          <dl className="seo-rows">
            <FactRow label="URL" value={http.url} mono testId="seo-index-http-url" />
            <FactRow label="Redirects" value="None" />
          </dl>
        )}
        {http.redirectTotal > http.redirects.length ? <p className="seo-note">and {formatCount(http.redirectTotal - http.redirects.length)} more redirects before these.</p> : null}
        {note ? (
          <p className="seo-index-source" data-testid="seo-index-source" data-source={http.source}>
            {note}
          </p>
        ) : null}
        {http.headersAvailable ? (
          http.headers.length > 0 ? (
            <dl className="seo-headers" data-testid="seo-index-headers" aria-label="Response headers">
              {http.headers.map((header, index) => (
                <div key={index} className="seo-header" data-testid="seo-index-header" data-name={header.name}>
                  <dt>{header.name}</dt>
                  <dd>
                    <PageText value={header.value} className="seo-mono" lines={3} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="seo-empty-line">None of the headers frost reads were sent.</p>
          )
        ) : null}
      </div>
    </Card>
  );
}

function DirectivesCard({ report }: { readonly report: IndexabilityReport }) {
  const headers = report.http?.headersAvailable === true;
  return (
    <Card title="Robots directives" icon={<RobotIcon />} testId="seo-index-directives">
      <p className="seo-row-label seo-index-sub">Meta robots</p>
      {report.robotsMeta.length === 0 ? (
        <p className="seo-empty-line seo-index-empty" data-testid="seo-index-meta-none">
          No robots meta tag (crawlers index and follow by default).
        </p>
      ) : (
        <ul className="seo-directives" data-testid="seo-index-meta">
          {report.robotsMeta.map((meta, index) => (
            <li key={index} className="seo-directive">
              <span className="seo-tag seo-directive-agent">{meta.name}</span>
              <PageText value={meta.content || '(empty)'} className="seo-mono" />
            </li>
          ))}
        </ul>
      )}
      <p className="seo-row-label seo-index-sub">X-Robots-Tag header</p>
      {!headers ? (
        <p className="seo-empty-line seo-index-empty">Unknown: the response’s headers are not available.</p>
      ) : report.xRobotsTag.length === 0 ? (
        <p className="seo-empty-line seo-index-empty" data-testid="seo-index-xrobots-none">
          Not sent.
        </p>
      ) : (
        <ul className="seo-directives" data-testid="seo-index-xrobots">
          {report.xRobotsTag.map((tag, index) => (
            <li key={index} className="seo-directive">
              <span className="seo-tag seo-directive-agent">{tag.agent ?? 'all'}</span>
              <PageText value={tag.value || '(empty)'} className="seo-mono" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function canonicalState(canonical: CanonicalReport): { label: string; tone: Tone } {
  if (canonical.effective === null) return { label: 'None', tone: 'muted' };
  if (canonical.conflict) return { label: 'HTML and header disagree', tone: 'warn' };
  if (canonical.elsewhere) return { label: 'Points to another URL', tone: 'warn' };
  return { label: 'Points to this page', tone: 'ok' };
}

function CanonicalCard({ canonical }: { readonly canonical: CanonicalReport }) {
  const state = canonicalState(canonical);
  return (
    <Card title="Canonical" icon={<CanonicalIcon />} testId="seo-index-canonical" aside={<Pill tone={state.tone} testId="seo-index-canonical-state">{state.label}</Pill>}>
      <dl className="seo-rows">
        <FactRow label="<link> tag" value={canonical.html} mono testId="seo-index-canonical-html" />
        <FactRow label="Link header" value={canonical.header} mono testId="seo-index-canonical-header" />
      </dl>
    </Card>
  );
}

function RobotsCard({ robots, flash }: { readonly robots: RobotsReport | null; readonly flash: (message: string) => void }) {
  const [view, setView] = useState(false);
  if (!robots) {
    return (
      <Card title="robots.txt" icon={<RobotIcon />} testId="seo-index-robots">
        <p className="seo-empty-line">Not checked for this page.</p>
      </Card>
    );
  }
  if (robots.outcome === 'pending') {
    return (
      <Card title="robots.txt" icon={<RobotIcon />} testId="seo-index-robots" aside={<Pill tone="muted" testId="seo-index-robots-outcome">{robotsFetchText(robots)}</Pill>}>
        <div className="seo-robots" data-outcome="pending">
          <PageText value={robots.url} className="seo-mono seo-robots-url" testId="seo-index-robots-url" />
          <p className="seo-robots-pending" data-testid="seo-index-robots-pending" aria-busy="true">
            <span className="seo-robots-pending-dot" aria-hidden="true" />
            Fetching robots.txt… The other checks are ready; the verdict follows once it answers.
          </p>
        </div>
      </Card>
    );
  }
  const tone: Tone = robots.outcome === 'ok' ? 'ok' : ALLOW_ALL.has(robots.outcome) ? 'muted' : 'warn';
  return (
    <Card title="robots.txt" icon={<RobotIcon />} testId="seo-index-robots" aside={<Pill tone={tone} testId="seo-index-robots-outcome">{robotsFetchText(robots)}</Pill>}>
      <div className="seo-robots" data-outcome={robots.outcome}>
        <PageText value={robots.finalUrl ?? robots.url} className="seo-mono seo-robots-url" testId="seo-index-robots-url" />
        <ul className="seo-robots-agents" data-testid="seo-index-robots-agents">
          {robots.agents.map((verdict) => {
            const label = robotsVerdictLabel(verdict, robots.outcome);
            return (
              <li key={verdict.agent} className="seo-robots-agent" data-testid="seo-index-robots-agent" data-agent={verdict.agent} data-allowed={String(verdict.allowed)}>
                <span className="seo-robots-agent-name">{verdict.agent === '*' ? 'Other crawlers (*)' : verdict.agent}</span>
                <Pill tone={label.tone}>{label.label}</Pill>
                <PageText value={robotsRuleText(verdict, robots)} className="seo-mono seo-robots-rule" testId="seo-index-robots-rule" />
                <PageText value={robotsGroupText(verdict)} className="seo-robots-group" />
              </li>
            );
          })}
        </ul>
        <p className="seo-note seo-robots-path">
          Matched against <bdi className="seo-mono">{robots.path}</bdi>
        </p>
        <p className="seo-row-label seo-index-sub">
          <SitemapIcon className="seo-inline-icon" /> Sitemaps
        </p>
        {robots.sitemaps.length === 0 ? (
          <p className="seo-empty-line seo-index-empty" data-testid="seo-index-sitemaps-none">
            {robots.outcome === 'ok' ? 'No Sitemap line.' : 'None (no robots.txt to read).'}
          </p>
        ) : (
          <ul className="seo-sitemaps" data-testid="seo-index-sitemaps">
            {robots.sitemaps.map((sitemap, index) => (
              <li key={index} className="seo-sitemap" data-testid="seo-index-sitemap">
                <PageText value={sitemap.raw} className="seo-mono" />
                <OpenButton url={sitemap.url} label="Open" flash={flash} testId="seo-index-open-sitemap" />
              </li>
            ))}
          </ul>
        )}
        {robots.sitemapTotal > robots.sitemaps.length ? <p className="seo-note">Showing {formatCount(robots.sitemaps.length)} of {formatCount(robots.sitemapTotal)} sitemaps.</p> : null}
        <div className="seo-panel-tools seo-robots-tools">
          <OpenButton url={robots.finalUrl ?? robots.url} label="Open robots.txt" flash={flash} testId="seo-index-open-robots" />
          {robots.outcome === 'ok' ? (
            <button type="button" className="seo-toggle" data-testid="seo-index-view-robots" aria-pressed={view} aria-expanded={view} onClick={() => setView(!view)}>
              <CodeIcon />
              <span>View robots.txt</span>
            </button>
          ) : null}
        </div>
        {view && robots.outcome === 'ok' ? (
          <>
            {robots.text === '' ? (
              <p className="seo-empty-line">The file is empty.</p>
            ) : (
              <pre className="seo-raw seo-robots-text" data-testid="seo-index-robots-text">
                <RawText text={robots.text} />
              </pre>
            )}
            {robots.textCut || robots.truncated ? (
              <p className="seo-note" data-testid="seo-index-robots-cut">
                {robots.truncated ? 'The file is over 500 KiB (512,000 bytes): crawlers (and frost) ignore the rest. ' : ''}
                {robots.textCut ? `Showing the first ${formatCount(robots.text.length)} characters.` : ''}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

function HreflangCard({ hreflang, children }: { readonly hreflang: HreflangReport; readonly children?: ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? hreflang.entries : hreflang.entries.slice(0, HREFLANG_FIRST_ROWS);
  const aside = hreflang.entries.length > 0 ? <span className="seo-badge">{formatCount(hreflang.total)}</span> : null;
  return (
    <Card title="hreflang" icon={<GlobeIcon />} testId="seo-index-hreflang" aside={aside}>
      {hreflang.entries.length === 0 ? (
        <p className="seo-empty-line seo-index-empty" data-testid="seo-index-hreflang-none">
          No hreflang annotations (only needed when the page has versions in other languages or regions).
        </p>
      ) : (
        <>
          <div className="seo-hreflang-summary">
            <Pill tone={hreflang.hasSelf ? 'ok' : 'warn'}>{hreflang.hasSelf ? 'Lists itself' : 'Does not list itself'}</Pill>
            <Pill tone={hreflang.hasXDefault ? 'ok' : 'muted'}>{hreflang.hasXDefault ? 'x-default set' : 'No x-default'}</Pill>
          </div>
          <ul className="seo-hreflang" data-testid="seo-index-hreflang-rows">
            {shown.map((entry, index) => (
              <li key={index} className="seo-hreflang-row" data-testid="seo-index-hreflang-row" data-valid={entry.valid} data-value={entry.value}>
                <bdi className="seo-tag seo-hreflang-code" title={entry.value}>
                  {entry.value || '(empty)'}
                </bdi>
                <span className="seo-hreflang-body">
                  <PageText value={entry.resolved ?? entry.href} className="seo-mono" />
                  {hreflangFlags(entry).length > 0 ? (
                    <span className="seo-hreflang-flags">
                      {hreflangFlags(entry).map((flag) => (
                        <span key={flag.flag} className="seo-flag-chip" data-tone={flag.tone} data-flag={flag.flag} data-testid="seo-index-hreflang-flag">
                          {flag.label}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {hreflang.entries.length > HREFLANG_FIRST_ROWS ? (
            <button type="button" className="seo-link-button" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${formatCount(hreflang.entries.length)}`}
            </button>
          ) : null}
          {HREFLANG_RECIPROCITY_CHECKED ? children : <p className="seo-note">Return links (each alternate listing this page back) are not checked: that needs fetching every alternate.</p>}
        </>
      )}
    </Card>
  );
}

export function Indexability({ audit, tab }: { readonly audit: SeoAudit; readonly tab?: TabState }) {
  const [message, flash] = useFlash();
  const report = audit.indexability;
  const checks = checksFor(useChecks(tab?.id), tab?.id ?? 0);
  return (
    <div className="seo-index" data-testid="seo-indexability">
      <VerdictCard report={report} />
      <PanelIssues audit={audit} categories={CATEGORIES} clean="Every indexability check passed." testId="seo-index-issues" />
      <HttpCard http={report.http} />
      <DirectivesCard report={report} />
      <CanonicalCard canonical={report.canonical} />
      <RobotsCard robots={report.robots} flash={flash} />
      {tab ? <SitemapChecks tab={tab} run={checks?.sitemaps ?? IDLE_SITEMAP_RUN} /> : null}
      <HreflangCard hreflang={report.hreflang}>{tab ? <HreflangChecks tab={tab} run={checks?.hreflang ?? IDLE_HREFLANG_RUN} /> : null}</HreflangCard>
      <Flash message={message} testId="seo-index-flash" />
    </div>
  );
}
