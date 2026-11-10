import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FETCH_DISCLOSURE } from '@app/specs/fetcher.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { CrawlRunView, CrawlStatusView } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS, CRAWL_SCOPES, CRAWL_VIEW_TEXT, CRAWL_WATCH, type CrawlServiceAnswer } from '@app/specs/site-crawl.spec';
import { crawlPaletteSources } from '../../crawl-palette';
import {
  CRAWL_INTERVAL_CHOICES,
  CRAWL_SCOPE_LABELS,
  answerText,
  crawlFormFor,
  crawlRuleSetNote,
  crawlStartInput,
  openInTab,
  refreshDelay,
  runCrawlWatch,
  runRowOf,
  startControl,
  type CrawlForm,
  type CrawlRefreshMark,
} from '../../crawl-view';
import { useSeqChange } from '../../hooks/useSeqChange';
import { actions } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { closeScreenshotEditor, onScreenshotEditorOpened } from '../../screenshot-editor';
import { askSettingsToClose, onSettingsOpened } from '../../settings-open';
import { closeProjects, onProjectsOpened } from '../changes/projects-sheet';
import { HelpSheetFrame, type HelpSheetProps } from '../ShortcutsView';
import { crawlActions } from './crawl-actions';
import { closeCrawl, openCrawl, useCrawlSheet } from './crawl-sheet';
import { SitePages } from './SitePages';
import { SiteStructure } from './SiteStructure';
import '../../crawl.css';

// The site crawl sheet (Phase 12 Task 7, SL-096/097; acceptance `site-crawl.feature.md`, Pages and Site
// structure; plan Decision 6). Over the page column like the Help sheets (one sheet at a time), it holds:
// - the start form (start URL, by default the active tab's site; scope; include and exclude prefixes; max
//   pages; interval; sitemaps on or off), `FETCH_DISCLOSURE`, and the rule-set note (the categories of
//   `CRAWL_RULE_IDS`, what is left out and why), so the `CRAWL_SCORE_LABEL` is never read as the sidebar's
//   health score;
// - the runs from main's view, long-polled (`crawl.watch`) while the sheet is open: each with its progress,
//   size and controls (pause, resume, cancel, delete), and the note that crawl data is deleted per run;
// - the chosen run's Pages (`SitePages.tsx`) and Site structure (`SiteStructure.tsx`).
// Whether a crawl may start comes from main's view: while it says `available: false` (as shipped, L6),
// Start and Resume are disabled with `LEGAL_GATE_NOTE`; existing runs can still be viewed, exported and
// deleted. Main refuses anyway (it is the authority). Everything from a page is React text.

// The palette's crawl actions, once per module instance.
const unregisterPaletteActions = registerPaletteActions(...crawlPaletteSources({ open: (request) => openCrawl(request) }));
import.meta.hot?.dispose(unregisterPaletteActions);

/**
 * When the shown run's Pages and Site structure read again (`refreshDelay`, `CRAWL_REFRESH_MS`): at once
 * for another run or state, at most every 5 s while pages come in. `null` until the first mark.
 */
function useRefreshMark(shown: CrawlRunView | null): CrawlRefreshMark | null {
  const [mark, setMark] = useState<CrawlRefreshMark | null>(null);
  const runId = shown?.id ?? null;
  const state = shown?.state ?? null;
  const pages = shown?.counts.pages ?? 0;
  useEffect(() => {
    if (runId === null || state === null) return;
    const next = { runId, state, pages };
    const delay = refreshDelay(mark, next, Date.now());
    if (delay === null) return;
    if (delay === 0) {
      setMark({ ...next, at: Date.now() });
      return;
    }
    const timer = setTimeout(() => setMark({ ...next, at: Date.now() }), delay);
    return () => clearTimeout(timer);
  }, [mark, runId, state, pages]);
  return mark;
}

/** Main's crawl view, long-polled while `live`. */
function useCrawlView(live: boolean): CrawlStatusView | null {
  const [view, setView] = useState<CrawlStatusView | null>(null);
  useEffect(() => {
    if (!live) return;
    let running = true;
    void runCrawlWatch({
      watch: crawlActions.watch,
      onView: (next) => setView(next.status),
      isLive: () => running,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      retryMs: CRAWL_WATCH.retryMs,
    });
    return () => {
      running = false;
    };
  }, [live]);
  return view;
}

