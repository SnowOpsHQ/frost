import { useState } from 'react';
import { MASKED_VALUE, STORAGE_USAGE_NOTE, type ClearSiteDataResult } from '@app/specs/devtools.spec';
import { formatExpiry } from '../../devtools-view';
import { useDevtoolsData } from '../../hooks/useDevtools';
import { devtoolsApi } from './api';
import type { DevtoolsPanelProps } from './DevtoolsDrawer';

// The Storage tab (spec `devtools.feature.md`, Storage): the tab origin's cookies with their values
// masked; Reveal shows one until the tab's next navigation (main keeps that, not the chrome). Read-only
// but for "Clear this site's data", which main confirms in its own dialog.

const CLEAR_MESSAGES: Readonly<Record<ClearSiteDataResult, string>> = {
  cleared: 'This site’s data was cleared.',
  cancelled: 'Nothing was cleared.',
  refused: 'This page has no site data to clear.',
  busy: 'Another site’s data is being cleared. Try again in a moment.',
};

export function StoragePanel({ tab, version }: DevtoolsPanelProps) {
  const storage = useDevtoolsData(devtoolsApi.storage, tab.id, version, String(tab.documentSeq));
  const [status, setStatus] = useState('');
  if (storage === null) return <p className="devtools-empty">Loading…</p>;
  if (storage.status !== 'ready') return <p className="devtools-empty">This page has no site storage.</p>;
  const clear = async () => {
    const result = await devtoolsApi.clearSiteData(tab.id);
    setStatus(result === null ? 'Nothing was cleared.' : CLEAR_MESSAGES[result]);
  };
  return (
    <div className="devtools-storage" data-testid="devtools-storage">
      <div className="devtools-toolbar">
        <span className="devtools-summary">
          Cookies for <bdi>{storage.origin}</bdi>: {storage.cookieTotal}
          {storage.cookieTotal > storage.cookies.length ? ` (the first ${storage.cookies.length} shown)` : ''}
        </span>
        <button type="button" className="devtools-button devtools-danger" data-testid="devtools-clear-site-data" onClick={() => void clear()}>
          Clear this site’s data…
        </button>
        <span className="devtools-count" data-testid="devtools-storage-status" aria-live="polite">
          {status}
        </span>
      </div>
      <div className="devtools-table-wrap">
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
      </div>
      <p className="devtools-muted">Values stay hidden until you reveal one; a revealed value is hidden again when the page changes. {STORAGE_USAGE_NOTE}</p>
    </div>
  );
}
