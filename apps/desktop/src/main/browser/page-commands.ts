import type { PageCommand } from '@app/specs/page-commands.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { aliveContents, type StripState, type Tab, type TabView } from './tab-model';
import { stepZoom, type ZoomDirection } from './zoom';

// The page commands of the active tab (spec `page-commands.feature.md`, Controller): reload, hard
// reload, stop, back / forward and zoom, from the menu, a shortcut or the chrome.

export interface PageCommands {
  run(command: PageCommand): void;
  /**
   * Reloads the active tab (ignoring the cache for a hard reload). A crashed (or errored) tab
   * reloads its WebContents, which restarts the renderer; if that WebContents is gone, a fresh view
   * loads the tab's URL instead.
   */
  reload(options?: { ignoreCache?: boolean }): void;
  back(): void;
  forward(): void;
  /** Stops `tab`'s page while it loads, unless it is in HTML fullscreen (Esc leaves that). */
  stopLoading(tab: Tab): void;
}

export interface PageCommandDeps {
  readonly strip: StripState;
  activeTab(): Tab | undefined;
  /** `tab`'s view if its WebContents is alive (a destroyed one is dropped). */
  liveView(tab: Tab): TabView | null;
  /** `tab`'s view, created if it has none (and a window is attached). */
  ensureView(tab: Tab): TabView | null;
  /** Re-reads `tab`'s state. */
  refresh(tab: Tab): void;
}

export function createPageCommands({ strip, activeTab, liveView, ensureView, refresh }: PageCommandDeps): PageCommands {
  /** Runs `act` on the active tab's live WebContents, if it has one. */
  const withActiveContents = (act: (contents: TabView['webContents']) => void): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    if (view) act(view.webContents);
  };

  const reload = ({ ignoreCache = false }: { ignoreCache?: boolean } = {}): void => {
    const tab = activeTab();
    if (!tab) return;
    const url = tab.state.url;
    const view = liveView(tab);
    if (view) {
      // A restored tab whose first load never committed (aborted) has no entry to reload: load
      // its saved URL again.
      if (tab.restored && view.webContents.getURL() === '') {
        view.webContents.loadURL(tab.restored.url).catch(() => {
          // Failures surface through `did-fail-load` / the tab state.
        });
      } else if (ignoreCache) {
        view.webContents.reloadIgnoringCache();
      } else {
        view.webContents.reload();
      }
      return;
    }
    if (!isWebUrl(url)) return;
    ensureView(tab)?.webContents.loadURL(url).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
  };

  const back = (): void => {
    withActiveContents((contents) => {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    });
  };

  const forward = (): void => {
    withActiveContents((contents) => {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    });
  };

  const stopLoading = (tab: Tab): void => {
    const contents = tab.view ? aliveContents(tab.view) : undefined;
    if (contents && tab.fullscreen === null && !tab.crashed && contents.isLoading()) contents.stop();
  };

  /**
   * Zooms the active tab's page one step (`stepZoom`). Chromium keeps zoom per host, so every
   * tab's state is re-read afterwards (those on the same host followed).
   */
  const zoom = (direction: ZoomDirection): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    if (!view) return;
    view.webContents.setZoomFactor(stepZoom(view.webContents.getZoomFactor(), direction));
    for (const each of strip.tabs) refresh(each);
  };

  const run = (command: PageCommand): void => {
    switch (command) {
      case 'reload':
        reload();
        return;
      case 'hard-reload':
        reload({ ignoreCache: true });
        return;
      case 'stop': {
        const tab = activeTab();
        if (tab) stopLoading(tab);
        return;
      }
      case 'back':
        back();
        return;
      case 'forward':
        forward();
        return;
      case 'zoom-in':
        zoom('in');
        return;
      case 'zoom-out':
        zoom('out');
        return;
      case 'zoom-reset':
        zoom('reset');
    }
  };

  return { run, reload, back, forward, stopLoading };
}
