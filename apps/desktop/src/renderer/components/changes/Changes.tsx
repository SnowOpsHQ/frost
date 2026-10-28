import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { DIFF_FIELD_LABELS, DIFF_REGION_LABELS, type Change, type SnapshotDiff } from '@app/specs/capture.spec';
import { CAPTURE_REFUSAL_MESSAGES, type CaptureAnswer, type HistoryCursor, type HistoryVersion } from '@app/specs/changes.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { changesPaletteSources, onPageCaptured } from '../../changes-palette';
import {
  CHANGE_KIND_LABELS,
  FIRST_HISTORY_GOAL,
  MAX_HISTORY_READS,
  canCapture,
  captureCountText,
  countBadge,
  captureInput,
  captureOutcomeKind,
  captureOutcomeText,
  compareFrom,
  contextLabel,
  groupByLane,
  groupChangesByRegion,
  historyGoalMet,
  historyReadLimit,
  mergeHistory,
  olderInLane,
  pageUrlOf,
  regionCount,
  shownLane,
  unchangedRegions,
  versionSummaryText,
  type HistoryGoal,
  type Lane,
} from '../../changes-view';
import { ReloadIcon } from '../../icons';
import { ipc } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { formatCount } from '../../seo-view';
import { captureProject, useCaptureProject } from './capture-project';
import { CaptureGlyph, ChangesIcon } from './changes-icons';

// The Changes panel (acceptance `changes-panel.feature.md`): the current page's captured versions,
// newest first and grouped into lanes, "Capture now", and the diff of two versions of a lane, by
// region. Its history is independent of the audit: the sidebar shows this panel before its audit
// states, and only capturing needs a ready audit. Everything from the page is React text in a
// `<bdi>` (never markup, never a link); no inline styles (strict CSP).

/** `changes.capture` of `tabId` (into `projectId`, Unfiled when `undefined`); `null` on an IPC failure. */
const capturePage = (tabId: number, projectId?: string): Promise<CaptureAnswer | null> => ipc.changes.capture.mutate(captureInput(tabId, projectId)).catch(() => null);

// The command palette's Changes actions (`changes-palette.ts`), once per module instance. They capture
// into the same project as the panel (`capture-project.ts`, the one seam Task 6's picker sets).
const unregisterPaletteActions = registerPaletteActions(...changesPaletteSources({ capture: (tabId) => capturePage(tabId, captureProject()) }));
import.meta.hot?.dispose(unregisterPaletteActions);

type AuditState = 'none' | SeoAuditResponse['status'];

/** A version's time, to the second (two captures in one minute read differently). */
const versionTime = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** Page text: inert, bidi-isolated, shown whole (wrapping anywhere). */
function Text({ value, testId }: { readonly value: string; readonly testId?: string }) {
  return (
    <bdi className="changes-text" dir="auto" data-testid={testId}>
      {value}
    </bdi>
  );
}

function Hint({ testId, title, message }: { readonly testId: string; readonly title: string; readonly message: string }) {
  return (
    <div className="seo-hint changes-hint" data-testid={testId}>
      <span className="seo-hint-art" aria-hidden="true">
        <ChangesIcon className="panel-art" />
      </span>
      <p className="seo-hint-title">{title}</p>
      <p className="seo-hint-message">{message}</p>
    </div>
  );
}

// ---- History -------------------------------------------------------------------------------------

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly versions: readonly HistoryVersion[]; readonly next: HistoryCursor | null; readonly loadingMore: boolean; readonly moreFailed: boolean };

/** Reads `url`'s history, newest first, following the cursor until `goal` is met (at most `MAX_HISTORY_READS` pages). */
async function readHistory(url: string, goal: HistoryGoal): Promise<{ versions: HistoryVersion[]; next: HistoryCursor | null }> {
  let versions: HistoryVersion[] = [];
  let next: HistoryCursor | null = null;
  for (let read = 0; read < MAX_HISTORY_READS; read++) {
    const limit = historyReadLimit(versions.length, goal);
    const answer = await ipc.changes.history.query(next === null ? { url, limit } : { url, cursor: next, limit });
    versions = mergeHistory(versions, answer.versions);
    next = answer.next;
    if (historyGoalMet(versions, next !== null, goal)) break;
  }
  return { versions, next };
}

