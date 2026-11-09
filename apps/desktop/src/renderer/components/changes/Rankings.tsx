import { useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_RANK_RANGE,
  RANK_CSV_KINDS,
  RANK_TABLE_COLUMNS,
  RANK_VIEW_TEXT,
  type RankCsvKind,
  type RankRange,
  type RankSeriesAnswer,
  type RankTableAnswer,
  type RankTableRow,
} from '@app/specs/rankings.spec';
import { CloseIcon } from '../../icons';
import { rankingsActions } from '../../ipc';
import {
  copyCsvText,
  emptyStates,
  historyNote,
  rangeOptions,
  rankRowView,
  rankTableInput,
  rankingsRefusalText,
  rowsForTag,
  saveCsvText,
  searchSummary,
  seriesRows,
  tagOptions,
  trendPoints,
  type RankFilter,
  type RankRowView,
} from '../../rankings-view';
import { isolatedTooltip } from '../../seo-view';
import '../../rankings.css';

// A project's Rankings view (Phase 10 Task 6; acceptance `rankings.feature.md`, The views): the rank
// table of its tracked searches over a range and a tag, the history note, the empty states, Copy CSV
// and Save CSV… (main writes the clipboard and asks for the file), and one search's series with "Open
// this result page"; with no site set, a button to the project's Settings (Task 7). Everything from a
// reading (queries, URLs, domains) is React text in a `<bdi>`; the trend is an SVG polyline drawn from
// numbers (`trendPoints`); no inline styles (strict CSP).

function Text({ value, className, testId }: { readonly value: string; readonly className?: string; readonly testId?: string }) {
  return (
    <bdi className={className ?? 'rankings-text'} dir="auto" data-testid={testId}>
      {value}
    </bdi>
  );
}

/** The trend of a row's points: an inline SVG from numbers only. */
function Trend({ row }: { readonly row: RankTableRow }) {
  const trend = trendPoints(row.points);
  if (trend.empty) return <span className="rankings-muted">{RANK_VIEW_TEXT.none}</span>;
  return (
    <svg className="rankings-trend" data-testid="rankings-trend" viewBox={`0 0 ${trend.width} ${trend.height}`} width={trend.width} height={trend.height} role="img" aria-label={trend.label}>
      {trend.segments.map((points, index) => (
        <polyline key={index} className="rankings-trend-line" points={points} fill="none" />
      ))}
      {trend.dots.map((dot, index) => (
        <circle key={index} className="rankings-trend-dot" cx={dot.x} cy={dot.y} r={1.8} />
      ))}
    </svg>
  );
}

function RankRowItem({
  row,
  view,
  selected,
  seriesId,
  buttonRef,
  onOpen,
}: {
  readonly row: RankTableRow;
  readonly view: RankRowView;
  readonly selected: boolean;
  readonly seriesId: string;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
  readonly onOpen: () => void;
}) {
  return (
    <tr className="rankings-row" data-testid="rankings-row" data-key={view.key} data-outcome={view.outcome} data-capped={view.capped !== null ? 'true' : undefined} data-selected={selected ? 'true' : undefined}>
      <th scope="row" className="rankings-search">
        <button
          ref={buttonRef}
          type="button"
          className="rankings-row-open"
          data-testid="rankings-row-open"
          aria-expanded={selected}
          aria-controls={selected ? seriesId : undefined}
          aria-label={`History of ${searchSummary(row.params)}`}
          title={isolatedTooltip(view.search)}
          onClick={onOpen}
        >
          <Text value={view.search} />
        </button>
        {view.alsoIn !== '' ? <span className="rankings-also-in">{view.alsoIn}</span> : null}
      </th>
      <td>
        <Text value={view.engine} />
      </td>
      <td>
        <Text value={view.locale} />
      </td>
      <td>{view.device}</td>
      <td className="rankings-filters">
        <Text value={view.filters} />
      </td>
      <td className="rankings-tags">
        {view.tags.map((tag) => (
          <Text key={tag} value={tag} className="rankings-tag" />
        ))}
      </td>
      <td className="rankings-number rankings-position" data-testid="rankings-position">
        {view.position}
      </td>
      <td className="rankings-number rankings-change" data-direction={view.direction}>
        {view.change}
      </td>
      <td className="rankings-number">{view.best}</td>
      <td className="rankings-trend-cell">
        <Trend row={row} />
        {view.capped !== null ? (
          <span className="rankings-capped" data-testid="rankings-capped" title={view.capped}>
            <span aria-hidden="true">*</span>
            <span className="visually-hidden">{view.capped}</span>
          </span>
        ) : null}
      </td>
      <td className="rankings-when">{view.lastChecked}</td>
      {view.competitors.map((competitor) => (
        <td key={competitor.host} className="rankings-number" data-competitor={competitor.host}>
          {competitor.position}
        </td>
      ))}
    </tr>
  );
}

