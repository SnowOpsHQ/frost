import { useEffect, useRef, useState } from 'react';
import { RANK_VIEW_TEXT, rankLabel, type CompareAnswer, type RankTableRow, type ReadingDate } from '@app/specs/rankings.spec';
import { rankingsActions } from '../../ipc';
import { rankCheckShown } from '../../projects-view';
import { compareFeatureRows, compareProblem, compareSideLabel, compareViewRows, defaultComparePicks, noReadingsText, rankingsRefusalText, readingDateOptions, searchSummary } from '../../rankings-view';
import '../../rankings.css';

// A project's Compare view (Phase 10 Task 6; acceptance `rankings.feature.md`, The views): two pickers,
// A and B, each a tracked search and a date of it, and the two readings side by side: the site's
// position on each, every domain's place and movement (the site and competitors marked) and the SERP
// features on each page. Everything from a reading is React text in a `<bdi>`; no inline styles.

function Text({ value, className }: { readonly value: string; readonly className?: string }) {
  return (
    <bdi className={className ?? 'rankings-text'} dir="auto">
      {value}
    </bdi>
  );
}

type Side = 'a' | 'b';

/**
 * One search's readings for a picker: `dates` `undefined` while a new search is read, `null` when the
 * read failed (`problem` says why). A refresh of the same search keeps the dates shown until the new
 * ones arrive. `searchKey` `null`: nothing is read (no search, or the other picker's read is shared).
 */
interface DatesState {
  readonly key: string | null;
  readonly dates: readonly ReadingDate[] | null | undefined;
  readonly problem: string | null;
}

const IDLE_DATES: DatesState = { key: null, dates: undefined, problem: null };

function useReadingDates(projectId: string, searchKey: string | null, refreshKey: unknown): DatesState {
  const [state, setState] = useState<DatesState>(IDLE_DATES);
  useEffect(() => {
    if (searchKey === null) return;
    let live = true;
    setState((current) => (current.key === searchKey ? current : { key: searchKey, dates: undefined, problem: null }));
    void rankingsActions.readingDates(projectId, searchKey).then((answer) => {
      if (!live) return;
      setState(answer?.status === 'ok' ? { key: searchKey, dates: answer.dates, problem: null } : { key: searchKey, dates: null, problem: rankingsRefusalText(answer) });
    });
    return () => {
      live = false;
    };
  }, [projectId, searchKey, refreshKey]);
  if (searchKey === null) return IDLE_DATES;
  return state.key === searchKey ? state : { key: searchKey, dates: undefined, problem: null };
}

/** A side's pick once its dates are known: kept while it is still one of them, else the side's first choice. */
function pickFor(current: string | null, dates: readonly ReadingDate[], first: string | null): string | null {
  return current !== null && dates.some((date) => date.readingId === current) ? current : first;
}

