import type { ReactNode } from 'react';
import { formatBytes, formatMs, formatVital, type Finding, type LargeResource, type NavigationReport, type SeoAudit, type SpeedReport, type VitalReading } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import {
  LAB_DATA_NOTE,
  SCORE_SOURCE_NOTE,
  SINCE_LOAD_LABEL,
  SOFT_NAVIGATION_NOTE,
  SPEED_SOURCE_LABELS,
  WAYLAND_PAINT_NOTE,
  RESOURCE_TYPE_LABELS,
  SIZE_UNAVAILABLE_LABEL,
  SIZE_UNAVAILABLE_NOTE,
  SPEED_LIVE_MAX_POLLS,
  SPEED_UNAVAILABLE_MESSAGES,
  VITAL_BAND_LABELS,
  VITAL_LABELS,
  VITAL_THRESHOLDS,
  type VitalBand,
} from '@app/specs/seo-speed.spec';
import { OpenTabIcon, ReloadIcon } from '../../icons';
import { actions } from '../../ipc';
import { useSpeed } from '../../hooks/useSpeed';
import { formatCount } from '../../seo-view';
import { agoText, barWidth, meterGeometry, missingVitalText, openableResource, PHASE_LABELS, shareText, shownSpeed, speedIssues, speedNotes, waterfall } from '../../speed-view';
import type { SpeedPollState } from '../../speed-poller';
import { Flash, useFlash } from './actions';
import { Issue } from './Overview';
import { PageText } from './parts';

// Page Speed (acceptance `seo-speed.feature.md`, Panel): the lab verdict and the live line, a card
// per metric (value, band, a threshold bar), the ranked `performance` issues, the navigation
// timing row, the requests by type, the largest requests, third parties and the DOM. Values come
// from main's live measurement while the panel is open (`useSpeed`), else from the one taken with
// the audit. Every bar is an SVG `<rect>` sized by attributes (no `style=`: strict CSP); every URL
// is React text, opened only through "Open" (`browser.openBackgroundTab`, http(s) only).

// ---- Icons (frost's own, 24×24, stroked; colour from styles.css) ------------------------------

