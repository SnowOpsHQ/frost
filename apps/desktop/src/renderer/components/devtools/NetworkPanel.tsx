import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NETWORK_LIMITS,
  NETWORK_SEARCH_MAX_CHARS,
  NETWORK_TYPE_FILTERS,
  NETWORK_TYPE_LABELS,
  type NetworkEntry,
  type NetworkHeader,
  type NetworkHeadersAnswer,
  type NetworkLogAnswer,
  type NetworkTypeFilter,
} from '@app/specs/devtools.spec';
import { filterNetwork, formatBytes, formatDuration, isFailed, mergeRows, NO_NETWORK_FILTER, ROBOTS_VERDICT_LABELS, shortName, statusLabel, waterfall, WATERFALL_WIDTH, type NetworkFilter } from '../../devtools-view';
import { devtoolsApi } from './api';
import type { DevtoolsPanelProps } from './DevtoolsDrawer';

// The Network tab (spec `devtools.feature.md`, Network): the active tab's requests as main recorded
// them (masked: secret headers are `•••`, bodies never captured), filters, and a waterfall drawn
// with SVG `<rect>` attributes (never `style=`). Every URL and header is inert text. The list is
// fetched incrementally (rows changed since the last cursor, no headers, `mergeRows`); a row's
// headers are fetched only when the user opens it (`devtools.requestHeaders`).

type ReadyLog = Extract<NetworkLogAnswer, { status: 'ready' }>;

/** The tab's rows, merged from incremental answers whenever `version` changes; the last answer's counts beside them. */
function useNetworkRows(tabId: number, version: number): { readonly rows: readonly NetworkEntry[]; readonly meta: ReadyLog | null } {
  const [state, setState] = useState<{ readonly tabId: number; readonly rows: readonly NetworkEntry[]; readonly meta: ReadyLog | null }>({ tabId, rows: [], meta: null });
  const cursor = useRef({ tabId, rev: 0, rows: [] as readonly NetworkEntry[] });
  useEffect(() => {
    let live = true;
    if (cursor.current.tabId !== tabId) cursor.current = { tabId, rev: 0, rows: [] };
    void (async () => {
      // Pages until main has nothing more (`more`), each merged into what the chrome holds.
      for (let page = 0; page < 20 && live; page++) {
        const answer = await devtoolsApi.network(tabId, cursor.current.rev);
        if (!live || answer === null || answer.status !== 'ready') return;
        const rows = mergeRows(cursor.current.rows, answer);
        cursor.current = { tabId, rev: answer.rev, rows };
        setState({ tabId, rows, meta: answer });
        if (!answer.more) return;
      }
    })();
    return () => {
      live = false;
    };
  }, [tabId, version]);
  return state.tabId === tabId ? state : { rows: [], meta: null };
}

