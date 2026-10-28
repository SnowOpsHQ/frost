import { useSyncExternalStore } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import type { GscPerformanceRow, GscQueryRow } from '@app/specs/gsc.schema';
import { GSC_CHART, GSC_METRIC_LABELS, GSC_PANEL_TEXT, GSC_SCOPE_LABELS, type GscPanelAction, type GscPanelMetric } from '@app/specs/gsc-panel.spec';
import { GSC_QUERY_SCOPES, GSC_RANGE_DAYS, type GscDateRange } from '@app/specs/gsc.spec';
import { chartModel } from '../../gsc-chart';
import { gscPaletteSources } from '../../gsc-palette';
import { formatDay, formatMetric, gscPanelView, gscPrefs, gscReadRequest, type GscPanelView, type GscPrefs, type GscTile } from '../../gsc-view';
import { useGscData } from '../../hooks/useGscData';
import { ReloadIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { useAccountState, useGscStatus } from '../../settings-hooks';
import { requestSettings } from '../../settings-open';
import { GscIcon } from './gsc-icons';
import { PageText, Section } from './parts';
import '../../gsc-panel.css';

// The Search Console panel (Phase 4 Task 10; spec `gsc-panel.spec.ts`; acceptance `gsc-panel.feature.md`):
// the active tab's page (or its whole property) over 7, 28 or 90 days — totals, a frost-drawn line
// chart of one metric, and the top queries. It reads only while it is shown (it is mounted only while
// the sidebar is open on it), and only once main says Search Console is configured, included in the
// plan and connected. Sign-in and Connect happen in Settings (they need a click there). The chart is
// SVG attributes only (no `style=`: strict CSP); queries and the property are inert `<bdi>` text.

// The command palette's Search Console actions (`gsc-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...gscPaletteSources({ scope: () => gscPrefs.get().scope, setScope: (scope) => gscPrefs.set({ scope }) }));
import.meta.hot?.dispose(unregisterPaletteActions);

const RANGE_LABEL = (days: number) => `${days} days`;

function Controls({ prefs, view }: { readonly prefs: GscPrefs; readonly view: GscPanelView }) {
  const site = view.property?.siteUrl ?? null;
  return (
    <div className="gsc-controls">
      <div className="seo-segmented" role="group" aria-label="Scope" data-testid="gsc-scopes">
        {GSC_QUERY_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            className="seo-segment"
            data-testid="gsc-scope"
            data-scope={scope}
            aria-pressed={prefs.scope === scope}
            title={scope === 'property' && site ? site : undefined}
            onClick={() => gscPrefs.set({ scope })}
          >
            {GSC_SCOPE_LABELS[scope]}
          </button>
        ))}
      </div>
      <div className="seo-segmented" role="group" aria-label="Date range" data-testid="gsc-ranges">
        {GSC_RANGE_DAYS.map((days) => (
          <button key={days} type="button" className="seo-segment" data-testid="gsc-range" data-days={days} aria-pressed={prefs.days === days} onClick={() => gscPrefs.set({ days })}>
            {RANGE_LABEL(days)}
          </button>
        ))}
      </div>
      {site ? (
        <p className="gsc-property" data-testid="gsc-property" data-kind={view.property!.kind}>
          <span className="gsc-property-label">Property</span>
          <PageText value={site} className="seo-mono" testId="gsc-property-site" />
        </p>
      ) : null}
    </div>
  );
}

function Notice({ view, onAction }: { readonly view: GscPanelView; readonly onAction: (action: GscPanelAction) => void }) {
  const notice = view.notice!;
  return (
    <section className="gsc-notice" data-testid="gsc-notice" data-state={view.state} role="status">
      <span className="gsc-notice-art" aria-hidden="true">
        <GscIcon />
      </span>
      <p className="gsc-notice-title" data-testid="gsc-notice-title">
        {notice.title}
      </p>
      <p className="gsc-notice-message" data-testid="gsc-notice-message">
        {notice.message}
      </p>
      {notice.action ? (
        <button type="button" className="panel-button panel-button-primary gsc-notice-button" data-testid="gsc-action" data-action={notice.action} onClick={() => onAction(notice.action!)}>
          {notice.action === 'retry' ? <ReloadIcon /> : null}
          <span>{notice.actionLabel}</span>
        </button>
      ) : null}
    </section>
  );
}

function Loading() {
  return (
    <div className="gsc-loading" data-testid="gsc-loading" aria-busy="true">
      <span className="visually-hidden">{GSC_PANEL_TEXT.loading}</span>
      <div className="gsc-tiles" aria-hidden="true">
        {[0, 1, 2, 3].map((n) => (
          <span key={n} className="seo-skeleton-block gsc-skeleton-tile" />
        ))}
      </div>
      <span className="seo-skeleton-block gsc-skeleton-chart" aria-hidden="true" />
    </div>
  );
}

