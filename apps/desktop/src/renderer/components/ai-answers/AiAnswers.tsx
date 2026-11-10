import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AI_ANSWER_RETENTION_LABELS, AI_ANSWER_RETENTIONS, AI_ANSWERS_LIMITS, AI_ANSWERS_VIEW_TEXT as TEXT, aiAnswerRetentionDeletes, type AiAnswerRetention } from '@app/specs/ai-answers.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { AiAnswerRecord, AiAnswerSummary, AiAnswersView } from '@app/specs/ai-answers.schema';
import { AI_SEARCH_VIA_SETTINGS, type AiSearchEngine, type AiSearchViaSetting } from '@app/specs/ai-search.spec';
import { aiAnswersPaletteSources } from '../../ai-answers-palette';
import { askControl, engineChoices, engineLabel, engineNote, engineToAsk, openInTab, runAnswerText, settingResultText, sourcesText, viaChoiceDisabled, watchedDomainOf, whenText } from '../../ai-answers-view';
import { useSeqChange } from '../../hooks/useSeqChange';
import { actions } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { closeScreenshotEditor, onScreenshotEditorOpened } from '../../screenshot-editor';
import { askSettingsToClose, onSettingsOpened } from '../../settings-open';
import { closeProjects, onProjectsOpened } from '../changes/projects-sheet';
import { closeCrawl, onCrawlOpened } from '../crawl/crawl-sheet';
import { HelpSheetFrame, type HelpSheetProps } from '../ShortcutsView';
import { aiAnswersActions } from './ai-answers-actions';
import { closeAiAnswers, openAiAnswers, useAiAnswersSheet } from './ai-answers-sheet';
import { AiAnswer } from './AiAnswer';
import '../../ai-answers.css';

// The AI answers sheet (Phase 12 Task 9, SL-046/084; acceptance `ai-answers.feature.md`, Renderer; plan
// Decision 9). Over the page column like the Help sheets (one sheet at a time), it holds:
// - "Ask AI engines": a question and an engine (the default, or one main says is usable), the cost note
//   (`DATA_SPEND_NOTE`) always shown, and Ask, which asks first (the note again, the engine, Send or Cancel).
//   Only Send calls main (`aiAnswers.run`): a user action, no approval card. Main refuses anyway while the
//   engine's provider is gated off (as shipped: `LEGAL_GATE_NOTE`), and Ask is disabled with that note.
// - the kept answers (newest first, paged) and the chosen one (`AiAnswer.tsx`, inert text), a watched
//   domain (by default the active tab's registrable domain) marked in its sources, Delete and Delete all
//   (each asks first), the note that an answer inside a chat follows the chat's retention;
// - settings: the retention, each engine's via (`api` or off; `api` disabled while its gate is closed) and
//   the default engine.
// Everything from an engine is React text; links open only through "Open in tab".

// The palette's AI answers actions, once per module instance.
const unregisterPaletteActions = registerPaletteActions(...aiAnswersPaletteSources({ open: (request) => openAiAnswers(request) }));
import.meta.hot?.dispose(unregisterPaletteActions);

type Shown = Omit<AiAnswerRecord, 'id'> & { readonly id: number | null };

