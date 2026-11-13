import { useEffect, useRef } from 'react';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { AlertIcon, CloseIcon, FrostMark, GlobeIcon } from '../icons';
import { actions } from '../ipc';
import { TabProfileBadge } from './RenderProfile';
import { tabLabel } from '../tab-label';
import { locationBadge } from '../location-view';
import { tablistFocusTarget } from '../tablist-keys';

// The tab strip of the browser chrome's row (spec `tabs.feature.md`). Styling is the bundled styles.css
// only (strict CSP).

/**
 * One tab in the strip: the `role="tab"` element (glyph or loading indicator, label; tooltip: the
 * full label) and, as its sibling, the close button. A tab's children are presentational, so the ×
 * is a mouse affordance outside it (`aria-hidden`, never focused); the keyboard closes the focused
 * tab with Delete, or the active one with Cmd/Ctrl+W.
 */
function Tab({ tab, active }: { readonly tab: TabState; readonly active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const label = tabLabel(tab);
  // Phase 12 Task 10b: a location tab always shows where it browses from.
  const location = locationBadge(tab);
  useEffect(() => {
    // The whole pill (its × too), with the tablist's scroll padding: room for the focus ring.
    if (active) ref.current?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const activate = () => void actions.activateTab(tab.id);
  const close = () => void actions.closeTab(tab.id);
  return (
    <div
      role="presentation"
      className="tab"
      data-testid="tab-item"
      data-active={active}
      onMouseDown={(event) => {
        // Browsers switch on press; the middle button closes instead (and must not autoscroll).
        if (event.button === 1) event.preventDefault();
        if (event.button === 0) activate();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) close();
      }}
    >
      <div
        ref={ref}
        role="tab"
        className="tab-main"
        data-testid="tab"
        data-tab-id={tab.id}
        aria-selected={active}
        aria-keyshortcuts="Delete"
        tabIndex={active ? 0 : -1}
        title={label}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          } else if (event.key === 'Delete') {
            event.preventDefault();
            // Keep keyboard focus in the strip: on the neighbour that remains.
            const items = [...(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
            const index = items.indexOf(event.currentTarget);
            (items[index + 1] ?? items[index - 1])?.focus();
            close();
          }
        }}
      >
        <span className="tab-glyph" aria-hidden="true">
          {tab.loading ? (
            <span className="tab-spinner" data-testid="tab-loading" />
          ) : tab.error || tab.crashed ? (
            <AlertIcon className="tab-icon tab-icon-alert" />
          ) : tab.url === '' ? (
            <FrostMark className="tab-mark" />
          ) : (
            <GlobeIcon className="tab-icon" />
          )}
        </span>
        <span className="tab-label" data-testid="tab-label">
          {label}
        </span>
        {location ? (
          <span className="tab-location" data-testid="tab-location" title={location.title}>
            {location.text}
          </span>
        ) : null}
        {tab.renderProfile ? <TabProfileBadge state={tab.renderProfile} /> : null}
        {tab.permissionPrompt && !active ? (
          <span className="tab-attention" data-testid="tab-permission-dot">
            <span className="tab-attention-dot" aria-hidden="true" />
            <span className="visually-hidden">, asking for a permission</span>
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="tab-close"
        data-testid="tab-close"
        aria-hidden="true"
        tabIndex={-1}
        title="Close tab"
        onMouseDown={(event) => {
          // Neither activates the tab nor takes focus.
          event.stopPropagation();
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * The tab strip: the chrome row's tablist (`ChromeRow.tsx`; spec `tabs.feature.md`, The chrome row). It
 * holds only tabs and scrolls sideways once they reach their minimum width; the address bar is its
 * next sibling and the new-tab button follows that. Roving tabindex: only the active tab is in the
 * Tab order; Left/Right/Home/End move focus inside the tablist.
 */
export function TabStrip({ state }: { readonly state: BrowserState | null }) {
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Tabs"
      data-testid="tab-strip"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.getAttribute('role') !== 'tab') return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
        const next = tablistFocusTarget(event.key, items.indexOf(target), items.length);
        if (next === null) return;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      {state?.tabs.map((tab) => <Tab key={tab.id} tab={tab} active={tab.id === state.activeTabId} />)}
    </div>
  );
}