/**
 * The page's history: read on mount, and again on `reload(goal)` (after a capture: as many versions
 * as were listed, and the captured one, so neither "Load more" nor the captured lane is lost);
 * `loadMore()` follows the cursor.
 */
function useHistory(url: string) {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const goal = useRef<HistoryGoal>(FIRST_HISTORY_GOAL);
  useEffect(() => {
    let live = true;
    readHistory(url, goal.current)
      .then((answer) => {
        if (live) setState({ status: 'ready', versions: answer.versions, next: answer.next, loadingMore: false, moreFailed: false });
      })
      .catch(() => {
        if (live) setState({ status: 'error' });
      });
    return () => {
      live = false;
    };
  }, [url, generation]);
  const reload = useCallback((next: HistoryGoal = FIRST_HISTORY_GOAL) => {
    goal.current = next;
    setGeneration((n) => n + 1);
  }, []);
  const loadMore = () => {
    if (state.status !== 'ready' || state.next === null || state.loadingMore) return;
    const { next } = state;
    setState({ ...state, loadingMore: true, moreFailed: false });
    // Only the read this cursor started may settle it (a reload in between replaced the list).
    const settle = (change: (current: Extract<HistoryState, { status: 'ready' }>) => HistoryState) => setState((current) => (current.status === 'ready' && current.next === next ? change(current) : current));
    ipc.changes.history
      .query({ url, cursor: next, limit: FIRST_HISTORY_GOAL.want })
      .then((answer) => settle((current) => ({ ...current, versions: mergeHistory(current.versions, answer.versions), next: answer.next, loadingMore: false })))
      .catch(() => settle((current) => ({ ...current, loadingMore: false, moreFailed: true })));
  };
  return { state, reload, loadMore };
}

/** Moves focus between the versions with the arrow keys, Home and End (Enter and Space select: they are buttons). */
function onVersionKey(event: KeyboardEvent<HTMLOListElement>): void {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.changes-version')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const last = buttons.length - 1;
  const to = { ArrowDown: Math.min(at + 1, last), ArrowUp: Math.max(at - 1, 0), Home: 0, End: last }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  buttons[to]!.focus();
}

