import type { NetworkHeader } from '@app/specs/devtools.spec';
import { useDevtoolsData } from '../../hooks/useDevtools';
import { devtoolsApi } from './api';
import type { DevtoolsPanelProps } from './DevtoolsDrawer';

// The Redirects tab (spec `devtools.feature.md`, Redirects): the main-frame redirect trace of the
// tab's current document from Phase 2's response recorder, each hop with its status and key headers
// (`REDIRECT_KEY_HEADERS`), then the final answer. Inert text only.

const SOURCE_NOTES: Readonly<Record<string, string>> = {
  network: '',
  cache: 'The final answer came from the HTTP cache.',
  navigation: 'This page was shown without a recorded response (back/forward cache, or before recording).',
  'in-page': 'The URL changed in place: the trace is the document’s.',
};

function KeyHeaders({ headers }: { readonly headers: readonly NetworkHeader[] }) {
  if (headers.length === 0) return null;
  return (
    <dl className="devtools-header-list devtools-hop-headers">
      {headers.map((h, i) => (
        <div key={`${h.name}-${i}`} className="devtools-header" data-testid="devtools-header" data-name={h.name} data-masked={h.masked}>
          <dt>{h.name}</dt>
          <dd>
            <bdi>{h.value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RedirectsPanel({ tab, version }: DevtoolsPanelProps) {
  const trace = useDevtoolsData(devtoolsApi.redirects, tab.id, version, String(tab.documentSeq));
  if (trace === null) return <p className="devtools-empty">Loading…</p>;
  if (trace.status !== 'ready') return <p className="devtools-empty" data-testid="devtools-redirects-none">No main-frame response was recorded for this page.</p>;
  const note = SOURCE_NOTES[trace.source] ?? '';
  return (
    <div className="devtools-redirects" data-testid="devtools-redirects">
      <p className="devtools-summary" data-testid="devtools-redirects-summary">
        {trace.hopTotal === 0 ? 'No redirects: the page answered directly.' : trace.hopTotal === 1 ? '1 redirect before the page.' : `${trace.hopTotal} redirects before the page.`}
        {trace.hopTotal > trace.hops.length ? ` The first ${trace.hops.length} are shown.` : ''}
      </p>
      <ol className="devtools-chain">
        {trace.hops.map((hop, i) => (
          <li key={`${i}-${hop.url}`} className="devtools-hop" data-testid="devtools-redirect-hop" data-status={hop.status}>
            <span className={`devtools-status devtools-status-${Math.floor(hop.status / 100)}xx`}>{hop.status}</span>
            <div className="devtools-hop-body">
              <p className="devtools-hop-url">
                <bdi>{hop.url}</bdi>
              </p>
              <p className="devtools-muted">
                → <bdi>{hop.location}</bdi>
                {hop.internal ? ' (a redirect Chromium made itself)' : ''}
              </p>
              {hop.headersRecorded ? <KeyHeaders headers={hop.headers} /> : <p className="devtools-muted">Headers not recorded.</p>}
            </div>
          </li>
        ))}
        <li className="devtools-hop devtools-hop-final" data-testid="devtools-redirect-final" data-status={trace.finalStatus ?? ''}>
          <span className={`devtools-status devtools-status-${trace.finalStatus === null ? 'none' : `${Math.floor(trace.finalStatus / 100)}xx`}`}>{trace.finalStatus ?? '—'}</span>
          <div className="devtools-hop-body">
            <p className="devtools-hop-url">
              <bdi>{trace.url}</bdi>
            </p>
            <KeyHeaders headers={trace.finalHeaders} />
            {note ? <p className="devtools-muted">{note}</p> : null}
          </div>
        </li>
      </ol>
    </div>
  );
}