/** One search's series: date, position and URL per reading, newest first, and "Open this result page". */
function Series({
  id,
  projectId,
  row,
  range,
  url,
  busy,
  onOpenUrl,
  onClose,
}: {
  readonly id: string;
  readonly projectId: string;
  readonly row: RankTableRow;
  readonly range: RankRange;
  readonly url: string | null;
  readonly busy: boolean;
  readonly onOpenUrl: (url: string) => void;
  readonly onClose: () => void;
}) {
  const [answer, setAnswer] = useState<RankSeriesAnswer | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setAnswer(undefined);
    void rankingsActions.series(projectId, row.searchKey, range).then((next) => {
      if (live) setAnswer(next);
    });
    return () => {
      live = false;
    };
  }, [projectId, row.searchKey, range, row.latest?.readingId]);
  const problem = answer === undefined ? null : rankingsRefusalText(answer);
  const points = answer?.status === 'ok' ? seriesRows(answer.points) : [];
  const summary = searchSummary(row.params);
  return (
    <section className="rankings-series" id={id} data-testid="rankings-series-view" aria-label={`History of ${summary}`}>
      <div className="rankings-series-head">
        <h4 className="rankings-series-title">
          <Text value={summary} />
        </h4>
        <button type="button" className="projects-small-button" data-testid="rankings-open-result" disabled={url === null || busy} title={url === null ? undefined : isolatedTooltip(url)} onClick={() => url !== null && onOpenUrl(url)}>
          {RANK_VIEW_TEXT.openResultPage}
        </button>
        <button type="button" className="projects-icon-button" data-testid="rankings-series-close" aria-label="Close this history" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {problem !== null ? <p className="projects-empty">{problem}</p> : null}
      {answer?.status === 'ok' && points.length === 0 ? <p className="projects-empty">{RANK_VIEW_TEXT.seriesEmpty}</p> : null}
      {points.length > 0 ? (
        <table className="rankings-table rankings-series-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Position</th>
              <th scope="col">URL</th>
            </tr>
          </thead>
          <tbody data-testid="rankings-series">
            {points.map((point) => (
              <tr key={point.readingId} data-testid="rankings-series-point" data-reading={point.readingId}>
                <td className="rankings-when">{point.when}</td>
                <td className="rankings-number">{point.position}</td>
                <td className="rankings-url">
                  <Text value={point.url} />
                  {point.alsoIn !== '' ? <span className="rankings-also-in">{point.alsoIn}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function Rankings({
  projectId,
  refreshKey,
  busy,
  onOpenUrl,
  say,
  onOpenSettings,
}: {
  readonly projectId: string;
  /** Changes when the project was read again (a run captured): the table is read again. */
  readonly refreshKey: unknown;
  /** A capture run is under way: nothing opens a page (the run's tab is in front). */
  readonly busy: boolean;
  /** Loads `url` in the active tab through `browser.navigate` (and closes the sheet). */
  readonly onOpenUrl: (url: string) => void;
  readonly say: (text: string) => void;
  /** Shows the project's Settings view (where its site is set; Phase 10 Task 7). */
  readonly onOpenSettings?: () => void;
}) {
  const id = useId();
  const [filter, setFilter] = useState<RankFilter>({ range: DEFAULT_RANK_RANGE, tag: null });
  const [answer, setAnswer] = useState<RankTableAnswer | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<RankCsvKind>('table');
  const [exporting, setExporting] = useState(false);
  /** Each row's open button, so closing the series gives focus back to the row it was opened from. */
  const openButtons = useRef(new Map<string, HTMLButtonElement>());
  /** The tags the project had at the last answer: a tag it no longer has is not asked for. */
  const knownTags = useRef<readonly string[]>([]);

  useEffect(() => {
    let live = true;
    void rankingsActions.table(rankTableInput(projectId, filter, knownTags.current)).then((next) => {
      if (!live) return;
      setAnswer(next);
      if (next?.status === 'ok') {
        knownTags.current = next.tags;
        if (filter.tag !== null && !next.tags.includes(filter.tag)) setFilter((current) => ({ ...current, tag: null }));
      }
    });
    return () => {
      live = false;
    };
  }, [projectId, filter, refreshKey]);

  const input = rankTableInput(projectId, filter, knownTags.current);
  const exportCsv = async (save: boolean) => {
    setExporting(true);
    try {
      say(save ? saveCsvText(await rankingsActions.saveCsv(projectId, kind, input.range, input.tag ?? null)) : copyCsvText(await rankingsActions.copyCsv(projectId, kind, input.range, input.tag ?? null)));
    } finally {
      setExporting(false);
    }
  };

  const ok = answer?.status === 'ok' ? answer : null;
  const rows = ok ? rowsForTag(ok.rows, input.tag ?? null) : [];
  const competitors = ok?.competitors ?? [];
  const states = ok ? emptyStates({ site: ok.site, rows }) : [];
  const note = ok ? historyNote(ok.retention) : null;
  const selectedRow = rows.find((row) => row.searchKey === selected) ?? null;
  const problem = answer === undefined ? null : rankingsRefusalText(answer);
  const seriesId = `${id}-series`;
  const closeSeries = () => {
    const key = selected;
    setSelected(null);
    if (key !== null) openButtons.current.get(key)?.focus();
  };

  return (
    <section className="rankings" data-testid="rankings-view" aria-label="Rankings">
      <div className="rankings-toolbar">
        <label className="projects-field projects-profile">
          <span>Range</span>
          <select className="projects-select" data-testid="rankings-range" value={filter.range} onChange={(event) => setFilter((current) => ({ ...current, range: event.target.value as RankRange }))}>
            {rangeOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="projects-field projects-profile">
          <span>Tag</span>
          <select className="projects-select" data-testid="rankings-tag" value={input.tag ?? ''} onChange={(event) => setFilter((current) => ({ ...current, tag: event.target.value === '' ? null : event.target.value }))}>
            {tagOptions(ok?.tags ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span className="rankings-toolbar-gap" />
        <label className="projects-field projects-profile">
          <span>Export</span>
          <select className="projects-select" data-testid="rankings-export-kind" value={kind} onChange={(event) => setKind(event.target.value as RankCsvKind)}>
            {RANK_CSV_KINDS.map((option) => (
              <option key={option} value={option}>
                {RANK_VIEW_TEXT.exportKinds[option]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="projects-small-button" data-testid="rankings-copy-csv" disabled={ok === null || exporting} onClick={() => void exportCsv(false)}>
          Copy CSV
        </button>
        <button type="button" className="projects-small-button" data-testid="rankings-save-csv" disabled={ok === null || exporting} onClick={() => void exportCsv(true)}>
          Save CSV…
        </button>
      </div>

      {note !== null ? (
        <p className="projects-note" data-testid="rankings-history-note" data-limited={note.limited ? 'true' : undefined}>
          {note.text}
        </p>
      ) : null}
      {problem !== null ? (
        <p className="projects-empty" data-testid="rankings-refused">
          {problem}
        </p>
      ) : null}
      {states.includes('no-site') ? (
        <p className="rankings-notice" data-testid="rankings-no-site">
          {RANK_VIEW_TEXT.noSite}
          {onOpenSettings !== undefined ? (
            <>
              {' '}
              <button type="button" className="projects-link-button" data-testid="rankings-open-settings" onClick={onOpenSettings}>
                Open Settings
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {ok !== null && input.tag !== undefined && rows.length === 0 ? (
        <p className="rankings-notice" data-testid="rankings-no-tagged">
          {RANK_VIEW_TEXT.noTagged}
        </p>
      ) : states.includes('no-readings') ? (
        <p className="rankings-notice" data-testid="rankings-no-readings">
          {RANK_VIEW_TEXT.noReadings}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="rankings-table-wrap">
          <table className="rankings-table" data-testid="rankings-table">
            <thead>
              <tr>
                {RANK_TABLE_COLUMNS.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
                {competitors.map((host) => (
                  <th key={host} scope="col" data-competitor={host}>
                    <Text value={host} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RankRowItem
                  key={row.searchKey}
                  row={row}
                  view={rankRowView(row, competitors)}
                  selected={row.searchKey === selected}
                  seriesId={seriesId}
                  buttonRef={(element) => {
                    if (element) openButtons.current.set(row.searchKey, element);
                    else openButtons.current.delete(row.searchKey);
                  }}
                  onOpen={() => setSelected((current) => (current === row.searchKey ? null : row.searchKey))}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {ok?.truncated ? <p className="projects-note">{RANK_VIEW_TEXT.truncated}</p> : null}

      {selectedRow !== null ? (
        <Series
          key={selectedRow.searchKey}
          id={seriesId}
          projectId={projectId}
          row={selectedRow}
          range={input.range}
          url={rankRowView(selectedRow, []).url}
          busy={busy}
          onOpenUrl={onOpenUrl}
          onClose={closeSeries}
        />
      ) : null}
    </section>
  );
}
