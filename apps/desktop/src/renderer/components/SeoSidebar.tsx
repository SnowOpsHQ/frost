import { useEffect, useRef, useState } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { IDLE_A11Y_RUN } from '@app/specs/seo-compliance.spec';
import { COMING_SOON_LABEL, DEFAULT_SEO_PANEL, SEO_PANELS, SEO_UNAVAILABLE_MESSAGES, type SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { AuditArt, ChevronIcon, ComplianceIcon, ImagesIcon, IndexabilityIcon, LinksIcon, OnPageIcon, OverviewIcon, ReloadIcon, SchemaIcon, SocialIcon, SpeedIcon } from '../icons';
import { actions } from '../ipc';
import type { PanelJump } from '../palette/registry';
import { highlightToClear, isolatedTooltip, railStatuses } from '../seo-view';
import { hostOf } from '../security';
import { Compliance } from './seo/Compliance';
import { Content } from './seo/Content';
import { ContentIcon } from './seo/content-icons';
import { Images } from './seo/Images';
import { Indexability } from './seo/Indexability';
import { Links } from './seo/Links';
import { OnPage } from './seo/OnPage';
import { AuditProfileNote } from './seo/AuditProfileNote';
import { Overview } from './seo/Overview';
import { Schema } from './seo/Schema';
import { Social } from './seo/Social';
import { Speed } from './seo/Speed';

// The SEO sidebar (spec `seo-sidebar.spec.ts`; acceptance `seo-sidebar.feature.md`, Sidebar): docked
// right of the page area, the open panel and then the persistent rail at the window's edge. The
// audit lives in main (`seo.getAudit`); this renders it. Styling is the bundled styles.css only
// (strict CSP); page-derived text is React text only (`seo/parts.tsx`).

/** Reasons a fresh run may fix (the page was slow or answered garbage); the others need the page itself to change. */
const RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'invalid-snapshot', 'extraction-failed', 'analysis-timeout', 'analysis-failed']);

/** Whether the audit can be run again now (a page is shown and no run is pending). */
function canRerun(response: SeoAuditResponse | null): boolean {
  return response !== null && (response.status === 'ready' || (response.status === 'unavailable' && RETRYABLE.has(response.reason)));
}

const PANEL_ICONS: Readonly<Record<SeoPanelId, typeof OverviewIcon>> = {
  overview: OverviewIcon,
  'on-page': OnPageIcon,
  content: ContentIcon,
  links: LinksIcon,
  images: ImagesIcon,
  social: SocialIcon,
  schema: SchemaIcon,
  indexability: IndexabilityIcon,
  speed: SpeedIcon,
  compliance: ComplianceIcon,
};

