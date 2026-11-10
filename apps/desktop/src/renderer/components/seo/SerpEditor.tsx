import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AI_DESTINATION_NOTE, AI_DESTINATION_ROW_LABEL, AI_SEARCH_DESTINATIONS, aiDestinationHost, aiDestinationLabel, openDestinationMessage } from '@app/specs/ai-destinations.spec';
import type { ProjectSummary } from '@app/specs/projects.spec';
import type { EditorState } from '@app/specs/serp-param-editor.spec';
import type { SerpTabState } from '@app/specs/serp-service.schema';
import { serpActions } from '../../hooks/useSerp';
import { actions, ipc } from '../../ipc';
import { onSerpEditorRequest, serpEditorModel, takeSerpEditorRequest, editorApply, editorFieldRows, trackAnswerText, trackProjectChoices, trackView, unsupportedNote, type SerpEditorMode, type SerpEditorModel } from '../../serp-editor-view';
import { notifyProjectsChanged, openProjects } from '../changes/projects-sheet';
import { Flash, useFlash } from './actions';

// The SERP panel's "Edit search" and "Track this search…" (acceptance `serp-panels.feature.md`, Edit
// search; spec `serp-param-editor.spec.ts`). The editor offers closed menus only and builds the URL
// with the spec's `editedSearchUrl` (the tab's own query re-encoded, closed values); Apply hands that
// URL to `browser.navigate`, the address bar's path with its browse guards, and nothing else. No page
// script runs. "Track this search…" saves the tab's search to a project through `projects.addSearch`
// (Phase 6's validated path: main builds and reads the URL again), or says why it cannot.
// `OpenInAi` (Phase 10 Task 10; `serp-panels.feature.md`, Open in an AI engine) is the "Open in" row:
// one button per AI destination, the note stated before any click; a click sends main the tab id and
// the destination id only (`serp.openDestination`), and main builds the URL from the tab's own search.

/**
 * "Open in" an AI engine: a button per `AI_SEARCH_DESTINATIONS` entry, with `AI_DESTINATION_NOTE`.
 * It opens only on a click (nothing here runs on mount or on a new reading). `testId` prefixes each
 * hook (`serp-open-in` in the panel: `serp-open-in-perplexity` …; `serp-edit-open-in` in the editor).
 */
export function OpenInAi({ tabId, testId }: { readonly tabId: number; readonly testId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, flash] = useFlash();
  const noteId = useId();
  return (
    <div className="serp-open-in" data-testid={testId} role="group" aria-label="Open this search in an AI engine" aria-describedby={noteId}>
      <span className="serp-editor-label">{AI_DESTINATION_ROW_LABEL}</span>
      <div className="seo-panel-tools">
        {AI_SEARCH_DESTINATIONS.map((destination) => (
          <button
            key={destination.id}
            type="button"
            className="panel-button"
            data-testid={`${testId}-${destination.id}`}
            aria-label={aiDestinationLabel(destination)}
            title={`${aiDestinationLabel(destination)} (${aiDestinationHost(destination)})`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void serpActions.openDestination(tabId, destination.id).then((result) => {
                setBusy(false);
                flash(openDestinationMessage(destination, result));
              });
            }}
          >
            {destination.label}
          </button>
        ))}
        <Flash message={message} testId={`${testId}-flash`} />
      </div>
      <p className="seo-note" id={noteId} data-testid={`${testId}-note`}>
        {AI_DESTINATION_NOTE}
      </p>
    </div>
  );
}

/** The editor: one labelled menu per field, Apply (disabled while there is no URL) and Cancel. */
function Editor({ model, tabId, onClose }: { readonly model: SerpEditorModel; readonly tabId: number; readonly onClose: () => void }) {
  const [state, setState] = useState<EditorState>(model.initial);
  const [busy, setBusy] = useState(false);
  const [message, flash] = useFlash();
  const id = useId();
  const rows = editorFieldRows(model, state);
  const apply = editorApply(model, state);
  const note = unsupportedNote(model.unsupported);
  const first = useRef<HTMLSelectElement | null>(null);
  useEffect(() => first.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apply.url === null || busy) return;
    setBusy(true);
    void actions.navigate(apply.url).then((started) => {
      setBusy(false);
      if (started) onClose();
      else flash('That search could not be opened.');
    });
  };

  return (
    <form className="serp-editor" data-testid="serp-editor" aria-label="Edit search" onSubmit={submit}>
      <div className="serp-editor-fields">
        {rows.map((row, index) => (
          <label key={row.id} className="serp-editor-field" data-key={row.id}>
            <span className="serp-editor-label">{row.label}</span>
            <select
              ref={index === 0 ? first : undefined}
              className="serp-editor-select"
              data-testid={row.testId}
              value={row.value}
              aria-describedby={row.hint === null ? undefined : `${id}-${row.id}-hint`}
              onChange={(event) => setState((current) => ({ ...current, [row.id]: event.target.value }))}
            >
              {row.id === 'host' && row.value === '' ? <option value="">Choose a domain</option> : null}
              {row.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {row.hint === null ? null : (
              <span className="seo-note serp-editor-hint" id={`${id}-${row.id}-hint`} data-testid={`${row.testId}-hint`}>
                {row.hint}
              </span>
            )}
          </label>
        ))}
      </div>
      {note === null ? null : (
        <p className="seo-note" data-testid="serp-edit-unsupported">
          {note}
        </p>
      )}
      <p className="seo-note">The search opens in this tab, on page 1. frost sends only these settings and the page’s own query.</p>
      {/* "Open in" an AI engine (Phase 10 Task 10): the tab's own search as it is now, not these settings. */}
      <OpenInAi tabId={tabId} testId="serp-edit-open-in" />
      <div className="seo-panel-tools">
        <button type="submit" className="panel-button" data-testid="serp-edit-apply" disabled={apply.url === null || busy} data-busy={busy}>
          Apply
        </button>
        <button type="button" className="panel-button" data-testid="serp-edit-cancel" onClick={onClose}>
          Cancel
        </button>
        {apply.problem !== null ? (
          <span className="seo-note" data-testid="serp-edit-problem">
            {apply.problem}
          </span>
        ) : null}
        <Flash message={message} testId="serp-edit-flash" />
      </div>
    </form>
  );
}

