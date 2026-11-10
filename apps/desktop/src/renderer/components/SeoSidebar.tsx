import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { IDLE_A11Y_RUN } from '@app/specs/seo-compliance.spec';
import {
  COMING_SOON_LABEL,
  DEFAULT_SEO_PANEL,
  MORE_PANELS_LABEL,
  PIN_PANEL_LABEL,
  PIN_PANEL_TITLES,
  RAIL_TOOLTIP_DELAY_MS,
  SEO_PANELS,
  SEO_RERUNNABLE_REASONS,
  SEO_UNAVAILABLE_MESSAGES,
  type PanelStatus,
  type SeoPanelId,
} from '@app/specs/seo-sidebar.spec';
import { AuditArt, ChevronIcon, ComplianceIcon, ImagesIcon, IndexabilityIcon, LinksIcon, MorePanelsIcon, OnPageIcon, OverviewIcon, PinIcon, ReloadIcon, SchemaIcon, SocialIcon, SpeedIcon } from '../icons';
import { actions } from '../ipc';
import type { PanelJump } from '../palette/registry';
import { highlightToClear, isolatedTooltip, railStatuses } from '../seo-view';
import { hostOf } from '../security';
import { isAlwaysPinned, morePanels, railPanels, usePaneLayout, useSidebarPins, worstStatus } from '../sidebar-layout';
import { Compliance } from './seo/Compliance';
import { Content } from './seo/Content';
import { GscPanel } from './seo/GscPanel';
import { GscIcon } from './seo/gsc-icons';
import { ContentIcon } from './seo/content-icons';
import { Images } from './seo/Images';
import { Indexability } from './seo/Indexability';
import { JavaScript } from './seo/JavaScript';
import { JavascriptIcon } from './seo/javascript-icons';
import { Links } from './seo/Links';
import { OnPage } from './seo/OnPage';
import { AuditProfileNote } from './seo/AuditProfileNote';
import { Overview } from './seo/Overview';
import { Schema } from './seo/Schema';
import { Serp } from './seo/Serp';
import { SerpIcon, VisibilityIcon } from './seo/serp-icons';
import { Social } from './seo/Social';
import { Speed } from './seo/Speed';
import { Visibility } from './seo/Visibility';
import { Changes } from './changes/Changes';
import { ChangesIcon, InspectorIcon } from './changes/changes-icons';
import { Inspector } from './changes/Inspector';

// The SEO sidebar (spec `seo-sidebar.spec.ts`; acceptance `seo-sidebar.feature.md`, Sidebar): docked
// right of the page area, the open panel and then the persistent rail at the window's edge. The
// audit lives in main (`seo.getAudit`); this renders it. Styling is the bundled styles.css only
// (strict CSP); page-derived text is React text only (`seo/parts.tsx`). Phase 11 Task 10: the open
// panel's width is the user's (its separator, `sidebar-layout.ts`), and the rail shows the pinned
// panels, the others in its "More panels" menu (an open one shows on the rail while open).

/** Reasons a fresh run may fix (`SEO_RERUNNABLE_REASONS`, shared with the palette's "Run the audit again"). */
const RETRYABLE: ReadonlySet<string> = new Set(SEO_RERUNNABLE_REASONS);

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
  javascript: JavascriptIcon,
  serp: SerpIcon,
  visibility: VisibilityIcon,
  changes: ChangesIcon,
  inspector: InspectorIcon,
  'search-console': GscIcon,
};

const PANEL_LABELS: ReadonlyMap<SeoPanelId, string> = new Map(SEO_PANELS.map((p) => [p.id, p.available ? p.label : `${p.label} · ${COMING_SOON_LABEL}`]));