function Tiles({ tiles }: { readonly tiles: readonly GscTile[] }) {
  return (
    <div className="gsc-tiles" role="group" aria-label="Totals (choose the chart's metric)" data-testid="gsc-tiles">
      {tiles.map((tile) => (
        <button key={tile.metric} type="button" className="gsc-tile" data-testid="gsc-tile" data-metric={tile.metric} aria-pressed={tile.selected} onClick={() => gscPrefs.set({ metric: tile.metric })}>
          <span className="gsc-tile-label">{tile.label}</span>
          <span className="gsc-tile-value" data-testid={`gsc-total-${tile.metric}`}>
            {tile.value}
          </span>
          {tile.hint ? <span className="gsc-tile-hint">{tile.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

function Chart({ rows, metric, range }: { readonly rows: readonly GscPerformanceRow[]; readonly metric: GscPanelMetric; readonly range: GscDateRange }) {
  const model = chartModel(rows, metric, range);
  const { width, height, padLeft, padRight } = GSC_CHART;
  const last = model.xTicks.length - 1;
  return (
    <figure className="gsc-chart" data-testid="gsc-chart" data-metric={metric} data-inverted={model.inverted}>
      <svg className="gsc-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={model.summary} data-testid="gsc-chart-svg">
        <title>{model.summary}</title>
        {model.yTicks.map((tick) => (
          <g key={tick.value} className="gsc-y-tick" data-testid="gsc-y-tick" data-value={tick.value}>
            <line className="gsc-grid" x1={padLeft} x2={width - padRight} y1={tick.pos} y2={tick.pos} />
            <text className="gsc-axis-label" x={padLeft - 6} y={tick.pos} textAnchor="end" dominantBaseline="middle">
              {tick.label}
            </text>
          </g>
        ))}
        {model.xTicks.map((tick, i) => (
          <text key={tick.value} className="gsc-axis-label" data-testid="gsc-x-tick" x={tick.pos} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}>
            {tick.label}
          </text>
        ))}
        {model.segments.map((d, i) => (
          <path key={i} className="gsc-line" data-testid="gsc-line" d={d} />
        ))}
        {model.dots.map((dot) => (
          <circle key={dot.date} className="gsc-dot" data-testid="gsc-dot" cx={dot.x} cy={dot.y} r="2.6" />
        ))}
      </svg>
      {/* A table never shrinks to the 1px box itself: its wrapper is the hidden one. */}
      <div className="visually-hidden">
        <table data-testid="gsc-chart-table">
          <caption>{model.summary}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">{GSC_METRIC_LABELS[metric]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date} data-testid="gsc-chart-row" data-date={row.date} data-value={row[metric]}>
                <td>{formatDay(row.date)}</td>
                <td>{formatMetric(metric, row[metric])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function Queries({ view }: { readonly view: GscPanelView }) {
  const queries = view.queries!;
  const rows: readonly GscQueryRow[] = queries.status === 'ok' ? queries.rows : [];
  return (
    <Section title="Top queries" testId="gsc-queries" badge={queries.status === 'ok' ? <span className="seo-pill" data-tone="muted">{rows.length}</span> : undefined}>
      {queries.status === 'unavailable' ? (
        <p className="gsc-muted" data-testid="gsc-queries-unavailable">
          {queries.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="gsc-muted">{GSC_PANEL_TEXT.noQueries}</p>
      ) : (
        <table className="gsc-queries-table">
          <thead>
            <tr>
              <th scope="col">Query</th>
              <th scope="col" className="gsc-num">
                Clicks
              </th>
              <th scope="col" className="gsc-num">
                <abbr title="Impressions">Impr.</abbr>
              </th>
              <th scope="col" className="gsc-num">
                CTR
              </th>
              <th scope="col" className="gsc-num">
                <abbr title="Average position">Pos.</abbr>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} data-testid="gsc-query-row">
                <td className="gsc-query">
                  <PageText value={row.query} testId="gsc-query-text" />
                </td>
                <td className="gsc-num" data-testid="gsc-query-clicks">
                  {formatMetric('clicks', row.clicks)}
                </td>
                <td className="gsc-num">{formatMetric('impressions', row.impressions)}</td>
                <td className="gsc-num">{formatMetric('ctr', row.ctr)}</td>
                <td className="gsc-num">{formatMetric('position', row.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export function GscPanel({ tab }: { readonly tab: TabState | undefined }) {
  const gsc = useGscStatus();
  const account = useAccountState();
  const prefs = useSyncExternalStore(gscPrefs.subscribe, gscPrefs.get);
  const base = { gsc, account: account?.status ?? null, url: tab?.url ?? '', prefs, answers: null, now: Date.now() };
  const { answers, retry } = useGscData(gscReadRequest(base));
  const view = gscPanelView({ ...base, answers });
  const act = (action: GscPanelAction) => {
    if (action === 'retry') retry();
    else requestSettings(action === 'open-account' ? 'account' : 'search-console');
  };
  return (
    <div className="gsc" data-testid="gsc-panel" data-state={view.state}>
      {view.controls ? <Controls prefs={prefs} view={view} /> : null}
      {view.state === 'loading' ? <Loading /> : null}
      {view.notice ? <Notice view={view} onAction={act} /> : null}
      {view.state === 'data' && view.tiles && view.rows ? (
        <>
          <Tiles tiles={view.tiles} />
          <Chart rows={view.rows} metric={prefs.metric} range={view.range} />
          <Queries view={view} />
        </>
      ) : null}
      {view.freshness ? (
        <p className="gsc-freshness" data-testid="gsc-freshness">
          {view.freshness}
        </p>
      ) : null}
    </div>
  );
}
