import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { BackIcon, ForwardIcon, PlusIcon, ReloadIcon, SidebarIcon, StopIcon } from '../icons';
import { actions } from '../ipc';
import { AddressBar } from './AddressBar';
import { RenderProfileToggle } from './RenderProfile';
import { TabStrip } from './TabStrip';

// The browser chrome's one row (`App.tsx`; specs `tabs.feature.md`, The chrome row, and
// `browser-chrome.feature.md`, Layout): in DOM order, which is the Tab order (`CHROME_ROW` in
// `tabs.spec.ts`), the navigation tools, the tablist, the address bar as its next sibling, New tab and
// the toolbar's toggles; the loading line along its foot. Styling is the bundled styles.css only
// (strict CSP).

export function ChromeRow({
  state,
  tab,
  sidebarOpen,
  onToggleSidebar,
  profileOpen,
  onToggleProfile,
}: {
  readonly state: BrowserState | null;
  readonly tab: TabState | undefined;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly profileOpen: boolean;
  readonly onToggleProfile: () => void;
}) {
  const loading = tab?.loading === true;
  return (
    <header className="chrome-row" data-testid="chrome-row" aria-label="Browser chrome">
      <nav className="nav-buttons" aria-label="Navigation">
        <button type="button" className="tool" data-testid="back" aria-label="Back" title="Back" disabled={!tab?.canGoBack} onClick={() => void actions.back()}>
          <BackIcon />
        </button>
        <button
          type="button"
          className="tool"
          data-testid="forward"
          aria-label="Forward"
          title="Forward"
          disabled={!tab?.canGoForward}
          onClick={() => void actions.forward()}
        >
          <ForwardIcon />
        </button>
        <button
          type="button"
          className="tool"
          data-testid="reload"
          aria-label={loading ? 'Stop' : 'Reload'}
          title={loading ? 'Stop loading' : 'Reload'}
          disabled={!tab || (tab.url === '' && !loading)}
          onClick={() => void (loading ? actions.stop() : actions.reload())}
        >
          {loading ? <StopIcon /> : <ReloadIcon />}
        </button>
      </nav>
      <TabStrip state={state} />
      <AddressBar tab={tab} focusSeq={state?.focusAddressBarSeq} />
      <button type="button" className="new-tab" data-testid="new-tab" aria-label="New tab" title="New tab" onClick={() => void actions.newTab()}>
        <PlusIcon />
      </button>
      {/* The SEO sidebar's panel (spec `seo-sidebar.feature.md`): also View › SEO Sidebar, Mod+Shift+S. */}
      <button
        type="button"
        className="tool sidebar-toggle"
        data-testid="seo-toggle"
        aria-pressed={sidebarOpen}
        aria-label="SEO sidebar"
        title={sidebarOpen ? 'Hide the SEO sidebar (Ctrl/⌘+Shift+S)' : 'Show the SEO sidebar (Ctrl/⌘+Shift+S)'}
        onClick={onToggleSidebar}
      >
        <SidebarIcon />
      </button>
      {/* Render profiles (`render-profile.feature.md`): the editor bar's toggle. */}
      <RenderProfileToggle tab={tab} open={profileOpen} onToggle={onToggleProfile} />
      <div className={loading ? 'progress progress-active' : 'progress'} aria-hidden="true" />
    </header>
  );
}