/** "More panels": the unpinned panels as a menu drawn over the open panel, beside the rail. */
function MoreMenu({
  panels,
  statuses,
  at,
  onSelect,
  onClose,
}: {
  readonly panels: readonly SeoPanelId[];
  readonly statuses: Partial<Record<SeoPanelId, PanelStatus>>;
  readonly at: { readonly x: number; readonly y: number };
  readonly onSelect: (panel: SeoPanelId) => void;
  /** `refocus`: give focus back to the More button (Escape, Tab). */
  readonly onClose: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  useLayoutEffect(() => {
    items()[0]?.focus();
  }, []);
  useEffect(() => {
    // A press anywhere else closes it.
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !(event.target as Element | null)?.closest?.('[data-testid="seo-rail-more"]')) onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose(true);
    }
  };
  return (
    <div ref={menu} className="seo-more-menu" data-testid="seo-more-menu" role="menu" aria-label={MORE_PANELS_LABEL} style={{ left: at.x, top: at.y }} onKeyDown={onKeyDown}>
      {panels.map((id) => {
        const Icon = PANEL_ICONS[id];
        const status = statuses[id];
        return (
          <button key={id} type="button" role="menuitem" tabIndex={-1} className="seo-more-item" data-testid="seo-more-item" data-panel={id} data-status={status} onClick={() => onSelect(id)}>
            <Icon />
            <span className="seo-more-label">{PANEL_LABELS.get(id)}</span>
            {status ? <span className="seo-more-dot seo-rail-dot" data-status={status} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function Rail({
  open,
  panel,
  response,
  unpinned,
  onSelect,
  onJump,
  onOpenMore,
  itemRefs,
  moreRef,
}: {
  readonly open: boolean;
  readonly panel: SeoPanelId;
  readonly response: SeoAuditResponse | null;
  readonly unpinned: ReadonlySet<SeoPanelId>;
  readonly onSelect: (panel: SeoPanelId) => void;
  /** Opens a panel from the More menu (never collapses), focusing its rail item. */
  readonly onJump: (panel: SeoPanelId) => void;
  /** Opens the sidebar (if collapsed) so the More menu can be drawn over it. */
  readonly onOpenMore: () => void;
  readonly itemRefs: Map<SeoPanelId, HTMLButtonElement>;
  readonly moreRef: { current: HTMLButtonElement | null };
}) {
  const statuses = railStatuses(response);
  const shown = railPanels(unpinned, open ? panel : null);
  const more = morePanels(unpinned);
  const moreStatus = worstStatus(statuses, more);
  // The hovered item's label, drawn beside it over the open panel (the native `title` waits ~1 s).
  // Collapsed, the tab's view sits beside the rail and would cover it: the native `title` stays.
  const [tip, setTip] = useState<{ readonly label: string; readonly x: number; readonly y: number } | null>(null);
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [menuAsked, setMenuAsked] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hideTip = () => {
    window.clearTimeout(timer.current);
    setTip(null);
  };
  const showTip = (el: HTMLElement, label: string) => {
    window.clearTimeout(timer.current);
    const place = () => {
      const r = el.getBoundingClientRect();
      setTip({ label, x: r.right + 8, y: r.top + r.height / 2 });
    };
    // Already showing (moving down the rail): the next label at once.
    if (tip) place();
    else timer.current = window.setTimeout(place, RAIL_TOOLTIP_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) {
      hideTip();
      setMenuAt(null);
    }
  }, [open]);
  // The menu is placed once the sidebar is open (it is drawn over the panel, never over the page).
  useLayoutEffect(() => {
    if (!menuAsked || !open) return;
    setMenuAsked(false);
    const r = moreRef.current?.getBoundingClientRect();
    // Beside the button, kept inside the window (each item is 34 px, plus the menu's padding).
    if (r) setMenuAt({ x: r.right + 8, y: Math.max(8, Math.min(r.top, window.innerHeight - 8 - (more.length * 34 + 10))) });
  }, [menuAsked, open, moreRef, more.length]);
  const closeMenu = (refocus: boolean) => {
    setMenuAt(null);
    if (refocus) moreRef.current?.focus();
  };
  return (
    <>
    <nav className="seo-rail" aria-label="SEO panels" data-testid="seo-rail" onScroll={hideTip}>
      {shown.map((id) => {
        const item = SEO_PANELS.find((p) => p.id === id)!;
        const Icon = PANEL_ICONS[item.id];
        const status = statuses[item.id];
        const selected = open && item.available && item.id === panel;
        const label = PANEL_LABELS.get(item.id)!;
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
            data-unpinned={unpinned.has(item.id) ? 'true' : undefined}
            aria-current={selected ? 'page' : undefined}
            aria-disabled={!item.available}
            disabled={!item.available}
            aria-label={label}
            title={open ? undefined : label}
            onPointerEnter={(e) => open && showTip(e.currentTarget, label)}
            onPointerLeave={hideTip}
            onClick={() => {
              hideTip();
              onSelect(item.id);
            }}
          >
            <Icon />
            {status ? <span className="seo-rail-dot" data-status={status} aria-hidden="true" /> : null}
            <span className="seo-rail-label">{item.available ? item.label : 'Soon'}</span>
          </button>
        );
      })}
      {more.length > 0 ? (
        <button
          ref={(el) => {
            moreRef.current = el;
          }}
          type="button"
          className="seo-rail-item seo-rail-more"
          data-testid="seo-rail-more"
          data-status={moreStatus ?? undefined}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          aria-label={MORE_PANELS_LABEL}
          title={open ? undefined : MORE_PANELS_LABEL}
          onPointerEnter={(e) => open && showTip(e.currentTarget, MORE_PANELS_LABEL)}
          onPointerLeave={hideTip}
          onClick={() => {
            hideTip();
            if (menuAt !== null) return closeMenu(false);
            onOpenMore();
            setMenuAsked(true);
          }}
        >
          <MorePanelsIcon />
          {moreStatus ? <span className="seo-rail-dot" data-status={moreStatus} aria-hidden="true" /> : null}
          <span className="seo-rail-label">{MORE_PANELS_LABEL}</span>
        </button>
      ) : null}
    </nav>
    {tip ? (
      <div className="seo-rail-tip" data-testid="seo-rail-tip" role="presentation" aria-hidden="true" style={{ left: tip.x, top: tip.y }}>
        {tip.label}
      </div>
    ) : null}
    {menuAt !== null && open ? (
      <MoreMenu
        panels={more}
        statuses={statuses}
        at={menuAt}
        onClose={closeMenu}
        onSelect={(id) => {
          setMenuAt(null);
          onJump(id);
        }}
      />
    ) : null}
    </>
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

function PanelBody({
  tab,
  panel,
  response,
  notesGeneration,
  onOpenPanel,
}: {
  readonly tab: TabState | undefined;
  readonly panel: SeoPanelId;
  readonly response: SeoAuditResponse | null;
  readonly notesGeneration?: number;
  /** Opens another panel from inside one (the Overview's AI-readiness tile). */
  readonly onOpenPanel: (panel: SeoPanelId) => void;
}) {
  // The SERP and Visibility panels render from main's `serp.*` state, never waiting for the audit (serp-panels.feature.md).
  if (tab && panel === 'serp') return <Serp tab={tab} />;
  // Visibility's AI-readiness section reads the audit when it is ready, and is pending until then.
  if (tab && panel === 'visibility') return <Visibility tab={tab} audit={response?.status === 'ready' ? response.audit : null} />;
  if (panel === 'changes') return <Changes tab={tab} response={response} />; // Phase 6: history shows whatever the audit's state.
  if (panel === 'inspector') return <Inspector tab={tab} />; // Phase 6 Task 8: the page's DOM, whatever the audit's state.
  // Search Console has no rules: it does not wait for the audit (`gsc-panel.feature.md`).
  if (panel === 'search-console') return <GscPanel tab={tab} />;
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
      return <Content audit={response.audit} tab={tab} notesGeneration={notesGeneration} />;
    case 'links':
      return <Links audit={response.audit} tab={tab} />;
    case 'images':
      return <Images audit={response.audit} tab={tab} />;
    case 'social':
      return <Social audit={response.audit} tab={tab} />;
    case 'schema':
      return <Schema audit={response.audit} tab={tab} />;
    case 'indexability':
      return <Indexability audit={response.audit} tab={tab} />;
    case 'speed':
      return <Speed audit={response.audit} tab={tab} renderProfile={response.renderProfile ?? null} />;
    case 'compliance':
      return <Compliance audit={response.audit} tab={tab} run={response.accessibilityRun ?? IDLE_A11Y_RUN} />;
    case 'javascript':
      return <JavaScript audit={response.audit} tab={tab} />;
    default:
      return (
        <>
          <AuditProfileNote renderProfile={response.renderProfile ?? null} tabOverrides={response.tabOverrides ?? null} />
          <Overview audit={response.audit} tab={tab} onOpenPanel={onOpenPanel} notesGeneration={notesGeneration} />
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
  notesGeneration,
}: {
  readonly tab: TabState | undefined;
  readonly open: boolean;
  readonly response: SeoAuditResponse | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly jump?: PanelJump | null;
  /** Main's content notes generation (`BrowserState.contentNotesGeneration`), for the Content panel. */
  readonly notesGeneration?: number;
}) {
  const [panel, setPanel] = useState<SeoPanelId>(DEFAULT_SEO_PANEL);
  const railItems = useRef(new Map<SeoPanelId, HTMLButtonElement>()).current;
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const aside = useRef<HTMLElement>(null);
  const { separator } = usePaneLayout('sidebar', open, aside);
  const [unpinned, togglePinned] = useSidebarPins();
  // Focus for a panel's rail item once it is rendered (an unpinned panel's item appears only once it is open).
  const focusItem = useRef<SeoPanelId | null>(null);
  useEffect(() => {
    const id = focusItem.current;
    if (id === null) return;
    focusItem.current = null;
    (railItems.get(id) ?? moreButton.current)?.focus();
  });
  /** Focuses `id`'s rail item now if it is there (it stays: the panel is opening), else once it is rendered. */
  const focusRail = (id: SeoPanelId) => {
    const item = railItems.get(id);
    if (item) item.focus();
    else focusItem.current = id;
  };
  // A command palette jump (`command-palette.feature.md`): open on that panel, focusing its rail item if asked.
  useEffect(() => {
    if (!jump) return;
    setPanel(jump.panel);
    onOpenChange(true);
    if (jump.focus) focusRail(jump.panel);
  }, [jump]);
  const wasOpen = useRef(open);
  // Collapsing from inside the panel (its button, or the shortcut while focus was in it) would drop
  // focus with the panel: it moves to the open panel's rail item instead (an unpinned panel's is
  // gone with it: "More panels" then).
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (active === null || active === document.body || !document.contains(active)) (railItems.get(panel) ?? moreButton.current)?.focus();
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
  // A panel without rules (Search Console) shows neither the audit's rerun button nor its footer.
  const audited = current.categories.length > 0;
  const ready = response?.status === 'ready' ? response : null;
  const host = tab ? hostOf(tab.url) : '';
  // A jump from inside a panel (the Overview's AI-readiness tile), as the palette's and the DevTools
  // drawer's jumps do: that panel, with focus on its rail item (the button that asked goes with the old panel).
  const openFromPanel = (id: SeoPanelId) => {
    setPanel(id);
    onOpenChange(true);
    focusRail(id);
  };
  const select = (id: SeoPanelId) => {
    // The open panel's rail item collapses the sidebar; any other opens it on that panel.
    if (open && id === panel) onOpenChange(false);
    else {
      setPanel(id);
      onOpenChange(true);
    }
  };
  const pinned = !unpinned.has(panel);
  return (
    <aside ref={aside} className="seo" data-testid="seo-sidebar" data-open={open} aria-label="SEO">
      <Rail open={open} panel={panel} response={response} unpinned={unpinned} onSelect={select} onJump={openFromPanel} onOpenMore={() => onOpenChange(true)} itemRefs={railItems} moreRef={moreButton} />
      {open ? (
        <div className="seo-panel" data-testid="seo-panel" data-panel={panel}>
          <header className="seo-head">
            <div className="seo-head-text">
              <h2 className="seo-head-title">{current.label}</h2>
              <span className="seo-head-sub" data-testid="seo-audit-url" title={isolatedTooltip(ready?.url ?? tab?.url ?? '')}>
                {host || 'SEO audit'}
              </span>
            </div>
            {isAlwaysPinned(panel) ? null : (
              <button
                type="button"
                className="tool seo-head-tool seo-pin"
                data-testid="seo-pin"
                aria-pressed={pinned}
                aria-label={PIN_PANEL_LABEL}
                title={pinned ? PIN_PANEL_TITLES.pinned : PIN_PANEL_TITLES.unpinned}
                onClick={() => togglePinned(panel)}
              >
                <PinIcon />
              </button>
            )}
            {audited ? (
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
            ) : null}
            <button type="button" className="tool seo-head-tool" data-testid="seo-collapse" aria-label="Collapse the SEO sidebar" title="Collapse (Ctrl/⌘+Shift+S)" onClick={() => {
                onOpenChange(false);
                focusItem.current = panel;
              }}>
              <ChevronIcon className="seo-collapse-icon" />
            </button>
          </header>
          <div className="seo-body">
            <PanelBody tab={tab} panel={panel} response={response} notesGeneration={notesGeneration} onOpenPanel={openFromPanel} />
          </div>
          {ready && audited ? (
            <footer className="seo-foot" data-testid="seo-duration" data-ms={Math.round(ready.audit.durationMs)}>
              Audited {new Date(ready.audit.takenAt).toLocaleTimeString()} · read in {Math.max(1, Math.round(ready.audit.durationMs))} ms
            </footer>
          ) : null}
        </div>
      ) : null}
      {open ? <div className="pane-separator seo-separator" data-testid="seo-resize" {...separator} /> : null}
    </aside>
  );
}
