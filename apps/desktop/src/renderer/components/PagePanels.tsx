import { useCallback, useLayoutEffect, useRef } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { BackIcon, CrashArt, OfflineArt, PageAlertArt, ReloadIcon, ShieldAlertArt, UnreachableArt } from '../icons';
import { actions } from '../ipc';
import { crashView, loadErrorView, type LoadErrorView } from '../page-error';
import { StartView } from './StartView';

// The page area of the browser chrome and what fills it instead of the tab's view: the error and
// crash panels (spec `browse-guard.feature.md`) or the start view. Styling is the bundled
// styles.css only (strict CSP).

const ERROR_ART: Record<LoadErrorView['errorClass'], typeof ShieldAlertArt> = {
  certificate: ShieldAlertArt,
  unreachable: UnreachableArt,
  offline: OfflineArt,
  generic: PageAlertArt,
};

/** The panel buttons: Try again / Reload (primary) and Go back. */
function PanelButton({ testId, primary, label, busy, onClick }: { readonly testId: string; readonly primary?: boolean; readonly label: string; readonly busy?: boolean; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className={primary ? 'panel-button panel-button-primary' : 'panel-button'}
      data-testid={testId}
      data-busy={busy === true}
      aria-busy={busy === true}
      onClick={onClick}
    >
      {primary ? <ReloadIcon /> : <BackIcon />}
      <span>{label}</span>
    </button>
  );
}

/**
 * The tab's last load failed (`browse-guard.feature.md`): main has hidden its view, so this panel
 * fills the page area. A refused certificate offers no way to proceed.
 */
function ErrorPanel({ tab }: { readonly tab: TabState & { readonly error: NonNullable<TabState['error']> } }) {
  const view = loadErrorView(tab.error, tab.canGoBack);
  const Art = ERROR_ART[view.errorClass];
  return (
    <section className="panel" data-testid="page-error" data-error-class={view.errorClass} aria-labelledby="page-error-title">
      <div className="panel-card">
        <span className="panel-badge" aria-hidden="true">
          <Art />
        </span>
        <h1 className="panel-title" id="page-error-title" data-testid="page-error-title">
          {view.title}
        </h1>
        <p className="panel-message" data-testid="page-error-message">
          {view.message}
        </p>
        <p className="panel-detail" data-testid="page-error-detail">
          {view.detail}
        </p>
        <div className="panel-actions" data-testid="page-error-actions">
          {view.actions.map((action) =>
            action === 'back' ? (
              <PanelButton key={action} testId="page-error-back" label="Go back" onClick={() => void actions.back()} />
            ) : (
              <PanelButton key={action} testId="page-error-retry" primary label="Try again" busy={tab.loading} onClick={() => void actions.reload()} />
            ),
          )}
        </div>
      </div>
    </section>
  );
}

/** The tab's renderer is gone: main has hidden its view; Reload restarts it. */
function CrashPanel({ tab }: { readonly tab: TabState }) {
  const view = crashView(tab.url);
  return (
    <section className="panel" data-testid="page-crashed" data-error-class="crashed" aria-labelledby="page-crashed-title">
      <div className="panel-card">
        <span className="panel-badge" aria-hidden="true">
          <CrashArt />
        </span>
        <h1 className="panel-title" id="page-crashed-title" data-testid="page-crashed-title">
          {view.title}
        </h1>
        <p className="panel-message">{view.message}</p>
        <div className="panel-actions">
          <PanelButton testId="page-crashed-reload" primary label="Reload" onClick={() => void actions.reload()} />
        </div>
      </div>
    </section>
  );
}

/** What fills the page area instead of the view: the crash or error panel, the start view, or nothing. */
function PageContent({ tab, empty }: { readonly tab: TabState | undefined; readonly empty: boolean }) {
  if (tab?.crashed) return <CrashPanel tab={tab} />;
  if (tab?.error) return <ErrorPanel tab={{ ...tab, error: tab.error }} />;
  return empty ? <StartView /> : null;
}

/** The area the tab's page view covers; its rectangle is reported to main on every resize. */
export function PageArea({ tab, empty }: { readonly tab: TabState | undefined; readonly empty: boolean }) {
  const area = useRef<HTMLElement>(null);
  const report = useCallback(() => {
    const el = area.current;
    if (!el) return;
    const { x, y, width, height } = el.getBoundingClientRect();
    void actions.setPageBounds({ x, y, width, height });
  }, []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [report]);

  return (
    <main ref={area} className="page-area" data-testid="page-area">
      <PageContent tab={tab} empty={empty} />
    </main>
  );
}