/** "Track this search…": the projects to save it to, and Save. */
function Track({ model, onClose }: { readonly model: SerpEditorModel; readonly onClose: () => void }) {
  const view = trackView(model);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const select = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    let live = true;
    void ipc.projects.list
      .query()
      .then((answer) => {
        if (!live) return;
        const choices = trackProjectChoices(answer.projects);
        setProjects(choices);
        setProjectId((current) => (choices.some((project) => project.id === current) ? current : (choices[0]?.id ?? '')));
      })
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (projects !== null && projects.length > 0) select.current?.focus();
  }, [projects]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (view.search === null || projectId === '' || busy) return;
    setBusy(true);
    void ipc.projects.addSearch
      .mutate({ projectId, search: view.search })
      .catch(() => null)
      .then((answer) => {
        setBusy(false);
        setMessage(trackAnswerText(answer));
        notifyProjectsChanged();
      });
  };

  return (
    <form className="serp-track" data-testid="serp-track" aria-label="Track this search" onSubmit={save}>
      {projects === null ? <p className="seo-note">Loading projects…</p> : null}
      {projects !== null && projects.length === 0 ? (
        <div className="seo-panel-tools">
          <p className="seo-note">Create a project first, then save this search to it.</p>
          <button type="button" className="panel-button" data-testid="serp-track-projects" onClick={() => openProjects()}>
            Projects
          </button>
        </div>
      ) : null}
      {projects !== null && projects.length > 0 ? (
        <label className="serp-editor-field">
          <span className="serp-editor-label">Project</span>
          <select ref={select} className="serp-editor-select" data-testid="serp-track-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="seo-note">The project keeps it as a saved search: Check rankings visits it later. Nothing is searched now.</p>
      <div className="seo-panel-tools">
        <button type="submit" className="panel-button" data-testid="serp-track-save" disabled={view.search === null || projectId === '' || busy} data-busy={busy}>
          Save search
        </button>
        <button type="button" className="panel-button" data-testid="serp-track-cancel" onClick={onClose}>
          Close
        </button>
        <span className="seo-note" role="status" aria-live="polite" data-testid="serp-track-message">
          {message}
        </span>
      </div>
    </form>
  );
}

/**
 * The search tools under the parameters bar: "Edit search" and "Track this search…" (disabled with
 * the reason when the search cannot be a saved search), and whichever of the two is open. The
 * palette opens either through `requestSerpEditor`.
 */
export function SearchTools({ state }: { readonly state: SerpTabState }) {
  const model = useMemo(() => serpEditorModel(state), [state]);
  const [mode, setMode] = useState<SerpEditorMode | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const trackButton = useRef<HTMLButtonElement | null>(null);
  const reasonId = useId();
  const tabId = state.tabId;
  // A request the palette made for this tab, now or before the panel mounted.
  useEffect(() => {
    const take = () => {
      const requested = takeSerpEditorRequest(tabId);
      if (requested !== null) setMode(requested);
    };
    take();
    return onSerpEditorRequest(take);
  }, [tabId]);
  // Another page (or another search) closes what was open: its settings were the old page's.
  const pageKey = model === null ? null : `${model.pageUrl}\n${model.params.url}`;
  const lastKey = useRef(pageKey);
  useEffect(() => {
    if (lastKey.current !== pageKey) setMode(null);
    lastKey.current = pageKey;
  }, [pageKey]);

  if (model === null) return null;
  const track = trackView(model);
  const close = () => {
    const button = mode === 'track' ? trackButton.current : editButton.current;
    setMode(null);
    button?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && mode !== null) {
      event.stopPropagation();
      close();
    }
  };
  return (
    <div className="serp-search-tools" data-testid="serp-search-tools" onKeyDown={onKeyDown}>
      <div className="seo-panel-tools">
        <button
          ref={editButton}
          type="button"
          className="panel-button"
          data-testid="serp-edit-open"
          aria-expanded={mode === 'edit'}
          disabled={model.fields.length === 0}
          onClick={() => setMode(mode === 'edit' ? null : 'edit')}
        >
          Edit search
        </button>
        <button
          ref={trackButton}
          type="button"
          className="panel-button"
          data-testid="serp-track-open"
          aria-expanded={mode === 'track'}
          aria-describedby={track.reason === null ? undefined : reasonId}
          disabled={track.search === null}
          onClick={() => setMode(mode === 'track' ? null : 'track')}
        >
          Track this search…
        </button>
      </div>
      {track.reason === null ? null : (
        <p className="seo-note" id={reasonId} data-testid="serp-track-reason">
          {track.reason}
        </p>
      )}
      {mode === 'edit' && model.fields.length > 0 ? <Editor key={pageKey} model={model} tabId={tabId} onClose={close} /> : null}
      {mode === 'track' && track.search !== null ? <Track key={pageKey} model={model} onClose={close} /> : null}
    </div>
  );
}
