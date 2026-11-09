import { useRef, useState } from 'react';
import {
  MASKED_VALUE,
  STORAGE_USAGE_NOTE,
  WEB_STORAGE_AREAS,
  type ClearSiteDataResult,
  type StorageAnswer,
  type WebStorageArea,
  type WebStorageAreaView,
  type WebStorageUnavailableReason,
} from '@app/specs/devtools.spec';
import { formatBytes, formatExpiry } from '../../devtools-view';
import { useDevtoolsData } from '../../hooks/useDevtools';
import { devtoolsApi } from './api';
import type { DevtoolsPanelProps } from './DevtoolsDrawer';

// The Storage tab (spec `devtools.feature.md`, Storage and Web storage): the tab origin's cookies with
// their values masked, and (Phase 11 Task 4) its local and session storage: key names and value sizes,
// values masked. Reveal shows one until the tab's next navigation (main keeps that, not the chrome;
// a revealed storage value is read again for each answer and never kept). Main runs its read-only
// storage reader only when this tab opens and on Refresh. Every key and value is inert text. Read-only
// but for "Clear this site's data", which main confirms in its own dialog.

const CLEAR_MESSAGES: Readonly<Record<ClearSiteDataResult, string>> = {
  cleared: 'This site’s data was cleared.',
  cancelled: 'Nothing was cleared.',
  refused: 'This page has no site data to clear.',
  busy: 'Another site’s data is being cleared. Try again in a moment.',
};

const AREA_TITLES: Readonly<Record<WebStorageArea, string>> = { local: 'Local storage', session: 'Session storage' };

const UNAVAILABLE: Readonly<Record<WebStorageUnavailableReason, string>> = {
  'opaque-origin': 'This page has no origin of its own (a sandboxed document), so it has no storage to read.',
  denied: 'The browser refused access to this storage.',
  timeout: 'The page took too long to answer. Try Refresh.',
  invalid: 'The page’s answer wasn’t valid, so nothing is shown.',
  failed: 'The storage couldn’t be read. Try Refresh.',
};

/** Bytes as text, up to GB (usage and quota). */
function formatStorageBytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : formatBytes(Math.round(bytes));
}