function VersionList({ lane, selected, onSelect }: { readonly lane: Lane; readonly selected: string; readonly onSelect: (versionId: string) => void }) {
  return (
    <ol className="changes-versions" aria-label="Versions, newest first" onKeyDown={onVersionKey}>
      {lane.versions.map((version) => {
        const isSelected = version.versionId === selected;
        return (
          <li key={version.versionId}>
            <button
              type="button"
              className="changes-version"
              data-testid="changes-version"
              data-version-id={version.versionId}
              data-selected={isSelected}
              aria-pressed={isSelected}
              // Roving: Tab reaches the list once (on the selected version); the arrows move within it.
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(version.versionId)}
            >
              <span className="changes-version-head">
                <span className="changes-version-time" data-testid="changes-version-time">
                  {versionTime(version.createdAt)}
                </span>
                <span className="changes-version-count" data-testid="changes-version-count">
                  {captureCountText(version.captureCount)}
                </span>
              </span>
              <span className="changes-version-summary" data-testid="changes-version-summary" data-first={version.parentVersionId === null}>
                {versionSummaryText(version)}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function LaneChips({ lanes, shown, more, onChoose }: { readonly lanes: readonly Lane[]; readonly shown: string; readonly more: boolean; readonly onChoose: (key: string) => void }) {
  return (
    <div className="seo-chips changes-lanes" role="group" aria-label="Capture lanes: render profile and search" data-testid="changes-lanes">
      {lanes.map((lane) => (
        <button key={lane.key} type="button" className="seo-chip-button" data-testid="changes-lane" data-lane={lane.key} aria-pressed={lane.key === shown} onClick={() => onChoose(lane.key)}>
          <span className="changes-lane-label">{lane.label}</span>
          <span className="seo-segment-count">{countBadge(lane.versions.length, more)}</span>
        </button>
      ))}
    </div>
  );
}

// ---- Diff ----------------------------------------------------------------------------------------

type DiffState = { readonly key: string } & ({ readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready'; readonly diff: SnapshotDiff | null });

/** The diff of two versions of a lane (`null` pair: nothing to read), and a way to read it again. */
function useDiff(fromId: string | null, toId: string | null): { readonly state: DiffState | null; readonly retry: () => void } {
  const key = fromId === null || toId === null ? null : `${fromId}:${toId}`;
  const [state, setState] = useState<DiffState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (fromId === null || toId === null) return;
    let live = true;
    const key = `${fromId}:${toId}`;
    setState({ key, status: 'loading' });
    ipc.changes.diff
      .query({ fromVersionId: fromId, toVersionId: toId })
      .then((diff) => live && setState({ key, status: 'ready', diff }))
      .catch(() => live && setState({ key, status: 'error' }));
    return () => {
      live = false;
    };
  }, [fromId, toId, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  if (key === null) return { state: null, retry };
  return { state: state?.key === key ? state : { key, status: 'loading' }, retry };
}

function ChangeItem({ change }: { readonly change: Change }) {
  const segments = change.segments && change.segments.length > 0 ? change.segments : null;
  return (
    <li className="changes-change" data-testid="changes-change" data-field={change.field} data-kind={change.kind}>
      <div className="changes-change-head">
        <span className="changes-change-field" data-testid="changes-change-field">
          {DIFF_FIELD_LABELS[change.field]}
        </span>
        <span className="changes-kind" data-kind={change.kind} data-testid="changes-change-kind">
          {CHANGE_KIND_LABELS[change.kind]}
        </span>
      </div>
      {segments ? (
        <p className="changes-segments" data-testid="changes-change-segments">
          <bdi dir="auto">
            {segments.map((segment, i) => (
              <span key={i} className="changes-segment" data-op={segment.op} data-testid="changes-segment">
                {segment.text}
              </span>
            ))}
          </bdi>
        </p>
      ) : (
        <dl className="changes-sides">
          {change.before !== null ? (
            <>
              <dt>Before</dt>
              <dd>
                <Text value={change.before} testId="changes-change-before" />
              </dd>
            </>
          ) : null}
          {change.after !== null ? (
            <>
              <dt>After</dt>
              <dd>
                <Text value={change.after} testId="changes-change-after" />
              </dd>
            </>
          ) : null}
        </dl>
      )}
      {change.context !== null && change.context !== '' ? (
        <p className="changes-context" data-testid="changes-change-context">
          <span className="changes-context-label">{contextLabel(change.field)}</span> <Text value={change.context} />
        </p>
      ) : null}
    </li>
  );
}

function DiffBody({ diff }: { readonly diff: SnapshotDiff }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const groups = groupChangesByRegion(diff.changes);
  const unchanged = unchangedRegions(diff);
  return (
    <>
      {diff.truncated ? (
        <p className="changes-note" data-tone="warn" data-testid="changes-truncated">
          Showing the first {formatCount(diff.changes.length)} of {formatCount(diff.changeCount)} changes.
        </p>
      ) : null}
      {diff.partial ? (
        <p className="changes-note" data-tone="warn" data-testid="changes-partial">
          One of these captures was cut short (a cap or the deadline), so some changes may be missing and removals are not reported.
        </p>
      ) : null}
      {groups.length === 0 ? <p className="seo-empty-line" data-testid="changes-diff-same">These versions read the same.</p> : null}
      {groups.map((group) => (
        <section key={group.region} className="changes-region" data-testid="changes-diff-region" data-region={group.region}>
          <h4 className="changes-region-title">
            <span>{group.label}</span> <span className="seo-badge">{formatCount(regionCount(diff.summary[group.region]))}</span>
          </h4>
          <ul className="changes-list">
            {group.changes.map((change, i) => (
              <ChangeItem key={i} change={change} />
            ))}
          </ul>
        </section>
      ))}
      {unchanged.length > 0 ? (
        <div className="changes-unchanged-block">
          <button type="button" className="seo-action changes-unchanged-toggle" data-testid="changes-unchanged-toggle" aria-expanded={showUnchanged} onClick={() => setShowUnchanged(!showUnchanged)}>
            {showUnchanged ? 'Hide unchanged regions' : 'Show unchanged regions'}
          </button>
          {showUnchanged ? (
            <ul className="changes-unchanged" data-testid="changes-unchanged" aria-label="Regions with no change">
              {unchanged.map((region) => (
                <li key={region}>{DIFF_REGION_LABELS[region]}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function DiffView({ lane, to, compareWith, onCompare, hasMore, onLoadMore }: {
  readonly lane: Lane;
  readonly to: HistoryVersion;
  readonly compareWith: string | null;
  readonly onCompare: (versionId: string) => void;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
}) {
  const from = compareFrom(lane, to.versionId, compareWith);
  const older = olderInLane(lane, to.versionId);
  const { state, retry } = useDiff(from?.versionId ?? null, to.versionId);
  const shown = from === null ? (to.parentVersionId === null ? 'first' : hasMore ? 'more' : 'removed') : state === null || state.status === 'loading' ? 'loading' : state.status === 'error' ? 'error' : state.diff === null ? 'none' : 'ready';
  const diff = state?.status === 'ready' ? state.diff : null;
  return (
    <section className="seo-section changes-diff" data-testid="changes-diff" data-state={shown} aria-busy={shown === 'loading'}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">What changed</h3>
        {shown === 'ready' && diff ? <span className="seo-badge">{formatCount(diff.changeCount)}</span> : null}
      </header>
      <p className="changes-pair">
        <span className="changes-pair-label">Version of</span> <span className="changes-pair-time">{versionTime(to.createdAt)}</span>
      </p>
      {older.length > 0 ? (
        <label className="changes-compare">
          <span className="changes-pair-label">Compare with…</span>
          <select className="seo-select" data-testid="changes-compare" value={from?.versionId ?? ''} onChange={(event) => onCompare(event.target.value)}>
            {older.map((version) => (
              <option key={version.versionId} value={version.versionId}>
                {`${versionTime(version.createdAt)} · ${captureCountText(version.captureCount)}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {shown === 'first' ? <p className="seo-empty-line">First capture: there is nothing to compare it with yet.</p> : null}
      {shown === 'removed' ? <p className="seo-empty-line">Earlier versions removed: the version before this one is no longer kept.</p> : null}
      {shown === 'more' ? (
        <p className="seo-empty-line">
          The version before this one is further back.{' '}
          <button type="button" className="seo-action" onClick={onLoadMore}>
            Load more
          </button>
        </p>
      ) : null}
      {shown === 'loading' ? <p className="seo-empty-line">Comparing…</p> : null}
      {shown === 'error' ? (
        <div className="changes-error" data-testid="changes-diff-error">
          <p className="seo-empty-line">The diff could not be read.</p>
          <button type="button" className="panel-button" data-testid="changes-diff-retry" onClick={retry}>
            <ReloadIcon />
            <span>Retry</span>
          </button>
        </div>
      ) : null}
      {shown === 'none' ? <p className="seo-empty-line">These versions cannot be compared.</p> : null}
      {shown === 'ready' && diff ? <DiffBody key={`${from?.versionId}:${to.versionId}`} diff={diff} /> : null}
    </section>
  );
}

// ---- The panel -----------------------------------------------------------------------------------

/** Why Capture now is off (no settled, ready audit of the loaded page). */
function captureHint(audit: AuditState, loading: boolean): string {
  if (loading) return 'Wait for the page to finish loading, then capture it.';
  return audit === 'unavailable' ? 'This page has no audit, so it cannot be captured now.' : CAPTURE_REFUSAL_MESSAGES['no-audit'];
}

function PageChanges({ tab, response }: { readonly tab: TabState; readonly response: SeoAuditResponse | null }) {
  const history = useHistory(pageUrlOf(tab.url));
  const { reload } = history;
  // The project captures go to (`capture-project.ts`: Task 6's picker sets it; Unfiled until then).
  const projectId = useCaptureProject();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly text: string; readonly kind: string } | null>(null);
  const [chosenLane, setChosenLane] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const audit: AuditState = response?.status ?? 'none';
  const ready = response?.status === 'ready';
  const capturable = canCapture(tab, response);
  const { state } = history;
  const versions = state.status === 'ready' ? state.versions : [];

  /** After a capture (here or from the palette): its lane, newest first; the history re-read as far as it was listed. */
  const listed = useRef(0);
  listed.current = versions.length;
  const afterCapture = useCallback(
    (answer: CaptureAnswer | null) => {
      if (answer?.status !== 'captured') return;
      setCaptured(answer.versionId);
      setChosenLane(null);
      setSelected(null);
      setCompareWith(null);
      reload({ want: listed.current, include: answer.versionId });
    },
    [reload],
  );
  useEffect(() => onPageCaptured(afterCapture), [afterCapture]);

  const capture = async () => {
    setBusy(true);
    setOutcome(null);
    const answer = await capturePage(tab.id, projectId);
    setBusy(false);
    setOutcome({ text: captureOutcomeText(answer), kind: captureOutcomeKind(answer) });
    afterCapture(answer);
  };

  const lanes = groupByLane(versions);
  const lane = shownLane(lanes, chosenLane ?? versions.find((version) => version.versionId === captured)?.laneKey ?? null);
  const to = lane ? (lane.versions.find((version) => version.versionId === selected) ?? lane.versions[0]!) : null;
  const select = (versionId: string) => {
    setSelected(versionId);
    setCompareWith(null);
  };

  return (
    <div className="changes" data-testid="changes" data-audit={audit} data-audit-at={ready ? response.audit.takenAt : undefined}>
      <section className="seo-section changes-capture-card">
        <div className="changes-capture-row">
          <button type="button" className="panel-button panel-button-primary changes-capture" data-testid="changes-capture" data-busy={busy} disabled={!capturable || busy} onClick={() => void capture()}>
            <CaptureGlyph />
            <span>{busy ? 'Capturing…' : 'Capture now'}</span>
          </button>
          {/* Task 6: the project picker goes here (`setCaptureProject`; Unfiled until then). */}
        </div>
        {!capturable ? (
          <p className="changes-note" data-testid="changes-capture-hint">
            {captureHint(audit, tab.loading)}
          </p>
        ) : null}
        <p className="changes-status" role="status" aria-live="polite" data-testid="changes-capture-status" data-outcome={outcome?.kind ?? ''}>
          {outcome?.text ?? ''}
        </p>
      </section>
      {state.status === 'loading' ? (
        <p className="seo-empty-line changes-loading" data-testid="changes-loading" aria-busy="true">
          Reading this page’s history…
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className="changes-error" data-testid="changes-error" role="alert">
          <p className="seo-empty-line">The history of this page could not be read.</p>
          <button type="button" className="panel-button" onClick={() => reload()}>
            <ReloadIcon />
            <span>Retry</span>
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && lane === null ? <Hint testId="changes-empty" title="No captures of this page yet" message="Capture now keeps what this page tells search engines, so later captures can show what changed, region by region." /> : null}
      {state.status === 'ready' && lane !== null && to !== null ? (
        <>
          {lanes.length > 1 ? (
            <LaneChips
              lanes={lanes}
              shown={lane.key}
              more={state.next !== null}
              onChoose={(key) => {
                setChosenLane(key);
                setSelected(null);
                setCompareWith(null);
              }}
            />
          ) : null}
          <section className="seo-section changes-history" data-testid="changes-history" data-lane={lane.key}>
            <header className="seo-section-head">
              <h3 className="seo-section-title">History</h3>
              <span className="seo-badge">{countBadge(lane.versions.length, state.next !== null)}</span>
            </header>
            <VersionList lane={lane} selected={to.versionId} onSelect={select} />
            {state.next !== null ? (
              <button type="button" className="seo-action changes-load-more" data-testid="changes-load-more" data-busy={state.loadingMore} disabled={state.loadingMore} onClick={history.loadMore}>
                {state.loadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
            {state.moreFailed ? <p className="seo-empty-line">More versions could not be read.</p> : null}
          </section>
          <DiffView lane={lane} to={to} compareWith={compareWith} onCompare={setCompareWith} hasMore={state.next !== null} onLoadMore={history.loadMore} />
        </>
      ) : null}
    </div>
  );
}

/** The Changes panel for the active tab (`response`: its audit as the sidebar shows it; history does not wait for it). */
export function Changes({ tab, response }: { readonly tab: TabState | undefined; readonly response: SeoAuditResponse | null }) {
  if (!tab || !isWebUrl(tab.url) || tab.error !== null || tab.crashed) {
    return (
      <div className="changes" data-testid="changes" data-audit={response?.status ?? 'none'}>
        <Hint testId="changes-no-page" title="No page to track" message="Open a web page (http or https) to capture it and see how it changes over time." />
      </div>
    );
  }
  // A new tab or page starts afresh: its own history, lanes, selection and capture outcome. An
  // in-page anchor (`#fragment`) is the same page.
  return <PageChanges key={`${tab.id} ${pageUrlOf(tab.url)}`} tab={tab} response={response} />;
}
