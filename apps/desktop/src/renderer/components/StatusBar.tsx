import type { TabState } from '@app/specs/browser.spec';
import { NOTICE_MESSAGES, UNRESPONSIVE_STATUS, type NoticeKind } from '@app/specs/tabs.spec';
import type { Connection } from '../hooks/usePing';
import { panelHost } from '../page-error';
import { hostOf, tabSecurity } from '../security';
import { zoomLabel } from '../zoom-label';

// The status bar of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

export function StatusBar({
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
  const zoom = tab && tab.url !== '' ? zoomLabel(tab.zoom) : null;
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
      {zoom !== null ? (
        <span className="status-zoom" data-testid="status-zoom" title="Page zoom">
          {zoom}
        </span>
      ) : null}
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
