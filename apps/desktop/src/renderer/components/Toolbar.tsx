import type { TabState } from '@app/specs/browser.spec';
import { BackIcon, ForwardIcon, ReloadIcon, StopIcon } from '../icons';
import { actions } from '../ipc';
import { AddressBar } from './AddressBar';

// The toolbar of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

export function Toolbar({ tab, focusSeq }: { readonly tab: TabState | undefined; readonly focusSeq: number | undefined }) {
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
      <div className={loading ? 'progress progress-active' : 'progress'} aria-hidden="true" />
    </header>
  );
}