function Rail({
  open,
  panel,
  response,
  onSelect,
  itemRefs,
}: {
  readonly open: boolean;
  readonly panel: SeoPanelId;
  readonly response: SeoAuditResponse | null;
  readonly onSelect: (panel: SeoPanelId) => void;
  readonly itemRefs: Map<SeoPanelId, HTMLButtonElement>;
}) {
  const statuses = railStatuses(response);
  return (
    <nav className="seo-rail" aria-label="SEO panels" data-testid="seo-rail">
      {SEO_PANELS.map((item) => {
        const Icon = PANEL_ICONS[item.id];
        const status = statuses[item.id];
        const selected = open && item.available && item.id === panel;
        const label = item.available ? item.label : `${item.label} · ${COMING_SOON_LABEL}`;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.set(item.id, el);
              else itemRefs.delete(item.id);
            }}
            type="button"
            className="seo-rail-item"
            data-testid="seo-rail-item"
            data-panel={item.id}
            data-status={status}
            data-selected={selected}
            aria-current={selected ? 'page' : undefined}
            aria-disabled={!item.available}
            disabled={!item.available}
            aria-label={label}
            title={label}
            onClick={() => onSelect(item.id)}
          >
            <Icon />
            {status ? <span className="seo-rail-dot" data-status={status} aria-hidden="true" /> : null}
            <span className="seo-rail-label">{item.available ? item.label : 'Soon'}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Skeleton() {
  return (
    <div className="seo-skeleton" data-testid="seo-pending" aria-busy="true" aria-label="Auditing this page">
      <div className="seo-skeleton-score">
        <span className="seo-skeleton-ring" />
        <span className="seo-skeleton-lines">
          <span className="seo-skeleton-line seo-skeleton-w40" />
          <span className="seo-skeleton-line seo-skeleton-w70" />
          <span className="seo-skeleton-line seo-skeleton-w55" />
        </span>
      </div>
      {[0, 1, 2, 3].map((n) => (
        <span key={n} className="seo-skeleton-block" />
      ))}
    </div>
  );
}

function Hint({ title, message, testId, reason, retry }: { readonly title: string; readonly message: string; readonly testId: string; readonly reason?: string; readonly retry?: () => void }) {
  return (
    <div className="seo-hint" data-testid={testId} data-reason={reason}>
      <span className="seo-hint-art" aria-hidden="true">
        <AuditArt />
      </span>
      <p className="seo-hint-title">{title}</p>
      <p className="seo-hint-message" data-testid={`${testId}-message`}>
        {message}
      </p>
      {retry ? (
        <button type="button" className="panel-button panel-button-primary seo-hint-button" data-testid="seo-retry" onClick={retry}>
          <ReloadIcon />
          <span>Retry</span>
        </button>
      ) : null}
    </div>
  );
}

function PanelBody({ tab, panel, response }: { readonly tab: TabState | undefined; readonly panel: SeoPanelId; readonly response: SeoAuditResponse | null }) {
  if (!tab || response === null) return <Hint testId="seo-empty" title="No page yet" message="Open a web page and frost audits it here: a health score, ranked issues and what search engines read." />;
  if (response.status === 'pending') return <Skeleton />;
  if (response.status === 'unavailable') {
    const retry = RETRYABLE.has(response.reason) ? () => void actions.rerunAudit(tab.id) : undefined;
    return <Hint testId="seo-unavailable" reason={response.reason} title="Audit unavailable" message={SEO_UNAVAILABLE_MESSAGES[response.reason]} retry={retry} />;
  }
  switch (panel) {
    case 'on-page':
      return <OnPage audit={response.audit} tab={tab} />;
    case 'content':
      return <Content audit={response.audit} tab={tab} />;
    case 'links':
      return <Links audit={response.audit} tab={tab} />;
    case 'images':
      return <Images audit={response.audit} tab={tab} />;
    case 'social':
      return <Social audit={response.audit} tab={tab} />;
    case 'schema':
      return <Schema audit={response.audit} tab={tab} />;
    case 'indexability':
      return <Indexability audit={response.audit} />;
    case 'speed':
      return <Speed audit={response.audit} tab={tab} renderProfile={response.renderProfile ?? null} />;
    case 'compliance':
      return <Compliance audit={response.audit} tab={tab} run={response.accessibilityRun ?? IDLE_A11Y_RUN} />;
    default:
      return (
        <>
          <AuditProfileNote renderProfile={response.renderProfile ?? null} />
          <Overview audit={response.audit} />
        </>
      );
  }
}

export function SeoSidebar({
  tab,
  open,
  response,
  onOpenChange,
  jump,
}: {
  readonly tab: TabState | undefined;
  readonly open: boolean;
  readonly response: SeoAuditResponse | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly jump?: PanelJump | null;
}) {
  const [panel, setPanel] = useState<SeoPanelId>(DEFAULT_SEO_PANEL);
  const railItems = useRef(new Map<SeoPanelId, HTMLButtonElement>()).current;
  // A command palette jump (`command-palette.feature.md`): open on that panel, focusing its rail item if asked.
  useEffect(() => {
    if (!jump) return;
    setPanel(jump.panel);
    onOpenChange(true);
    if (jump.focus) railItems.get(jump.panel)?.focus();
  }, [jump]);
  const wasOpen = useRef(open);
  // Collapsing from inside the panel (its button, or the shortcut while focus was in it) would drop
  // focus with the panel: it moves to the open panel's rail item instead.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (active === null || active === document.body || !document.contains(active)) railItems.get(panel)?.focus();
    }
    wasOpen.current = open;
  }, [open, panel, railItems]);
  // The page overlay never outlives its toggle: collapsing the sidebar or leaving the panel that owns
  // it turns it off (`HIGHLIGHT_PANELS`).
  const highlight = tab?.highlight ?? 'off';
  const tabId = tab?.id;
  useEffect(() => {
    if (tabId !== undefined && highlightToClear(highlight, panel, open)) void actions.setHighlight(tabId, 'off');
  }, [tabId, highlight, panel, open]);
  const current = SEO_PANELS.find((p) => p.id === panel)!;
  const ready = response?.status === 'ready' ? response : null;
  const host = tab ? hostOf(tab.url) : '';
  const select = (id: SeoPanelId) => {
    // The open panel's rail item collapses the sidebar; any other opens it on that panel.
    if (open && id === panel) onOpenChange(false);
    else {
      setPanel(id);
      onOpenChange(true);
    }
  };
  return (
    <aside className="seo" data-testid="seo-sidebar" data-open={open} aria-label="SEO">
      {open ? (
        <div className="seo-panel" data-testid="seo-panel" data-panel={panel}>
          <header className="seo-head">
            <div className="seo-head-text">
              <h2 className="seo-head-title">{current.label}</h2>
              <span className="seo-head-sub" data-testid="seo-audit-url" title={isolatedTooltip(ready?.url ?? tab?.url ?? '')}>
                {host || 'SEO audit'}
              </span>
            </div>
            <button
              type="button"
              className="tool seo-head-tool"
              data-testid="seo-rerun"
              aria-label="Run the audit again"
              title="Run the audit again"
              disabled={!tab || !canRerun(response)}
              onClick={() => tab && void actions.rerunAudit(tab.id)}
            >
              <ReloadIcon />
            </button>
            <button type="button" className="tool seo-head-tool" data-testid="seo-collapse" aria-label="Collapse the SEO sidebar" title="Collapse (Ctrl/⌘+Shift+S)" onClick={() => {
                onOpenChange(false);
                railItems.get(panel)?.focus();
              }}>
              <ChevronIcon className="seo-collapse-icon" />
            </button>
          </header>
          <div className="seo-body">
            <PanelBody tab={tab} panel={panel} response={response} />
          </div>
          {ready ? (
            <footer className="seo-foot" data-testid="seo-duration" data-ms={Math.round(ready.audit.durationMs)}>
              Audited {new Date(ready.audit.takenAt).toLocaleTimeString()} · read in {Math.max(1, Math.round(ready.audit.durationMs))} ms
            </footer>
          ) : null}
        </div>
      ) : null}
      <Rail open={open} panel={panel} response={response} onSelect={select} itemRefs={railItems} />
    </aside>
  );
}
