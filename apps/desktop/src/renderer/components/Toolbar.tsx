import type { TabState } from '@app/specs/browser.spec';
import { BackIcon, ForwardIcon, ReloadIcon, SidebarIcon, StopIcon } from '../icons';
import { actions } from '../ipc';
import { AddressBar } from './AddressBar';
import { RenderProfileToggle } from './RenderProfile';

// The toolbar of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

export function Toolbar({
  tab,
  focusSeq,
  sidebarOpen,
  onToggleSidebar,
  profileOpen,
  onToggleProfile,
}: {
  readonly tab: TabState | undefined;
  readonly focusSeq: number | undefined;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly profileOpen: boolean;
  readonly onToggleProfile: () => void;
}) {
  const loading = tab?.loading === true;
  return (
    <header className="toolbar">
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
      <AddressBar tab={tab} focusSeq={focusSeq} />
      {/* Render profiles (`render-profile.feature.md`): the editor bar's toggle. */}
      <RenderProfileToggle tab={tab} open={profileOpen} onToggle={onToggleProfile} />
      {/* The SEO sidebar's panel (spec `seo-sidebar.feature.md`): also View › SEO Sidebar, Mod+Shift+S. */}
      <button
        type="button"
        className="tool seo-toggle"
        data-testid="seo-toggle"
        aria-pressed={sidebarOpen}
        aria-label="SEO sidebar"
        title={sidebarOpen ? 'Hide the SEO sidebar (Ctrl/⌘+Shift+S)' : 'Show the SEO sidebar (Ctrl/⌘+Shift+S)'}
        onClick={onToggleSidebar}
      >
        <SidebarIcon />
      </button>
      <div className={loading ? 'progress progress-active' : 'progress'} aria-hidden="true" />
    </header>
  );
}