function StartForm({ view, initial, projectId, say }: { readonly view: CrawlStatusView | null; readonly initial: CrawlForm; readonly projectId: string | null; readonly say: (text: string | null) => void }) {
  const [form, setForm] = useState<CrawlForm>(initial);
  useEffect(() => setForm(initial), [initial]);
  const [busy, setBusy] = useState(false);
  const control = startControl(view);
  const noteId = useId();
  const rules = crawlRuleSetNote();
  const set = <K extends keyof CrawlForm>(key: K, value: CrawlForm[K]) => setForm((was) => ({ ...was, [key]: value }));
  const start = async () => {
    if (control.disabled || busy) return;
    const built = crawlStartInput(form, projectId);
    if (!built.ok) {
      say(built.problem);
      return;
    }
    setBusy(true);
    const answer = await crawlActions.start(built.input);
    setBusy(false);
    say(answer?.status === 'started' ? 'Crawl started.' : answerText(answer));
  };
  return (
    <section className="crawl-section crawl-start" aria-labelledby="crawl-start-title">
      <h2 className="crawl-section-title" id="crawl-start-title">
        {CRAWL_VIEW_TEXT.startTitle}
      </h2>
      <div className="crawl-form">
        <label className="crawl-field crawl-field-wide">
          <span>Start URL</span>
          <input className="crawl-input" data-testid="crawl-start-url" type="url" maxLength={CRAWL_LIMITS.maxUrlChars} value={form.startUrl} onChange={(event) => set('startUrl', event.target.value)} />
        </label>
        <label className="crawl-field">
          <span>Scope</span>
          <select className="crawl-select" data-testid="crawl-scope" value={form.scope} onChange={(event) => set('scope', event.target.value as CrawlForm['scope'])}>
            {CRAWL_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {CRAWL_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-field">
          <span>Max pages</span>
          <input className="crawl-input crawl-input-narrow" data-testid="crawl-max-pages" inputMode="numeric" value={form.maxPages} onChange={(event) => set('maxPages', event.target.value)} />
        </label>
        <label className="crawl-field">
          <span>Interval</span>
          <select className="crawl-select" data-testid="crawl-interval" value={String(form.intervalMs)} onChange={(event) => set('intervalMs', Number(event.target.value))}>
            {CRAWL_INTERVAL_CHOICES.map((ms) => (
              <option key={ms} value={String(ms)}>
                {ms / 1000} s between requests
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-check">
          <input type="checkbox" data-testid="crawl-sitemaps" checked={form.sitemaps} onChange={(event) => set('sitemaps', event.target.checked)} />
          <span>Read the site’s sitemaps</span>
        </label>
        <label className="crawl-field crawl-field-wide">
          <span>Only paths starting with (one per line)</span>
          <textarea className="crawl-input crawl-textarea" data-testid="crawl-include" rows={2} value={form.include} onChange={(event) => set('include', event.target.value)} />
        </label>
        <label className="crawl-field crawl-field-wide">
          <span>Skip paths starting with (one per line)</span>
          <textarea className="crawl-input crawl-textarea" data-testid="crawl-exclude" rows={2} value={form.exclude} onChange={(event) => set('exclude', event.target.value)} />
        </label>
      </div>
      <p className="crawl-note" data-testid="crawl-disclosure">
        robots.txt is always obeyed, one request at a time per site. {FETCH_DISCLOSURE}
      </p>
      <div className="crawl-rules" data-testid="crawl-rule-set">
        {/* The intro is always shown: the score is the crawl's own, never the sidebar's. */}
        <p className="crawl-note" data-testid="crawl-rule-set-intro">
          {CRAWL_VIEW_TEXT.ruleSetIntro} {rules.categories.join(', ')}.
        </p>
        <details className="crawl-rules-more">
          <summary>{CRAWL_VIEW_TEXT.ruleSetTitle}</summary>
          <p className="crawl-note">{CRAWL_VIEW_TEXT.ruleSetExcluded}</p>
          <ul className="crawl-rule-list">
            {rules.excluded.map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong>: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="crawl-start-row">
        {/* Disabled while main's view says no (the gate's note beside it). */}
        <button type="button" className="panel-button panel-button-primary" data-testid="crawl-start" disabled={control.disabled} aria-describedby={noteId} aria-disabled={busy || undefined} onClick={() => void start()}>
          <span>{CRAWL_VIEW_TEXT.start}</span>
        </button>
        <p className="crawl-note" id={noteId} data-testid="crawl-start-note">
          {control.note}
        </p>
      </div>
    </section>
  );
}

function RunItem({ run, view, selected, onSelect, say }: { readonly run: CrawlRunView; readonly view: CrawlStatusView; readonly selected: boolean; readonly onSelect: () => void; readonly say: (text: string | null) => void }) {
  const row = runRowOf(run, view);
  const [confirming, setConfirming] = useState(false);
  const act = async (call: Promise<CrawlServiceAnswer | null>) => say(answerText(await call));
  const resumeNoteId = useId();
  return (
    <li className="crawl-run" data-testid="crawl-run" data-selected={selected ? 'true' : undefined}>
      <div className="crawl-run-head">
        <button type="button" className="crawl-run-pick" aria-pressed={selected} data-testid="crawl-run-pick" onClick={onSelect}>
          <bdi dir="auto">{run.startUrl}</bdi>
        </button>
        <span className="crawl-run-state" data-testid="crawl-run-state">
          {row.state}
        </span>
      </div>
      <p className="crawl-note">
        {row.progress} · <span data-testid="crawl-run-size">{row.size}</span>
      </p>
      {run.note !== undefined ? <p className="crawl-note">{run.note}</p> : null}
      <div className="crawl-run-actions">
        {row.canPause ? (
          <button type="button" className="panel-button" data-testid="crawl-pause" onClick={() => void act(crawlActions.pause(run.id))}>
            <span>{CRAWL_VIEW_TEXT.pause}</span>
          </button>
        ) : null}
        {row.resume.shown ? (
          <button type="button" className="panel-button" data-testid="crawl-resume" disabled={row.resume.disabled} aria-describedby={resumeNoteId} onClick={() => void act(crawlActions.resume(run.id))}>
            <span>{CRAWL_VIEW_TEXT.resume}</span>
          </button>
        ) : null}
        {row.canCancel ? (
          <button type="button" className="panel-button" data-testid="crawl-cancel" onClick={() => void act(crawlActions.cancel(run.id))}>
            <span>{CRAWL_VIEW_TEXT.cancel}</span>
          </button>
        ) : null}
        {confirming ? (
          <span className="crawl-confirm" role="group" aria-label={CRAWL_VIEW_TEXT.deleteConfirm}>
            <span className="crawl-note">{CRAWL_VIEW_TEXT.deleteConfirm}</span>
            <button
              type="button"
              className="panel-button crawl-danger"
              data-testid="crawl-delete-confirm"
              onClick={() => {
                setConfirming(false);
                void act(crawlActions.delete(run.id));
              }}
            >
              <span>{CRAWL_VIEW_TEXT.delete}</span>
            </button>
            <button type="button" className="panel-button" data-testid="crawl-delete-keep" onClick={() => setConfirming(false)}>
              <span>Keep</span>
            </button>
          </span>
        ) : (
          <button type="button" className="panel-button" data-testid="crawl-delete" disabled={!row.canDelete} onClick={() => setConfirming(true)}>
            <span>{CRAWL_VIEW_TEXT.delete}</span>
          </button>
        )}
        <span className="crawl-note" id={resumeNoteId}>
          {row.resume.shown ? row.resume.note : null}
        </span>
      </div>
    </li>
  );
}

/** The App slot: the crawl sheet while it is open. */
export function CrawlSheet({ tab, historySeq, onOpen }: HelpSheetProps & { readonly tab: (HelpSheetProps['tab'] & { readonly url?: string }) | undefined }) {
  const { open, request } = useCrawlSheet();
  const view = useCrawlView(open);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<'pages' | 'structure'>('pages');
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;
  const tabUrl = tab?.url;
  const latestTabUrl = useRef(tabUrl);
  latestTabUrl.current = tabUrl;
  const [initial, setInitial] = useState<CrawlForm>(() => crawlFormFor(null));

  // Each open request: the other sheets close (one at a time), the form starts from the asked site or the active tab's.
  useEffect(() => {
    if (!open || request === null) return;
    if (!askSettingsToClose()) {
      closeCrawl();
      return;
    }
    closeProjects();
    closeScreenshotEditor();
    latestOnOpen.current();
    setInitial(crawlFormFor(request.startUrl ?? latestTabUrl.current, request.scope ?? 'host'));
    setStatus(null);
  }, [open, request]);
  // Another sheet opening closes this one.
  useEffect(() => onSettingsOpened(closeCrawl), []);
  useEffect(() => onScreenshotEditorOpened(closeCrawl), []);
  useEffect(() => onProjectsOpened(closeCrawl), []);
  useSeqChange(historySeq, closeCrawl);
  // Another tab, or a new document in this one, closes it (as the Help sheets): the page shows again.
  const pageKey = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seenPage = useRef(pageKey);
  useEffect(() => {
    if (seenPage.current !== pageKey && seenPage.current !== '') closeCrawl();
    seenPage.current = pageKey;
  }, [pageKey]);
  // The run shown: the one chosen, else the running one, else the newest.
  const runs = view?.runs ?? [];
  const shown = runs.find((run) => run.id === selected) ?? runs.find((run) => run.id === view?.activeRunId) ?? runs[0] ?? null;
  const openUrl = useCallback((url: string) => void openInTab(url, { close: closeCrawl, navigate: actions.navigate }), []);

  const mark = useRefreshMark(open ? shown : null);
  if (!open) return null;
  // The shown run's views read once its mark is set, and again only when the mark moves.
  const refreshKey = mark !== null && shown !== null && mark.runId === shown.id ? `${mark.state} ${mark.pages} ${mark.at}` : null;
  return (
    <HelpSheetFrame testId="crawl-view" title={CRAWL_VIEW_TEXT.title} closeLabel={CRAWL_VIEW_TEXT.close} focusSeq={request?.seq ?? 0} onClose={closeCrawl}>
      <div className="crawl">
        <p className="crawl-status" role="status" aria-live="polite" data-testid="crawl-status">
          {status}
        </p>
        <StartForm view={view} initial={initial} projectId={request?.projectId ?? null} say={setStatus} />
        <section className="crawl-section" aria-labelledby="crawl-runs-title">
          <h2 className="crawl-section-title" id="crawl-runs-title">
            Runs
          </h2>
          <p className="crawl-note" data-testid="crawl-retention-note">
            {CRAWL_VIEW_TEXT.retentionNote}
          </p>
          {view === null ? <p className="crawl-note">Loading…</p> : null}
          {view !== null && runs.length === 0 ? <p className="crawl-note">{CRAWL_VIEW_TEXT.noRuns}</p> : null}
          {view !== null && runs.length > 0 ? (
            <ul className="crawl-runs">
              {runs.map((run) => (
                <RunItem key={run.id} run={run} view={view} selected={shown?.id === run.id} onSelect={() => setSelected(run.id)} say={setStatus} />
              ))}
            </ul>
          ) : null}
        </section>
        {shown !== null ? (
          <section className="crawl-section" aria-label="The run's pages and structure">
            <div className="crawl-tabs" role="group" aria-label="Run views">
              <button type="button" className="crawl-tab" data-testid="crawl-tab-pages" aria-pressed={panel === 'pages'} onClick={() => setPanel('pages')}>
                {CRAWL_VIEW_TEXT.pagesTab}
              </button>
              <button type="button" className="crawl-tab" data-testid="crawl-tab-structure" aria-pressed={panel === 'structure'} onClick={() => setPanel('structure')}>
                {CRAWL_VIEW_TEXT.structureTab}
              </button>
            </div>
            {refreshKey === null ? null : panel === 'pages' ? <SitePages runId={shown.id} refreshKey={refreshKey} onOpenUrl={openUrl} /> : <SiteStructure runId={shown.id} refreshKey={refreshKey} onOpenUrl={openUrl} />}
          </section>
        ) : null}
      </div>
    </HelpSheetFrame>
  );
}