function AskForm({ view, focusSeq, say, onAnswer }: { readonly view: AiAnswersView | null; readonly focusSeq: number | null; readonly say: (text: string | null) => void; readonly onAnswer: (answer: Shown) => void }) {
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<AiSearchEngine | ''>('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const control = askControl(view, engine, query);
  const choices = engineChoices(view);
  const asked = engineToAsk(view, engine);
  // After the frame's own focus (its heading): parents' effects run after their children's.
  useEffect(() => {
    if (focusSeq !== null) queueMicrotask(() => input.current?.focus());
  }, [focusSeq]);
  const send = async () => {
    setConfirming(false);
    if (control.disabled || busy) return;
    setBusy(true);
    say(null);
    const answer = await aiAnswersActions.run(engine === '' ? { query } : { query, engine });
    setBusy(false);
    if (answer?.status === 'ok') onAnswer(answer.answer);
    else say(runAnswerText(answer));
  };
  return (
    <section className="ai-answers-section" aria-labelledby="ai-answers-ask-title">
      <h2 className="ai-answers-section-title" id="ai-answers-ask-title">
        {TEXT.askTitle}
      </h2>
      <div className="ai-answers-form">
        <label className="ai-answers-field ai-answers-field-wide">
          <span>{TEXT.queryLabel}</span>
          <input
            ref={input}
            className="ai-answers-input"
            data-testid="ai-answers-query"
            type="text"
            maxLength={AI_ANSWERS_LIMITS.maxQueryChars}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
        <label className="ai-answers-field">
          <span>{TEXT.engineLabel}</span>
          <select
            className="ai-answers-select"
            data-testid="ai-answers-engine"
            value={engine}
            onChange={(event) => {
              setEngine(event.target.value as AiSearchEngine | '');
              setConfirming(false);
            }}
          >
            <option value="">{TEXT.defaultEngineChoice}</option>
            {choices.map((choice) => (
              <option key={choice.engine} value={choice.engine} disabled={choice.disabled}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="ai-answers-note" data-testid="ai-answers-cost-note">
        {TEXT.costNote}
      </p>
      <div className="ai-answers-row">
        <button type="button" className="panel-button panel-button-primary" data-testid="ai-answers-ask" disabled={control.disabled} aria-describedby={noteId} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
          <span>{TEXT.ask}</span>
        </button>
        <p className="ai-answers-note" id={noteId} data-testid="ai-answers-ask-note">
          {control.note}
        </p>
      </div>
      {confirming && !control.disabled ? (
        <div className="ai-answers-confirm ai-answers-confirm-box" role="group" aria-label={TEXT.send} data-testid="ai-answers-confirm">
          <p className="ai-answers-note">
            Send “<bdi dir="auto">{query}</bdi>” to {asked === null ? TEXT.defaultEngineChoice : engineLabel(asked)}? {TEXT.costNote}
          </p>
          <button type="button" className="panel-button panel-button-primary" data-testid="ai-answers-send" onClick={() => void send()}>
            <span>{TEXT.send}</span>
          </button>
          <button type="button" className="panel-button" data-testid="ai-answers-cancel" onClick={() => setConfirming(false)}>
            <span>{TEXT.cancel}</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Settings({ view, reload, say }: { readonly view: AiAnswersView | null; readonly reload: () => void; readonly say: (text: string | null) => void }) {
  // A retention that deletes now (shorter, or off) waits here until confirmed, like Delete all.
  const [pending, setPending] = useState<AiAnswerRetention | null>(null);
  if (view === null) return null;
  const setting = async (result: Promise<string | null>) => {
    say(settingResultText(await result));
    reload();
  };
  const saveRetention = (retention: AiAnswerRetention) => {
    setPending(null);
    void aiAnswersActions.setRetention(retention).then((ok) => {
      say(ok ? null : 'The setting could not be saved.');
      reload();
    });
  };
  return (
    <section className="ai-answers-section" aria-labelledby="ai-answers-settings-title">
      <h2 className="ai-answers-section-title" id="ai-answers-settings-title">
        {TEXT.settingsTitle}
      </h2>
      <div className="ai-answers-form">
        <label className="ai-answers-field">
          <span>{TEXT.retentionLabel}</span>
          <select
            className="ai-answers-select"
            data-testid="ai-answers-retention"
            value={view.retention}
            onChange={(event) => {
              const retention = event.target.value as AiAnswerRetention;
              if (aiAnswerRetentionDeletes(view.retention, retention)) setPending(retention);
              else saveRetention(retention);
            }}
          >
            {AI_ANSWER_RETENTIONS.map((retention) => (
              <option key={retention} value={retention}>
                {AI_ANSWER_RETENTION_LABELS[retention]}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-answers-field">
          <span>{TEXT.defaultEngineLabel}</span>
          <select className="ai-answers-select" data-testid="ai-answers-default-engine" value={view.defaultEngine ?? ''} onChange={(event) => void setting(aiAnswersActions.setDefaultEngine(event.target.value === '' ? null : (event.target.value as AiSearchEngine)))}>
            <option value="">{TEXT.noDefaultEngine}</option>
            {view.engines.map((engine) => (
              <option key={engine.engine} value={engine.engine} disabled={viaChoiceDisabled(engine, 'api')}>
                {engineLabel(engine.engine)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pending !== null ? (
        <span className="ai-answers-confirm" role="group" aria-label={pending === 'off' ? TEXT.retentionOffConfirm : TEXT.retentionShorterConfirm} data-testid="ai-answers-retention-confirm-row">
          <span className="ai-answers-note">
            {AI_ANSWER_RETENTION_LABELS[pending]}: {pending === 'off' ? TEXT.retentionOffConfirm : TEXT.retentionShorterConfirm}
          </span>
          <button type="button" className="panel-button ai-answers-danger" data-testid="ai-answers-retention-confirm" onClick={() => saveRetention(pending)}>
            <span>{TEXT.retentionChange}</span>
          </button>
          <button type="button" className="panel-button" data-testid="ai-answers-retention-keep" onClick={() => setPending(null)}>
            <span>{TEXT.keep}</span>
          </button>
        </span>
      ) : null}
      <ul className="ai-answers-engines">
        {view.engines.map((engine) => (
          <li key={engine.engine} className="ai-answers-engine">
            <label className="ai-answers-field">
              <span>
                {engineLabel(engine.engine)} · {TEXT.viaLabel}
              </span>
              <select className="ai-answers-select" data-testid={`ai-answers-via-${engine.engine}`} value={engine.via ?? (engine.usable ? 'api' : 'off')} onChange={(event) => void setting(aiAnswersActions.setVia(engine.engine, event.target.value as AiSearchViaSetting))}>
                {AI_SEARCH_VIA_SETTINGS.map((via) => (
                  <option key={via} value={via} disabled={viaChoiceDisabled(engine, via)}>
                    {via === 'off' ? TEXT.viaOff : 'API'}
                  </option>
                ))}
              </select>
            </label>
            <p className="ai-answers-note" data-testid={`ai-answers-engine-note-${engine.engine}`}>
              {engineNote(engine)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The App slot: the AI answers sheet while it is open. */
export function AiAnswersSheet({ tab, historySeq, onOpen }: HelpSheetProps & { readonly tab: (HelpSheetProps['tab'] & { readonly url?: string }) | undefined }) {
  const { open, request } = useAiAnswersSheet();
  const [view, setView] = useState<AiAnswersView | null>(null);
  const [rows, setRows] = useState<AiAnswerSummary[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [watch, setWatch] = useState('');
  const [confirmingAll, setConfirmingAll] = useState(false);
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;
  const latestTabUrl = useRef(tab?.url);
  latestTabUrl.current = tab?.url;
  const watched = watchedDomainOf(watch);

  const show = useCallback(async (id: number) => {
    const record = await aiAnswersActions.get(id);
    if (record !== null) setShown(record);
    else setStatus('That answer is no longer kept.');
  }, []);

  const load = useCallback(async () => {
    const [nextView, page] = await Promise.all([aiAnswersActions.view(), aiAnswersActions.list({ limit: AI_ANSWERS_LIMITS.defaultPageSize })]);
    setView(nextView);
    if (page === null) {
      setStatus('The AI answers could not be read.');
      return;
    }
    setRows(page.rows);
    setMore(page.more);
    setTotal(page.total);
    return page;
  }, []);

  const reloadView = useCallback(() => void aiAnswersActions.view().then(setView), []);

  // Each open request: the other sheets close (one at a time); the answers are read again.
  useEffect(() => {
    if (!open || request === null) return;
    if (!askSettingsToClose()) {
      closeAiAnswers();
      return;
    }
    closeProjects();
    closeScreenshotEditor();
    closeCrawl();
    latestOnOpen.current();
    setStatus(null);
    setConfirmingAll(false);
    setWatch(watchedDomainOf(latestTabUrl.current) ?? '');
    void load().then((page) => {
      const newest = page?.rows[0];
      if (newest !== undefined) void show(newest.id);
      else setShown(null);
    });
  }, [open, request, load, show]);
  // Another sheet opening closes this one.
  useEffect(() => onSettingsOpened(closeAiAnswers), []);
  useEffect(() => onScreenshotEditorOpened(closeAiAnswers), []);
  useEffect(() => onProjectsOpened(closeAiAnswers), []);
  useEffect(() => onCrawlOpened(closeAiAnswers), []);
  useSeqChange(historySeq, closeAiAnswers);
  // Another tab, or a new document in this one, closes it (as the Help sheets): the page shows again.
  const pageKey = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seenPage = useRef(pageKey);
  useEffect(() => {
    if (seenPage.current !== pageKey && seenPage.current !== '') closeAiAnswers();
    seenPage.current = pageKey;
  }, [pageKey]);

  const openUrl = useCallback((url: string) => void openInTab(url, { close: closeAiAnswers, navigate: actions.navigate }), []);

  const showMore = async () => {
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    const page = await aiAnswersActions.list({ beforeId: last.id, limit: AI_ANSWERS_LIMITS.defaultPageSize });
    if (page === null) return setStatus('The AI answers could not be read.');
    setRows((was) => [...was, ...page.rows.filter((row) => !was.some((seen) => seen.id === row.id))]);
    setMore(page.more);
    setTotal(page.total);
  };

  const deleteOne = async (id: number) => {
    const ok = await aiAnswersActions.delete(id);
    setStatus(ok ? 'Answer deleted.' : 'The answer could not be deleted.');
    if (ok) setShown(null);
    await load();
  };

  const deleteAll = async () => {
    setConfirmingAll(false);
    const ok = await aiAnswersActions.deleteAll();
    setStatus(ok ? 'Every kept AI answer was deleted.' : 'The answers could not be deleted.');
    if (ok) setShown((was) => (was !== null && was.id !== null ? null : was));
    await load();
  };

  if (!open) return null;
  return (
    <HelpSheetFrame testId="ai-answers-view" title={TEXT.title} closeLabel={TEXT.close} focusSeq={request?.focus === 'ask' ? -1 : (request?.seq ?? 0)} onClose={closeAiAnswers}>
      <div className="ai-answers">
        <p className="ai-answers-status" role="status" aria-live="polite" data-testid="ai-answers-status">
          {status}
        </p>
        <AskForm
          view={view}
          focusSeq={request?.focus === 'ask' ? request.seq : null}
          say={setStatus}
          onAnswer={(answer) => {
            setShown(answer);
            if (answer.id === null) setStatus(view?.retention === 'off' ? TEXT.shownNotKept : TEXT.notKept);
            void load();
          }}
        />
        <section className="ai-answers-section" aria-labelledby="ai-answers-list-title">
          <div className="ai-answers-row ai-answers-row-spread">
            <h2 className="ai-answers-section-title" id="ai-answers-list-title">
              {TEXT.answersTitle} {total > 0 ? `(${total})` : null}
            </h2>
            <label className="ai-answers-field ai-answers-field-inline">
              <span>{TEXT.watchLabel}</span>
              <input className="ai-answers-input" data-testid="ai-answers-watch" type="text" maxLength={AI_ANSWERS_LIMITS.maxDomainChars} placeholder={TEXT.watchPlaceholder} value={watch} onChange={(event) => setWatch(event.target.value)} />
            </label>
          </div>
          <p className="ai-answers-note" data-testid="ai-answers-chat-retention-note">
            {TEXT.chatRetentionNote}
          </p>
          {view !== null && rows.length === 0 ? <p className="ai-answers-note">{TEXT.noAnswers}</p> : null}
          <div className="ai-answers-split">
            {rows.length > 0 ? (
              <ul className="ai-answers-list" aria-label={TEXT.answersTitle}>
                {rows.map((row) => (
                  <li key={row.id}>
                    <button type="button" className="ai-answers-pick" aria-pressed={shown?.id === row.id} data-testid="ai-answers-pick" data-watched={watched !== null && row.citedDomains.includes(watched) ? 'true' : undefined} onClick={() => void show(row.id)}>
                      <bdi className="ai-answers-pick-query" dir="auto">
                        {row.query}
                      </bdi>
                      <span className="ai-answers-note">
                        {engineLabel(row.engine)} · {whenText(row.createdAt)} · {sourcesText(row.citationCount)}
                      </span>
                      {watched !== null && row.citedDomains.includes(watched) ? <span className="visually-hidden">{` (cites ${watched}, ${TEXT.watched})`}</span> : null}
                    </button>
                  </li>
                ))}
                {more ? (
                  <li>
                    <button type="button" className="panel-button" data-testid="ai-answers-more" onClick={() => void showMore()}>
                      <span>{TEXT.more}</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {shown !== null ? <AiAnswer key={shown.id ?? 'unkept'} answer={shown} watched={watched} onOpenUrl={openUrl} onDelete={shown.id === null ? undefined : () => void deleteOne(shown.id!)} /> : null}
          </div>
          <div className="ai-answers-row">
            <button type="button" className="panel-button" data-testid="ai-answers-refresh" onClick={() => void load()}>
              <span>{TEXT.refresh}</span>
            </button>
            {confirmingAll ? (
              <span className="ai-answers-confirm" role="group" aria-label={TEXT.deleteAllConfirm} data-testid="ai-answers-delete-all-confirm-row">
                <span className="ai-answers-note">{TEXT.deleteAllConfirm}</span>
                <button type="button" className="panel-button ai-answers-danger" data-testid="ai-answers-delete-all-confirm" onClick={() => void deleteAll()}>
                  <span>{TEXT.deleteAll}</span>
                </button>
                <button type="button" className="panel-button" data-testid="ai-answers-delete-all-keep" onClick={() => setConfirmingAll(false)}>
                  <span>{TEXT.keep}</span>
                </button>
              </span>
            ) : (
              <button type="button" className="panel-button" data-testid="ai-answers-delete-all" disabled={total === 0} onClick={() => setConfirmingAll(true)}>
                <span>{TEXT.deleteAll}</span>
              </button>
            )}
          </div>
        </section>
        <Settings view={view} reload={reloadView} say={setStatus} />
      </div>
    </HelpSheetFrame>
  );
}
