import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
import { DEVTOOLS_HEIGHT, DEVTOOLS_TABS, type DevtoolsTabId } from '@app/specs/devtools.spec';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import type { SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { devtoolsPaletteSources } from '../../devtools-palette';
import { clampHeight, heightAfterKey } from '../../devtools-view';
import { useDevtoolsDrawer, useDevtoolsVersion } from '../../hooks/useDevtools';
import { CloseIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { ConsolePanel } from './ConsolePanel';
import { IssuesPanel } from './IssuesPanel';
import { NetworkPanel } from './NetworkPanel';
import { RedirectsPanel } from './RedirectsPanel';
import { StoragePanel } from './StoragePanel';

// The SEO devtools drawer (spec `devtools.feature.md`): a band under the workspace (the page column
// and the SEO sidebar), so the page area above it shrinks and main lays the tab's view out above it
// (`setPageBounds`, as for the palette's sheet at the top). Its height is an SVG strut's `height`
// attribute (never `style=`: strict CSP), clamped here and by the CSS. Read-only by design:
// everything it shows comes from the `devtools.*` procedures (masked by main) or the shown audit,
// rendered as text.

// The palette's devtools actions (`devtools-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...devtoolsPaletteSources());
import.meta.hot?.dispose(unregisterPaletteActions);

/** What a Devtools tab is drawn with. */
export interface DevtoolsPanelProps {
  readonly tab: TabState;
  readonly version: number;
}

export function DevtoolsDrawer({
  state,
  tab,
  audit,
  onOpenPanel,
}: {
  readonly state: BrowserState | null;
  readonly tab: TabState | undefined;
  readonly audit: SeoAuditResponse | null;
  readonly onOpenPanel: (panel: SeoPanelId) => void;
}) {
  const drawer = useDevtoolsDrawer(state?.devtoolsToggleSeq);
  const { open, height, setHeight, tab: shown, setTab, setOpen, focusSeq } = drawer;
  const root = useRef<HTMLElement>(null);
  const tabButtons = useRef(new Map<DevtoolsTabId, HTMLButtonElement>()).current;
  const drag = useRef<{ readonly pointer: number; readonly y: number; readonly height: number } | null>(null);
  // The issues tab needs no data from main; the others follow the tab's devtools version.
  const version = useDevtoolsVersion(tab?.id, open && shown !== 'issues');

  // The palette asked for a tab: move focus to it.
  useEffect(() => {
    if (focusSeq > 0) tabButtons.get(shown)?.focus();
  }, [focusSeq]);

  if (!open) return null;

  /** The workspace stack's height, the workspace's and the drawer's together (the clamp's reference); 0 before layout. */
  const column = (): number => root.current?.parentElement?.clientHeight ?? 0;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, y: event.clientY, height };
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    setHeight(clampHeight(start.height + (start.y - event.clientY), column()));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = heightAfterKey(height, event.key, column());
    if (next === null) return;
    event.preventDefault();
    setHeight(next);
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = DEVTOOLS_TABS.findIndex((t) => t.id === shown);
    const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (move === 0) return;
    event.preventDefault();
    const next = DEVTOOLS_TABS[(at + move + DEVTOOLS_TABS.length) % DEVTOOLS_TABS.length]!.id;
    setTab(next);
    tabButtons.get(next)?.focus();
  };

  const page = tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;
  const shownHeight = clampHeight(height, column());

  return (
    <section className="devtools" data-testid="devtools" aria-label="SEO devtools" ref={root}>
      <div
        className="devtools-resize"
        data-testid="devtools-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the devtools drawer"
        aria-valuemin={DEVTOOLS_HEIGHT.min}
        aria-valuenow={shownHeight}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onResizeKey}
      />
      {/* The drawer's height (an attribute, never `style=`); the CSS's max-height keeps the page in view. */}
      <svg className="devtools-strut" width="1" height={shownHeight} aria-hidden="true" focusable="false" />
      <div className="devtools-body">
        <div className="devtools-head">
          <div className="devtools-tabs" role="tablist" aria-label="Devtools" onKeyDown={onTabKey}>
            {DEVTOOLS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`devtools-tab-${t.id}`}
                className="devtools-tab"
                data-testid="devtools-tab"
                data-tab={t.id}
                aria-selected={t.id === shown}
                aria-controls="devtools-panel"
                tabIndex={t.id === shown ? 0 : -1}
                ref={(el) => {
                  if (el) tabButtons.set(t.id, el);
                  else tabButtons.delete(t.id);
                }}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="devtools-note">Read-only</span>
          <button type="button" className="tool devtools-close" data-testid="devtools-close" aria-label="Close the devtools drawer" title="Close (Ctrl/⌘+Shift+D)" onClick={() => setOpen(false)}>
            <CloseIcon />
          </button>
        </div>
        <div className="devtools-panel" id="devtools-panel" role="tabpanel" aria-labelledby={`devtools-tab-${shown}`} data-testid="devtools-panel" data-tab={shown}>
          {shown === 'issues' ? (
            <IssuesPanel audit={audit} onOpenPanel={onOpenPanel} />
          ) : !tab || !page ? (
            <p className="devtools-empty" data-testid="devtools-empty">
              Open a web page to inspect it.
            </p>
          ) : shown === 'network' ? (
            <NetworkPanel tab={tab} version={version} />
          ) : shown === 'redirects' ? (
            <RedirectsPanel tab={tab} version={version} />
          ) : shown === 'console' ? (
            <ConsolePanel tab={tab} version={version} />
          ) : (
            <StoragePanel tab={tab} version={version} />
          )}
        </div>
      </div>
    </section>
  );
}
