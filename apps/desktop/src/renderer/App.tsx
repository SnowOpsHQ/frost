import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types);
// runtime constants come from the Zod-free tabs.spec.
import type { BrowserState, Notice, TabState } from '@app/specs/browser.spec';
import { NOTICE_MESSAGES, UNRESPONSIVE_STATUS, type NoticeKind } from '@app/specs/tabs.spec';
import { addressFieldReducer, addressFieldText, initialAddressField } from './address-field';
import { createNoticeTracker, type NoticeTracker } from './notice';
import { crashView, isCertificateErrorCode, loadErrorView, panelHost, type LoadErrorView } from './page-error';
import { tabLabel } from './tab-label';
import { tablistFocusTarget } from './tablist-keys';
import {
  AlertIcon,
  BackIcon,
  CloseIcon,
  CrashArt,
  ForwardIcon,
  FrostMark,
  GlobeIcon,
  LockIcon,
  NotSecureIcon,
  OfflineArt,
  PageAlertArt,
  PlusIcon,
  ReloadIcon,
  SearchIcon,
  ShieldAlertArt,
  StopIcon,
  UnreachableArt,
} from './icons';

// The browser chrome (spec `browser-chrome.feature.md`, Layout; `tabs.feature.md`): tab strip,
// toolbar, page area, status bar.
// All browser state lives in main; this page renders it and sends user intents over the
// sender-guarded `browser.*` procedures. Styling is the bundled styles.css only (strict CSP).

const ipc = createIpcClient<AppRouter>();

const RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long-polls `browser.watch`; each answer carries the full state and its version. */
function useBrowserState(): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null);
  useEffect(() => {
    let live = true;
    let since = 0;
    void (async () => {
      while (live) {
        try {
          const next = await ipc.browser.watch.query({ sinceVersion: since });
          if (!live) return;
          since = next.version;
          setState(next);
        } catch {
          if (live) await sleep(RETRY_MS);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return state;
}

type Connection = 'connecting' | 'connected' | 'error';

/** Phase 0's sender-validated `ping`, now the status bar's connection indicator. */
function usePing(): { ping: string; connection: Connection } {
  const [ping, setPing] = useState('');
  useEffect(() => {
    let live = true;
    ipc.ping.query().then(
      (result) => live && setPing(result),
      () => live && setPing('error'),
    );
    return () => {
      live = false;
    };
  }, []);
  return { ping, connection: ping === '' ? 'connecting' : ping === 'pong' ? 'connected' : 'error' };
}

function ignore(): void {}

const actions = {
  /** Resolves whether a navigation started (`false` on a no-op or an IPC failure). */
  navigate: (input: string) => ipc.browser.navigate.mutate({ input }).catch(() => false),
  newTab: () => ipc.browser.newTab.mutate().catch(ignore),
  closeTab: (tabId: number) => ipc.browser.closeTab.mutate({ tabId }).catch(ignore),
  activateTab: (tabId: number) => ipc.browser.activateTab.mutate({ tabId }).catch(ignore),
  back: () => ipc.browser.back.mutate().catch(ignore),
  forward: () => ipc.browser.forward.mutate().catch(ignore),
  reload: () => ipc.browser.reload.mutate().catch(ignore),
  stop: () => ipc.browser.stop.mutate().catch(ignore),
};

/**
 * Calls `onChange` whenever `seq` changes after the first value seen (main's focus requests and
 * notices are counters; the value at load time is history, not a request).
 */
function useSeqChange(seq: number | undefined, onChange: () => void): void {
  const seen = useRef<number | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (seq === undefined) return;
    if (seen.current !== undefined && seq !== seen.current) latest.current();
    seen.current = seq;
  }, [seq]);
}

/** The status-bar notice to show: the latest one main raised, for `NOTICE_DISPLAY_MS` (`notice.ts`). */
function useNotice(notice: Notice | null | undefined): NoticeKind | null {
  const [shown, setShown] = useState<NoticeKind | null>(null);
  const tracker = useRef<NoticeTracker | null>(null);
  useEffect(() => {
    const created = createNoticeTracker(setShown);
    tracker.current = created;
    return () => {
      created.dispose();
      tracker.current = null;
    };
  }, []);
  const seq = notice === undefined ? undefined : (notice?.seq ?? 0);
  useEffect(() => {
    if (notice !== undefined) tracker.current?.update(notice);
  }, [seq]);
  return shown;
}

type Security = 'secure' | 'insecure' | 'none';

function securityOf(url: string): Security {
  if (url.startsWith('https://')) return 'secure';
  if (url.startsWith('http://')) return 'insecure';
  return 'none';
}

/** A tab's badge: never the lock for a failed load (a refused certificate is "not secure"). */
function tabSecurity(tab: TabState | undefined): Security {
  if (!tab) return 'none';
  if (tab.error) return isCertificateErrorCode(tab.error.code) ? 'insecure' : 'none';
  return securityOf(tab.url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function AddressBar({ tab, focusSeq }: { readonly tab: TabState | undefined; readonly focusSeq: number | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  const [field, dispatch] = useReducer(addressFieldReducer, initialAddressField);
  const selectOnMouseUp = useRef(false);
  const url = tab?.url ?? '';
  const loading = tab?.loading === true;
  const empty = url === '';
  const tabId = tab?.id;

  /** Focus with everything selected (no click follows, so no mouseup to protect). */
  const focusAll = () => {
    input.current?.focus();
    input.current?.select();
    selectOnMouseUp.current = false;
  };

  useEffect(() => dispatch({ type: 'tab-switched' }), [tabId]);
  useEffect(() => dispatch({ type: 'url-changed' }), [url]);
  useEffect(() => {
    if (!loading) dispatch({ type: 'load-ended' });
  }, [loading]);

  // An empty tab puts the caret in the address bar.
  useEffect(() => {
    if (empty && tabId !== undefined) focusAll();
  }, [empty, tabId]);
  // Main asked for the address bar (new tab, Cmd/Ctrl+L, switching to an empty tab).
  useSeqChange(focusSeq, focusAll);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const typed = event.currentTarget.value;
      if (typed.trim() === '') return;
      dispatch({ type: 'submit', text: typed });
      // Focus moves to the page (main focuses the tab's WebContents).
      event.currentTarget.blur();
      void actions.navigate(typed).then((navigated) => {
        if (!navigated) dispatch({ type: 'navigate-failed' });
      });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'cancel' });
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const security = field.draft !== null || field.submitted !== null ? 'none' : tabSecurity(tab);
  return (
    <div className="address" data-security={security}>
      <span className="address-badge" title={security === 'secure' ? 'Secure connection' : security === 'insecure' ? 'Not secure' : undefined}>
        {security === 'secure' ? <LockIcon /> : security === 'insecure' ? <NotSecureIcon /> : <SearchIcon />}
      </span>
      <input
        ref={input}
        data-testid="address"
        className="address-input"
        type="text"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label="Address and search bar"
        placeholder="Search or enter address"
        value={addressFieldText(field, url)}
        onChange={(event) => dispatch({ type: 'edit', text: event.target.value })}
        onFocus={(event) => {
          event.currentTarget.select();
          selectOnMouseUp.current = true;
        }}
        onMouseUp={(event) => {
          // Keep the select-all from focus instead of letting the click place the caret.
          if (selectOnMouseUp.current) event.preventDefault();
          selectOnMouseUp.current = false;
        }}
        onBlur={() => {
          dispatch({ type: 'cancel' });
          selectOnMouseUp.current = false;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/**
 * One tab in the strip: the `role="tab"` element (glyph or loading indicator, label; tooltip: the
 * full label) and, as its sibling, the close button. A tab's children are presentational, so the ×
 * is a mouse affordance outside it (`aria-hidden`, never focused); the keyboard closes the focused
 * tab with Delete, or the active one with Cmd/Ctrl+W.
 */
function Tab({ tab, active }: { readonly tab: TabState; readonly active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const label = tabLabel(tab);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
 * The tab strip above the toolbar; it scrolls sideways when the tabs no longer fit. Roving tabindex:
 * only the active tab is in the Tab order; Left/Right/Home/End move focus inside the tablist.
 */
function TabStrip({ state }: { readonly state: BrowserState | null }) {
  return (
    <div className="tabstrip" data-testid="tab-strip">
      <div
        className="tabs"
        role="tablist"
        aria-label="Tabs"
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
      <button type="button" className="new-tab" data-testid="new-tab" aria-label="New tab" title="New tab" onClick={() => void actions.newTab()}>
        <PlusIcon />
      </button>
    </div>
  );
}

function Toolbar({ tab, focusSeq }: { readonly tab: TabState | undefined; readonly focusSeq: number | undefined }) {
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

function StartView() {
  return (
    <section className="start" data-testid="start-view" aria-label="New tab">
      <FrostMark className="start-mark" />
      <h1 className="start-wordmark">frost</h1>
      <p className="start-hint">Search or enter address</p>
    </section>
  );
}

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
function PageArea({ tab, empty }: { readonly tab: TabState | undefined; readonly empty: boolean }) {
  const area = useRef<HTMLElement>(null);
  const report = useCallback(() => {
    const el = area.current;
    if (!el) return;
    const { x, y, width, height } = el.getBoundingClientRect();
    ipc.browser.setPageBounds.mutate({ x, y, width, height }).catch(ignore);
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

function StatusBar({
  tab,
  notice,
  ping,
  connection,
}: {
  readonly tab: TabState | undefined;
  readonly notice: NoticeKind | null;
  readonly ping: string;
  readonly connection: Connection;
}) {
  const url = tab?.url ?? '';
  const host = hostOf(url);
  const security = tabSecurity(tab);
  let status = 'Ready';
  if (tab?.loading) status = host ? `Loading ${host}…` : 'Loading…';
  else if (tab?.crashed) status = `${panelHost(url)} · Page crashed`;
  else if (tab?.error) status = `Couldn\u2019t load ${panelHost(tab.error.url)}`;
  else if (host) status = security === 'secure' ? `${host} · Secure connection` : `${host} · Not secure`;
  return (
    <footer className="status-bar" data-testid="status-bar">
      {notice !== null ? (
        <span className="status-text status-notice" data-testid="status-notice" role="status">
          {NOTICE_MESSAGES[notice]}
        </span>
      ) : tab?.unresponsive ? (
        <span className="status-text status-notice" data-testid="status-unresponsive" role="status">
          {UNRESPONSIVE_STATUS}
        </span>
      ) : (
        <span className="status-text" data-security={tab?.loading ? undefined : security}>
          {status}
        </span>
      )}
      <span className="connection" data-state={connection} title="Connection to the frost main process">
        <span className="connection-dot" aria-hidden="true" />
        <span className="connection-label" aria-hidden="true">
          {connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        <output data-testid="ping" className="visually-hidden">
          {ping}
        </output>
      </span>
    </footer>
  );
}

export function App() {
  const state = useBrowserState();
  const { ping, connection } = usePing();
  const tab = state?.tabs.find((t) => t.id === state.activeTabId);
  const empty = !tab || (tab.url === '' && !tab.loading);
  const notice = useNotice(state === null ? undefined : state.notice);
  return (
    <div className="chrome">
      <TabStrip state={state} />
      <Toolbar tab={tab} focusSeq={state?.focusAddressBarSeq} />
      <PageArea tab={tab} empty={state !== null && empty} />
      <StatusBar tab={tab} notice={notice} ping={ping} connection={connection} />
    </div>
  );
}
