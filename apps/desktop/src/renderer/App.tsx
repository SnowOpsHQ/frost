import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { BackIcon, ForwardIcon, FrostMark, LockIcon, NotSecureIcon, ReloadIcon, SearchIcon, StopIcon } from './icons';

// The browser chrome (spec `browser-chrome.feature.md`, Layout): toolbar, page area, status bar.
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
  navigate: (input: string) => ipc.browser.navigate.mutate({ input }).catch(ignore),
  back: () => ipc.browser.back.mutate().catch(ignore),
  forward: () => ipc.browser.forward.mutate().catch(ignore),
  reload: () => ipc.browser.reload.mutate().catch(ignore),
  stop: () => ipc.browser.stop.mutate().catch(ignore),
};

type Security = 'secure' | 'insecure' | 'none';

function securityOf(url: string): Security {
  if (url.startsWith('https://')) return 'secure';
  if (url.startsWith('http://')) return 'insecure';
  return 'none';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function AddressBar({ tab }: { readonly tab: TabState | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  /** What the user is typing; `null` when not editing. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Text the user submitted, shown until its navigation commits or the load ends. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const selectOnMouseUp = useRef(false);
  const url = tab?.url ?? '';
  const loading = tab?.loading === true;
  const empty = url === '';

  useEffect(() => setSubmitted(null), [url]);
  useEffect(() => {
    if (!loading) setSubmitted(null);
  }, [loading]);

  // An empty tab puts the caret in the address bar.
  useEffect(() => {
    if (empty && tab) input.current?.focus();
  }, [empty, tab?.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const typed = event.currentTarget.value;
      if (typed.trim() === '') return;
      setSubmitted(typed);
      setDraft(null);
      // Focus moves to the page (main focuses the tab's WebContents).
      event.currentTarget.blur();
      void actions.navigate(typed);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const security = draft !== null || submitted !== null ? 'none' : securityOf(url);
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
        value={draft ?? submitted ?? url}
        onChange={(event) => setDraft(event.target.value)}
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
          setDraft(null);
          selectOnMouseUp.current = false;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function Toolbar({ tab }: { readonly tab: TabState | undefined }) {
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
      <AddressBar tab={tab} />
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

/** The area the tab's page view covers; its rectangle is reported to main on every resize. */
function PageArea({ empty }: { readonly empty: boolean }) {
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
      {empty ? <StartView /> : null}
    </main>
  );
}

function StatusBar({ tab, ping, connection }: { readonly tab: TabState | undefined; readonly ping: string; readonly connection: Connection }) {
  const url = tab?.url ?? '';
  const host = hostOf(url);
  const security = securityOf(url);
  let status = 'Ready';
  if (tab?.loading) status = host ? `Loading ${host}…` : 'Loading…';
  else if (host) status = security === 'secure' ? `${host} · Secure connection` : `${host} · Not secure`;
  return (
    <footer className="status-bar" data-testid="status-bar">
      <span className="status-text" data-security={tab?.loading ? undefined : security}>
        {status}
      </span>
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
  return (
    <div className="chrome">
      <Toolbar tab={tab} />
      <PageArea empty={state !== null && empty} />
      <StatusBar tab={tab} ping={ping} connection={connection} />
    </div>
  );
}