function WebStorageSection({ tabId, area, view }: { readonly tabId: number; readonly area: WebStorageArea; readonly view: WebStorageAreaView }) {
  const title = AREA_TITLES[area];
  return (
    <section className="devtools-web-storage" data-testid="devtools-web-storage" data-area={area} aria-label={title}>
      <h3 className="devtools-subhead">
        {title}
        {view.status === 'ready' ? `: ${view.total}${view.total > view.items.length ? ` (the first ${view.items.length} shown)` : ''}` : ''}
      </h3>
      {view.status !== 'ready' ? (
        <p className="devtools-muted" data-testid="devtools-web-storage-unavailable" data-reason={view.reason}>
          {UNAVAILABLE[view.reason]}
        </p>
      ) : view.items.length === 0 ? (
        <p className="devtools-empty">No keys.</p>
      ) : (
        <table className="devtools-table devtools-web-storage-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item, index) => (
              <tr key={`${index}\u0000${item.key}`} className="devtools-row" data-testid="devtools-web-storage-item" data-key={item.key} data-masked={item.value === null}>
                <td>
                  <bdi dir="auto">{item.key}</bdi>
                  {item.keyTruncated ? <span className="devtools-muted"> (cut)</span> : null}
                </td>
                <td className="devtools-cookie-value">
                  {item.value === null ? (
                    <>
                      <span data-testid="devtools-web-storage-value" aria-label="Hidden value">
                        {MASKED_VALUE}
                      </span>{' '}
                      {item.keyTruncated ? null : (
                        <button
                          type="button"
                          className="devtools-link"
                          data-testid="devtools-web-storage-reveal"
                          aria-label={`Reveal the value of ${item.key}`}
                          onClick={() => void devtoolsApi.revealStorageItem(tabId, area, item.key)}
                        >
                          Reveal
                        </button>
                      )}
                    </>
                  ) : (
                    <span data-testid="devtools-web-storage-value">
                      <bdi dir="auto">{item.value}</bdi>
                      {item.valueTruncated ? <span className="devtools-muted"> (cut)</span> : null}
                    </span>
                  )}
                </td>
                <td>{item.size === 1 ? '1 character' : `${item.size.toLocaleString('en')} characters`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function StoragePanel({ tab, version }: DevtoolsPanelProps) {
  // Main reads the page's web storage only when this tab opens (for a tab not read yet here) and on
  // Refresh: each (tab, Refresh) pair is asked once, marked when sent (a second fetch meanwhile shares
  // main's read in flight). An answer for a page without storage (no web page: main ran no script)
  // unmarks it, so a tab opened on such a page reads at its first web page. The fetches a change wakes
  // (`version`, a navigation) answer the last read's keys.
  const [refreshSeq, setRefreshSeq] = useState(0);
  const readSent = useRef<string | null>(null);
  const load = async (tabId: number): Promise<StorageAnswer | null> => {
    const key = `${tabId}:${refreshSeq}`;
    const read = readSent.current !== key;
    if (read) readSent.current = key;
    const answer = await devtoolsApi.storage(tabId, read);
    if (read && answer !== null && answer.status !== 'ready' && readSent.current === key) readSent.current = null;
    return answer;
  };
  const storage = useDevtoolsData(load, tab.id, version, `${tab.documentSeq}:${refreshSeq}`);
  const [status, setStatus] = useState('');
  if (storage === null) return <p className="devtools-empty">Loading…</p>;
  if (storage.status !== 'ready') return <p className="devtools-empty">This page has no site storage.</p>;
  const clear = async () => {
    const result = await devtoolsApi.clearSiteData(tab.id);
    setStatus(result === null ? 'Nothing was cleared.' : CLEAR_MESSAGES[result]);
  };
  const web = storage.webStorage;
  const refresh = () => setRefreshSeq((seq) => seq + 1);
  return (
    <div className="devtools-storage" data-testid="devtools-storage">
      <div className="devtools-toolbar">
        <span className="devtools-summary">
          Cookies for <bdi>{storage.origin}</bdi>: {storage.cookieTotal}
          {storage.cookieTotal > storage.cookies.length ? ` (the first ${storage.cookies.length} shown)` : ''}
        </span>
        <button type="button" className="devtools-button" data-testid="devtools-storage-refresh" onClick={refresh}>
          Refresh
        </button>
        <button type="button" className="devtools-button devtools-danger" data-testid="devtools-clear-site-data" onClick={() => void clear()}>
          Clear this site’s data…
        </button>
        <span className="devtools-count" data-testid="devtools-storage-status" aria-live="polite">
          {status}
        </span>
      </div>
      <div className="devtools-table-wrap devtools-storage-sections">
        <table className="devtools-table devtools-cookie-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col">Domain</th>
              <th scope="col">Path</th>
              <th scope="col">Expires</th>
              <th scope="col">HttpOnly</th>
              <th scope="col">Secure</th>
              <th scope="col">SameSite</th>
            </tr>
          </thead>
          <tbody>
            {storage.cookies.map((cookie) => (
              <tr key={`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`} className="devtools-row" data-testid="devtools-cookie" data-name={cookie.name} data-masked={cookie.value === null}>
                <td>
                  <bdi>{cookie.name}</bdi>
                </td>
                <td className="devtools-cookie-value">
                  {cookie.value === null ? (
                    <>
                      <span data-testid="devtools-cookie-value" aria-label="Hidden value">
                        {MASKED_VALUE}
                      </span>{' '}
                      <button
                        type="button"
                        className="devtools-link"
                        data-testid="devtools-cookie-reveal"
                        aria-label={`Reveal the value of ${cookie.name}`}
                        onClick={() => void devtoolsApi.revealCookie(tab.id, { name: cookie.name, domain: cookie.domain, path: cookie.path })}
                      >
                        Reveal
                      </button>
                    </>
                  ) : (
                    <span data-testid="devtools-cookie-value">
                      <bdi>{cookie.value}</bdi>
                      {cookie.valueTruncated ? <span className="devtools-muted"> (cut)</span> : null}
                    </span>
                  )}
                </td>
                <td>
                  <bdi>{cookie.domain}</bdi>
                </td>
                <td>
                  <bdi>{cookie.path}</bdi>
                </td>
                <td>{formatExpiry(cookie.expires)}</td>
                <td>{cookie.httpOnly ? 'Yes' : ''}</td>
                <td>{cookie.secure ? 'Yes' : ''}</td>
                <td>{cookie.sameSite === 'unspecified' ? '' : cookie.sameSite === 'no_restriction' ? 'None' : cookie.sameSite === 'lax' ? 'Lax' : 'Strict'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {storage.cookies.length === 0 ? <p className="devtools-empty">No cookies for this page.</p> : null}
        {web === null ? (
          <p className="devtools-muted" data-testid="devtools-web-storage-unread">
            Press Refresh to read this page’s local and session storage.
          </p>
        ) : (
          WEB_STORAGE_AREAS.map((area) => <WebStorageSection key={area} tabId={tab.id} area={area} view={web[area]} />)
        )}
      </div>
      <p className="devtools-muted" data-testid="devtools-storage-usage">
        {storage.usage !== null ? `Storage used: ${formatStorageBytes(storage.usage)}${storage.quota !== null ? ` of ${formatStorageBytes(storage.quota)}` : ''}. ` : ''}
        Values stay hidden until you reveal one; a revealed value is hidden again when the page changes. {STORAGE_USAGE_NOTE}
      </p>
    </div>
  );
}