function Picker({
  side,
  searches,
  searchKey,
  dates,
  readingId,
  onSearch,
  onDate,
}: {
  readonly side: Side;
  readonly searches: readonly RankTableRow[];
  readonly searchKey: string | null;
  readonly dates: DatesState;
  readonly readingId: string | null;
  readonly onSearch: (key: string) => void;
  readonly onDate: (readingId: string) => void;
}) {
  const name = side.toUpperCase();
  return (
    <fieldset className="compare-picker" data-testid={`compare-picker-${side}`}>
      <legend className="retention-legend">{name}</legend>
      <label className="projects-field">
        <span>Search</span>
        <select className="projects-select" data-testid={`compare-search-${side}`} aria-label={`Search ${name}`} value={searchKey ?? ''} disabled={searches.length === 0} onChange={(event) => onSearch(event.target.value)}>
          {searches.map((row) => (
            <option key={row.searchKey} value={row.searchKey}>
              {searchSummary(row.params)}
            </option>
          ))}
        </select>
      </label>
      <label className="projects-field">
        <span>Date</span>
        <select className="projects-select" data-testid={`compare-date-${side}`} aria-label={`Date ${name}`} value={readingId ?? ''} disabled={!dates.dates || dates.dates.length === 0} onChange={(event) => onDate(event.target.value)}>
          {(dates.dates ?? []).length === 0 ? <option value="">{dates.dates === undefined ? 'Reading…' : (dates.problem ?? RANK_VIEW_TEXT.compareNoDates)}</option> : null}
          {readingDateOptions(dates.dates ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {dates.problem !== null ? (
        <p className="projects-empty" data-testid={`compare-dates-refused-${side}`}>
          {dates.problem}
        </p>
      ) : null}
    </fieldset>
  );
}

function Result({ answer }: { readonly answer: CompareAnswer | null }) {
  const problem = rankingsRefusalText(answer);
  if (answer === null || answer.status !== 'ok') return <p className="projects-empty">{problem}</p>;
  const { comparison } = answer;
  const sides = { a: compareSideLabel(comparison.a), b: compareSideLabel(comparison.b) };
  const rows = compareViewRows(comparison);
  const features = compareFeatureRows(comparison);
  return (
    <div className="compare-result" data-testid="compare-result">
      <dl className="compare-sides">
        {(['a', 'b'] as const).map((side) => (
          <div key={side} className="compare-side" data-side={side} data-status={sides[side].status}>
            <dt>{side.toUpperCase()}</dt>
            <dd>
              <Text value={sides[side].search} />
              <span className="rankings-muted"> · {sides[side].when}</span>
            </dd>
          </div>
        ))}
      </dl>
      {comparison.site !== null ? (
        <p className="compare-site" data-testid="compare-site">
          {RANK_VIEW_TEXT.siteRole}: A {rankLabel(comparison.site.a)} · B {rankLabel(comparison.site.b)}
        </p>
      ) : (
        <p className="rankings-notice">{RANK_VIEW_TEXT.noSite}</p>
      )}
      {rows.length > 0 ? (
        <div className="rankings-table-wrap">
          <table className="rankings-table compare-table">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">A</th>
                <th scope="col">B</th>
                <th scope="col">Movement</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.domain} className="compare-row" data-testid="compare-row" data-domain={row.domain} data-movement={row.movement} data-role={row.role ?? undefined}>
                  <th scope="row">
                    <Text value={row.domain} />
                    {row.roleLabel !== '' ? <span className="compare-role">{row.roleLabel}</span> : null}
                  </th>
                  <td className="rankings-number">{row.a}</td>
                  <td className="rankings-number">{row.b}</td>
                  <td className="compare-movement" data-movement={row.movement}>
                    {row.movementLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="projects-empty">No organic results on either page.</p>
      )}
      {comparison.truncated ? <p className="projects-note">{RANK_VIEW_TEXT.compareTruncated}</p> : null}
      {features.length > 0 ? (
        <table className="rankings-table compare-features">
          <thead>
            <tr>
              <th scope="col">SERP feature</th>
              <th scope="col">A</th>
              <th scope="col">B</th>
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature.type} data-testid="compare-feature" data-feature={feature.type}>
                <th scope="row">{feature.label}</th>
                <td>{feature.a}</td>
                <td>{feature.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function Compare({ projectId, refreshKey }: { readonly projectId: string; readonly refreshKey: unknown }) {
  const [searches, setSearches] = useState<readonly RankTableRow[] | undefined>(undefined);
  const [tableProblem, setTableProblem] = useState<string | null>(null);
  const [searchA, setSearchA] = useState<string | null>(null);
  const [searchB, setSearchB] = useState<string | null>(null);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const [answer, setAnswer] = useState<CompareAnswer | null | undefined>(undefined);
  const [comparing, setComparing] = useState(false);
  /** The picks as they are now, for an answer that arrives after they changed. */
  const picks = useRef({ a: pickA, b: pickB });
  picks.current = { a: pickA, b: pickB };

  // The tracked searches (the rows do not depend on the range: the shortest is the lightest read). A
  // refresh that fails keeps the list shown and says why.
  useEffect(() => {
    let live = true;
    void rankingsActions.table({ projectId, range: '7d' }).then((next) => {
      if (!live) return;
      if (next?.status !== 'ok') return setTableProblem(rankingsRefusalText(next));
      const rows = next.rows;
      setTableProblem(null);
      setSearches(rows);
      const first = rows.find((row) => row.latest !== null)?.searchKey ?? rows[0]?.searchKey ?? null;
      const known = (key: string | null) => key !== null && rows.some((row) => row.searchKey === key);
      setSearchA((current) => (known(current) ? current : first));
      setSearchB((current) => (known(current) ? current : first));
    });
    return () => {
      live = false;
    };
  }, [projectId, refreshKey]);

  // One search on both sides: one read of its dates.
  const shared = searchA !== null && searchA === searchB;
  const datesA = useReadingDates(projectId, searchA, refreshKey);
  const ownDatesB = useReadingDates(projectId, shared ? null : searchB, refreshKey);
  const datesB = shared ? datesA : ownDatesB;
  // Each side's pick once its dates are known (one search: A the second-newest, B the newest). While
  // dates are read again the picks stay; a failed read clears them.
  const listA = datesA.dates;
  const listB = datesB.dates;
  useEffect(() => {
    if (listA === undefined) return;
    setPickA((current) => (listA === null ? null : pickFor(current, listA, shared ? defaultComparePicks(listA).a : (listA[0]?.readingId ?? null))));
  }, [listA, shared]);
  useEffect(() => {
    if (listB === undefined) return;
    setPickB((current) => (listB === null ? null : pickFor(current, listB, defaultComparePicks(listB).b)));
  }, [listB]);
  // A new pick: the old result no longer says what is picked.
  useEffect(() => setAnswer(undefined), [pickA, pickB]);

  const problem = compareProblem(pickA, pickB);
  const compare = async () => {
    if (pickA === null || pickB === null || problem !== null) return;
    const asked = { a: pickA, b: pickB };
    setComparing(true);
    try {
      const next = await rankingsActions.compare(projectId, asked.a, asked.b);
      // The picks moved on while it was read: that answer is not of what is picked now.
      if (picks.current.a === asked.a && picks.current.b === asked.b) setAnswer(next);
    } finally {
      setComparing(false);
    }
  };
  const choose = (side: Side, key: string) => {
    if (side === 'a') {
      setSearchA(key);
      setPickA(null);
    } else {
      setSearchB(key);
      setPickB(null);
    }
  };

  return (
    <section className="compare" data-testid="compare-view" aria-label="Compare searches">
      {tableProblem !== null ? (
        <p className="projects-empty" data-testid="compare-refused">
          {tableProblem}
        </p>
      ) : null}
      {tableProblem === null && searches !== undefined && searches.length === 0 ? <p className="rankings-notice">{noReadingsText(rankCheckShown())}</p> : null}
      <div className="compare-pickers">
        <Picker side="a" searches={searches ?? []} searchKey={searchA} dates={datesA} readingId={pickA} onSearch={(key) => choose('a', key)} onDate={setPickA} />
        <Picker side="b" searches={searches ?? []} searchKey={searchB} dates={datesB} readingId={pickB} onSearch={(key) => choose('b', key)} onDate={setPickB} />
      </div>
      <div className="compare-actions">
        <button type="button" className="panel-button panel-button-primary" data-testid="compare-run" disabled={problem !== null || comparing} onClick={() => void compare()}>
          <span>Compare</span>
        </button>
        {problem !== null && searches && searches.length > 0 ? <p className="projects-note">{problem}</p> : null}
      </div>
      {answer !== undefined ? <Result answer={answer} /> : null}
    </section>
  );
}