function Icon({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A dial with its needle: the lab verdict. */
function GaugeIcon() {
  return (
    <Icon>
      <path d="M4.2 16.5a8.2 8.2 0 1 1 15.6 0" />
      <path d="M12 13.2l4-4.4" />
      <circle cx="12" cy="13.6" r="1.3" />
      <path d="M7.6 16.5h8.8" />
    </Icon>
  );
}

/** A heartbeat line: live updates. */
function PulseIcon() {
  return (
    <Icon>
      <path d="M3 12.5h4l2-5 3.4 10 2.4-6.5 1.4 1.5H21" />
    </Icon>
  );
}

/** Staggered bars on a time axis: navigation timing. */
function TimelineIcon() {
  return (
    <Icon>
      <path d="M4 5.5h5" />
      <path d="M7 10h7" />
      <path d="M11 14.5h6" />
      <path d="M15 19h5" />
      <path d="M3.5 3.5v17" />
    </Icon>
  );
}

/** Stacked layers: requests by type. */
function StackIcon() {
  return (
    <Icon>
      <path d="M12 4l8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16l8 4 8-4" />
    </Icon>
  );
}

/** A heavy box: the largest requests. */
function WeightIcon() {
  return (
    <Icon>
      <path d="M9.5 7.5a2.5 2.5 0 1 1 5 0" />
      <path d="M6.6 7.5h10.8l2.1 12H4.5z" />
      <path d="M10 13.5h4" />
    </Icon>
  );
}

/** Linked nodes on other hosts: third parties. */
function HostsIcon() {
  return (
    <Icon>
      <circle cx="6" cy="12" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M8.2 11l7.6-3.9" />
      <path d="M8.2 13l7.6 3.9" />
    </Icon>
  );
}

/** A branching tree: the DOM. */
function TreeIcon() {
  return (
    <Icon>
      <rect x="9.5" y="3" width="5" height="4" rx="1" />
      <rect x="3.5" y="17" width="5" height="4" rx="1" />
      <rect x="15.5" y="17" width="5" height="4" rx="1" />
      <path d="M12 7v5M6 17v-2.5a1.5 1.5 0 0 1 1.5-1.5h9a1.5 1.5 0 0 1 1.5 1.5V17" />
    </Icon>
  );
}

/** A finger tapping: interact to measure INP. */
function TapIcon() {
  return (
    <Icon>
      <path d="M9.5 11V5.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M12.5 9.5a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L5 15.6a1.4 1.4 0 0 1 2.1-1.9l2.4 2.3" />
      <path d="M6.5 4.5L5 3M15.5 4.5L17 3" />
    </Icon>
  );
}

/** A flask: lab data. */
function FlaskIcon() {
  return (
    <Icon>
      <path d="M9.5 3.5h5" />
      <path d="M10.5 3.5v5.2L5.2 18a1.8 1.8 0 0 0 1.6 2.6h10.4a1.8 1.8 0 0 0 1.6-2.6l-5.3-9.3V3.5" />
      <path d="M7.6 14.5h8.8" />
    </Icon>
  );
}

// ---- Parts -----------------------------------------------------------------------------------

function Card({ title, icon, aside, children, testId }: { readonly title: string; readonly icon: ReactNode; readonly aside?: ReactNode; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <section className="seo-section seo-speed-card" data-testid={testId}>
      <header className="seo-section-head">
        <h3 className="seo-section-title seo-speed-title">
          <span className="seo-speed-title-icon" aria-hidden="true">
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

const VERDICT_SUMMARY: Readonly<Record<VitalBand, string>> = {
  good: 'The Core Web Vitals measured on this visit are within the good thresholds.',
  'needs-improvement': 'At least one Core Web Vital measured on this visit needs improvement.',
  poor: 'At least one Core Web Vital measured on this visit is poor.',
};

/** The live line: updating, paused, waiting for the first answer, or why there is none. */
function LiveLine({ state, report, source, onResume }: { readonly state: SpeedPollState; readonly report: SpeedReport | null; readonly source: 'live' | 'audit' | null; readonly onResume: () => void }) {
  const response = state.response;
  let kind: 'live' | 'paused' | 'measuring' | 'unavailable' = 'measuring';
  let text = 'Measuring…';
  if (response?.status === 'unavailable') {
    kind = 'unavailable';
    text = SPEED_UNAVAILABLE_MESSAGES[response.reason];
  } else if (source === 'live' && report) {
    kind = state.paused ? 'paused' : 'live';
    text = state.paused ? `Paused after ${formatCount(SPEED_LIVE_MAX_POLLS)} updates · last ${agoText(report.measuredAt, Date.now())}` : `Live · updated ${agoText(report.measuredAt, Date.now())}`;
  } else if (state.paused) {
    kind = 'paused';
    text = 'Paused';
  }
  return (
    <div className="seo-speed-live" data-testid="seo-speed-live" data-state={kind} data-polls={state.polls}>
      <span className="seo-speed-live-dot" aria-hidden="true" />
      <span className="seo-speed-live-text">{text}</span>
      {state.paused ? (
        <button type="button" className="seo-speed-resume" data-testid="seo-speed-resume" onClick={onResume}>
          Resume
        </button>
      ) : null}
    </div>
  );
}

function VerdictCard({ report, state, source, onResume, onRemeasure }: { readonly report: SpeedReport | null; readonly state: SpeedPollState; readonly source: 'live' | 'audit' | null; readonly onResume: () => void; readonly onRemeasure: () => void }) {
  const band = report?.verdict ?? null;
  return (
    <section className="seo-speed-verdict" data-testid="seo-speed-verdict" data-band={band ?? 'none'}>
      <div className="seo-speed-verdict-head">
        <span className="seo-speed-verdict-icon" aria-hidden="true">
          <GaugeIcon />
        </span>
        <span className="seo-speed-verdict-text">
          <span className="seo-eyebrow">Lab verdict</span>
          <span className="seo-speed-verdict-label" data-testid="seo-speed-verdict-label">
            {band ? VITAL_BAND_LABELS[band] : report ? 'Not enough data yet' : 'Not measured yet'}
          </span>
        </span>
        <button type="button" className="seo-action seo-speed-remeasure" data-testid="seo-speed-remeasure" title="Reload the page and measure it again" onClick={onRemeasure}>
          <ReloadIcon />
          <span>Re-measure</span>
        </button>
      </div>
      <p className="seo-speed-verdict-summary">{band ? VERDICT_SUMMARY[band] : 'LCP and CLS appear once the page has painted; INP once you interact with it.'}</p>
      <LiveLine state={state} report={report} source={source} onResume={onResume} />
      {report && report.paintUnavailable ? (
        <p className="seo-speed-warning" data-testid="seo-speed-wayland">
          {WAYLAND_PAINT_NOTE}
        </p>
      ) : null}
      <p className="seo-speed-lab" data-testid="seo-speed-lab-note">
        <FlaskIcon />
        <span>{LAB_DATA_NOTE}</span>
      </p>
    </section>
  );
}

function MetricCard({ reading, report }: { readonly reading: VitalReading; readonly report: SpeedReport }) {
  const label = VITAL_LABELS[reading.metric];
  const { good, poor } = VITAL_THRESHOLDS[reading.metric];
  const geometry = meterGeometry(reading.metric, reading.value);
  const missing = missingVitalText(reading, report);
  return (
    <li className="seo-speed-metric" data-testid="seo-speed-metric" data-metric={reading.metric} data-band={reading.band ?? 'none'} data-value={reading.value ?? ''} title={`${label.name}: good ≤ ${formatVital(reading.metric, good)}, poor > ${formatVital(reading.metric, poor)}`}>
      <span className="seo-speed-metric-head">
        <span className="seo-speed-metric-short">{label.short}</span>
        {reading.band ? <span className="seo-speed-metric-band">{VITAL_BAND_LABELS[reading.band]}</span> : null}
      </span>
      {reading.value !== null ? (
        <span className="seo-speed-metric-value" data-testid="seo-speed-metric-value">
          {formatVital(reading.metric, reading.value)}
        </span>
      ) : (
        <span className="seo-speed-metric-hint" data-testid="seo-speed-metric-hint">
          {reading.metric === 'inp' ? <TapIcon /> : null}
          <span>{missing}</span>
        </span>
      )}
      <svg className="seo-speed-meter" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="seo-speed-zone" data-zone="good" x="0" y="2" width={geometry.good} height="4" />
        <rect className="seo-speed-zone" data-zone="needs-improvement" x={geometry.good} y="2" width={geometry.poor - geometry.good} height="4" />
        <rect className="seo-speed-zone" data-zone="poor" x={geometry.poor} y="2" width={100 - geometry.poor} height="4" />
        {geometry.marker !== null ? <rect className="seo-speed-marker" data-testid="seo-speed-marker" x={Math.max(0, Math.min(98.6, geometry.marker - 0.7))} y="0" width="1.4" height="8" /> : null}
      </svg>
      <span className="seo-speed-metric-name">{label.name}</span>
    </li>
  );
}

function Issues({ findings, source }: { readonly findings: readonly Finding[]; readonly source: 'live' | 'audit' | null }) {
  return (
    <section className="seo-issues" data-testid="seo-speed-issues">
      <header className="seo-section-head">
        <h3 className="seo-section-title">Issues</h3>
        {source ? (
          <span className="seo-speed-source" data-testid="seo-speed-source" data-source={source} title={SCORE_SOURCE_NOTE}>
            {SPEED_SOURCE_LABELS[source]}
          </span>
        ) : null}
        {findings.length > 0 ? <span className="seo-badge">{formatCount(findings.length)}</span> : null}
      </header>
      {findings.length === 0 ? (
        <p className="seo-empty-line seo-all-clear-line">No speed issues on this visit.</p>
      ) : (
        <ol className="seo-issue-list">
          {findings.map((finding) => (
            <Issue key={finding.ruleId} finding={finding} />
          ))}
        </ol>
      )}
      {source === 'live' ? <p className="seo-note">{SCORE_SOURCE_NOTE}</p> : null}
    </section>
  );
}

function NavigationCard({ nav }: { readonly nav: NavigationReport | null }) {
  if (!nav) {
    return (
      <Card title="Navigation timing" icon={<TimelineIcon />} testId="seo-speed-navigation">
        <p className="seo-empty-line">This document has no navigation timing.</p>
      </Card>
    );
  }
  const row = waterfall(nav);
  return (
    <Card title="Navigation timing" icon={<TimelineIcon />} testId="seo-speed-navigation" aside={<span className="seo-badge">{formatMs(row.end)}</span>}>
      <svg className="seo-speed-waterfall" data-testid="seo-speed-waterfall" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="The page’s request, phase by phase, to the load event">
        <rect className="seo-speed-waterfall-track" x="0" y="5" width="100" height="6" />
        {row.bars.map((bar) => (
          <rect key={bar.phase} className="seo-speed-phase" data-phase={bar.phase} data-testid="seo-speed-phase" x={bar.x} y="4" width={bar.width} height="8" />
        ))}
        {row.markers.map((mark) => (
          <rect key={mark.id} className="seo-speed-mark" data-mark={mark.id} x={Math.max(0, Math.min(99.6, mark.x - 0.2))} y="0" width="0.4" height="16" />
        ))}
      </svg>
      <ul className="seo-speed-phases">
        {nav.spans.map((span) => (
          <li key={span.phase} className="seo-speed-phase-item" data-phase={span.phase}>
            <span className="seo-speed-swatch" aria-hidden="true" />
            <span className="seo-speed-phase-label">{PHASE_LABELS[span.phase]}</span>
            <span className="seo-speed-num">{formatMs(span.end - span.start)}</span>
          </li>
        ))}
      </ul>
      <dl className="seo-speed-milestones">
        <div>
          <dt>TTFB</dt>
          <dd data-testid="seo-speed-ttfb">{formatMs(nav.ttfb)}</dd>
        </div>
        <div data-mark="dcl">
          <dt title="DOMContentLoaded">DOM ready</dt>
          <dd>{nav.domContentLoaded === null ? 'Not yet' : formatMs(nav.domContentLoaded)}</dd>
        </div>
        <div data-mark="load">
          <dt>Load</dt>
          <dd data-testid="seo-speed-load">{nav.load === null ? 'Not yet' : formatMs(nav.load)}</dd>
        </div>
      </dl>
      {nav.redirectCount > 0 ? <p className="seo-note">{formatCount(nav.redirectCount)} redirect{nav.redirectCount === 1 ? '' : 's'} before the page.</p> : null}
    </Card>
  );
}

function ResourcesCard({ report }: { readonly report: SpeedReport }) {
  const max = Math.max(1, ...report.byType.map((b) => b.weight));
  const { requests } = report;
  return (
    <Card title="Requests" icon={<StackIcon />} testId="seo-speed-resources" aside={<span className="seo-badge" data-testid="seo-speed-requests" data-total={requests.total}>{formatCount(requests.total)}</span>}>
      <dl className="seo-speed-totals">
        <div>
          <dt>Page weight</dt>
          <dd data-testid="seo-speed-weight" data-bytes={requests.weight}>
            {formatBytes(requests.weight)}
          </dd>
        </div>
        <div>
          <dt>Transferred</dt>
          <dd>{formatBytes(requests.transfer)}</dd>
        </div>
        <div>
          <dt>Decoded</dt>
          <dd>{formatBytes(requests.decoded)}</dd>
        </div>
      </dl>
      <ul className="seo-speed-types" data-testid="seo-speed-breakdown">
        {report.byType.map((type) => (
          <li key={type.type} className="seo-speed-type" data-testid="seo-speed-type" data-type={type.type} data-requests={type.requests} data-bytes={type.weight} data-empty={type.requests === 0}>
            <span className="seo-speed-type-label">{RESOURCE_TYPE_LABELS[type.type]}</span>
            <svg className="seo-speed-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <rect className="seo-speed-bar-track" x="0" y="0" width="100" height="6" />
              <rect className="seo-speed-bar-fill" data-type={type.type} x="0" y="0" width={barWidth(type.weight, max)} height="6" />
            </svg>
            <span className="seo-speed-num">{formatCount(type.requests)}</span>
            <span className="seo-speed-num seo-speed-bytes">{type.requests > 0 && type.weight === 0 && type.unavailable === type.requests ? SIZE_UNAVAILABLE_LABEL : formatBytes(type.weight)}</span>
          </li>
        ))}
      </ul>
      {requests.unavailable > 0 ? (
        <p className="seo-note" data-testid="seo-speed-unavailable">
          {formatCount(requests.unavailable)} {requests.unavailable === 1 ? 'request has' : 'requests have'} no size: {SIZE_UNAVAILABLE_NOTE}
        </p>
      ) : null}
      {requests.cached > 0 ? <p className="seo-note">{formatCount(requests.cached)} came from the cache (counted at their encoded size).</p> : null}
      {requests.notItemised > 0 ? <p className="seo-note">{formatCount(requests.notItemised)} more requests are counted in the totals but not itemised.</p> : null}
      {speedNotes(report)
        .filter((note) => note.id !== 'wayland' && note.id !== 'soft-navigation')
        .map((note) => (
          <p key={note.id} className="seo-note" data-testid={`seo-speed-note-${note.id}`}>
            {note.text}
          </p>
        ))}
    </Card>
  );
}

function LargeRow({ resource, flash }: { readonly resource: LargeResource; readonly flash: (message: string) => void }) {
  const openable = openableResource(resource.url, resource.urlCut);
  return (
    <li className="seo-speed-large" data-testid="seo-speed-large" data-type={resource.type} data-bytes={resource.weight}>
      <span className="seo-speed-large-main">
        <PageText value={resource.url} className="seo-mono seo-speed-large-url" />
        <span className="seo-speed-large-meta">
          <span className="seo-tag">{RESOURCE_TYPE_LABELS[resource.type]}</span>
          <span className="seo-speed-num">{formatBytes(resource.weight)}</span>
          <span className="seo-speed-num">{formatMs(resource.duration)}</span>
          {resource.cached ? <span className="seo-speed-flag">cached</span> : null}
          {resource.thirdParty ? <span className="seo-speed-flag" data-party="third">3rd party</span> : null}
        </span>
      </span>
      <button
        type="button"
        className="tool seo-speed-open"
        data-testid="seo-speed-open"
        disabled={!openable}
        aria-label="Open in new tab"
        title={openable ? 'Open in new tab' : 'Only complete http and https addresses open in a tab'}
        onClick={() => void actions.openBackgroundTab(resource.url).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'))}
      >
        <OpenTabIcon />
      </button>
    </li>
  );
}

function LargestCard({ report, flash }: { readonly report: SpeedReport; readonly flash: (message: string) => void }) {
  return (
    <Card title="Largest requests" icon={<WeightIcon />} testId="seo-speed-largest">
      {report.largest.length === 0 ? (
        <p className="seo-empty-line">No request reported a size.</p>
      ) : (
        <ol className="seo-speed-large-list">
          {report.largest.map((resource, index) => (
            <LargeRow key={index} resource={resource} flash={flash} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function ThirdPartyCard({ report }: { readonly report: SpeedReport }) {
  const { thirdParty, requests } = report;
  return (
    <Card title="Hosts" icon={<HostsIcon />} testId="seo-speed-third-party" aside={<span className="seo-badge">{formatCount(thirdParty.hostTotal)}</span>}>
      <p className="seo-speed-share" data-testid="seo-speed-third-share">
        Third parties: <strong>{shareText(thirdParty.requests, requests.itemised)}</strong> of requests, <strong>{shareText(thirdParty.weight, requests.weight)}</strong> of bytes
      </p>
      <ul className="seo-speed-hosts">
        {thirdParty.hosts.map((host) => (
          <li key={host.host} className="seo-speed-host" data-testid="seo-speed-host" data-third-party={host.thirdParty}>
            <PageText value={host.host || '(no host)'} className="seo-mono" />
            <span className="seo-speed-flag" data-party={host.thirdParty ? 'third' : 'first'}>
              {host.thirdParty ? '3rd party' : '1st party'}
            </span>
            <span className="seo-speed-num">{formatCount(host.requests)}</span>
            <span className="seo-speed-num seo-speed-bytes">{formatBytes(host.weight)}</span>
          </li>
        ))}
      </ul>
      {thirdParty.hostTotal > thirdParty.hosts.length ? <p className="seo-note">and {formatCount(thirdParty.hostTotal - thirdParty.hosts.length)} more hosts.</p> : null}
    </Card>
  );
}

function DomCard({ report }: { readonly report: SpeedReport }) {
  return (
    <Card title="DOM" icon={<TreeIcon />} testId="seo-speed-dom">
      <dl className="seo-speed-totals">
        <div>
          <dt>Elements</dt>
          <dd data-testid="seo-speed-dom-elements">{formatCount(report.dom.elements)}</dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>
            {formatCount(report.dom.depth)}
            {report.dom.depthComplete ? '' : '+'}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

export function Speed({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const { state, resume, restart } = useSpeed(tab);
  const [message, flash] = useFlash();
  const { report, source } = shownSpeed(tab.url, state.response, audit);
  const remeasure = () => {
    void actions.reload();
    restart();
  };
  return (
    <div className="seo-speed" data-testid="seo-speed" data-source={source ?? 'none'}>
      <VerdictCard report={report} state={state} source={source} onResume={resume} onRemeasure={remeasure} />
      {report ? (
        <>
          <header className="seo-speed-since">
            <span className="seo-eyebrow" data-testid="seo-speed-since">
              {SINCE_LOAD_LABEL}
            </span>
          </header>
          {report.softNavigation ? (
            <p className="seo-note seo-speed-soft" data-testid="seo-speed-note-soft-navigation">
              {SOFT_NAVIGATION_NOTE}
            </p>
          ) : null}
          <ul className="seo-speed-metrics" data-testid="seo-speed-metrics">
            {report.vitals.map((reading) => (
              <MetricCard key={reading.metric} reading={reading} report={report} />
            ))}
          </ul>
          <Issues findings={speedIssues(report, audit)} source={source} />
          <NavigationCard nav={report.navigation} />
          <ResourcesCard report={report} />
          <LargestCard report={report} flash={flash} />
          <ThirdPartyCard report={report} />
          <DomCard report={report} />
        </>
      ) : (
        <Issues findings={speedIssues(null, audit)} source={null} />
      )}
      <Flash message={message} testId="seo-speed-flash" />
    </div>
  );
}