function Headers({ title, headers, omitted, testId }: { readonly title: string; readonly headers: readonly NetworkHeader[]; readonly omitted: number; readonly testId: string }) {
  return (
    <div className="devtools-headers" data-testid={testId}>
      <h3 className="devtools-subhead">{title}</h3>
      {headers.length === 0 ? <p className="devtools-muted">None recorded.</p> : null}
      <dl className="devtools-header-list">
        {headers.map((h, i) => (
          <div key={`${h.name}-${i}`} className="devtools-header" data-testid="devtools-header" data-name={h.name} data-masked={h.masked}>
            <dt>{h.name}</dt>
            <dd title={h.masked ? 'frost never stores this header’s value' : undefined}>
              <bdi>{h.value}</bdi>
              {h.truncated ? <span className="devtools-muted"> (cut)</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {omitted > 0 ? <p className="devtools-muted">{omitted === 1 ? '1 other header not kept.' : `${omitted} other headers not kept.`}</p> : null}
    </div>
  );
}

/** The open row's headers, fetched on demand (again when the row changes). */
function useRowHeaders(tabId: number, entry: NetworkEntry): NetworkHeadersAnswer | null {
  const [answer, setAnswer] = useState<{ readonly key: number; readonly value: NetworkHeadersAnswer } | null>(null);
  useEffect(() => {
    let live = true;
    void devtoolsApi.requestHeaders(tabId, entry.key).then((value) => {
      if (live && value !== null) setAnswer({ key: entry.key, value });
    });
    return () => {
      live = false;
    };
  }, [tabId, entry.key, entry.rev]);
  return answer?.key === entry.key ? answer.value : null;
}

function Details({ tabId, entry }: { readonly tabId: number; readonly entry: NetworkEntry }) {
  const headers = useRowHeaders(tabId, entry);
  return (
    <div className="devtools-details" data-testid="devtools-network-details">
      <p className="devtools-details-url">
        <span className="devtools-method">{entry.method}</span> <bdi>{entry.url}</bdi>
        {entry.urlTruncated ? <span className="devtools-muted"> (cut)</span> : null}
      </p>
      {entry.redirectTo !== null ? (
        <p className="devtools-muted">
          Redirected to <bdi>{entry.redirectTo}</bdi>
        </p>
      ) : null}
      {entry.error !== null ? <p className="devtools-error-text">{entry.error}</p> : null}
      {headers === null ? (
        <p className="devtools-muted">Loading headers…</p>
      ) : headers.status !== 'ready' ? (
        <p className="devtools-muted">This request is no longer in the log.</p>
      ) : (
        <>
          <Headers title="Request headers" headers={headers.requestHeaders} omitted={headers.omittedRequestHeaders} testId="devtools-request-headers" />
          <Headers title="Response headers" headers={headers.responseHeaders} omitted={headers.omittedResponseHeaders} testId="devtools-response-headers" />
          {headers.headersDropped ? <p className="devtools-notice-inline">Some headers weren’t kept: the log’s memory budget was full.</p> : null}
        </>
      )}
      <p className="devtools-muted">Bodies are never recorded.</p>
    </div>
  );
}

export function NetworkPanel({ tab, version }: DevtoolsPanelProps) {
  const { rows: entries, meta: log } = useNetworkRows(tab.id, version);
  const [filter, setFilter] = useState<NetworkFilter>(NO_NETWORK_FILTER);
  const [selected, setSelected] = useState<number | null>(null);
  const shown = useMemo(() => filterNetwork(entries, filter), [entries, filter]);
  const bars = useMemo(() => waterfall(shown), [shown]);
  const chosen = selected === null ? undefined : entries.find((e) => e.key === selected);
  const set = (change: Partial<NetworkFilter>) => setFilter((was) => ({ ...was, ...change }));
  const preserve = log?.preserve === true;

  return (
    <div className="devtools-network" data-testid="devtools-network">
      <div className="devtools-toolbar">
        <label className="devtools-field">
          <span className="visually-hidden">Type</span>
          <select data-testid="devtools-network-type" value={filter.type} onChange={(e) => set({ type: e.currentTarget.value as NetworkTypeFilter })}>
            {NETWORK_TYPE_FILTERS.map((type) => (
              <option key={type} value={type}>
                {type === 'all' ? 'All types' : NETWORK_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          className="devtools-search"
          data-testid="devtools-network-search"
          placeholder="Filter URLs"
          aria-label="Filter requests by URL or method"
          maxLength={NETWORK_SEARCH_MAX_CHARS}
          value={filter.search}
          onChange={(e) => set({ search: e.currentTarget.value })}
        />
        <label className="devtools-check">
          <input type="checkbox" data-testid="devtools-network-third-party" checked={filter.thirdParty} onChange={(e) => set({ thirdParty: e.currentTarget.checked })} />
          Third-party
        </label>
        <label className="devtools-check">
          <input type="checkbox" data-testid="devtools-network-failed" checked={filter.failed} onChange={(e) => set({ failed: e.currentTarget.checked })} />
          Failed
        </label>
        <label className="devtools-check">
          <input type="checkbox" data-testid="devtools-network-preserve" checked={preserve} onChange={(e) => void devtoolsApi.setPreserveLog(tab.id, e.currentTarget.checked)} />
          Preserve log
        </label>
        <span className="devtools-count" data-testid="devtools-network-count" aria-live="polite">
          {shown.length === entries.length ? `${entries.length} requests` : `${shown.length} of ${entries.length} requests`}
        </span>
      </div>
      {log && (log.notKept > 0 || log.dropped > 0 || log.overBudget.entries > 0 || log.overBudget.bytes > 0) ? (
        <p className="devtools-notice" data-testid="devtools-network-notice">
          {log.notKept > 0 ? `${log.notKept} earlier requests weren’t kept while the drawer was closed. Reload to record them all. ` : ''}
          {log.dropped > 0 ? `${log.dropped} more requests weren’t kept (the log keeps the first ${NETWORK_LIMITS.maxPerDocument.toLocaleString('en')} per page). ` : ''}
          {log.overBudget.entries > 0 || log.overBudget.bytes > 0
            ? `The log’s memory budget is full: ${log.overBudget.entries} requests and ${formatBytes(log.overBudget.bytes)} of headers and text weren’t kept.`
            : ''}
        </p>
      ) : null}
      <div className="devtools-split">
        <div className="devtools-table-wrap">
          <table className="devtools-table devtools-network-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Method</th>
                <th scope="col">Status</th>
                <th scope="col">Type</th>
                <th scope="col">Size</th>
                <th scope="col">Time</th>
                <th scope="col">Cache</th>
                <th scope="col">3rd</th>
                <th scope="col">robots.txt</th>
                <th scope="col" className="devtools-waterfall-head">
                  Waterfall
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => {
                const bar = bars.get(entry.key);
                const failed = isFailed(entry);
                return (
                  <tr
                    key={entry.key}
                    className={entry.key === selected ? 'devtools-row devtools-row-selected' : failed ? 'devtools-row devtools-row-failed' : 'devtools-row'}
                    data-testid="devtools-network-row"
                    data-type={entry.type}
                    data-status={entry.status ?? ''}
                    data-third-party={entry.thirdParty}
                    data-failed={failed}
                    data-robots={entry.robots}
                    aria-selected={entry.key === selected}
                    onClick={() => setSelected(entry.key === selected ? null : entry.key)}
                  >
                    <td className="devtools-name" title={entry.url}>
                      {/* The row's click (bubbled): selects it, shows its headers. */}
                      <button type="button" className="devtools-row-button" data-testid="devtools-network-name" aria-expanded={entry.key === selected}>
                        <bdi>{shortName(entry.url)}</bdi>
                      </button>
                    </td>
                    <td>{entry.method}</td>
                    <td data-testid="devtools-network-status">{statusLabel(entry)}</td>
                    <td data-testid="devtools-network-type-cell">{NETWORK_TYPE_LABELS[entry.type]}</td>
                    <td>{formatBytes(entry.size)}</td>
                    <td>{formatDuration(entry.durationMs)}</td>
                    <td>{entry.fromCache ? 'Cache' : ''}</td>
                    <td>{entry.thirdParty ? '3rd' : ''}</td>
                    <td className={`devtools-robots devtools-robots-${entry.robots}`}>{ROBOTS_VERDICT_LABELS[entry.robots]}</td>
                    <td className="devtools-waterfall-cell">
                      <svg className="devtools-waterfall" viewBox={`0 0 ${WATERFALL_WIDTH} 10`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
                        {bar ? <rect className={`devtools-bar devtools-bar-${entry.state}`} x={bar.x} y={2} width={bar.width} height={6} /> : null}
                      </svg>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {entries.length === 0 ? <p className="devtools-empty">No requests recorded yet. Reload the page to record its requests.</p> : null}
        </div>
        {chosen ? <Details tabId={tab.id} entry={chosen} /> : null}
      </div>
    </div>
  );
}
