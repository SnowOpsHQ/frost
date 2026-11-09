import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { PROJECT_NAME_MAX_CHARS, PROJECT_QUERY_MAX_CHARS } from '@app/specs/capture-db.spec';
import {
  CAPTURE_RUN_NOTE,
  DEFAULT_PROJECT_SORT,
  DELETED_NOT_PURGED,
  DUE_TEXT,
  PROJECTS_TITLE,
  PROJECT_VIEWS,
  PROJECT_VIEW_LABELS,
  QUERY_FIELD_MAX_CHARS,
  RUN_TARGET_OUTCOME_LABELS,
  queryLabel,
  TAG_EDITOR_TEXT,
  type ProjectDetail,
  type ProjectSort,
  type ProjectSummary,
  type ProjectViewId,
  type RunState,
} from '@app/specs/projects.spec';
import type { EntryKind } from '@app/specs/workspace-db.spec';
import { SERP_DEVICE_LABELS, SERP_DEVICES } from '@app/specs/serp.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { CloseIcon, PlusIcon } from '../../icons';
import { actions, ipc, projectsActions } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { projectsPaletteSources, retentionPaletteSources } from '../../projects-palette';
import {
  EMPTY_QUERY_FORM,
  PROJECT_PROFILE_CHOICES,
  PROJECT_SORT_OPTIONS,
  QUERY_ENGINES,
  TAGS_TEXT_MAX_CHARS,
  addPageText,
  blockedRunNote,
  changeCountText,
  checkRankingsButton,
  dueLabel,
  favoriteButton,
  favoriteText,
  lastCaptureText,
  listedProjects,
  pageUrlFromInput,
  profileChoiceOf,
  profileOfChoice,
  projectSortOf,
  queryFromForm,
  rankCheckShown,
  refusalText,
  runActive,
  runProgressText,
  setTagsText,
  startRunText,
  tagEditorLabel,
  tagsFromText,
  tagsTextOf,
  type QueryForm,
} from '../../projects-view';
import { isolatedTooltip } from '../../seo-view';
import { tablistFocusTarget } from '../../tablist-keys';
import { BulkAdd } from './BulkAdd';
import { Compare } from './Compare';
import { ProjectSettings } from './ProjectSettings';
import { lastOpenedProject, notifyProjectsChanged, openProjects, setLastOpenedProject, useProjectsRequest } from './projects-sheet';
import { Rankings } from './Rankings';
import { Retention } from './Retention';

// The Projects sheet (acceptance `projects.feature.md`, The sheet): over the page column like
// History, it lists the projects (Unfiled first) with create, inline rename and delete (main asks
// first), and shows one project: its pages and queries with each one's last capture and change count
// (a click opens it in the active tab), its render profile, and "Capture now" with its progress and
// Cancel, and its retention and disk usage (`Retention.tsx`). While a run is under way the sheet
// shrinks to a band (`data-running`), so the run's tab is shown (a viewport screenshot captures what
// is on screen). Everything from the user or a page is React text in a `<bdi>`; no inline styles
// (strict CSP). A project shows in one of its views (`PROJECT_VIEWS`, a tablist under its name):
// Overview (all of the above), Rankings (`Rankings.tsx`) and Compare (`Compare.tsx`), Phase 10 Task 6,
// and Settings (`ProjectSettings.tsx`: site and competitors), Task 7. Task 7 also adds the list's star
// and sort menu (view state, not kept), the tags of pages and saved searches (an inline editor on each
// row) and Bulk add (`BulkAdd.tsx`, in place of the query form). Task 8 adds "Due" in the list, Check
// rankings beside Capture now (a run of the saved searches; main asks the disclosure first when it
// must), a blocked run's note under its progress, and the cadence in Settings; "Due" and Check rankings
// show only when `rankCheckShown()` (`RANK_CHECK_AVAILABLE`, legal gate L1: not until the owner's note).

// The palette's Projects and retention actions (`projects-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(
  ...projectsPaletteSources({
    open: (request) => openProjects(request),
    lastProject: lastOpenedProject,
    startRun: (projectId, scope) => ipc.projects.startRun.mutate({ projectId, screenshot: false, ...(scope === undefined ? {} : { scope }) }).catch(() => null),
  }),
  ...retentionPaletteSources({
    open: (request) => openProjects(request),
    lastProject: lastOpenedProject,
    purgeNow: (projectId) => ipc.projects.purgeNow.mutate({ projectId }).catch(() => null),
    compact: () => ipc.projects.compact.mutate().catch(() => null),
  }),
);
import.meta.hot?.dispose(unregisterPaletteActions);

/** How long the run-state poll rests after a failed poll. */
const POLL_RETRY_MS = 1_000;

/** The run's state, long-polled while the sheet is open (`projects.runState`). */
function useRunState(): RunState | null {
  const [state, setState] = useState<RunState | null>(null);
  useEffect(() => {
    let live = true;
    let since = 0;
    void (async () => {
      while (live) {
        try {
          const next = await ipc.projects.runState.query({ sinceVersion: since });
          if (!live) break;
          since = next.version;
          setState(next);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_MS));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function Text({ value, className, testId }: { readonly value: string; readonly className?: string; readonly testId?: string }) {
  return (
    <bdi className={className ?? 'projects-text'} dir="auto" data-testid={testId}>
      {value}
    </bdi>
  );
}

// ---- The project list ----------------------------------------------------------------------------

/** frost's own star: a five-pointed outline, filled by CSS when pressed. */
function StarIcon() {
  return (
    <svg className="icon projects-star-icon" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" />
    </svg>
  );
}

function ProjectItem({
  project,
  selected,
  addUrl,
  onSelect,
  onRename,
  onAddHere,
  onFavorite,
}: {
  readonly project: ProjectSummary;
  readonly selected: boolean;
  readonly addUrl: string | null;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onAddHere: () => void;
  readonly onFavorite: (favorite: boolean) => void;
}) {
  const star = favoriteButton(project);
  const due = rankCheckShown() ? dueLabel(project) : null;
  const dueId = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await onRename(name)) setRenaming(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    // Esc ends the rename here, not the sheet.
    event.preventDefault();
    event.stopPropagation();
    setRenaming(false);
    setName(project.name);
  };
  return (
    <li className="projects-item" data-testid="projects-item" data-project={project.id} data-selected={selected} data-unfiled={project.unfiled} data-favorite={project.favorite}>
      <button type="button" className="projects-icon-button projects-star" data-testid="projects-star" aria-pressed={star.pressed} aria-label={star.label} title={star.pressed ? 'Remove from favorites' : 'Add to favorites'} onClick={() => onFavorite(star.next)}>
        <StarIcon />
      </button>
      {renaming ? (
        <form className="projects-rename" onSubmit={(event) => void save(event)}>
          <input
            className="projects-input"
            data-testid="projects-rename-input"
            aria-label={`New name for ${project.name}`}
            maxLength={PROJECT_NAME_MAX_CHARS}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="projects-small-button" data-testid="projects-rename-save">
            Save
          </button>
        </form>
      ) : (
        <button type="button" className="projects-item-open" data-testid="projects-item-open" aria-current={selected ? 'true' : undefined} aria-describedby={due !== null ? dueId : undefined} onClick={onSelect}>
          <Text value={project.name} className="projects-item-name" />
          {due !== null ? (
            <span className="projects-due" data-testid="projects-due" title={DUE_TEXT.note}>
              {due}
            </span>
          ) : null}
        </button>
      )}
      {due !== null ? (
        <span id={dueId} hidden>
          {DUE_TEXT.note}
        </span>
      ) : null}
      {!project.unfiled && !renaming ? (
        <button type="button" className="projects-small-button" data-testid="projects-rename" aria-label={`Rename ${project.name}`} onClick={() => setRenaming(true)}>
          Rename
        </button>
      ) : null}
      {addUrl !== null ? (
        <button type="button" className="projects-small-button projects-add-here" data-testid="projects-add-here" aria-label={`Add this page to ${project.name}`} onClick={onAddHere}>
          Add here
        </button>
      ) : null}
    </li>
  );
}

// ---- One project ---------------------------------------------------------------------------------

/** An entry's tags, edited inline: comma-separated, read as main reads them (`normalizeTags`). */
function TagEditor({ label, tags, onSave, onDone }: { readonly label: string; readonly tags: readonly string[]; readonly onSave: (tags: string[]) => Promise<boolean>; readonly onDone: () => void }) {
  const [text, setText] = useState(tagsTextOf(tags));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const noteId = useId();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = tagsFromText(text);
    if ('problem' in parsed) return setProblem(parsed.problem);
    setProblem(null);
    setSaving(true);
    try {
      if (await onSave(parsed.tags)) onDone();
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return;
    // Esc ends the edit here, not the sheet.
    event.preventDefault();
    event.stopPropagation();
    onDone();
  };
  return (
    <form className="projects-tags-editor" data-testid="projects-tags-editor" onSubmit={(event) => void save(event)} onKeyDown={onKeyDown}>
      <input
        className="projects-input"
        data-testid="projects-tags-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        autoFocus
        aria-label={tagEditorLabel(label)}
        aria-describedby={noteId}
        aria-invalid={problem !== null ? 'true' : undefined}
        maxLength={TAGS_TEXT_MAX_CHARS}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="projects-small-button" data-testid="projects-tags-save" disabled={saving}>
        Save
      </button>
      <button type="button" className="projects-small-button" data-testid="projects-tags-cancel" onClick={onDone}>
        Cancel
      </button>
      <span className="projects-note" id={noteId} role={problem !== null ? 'alert' : undefined}>
        {problem ?? TAG_EDITOR_TEXT.note}
      </span>
    </form>
  );
}

/** A page or query: a click opens it in the active tab (not while a run is under way: the run's tab is in front); its tags, with an editor. */
function EntryRow({
  testId,
  url,
  label,
  lastCapturedAt,
  changeCount,
  tags,
  running,
  onOpen,
  onRemove,
  onSaveTags,
}: {
  readonly testId: string;
  readonly url: string;
  readonly label: string;
  readonly lastCapturedAt: number | null;
  readonly changeCount: number | null;
  readonly tags: readonly string[];
  readonly running: boolean;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
  readonly onSaveTags: (tags: string[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // Its accessible name starts with its visible text.
  const tagsButtonText = tags.length === 0 ? 'Add tags' : 'Edit tags';
  const returnFocus = useRef(false);
  // Focus goes back to the button the editor was opened from, once it is shown again.
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const done = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  return (
    <li className="projects-entry" data-testid={testId} data-url={url} data-captured={lastCapturedAt !== null}>
      <div className="projects-entry-main">
        <button type="button" className="projects-entry-open" data-testid={`${testId}-open`} title={isolatedTooltip(url)} disabled={running} onClick={onOpen}>
          <Text value={label} className="projects-entry-label" />
          <span className="projects-entry-meta">
            <span data-testid={`${testId}-last`}>{lastCaptureText(lastCapturedAt)}</span>
            {lastCapturedAt !== null ? <span data-testid={`${testId}-changes`}>{changeCountText(changeCount, true)}</span> : null}
          </span>
        </button>
        {editing ? (
          <TagEditor label={label} tags={tags} onSave={onSaveTags} onDone={done} />
        ) : (
          <div className="projects-entry-tags" data-testid={`${testId}-tags`}>
            {tags.map((tag) => (
              <Text key={tag} value={tag} className="projects-tag" testId="projects-tag" />
            ))}
            <button ref={editButton} type="button" className="projects-link-button" data-testid={`${testId}-tags-edit`} aria-label={`${tagsButtonText} for ${label}`} onClick={() => setEditing(true)}>
              {tagsButtonText}
            </button>
          </div>
        )}
      </div>
      <button type="button" className="projects-icon-button" data-testid={`${testId}-remove`} aria-label={`Remove ${label}`} title="Remove" onClick={onRemove}>
        <CloseIcon />
      </button>
    </li>
  );
}

function RunProgress({ run, onCancel }: { readonly run: RunState; readonly onCancel: () => void }) {
  const active = runActive(run.state);
  const blocked = blockedRunNote(run);
  return (
    <section className="projects-run" data-testid="projects-run" data-state={run.state} aria-label="Capture run">
      <div className="projects-run-head">
        <p className="projects-run-progress" data-testid="projects-run-progress" role="status" aria-live="polite">
          {runProgressText(run)}
        </p>
        {active ? (
          <button type="button" className="projects-small-button" data-testid="projects-run-cancel" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <ol className="projects-run-targets">
        {run.targets.map((target, index) => (
          <li key={index} className="projects-run-target" data-testid="projects-run-target" data-kind={target.kind} data-outcome={target.outcome} data-screenshot={target.screenshot ?? ''}>
            <Text value={target.label} className="projects-entry-label" />
            <span className="projects-run-outcome">
              {RUN_TARGET_OUTCOME_LABELS[target.outcome]}
              {target.outcome === 'captured' ? ` · ${changeCountText(target.changeCount, true)}` : ''}
              {target.screenshot === 'saved' ? ' · screenshot' : target.screenshot === 'failed' ? ' · no screenshot' : ''}
            </span>
          </li>
        ))}
      </ol>
      {blocked !== null ? (
        <div className="projects-run-blocked" data-testid="projects-run-blocked" role="alert">
          <p className="projects-run-blocked-reason">{blocked.reason}</p>
          <p className="projects-note">{blocked.note}</p>
        </div>
      ) : null}
    </section>
  );
}

/** The project's views as a tablist: real buttons, the selected one in the tab order, arrows move between them. */
function ViewSwitch({ view, panelId, onView }: { readonly view: ProjectViewId; readonly panelId: string; readonly onView: (view: ProjectViewId) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tablistFocusTarget(event.key, index, PROJECT_VIEWS.length);
    if (target === null) return;
    event.preventDefault();
    onView(PROJECT_VIEWS[target]!);
    buttons.current[target]?.focus();
  };
  return (
    <div className="projects-views" role="tablist" aria-label="Project views" data-testid="projects-views">
      {PROJECT_VIEWS.map((id, index) => (
        <button
          key={id}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="tab"
          id={`${panelId}-${id}`}
          className="projects-view-tab"
          data-testid={`projects-view-${id}`}
          aria-selected={view === id}
          aria-controls={panelId}
          tabIndex={view === id ? 0 : -1}
          onClick={() => onView(id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {PROJECT_VIEW_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

function ProjectView({
  detail,
  run,
  tab,
  view,
  onView,
  onChanged,
  onDeleted,
  onOpenUrl,
  say,
}: {
  readonly detail: NonNullable<ProjectDetail>;
  readonly view: ProjectViewId;
  readonly onView: (view: ProjectViewId) => void;
  readonly run: RunState | null;
  readonly tab: TabState | undefined;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
  readonly onOpenUrl: (url: string) => void;
  readonly say: (text: string) => void;
}) {
  const { project, pages, queries, competitors } = detail;
  const projectId = project.id;
  const [pageInput, setPageInput] = useState('');
  const [form, setForm] = useState<QueryForm>(EMPTY_QUERY_FORM);
  const [screenshots, setScreenshots] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkButton = useRef<HTMLButtonElement>(null);
  const bulkReturnFocus = useRef(false);
  // Focus goes back to "Bulk add…" once the dialog closed and it is shown again.
  useEffect(() => {
    if (bulkOpen || !bulkReturnFocus.current) return;
    bulkReturnFocus.current = false;
    bulkButton.current?.focus();
  }, [bulkOpen]);
  const busy = run !== null && runActive(run.state);
  const mine = run !== null && run.projectId === projectId && run.state !== 'idle';
  const field = (key: keyof QueryForm) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value })) });

  /** Runs a change, says its refusal (if any), and reads the project again. */
  const change = async (answer: Promise<{ readonly status: string } | null>, done?: string) => {
    const problem = refusalText(await answer);
    if (problem !== null) say(problem);
    else if (done) say(done);
    notifyProjectsChanged();
    onChanged();
    return problem === null;
  };

  const addPage = async (event: FormEvent) => {
    event.preventDefault();
    const url = pageUrlFromInput(pageInput);
    if (url === null) return say('Enter an http or https address.');
    const answer = await ipc.projects.addPage.mutate({ projectId, url }).catch(() => null);
    say(addPageText(answer));
    if (answer?.status === 'added') setPageInput('');
    notifyProjectsChanged();
    onChanged();
  };
  const addCurrent = async () => {
    const answer = await ipc.projects.addCurrentPage.mutate({ projectId }).catch(() => null);
    say(addPageText(answer));
    notifyProjectsChanged();
    onChanged();
  };
  const addQuery = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = queryFromForm(form);
    if ('problem' in parsed) return say(parsed.problem);
    if (await change(ipc.projects.addSearch.mutate({ projectId, search: parsed.search }).catch(() => null), 'Query added.')) setForm((current) => ({ ...EMPTY_QUERY_FORM, engine: current.engine }));
  };
  const setProfile = (choice: string) => {
    const profile = profileOfChoice(choice);
    if (profile !== undefined) void change(ipc.projects.setRenderProfile.mutate({ projectId, profile }).catch(() => null));
  };
  const remove = async () => {
    const answer = await ipc.projects.remove.mutate({ projectId }).catch(() => null);
    if (answer?.status === 'deleted') {
      say(answer.purged === null ? DELETED_NOT_PURGED : `Project deleted, with ${answer.purged.captures} captures and ${answer.purged.screenshots} screenshots.`);
      onDeleted();
    } else say(refusalText(answer) ?? '');
  };
  const capture = async () => {
    const answer = await ipc.projects.startRun.mutate({ projectId, screenshot: screenshots }).catch(() => null);
    const problem = startRunText(answer);
    if (problem !== null) say(problem);
  };
  // Check rankings (Phase 10 Task 8): the saved searches only; main asks the disclosure first when it must.
  const checkRankings = async () => {
    const problem = startRunText(await projectsActions.checkRankings(projectId));
    if (problem !== null) say(problem);
  };
  const check = checkRankingsButton(queries.length, busy);
  const saveTags = async (entryKind: EntryKind, entryId: string, tags: string[]): Promise<boolean> => {
    const answer = await projectsActions.setTags(projectId, entryKind, entryId, tags);
    say(setTagsText(answer));
    onChanged();
    return answer?.status === 'ok';
  };
  const closeBulk = () => {
    bulkReturnFocus.current = true;
    setBulkOpen(false);
  };
  const choice = profileChoiceOf(project.renderProfile);
  const canAddCurrent = tab !== undefined && isWebUrl(tab.url);
  const panelId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const focusSettings = useRef(false);
  // "Open Settings" (the Rankings view's no-site notice): focus goes to the site input once it shows.
  useEffect(() => {
    if (view !== 'settings' || !focusSettings.current) return;
    focusSettings.current = false;
    const target = detailRef.current?.querySelector<HTMLElement>('[data-testid="projects-site-input"]') ?? detailRef.current?.querySelector<HTMLElement>('[data-testid="projects-view-settings"]');
    target?.focus();
  }, [view]);
  const openSettings = () => {
    focusSettings.current = true;
    onView('settings');
  };

  return (
    <div ref={detailRef} className="projects-detail" data-testid="projects-detail" data-project={projectId} data-view={view}>
      <header className="projects-detail-head">
        <h2 className="projects-detail-name" data-testid="projects-name">
          <Text value={project.name} />
        </h2>
        {!project.unfiled ? (
          <button type="button" className="projects-small-button projects-danger" data-testid="projects-delete" disabled={mine && busy} onClick={() => void remove()}>
            Delete project…
          </button>
        ) : null}
      </header>

      <ViewSwitch view={view} panelId={panelId} onView={onView} />

      {/* The run's progress and Cancel, above whichever view is shown. */}
      {mine && run ? <RunProgress run={run} onCancel={() => void ipc.projects.cancelRun.mutate().catch(() => false)} /> : null}

      <div className="projects-view-panel" id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view}`} data-testid="projects-view-panel">
        {view === 'rankings' ? <Rankings projectId={projectId} refreshKey={detail} busy={busy} onOpenUrl={onOpenUrl} say={say} onOpenSettings={project.unfiled ? undefined : openSettings} /> : null}
        {view === 'compare' ? <Compare projectId={projectId} refreshKey={detail} /> : null}
        {view === 'settings' ? (
          <ProjectSettings
            project={project}
            competitors={competitors}
            onChanged={() => {
              notifyProjectsChanged();
              onChanged();
            }}
            say={say}
          />
        ) : null}
        {view === 'overview' ? (
          <>
            <section className="projects-section projects-capture" aria-label="Capture now">
              <div className="projects-capture-row">
                <button type="button" className="panel-button panel-button-primary" data-testid="projects-capture" disabled={busy || pages.length + queries.length === 0} onClick={() => void capture()}>
                  <span>{mine && busy ? 'Capturing…' : 'Capture now'}</span>
                </button>
                {rankCheckShown() ? (
                  <button type="button" className="panel-button" data-testid="projects-check-rankings" disabled={check.disabled} title={check.title} onClick={() => void checkRankings()}>
                    <span>{check.label}</span>
                  </button>
                ) : null}
                <label className="projects-check">
                  <input type="checkbox" data-testid="projects-capture-screenshots" checked={screenshots} onChange={(event) => setScreenshots(event.target.checked)} />
                  <span>with viewport screenshots</span>
                </label>
                <label className="projects-field projects-profile">
                  <span>Render profile</span>
                  <select className="projects-select" data-testid="projects-profile" value={choice} onChange={(event) => setProfile(event.target.value)}>
                    {choice === 'custom' ? <option value="custom">Custom (set elsewhere)</option> : null}
                    {PROJECT_PROFILE_CHOICES.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="projects-note" data-testid="projects-run-note">
                {CAPTURE_RUN_NOTE}
              </p>
            </section>

            <section className="projects-section" aria-labelledby="projects-pages-title">
              <h3 className="projects-section-title" id="projects-pages-title">
                Pages <span className="projects-count">{pages.length}</span>
              </h3>
              {pages.length === 0 ? <p className="projects-empty">No pages yet.</p> : null}
              <ul className="projects-entries">
                {pages.map((page) => (
                  <EntryRow
                    key={page.id}
                    testId="projects-page"
                    url={page.url}
                    label={page.url}
                    lastCapturedAt={page.lastCapturedAt}
                    changeCount={page.changeCount}
                    tags={page.tags}
                    running={busy}
                    onOpen={() => onOpenUrl(page.url)}
                    onRemove={() => void change(ipc.projects.removePage.mutate({ projectId, pageId: page.id }).catch(() => null))}
                    onSaveTags={(tags) => saveTags('page', page.id, tags)}
                  />
                ))}
              </ul>
              <form className="projects-add" onSubmit={(event) => void addPage(event)}>
                <input className="projects-input" data-testid="projects-page-url" type="text" spellCheck={false} autoComplete="off" placeholder="https://example.com/page" aria-label="Page address" value={pageInput} onChange={(event) => setPageInput(event.target.value)} />
                <button type="submit" className="projects-small-button" data-testid="projects-page-add">
                  <PlusIcon />
                  <span>Add page</span>
                </button>
                <button type="button" className="projects-small-button" data-testid="projects-page-add-current" disabled={!canAddCurrent} onClick={() => void addCurrent()}>
                  Add the current page
                </button>
              </form>
            </section>

            <section className="projects-section" aria-labelledby="projects-queries-title">
              <h3 className="projects-section-title" id="projects-queries-title">
                Search queries <span className="projects-count">{queries.length}</span>
              </h3>
              {queries.length === 0 ? <p className="projects-empty">No queries yet.</p> : null}
              <ul className="projects-entries">
                {queries.map((query) => (
                  <EntryRow
                    key={query.id}
                    testId="projects-query"
                    url={query.url}
                    label={queryLabel(query.params)}
                    lastCapturedAt={query.lastCapturedAt}
                    changeCount={query.changeCount}
                    tags={query.tags}
                    running={busy}
                    onOpen={() => onOpenUrl(query.url)}
                    onRemove={() => void change(ipc.projects.removeSearch.mutate({ projectId, queryId: query.id }).catch(() => null))}
                    onSaveTags={(tags) => saveTags('search', query.id, tags)}
                  />
                ))}
              </ul>
              {bulkOpen ? (
                <BulkAdd projectId={projectId} savedSearches={queries.length} onClose={closeBulk} onChanged={onChanged} say={say} />
              ) : (
                <form className="projects-query-form" onSubmit={(event) => void addQuery(event)}>
                  <label className="projects-field projects-field-wide">
                    <span>Query</span>
                    <input className="projects-input" data-testid="projects-query-text" type="text" spellCheck={false} autoComplete="off" maxLength={PROJECT_QUERY_MAX_CHARS} {...field('query')} />
                  </label>
                  <label className="projects-field">
                    <span>Engine</span>
                    <select className="projects-select" data-testid="projects-query-engine" {...field('engine')}>
                      {QUERY_ENGINES.map((engine) => (
                        <option key={engine.id} value={engine.id}>
                          {engine.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="projects-field projects-field-short">
                    <span>Country</span>
                    <input className="projects-input" data-testid="projects-query-country" type="text" spellCheck={false} autoComplete="off" placeholder="de" maxLength={2} {...field('country')} />
                  </label>
                  <label className="projects-field projects-field-short">
                    <span>Language</span>
                    <input className="projects-input" data-testid="projects-query-language" type="text" spellCheck={false} autoComplete="off" placeholder="en" maxLength={QUERY_FIELD_MAX_CHARS.language} {...field('language')} />
                  </label>
                  <label className="projects-field">
                    <span>Device</span>
                    <select className="projects-select" data-testid="projects-query-device" {...field('device')}>
                      {SERP_DEVICES.map((device) => (
                        <option key={device} value={device}>
                          {SERP_DEVICE_LABELS[device]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="projects-small-button" data-testid="projects-query-add">
                    <PlusIcon />
                    <span>Add query</span>
                  </button>
                  <button ref={bulkButton} type="button" className="projects-small-button" data-testid="projects-bulk-open" aria-haspopup="dialog" onClick={() => setBulkOpen(true)}>
                    Bulk add…
                  </button>
                </form>
              )}
            </section>

            <Retention projectId={projectId} retention={project.retention} refreshKey={detail} busy={busy} say={say} onChanged={onChanged} />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---- The sheet -----------------------------------------------------------------------------------

export function Projects({ tab, onClose }: { readonly tab: TabState | undefined; readonly onClose: () => void }) {
  const request = useProjectsRequest();
  const run = useRunState();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(request?.projectId ?? lastOpenedProject() ?? null);
  const [detail, setDetail] = useState<ProjectDetail | undefined>(undefined);
  const [addUrl, setAddUrl] = useState<string | null>(request?.addUrl ?? null);
  const [view, setView] = useState<ProjectViewId>(request?.view ?? 'overview');
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  // View state only: never sent to main or kept.
  const [sort, setSort] = useState<ProjectSort>(DEFAULT_PROJECT_SORT);
  const sheet = useRef<HTMLElement>(null);
  /** The project whose star was just pressed: its star gets focus back once the list (maybe reordered) shows. */
  const focusStar = useRef<string | null>(null);

  const loadList = useCallback(() => {
    void ipc.projects.list
      .query()
      .then((answer) => setProjects(answer.projects))
      .catch(() => setProjects([]));
  }, []);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    loadList();
  }, [loadList, generation]);
  // A new request (the palette, the Changes panel) shows what it asked for.
  useEffect(() => {
    if (!request) return;
    if (request.projectId !== null) setSelected(request.projectId);
    if (request.view !== null) setView(request.view);
    setAddUrl(request.addUrl);
  }, [request]);
  // Nothing chosen yet: the first project (Unfiled).
  useEffect(() => {
    if (selected === null && projects && projects.length > 0) setSelected(projects[0]!.id);
  }, [projects, selected]);
  useEffect(() => {
    if (selected === null) return;
    setLastOpenedProject(selected);
    let live = true;
    void ipc.projects.get
      .query({ projectId: selected })
      .then((answer) => {
        if (live) setDetail(answer);
      })
      .catch(() => {
        if (live) setDetail(null);
      });
    return () => {
      live = false;
    };
  }, [selected, generation]);
  // A run of the shown project that ends (or captures a target): read the project again.
  const captured = run?.targets.filter((target) => target.outcome === 'captured').length ?? 0;
  const runEnded = run !== null && !runActive(run.state);
  useEffect(() => {
    if (run?.projectId === selected && (runEnded || captured > 0)) reload();
  }, [runEnded, captured, run?.projectId, selected, reload]);
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  const close = () => {
    onClose();
    void actions.focusPage();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const answer = await ipc.projects.create.mutate({ name: newName }).catch(() => null);
    if (answer?.status === 'created') {
      setNewName('');
      setSelected(answer.project.id);
      setStatus(`Created ${answer.project.name}.`);
      notifyProjectsChanged();
      reload();
    } else setStatus(refusalText(answer) ?? '');
  };
  const rename = async (projectId: string, name: string): Promise<boolean> => {
    const answer = await ipc.projects.rename.mutate({ projectId, name }).catch(() => null);
    const problem = refusalText(answer);
    setStatus(problem ?? 'Renamed.');
    notifyProjectsChanged();
    reload();
    return problem === null;
  };
  const addHere = async (projectId: string) => {
    if (addUrl === null) return;
    const answer = await ipc.projects.addPage.mutate({ projectId, url: addUrl }).catch(() => null);
    setStatus(addPageText(answer));
    notifyProjectsChanged();
    if (answer?.status === 'added') {
      setAddUrl(null);
      setSelected(projectId);
    }
    reload();
  };
  useEffect(() => {
    const projectId = focusStar.current;
    if (projectId === null || projects === null) return;
    focusStar.current = null;
    const item = [...(sheet.current?.querySelectorAll<HTMLElement>('[data-testid="projects-item"]') ?? [])].find((element) => element.dataset.project === projectId);
    item?.querySelector<HTMLElement>('[data-testid="projects-star"]')?.focus();
  }, [projects]);
  const favorite = async (projectId: string, next: boolean) => {
    focusStar.current = projectId;
    setStatus(favoriteText(await projectsActions.setFavorite(projectId, next), next));
    reload();
  };
  const openUrl = (url: string) => {
    onClose();
    void actions.navigate(url);
  };

  const running = run !== null && runActive(run.state);
  return (
    <section ref={sheet} tabIndex={-1} className="projects-sheet" data-testid="projects-view" data-running={running ? 'true' : undefined} aria-labelledby="projects-title" onKeyDown={onKeyDown}>
      <div className="projects">
        <header className="projects-header">
          <h1 className="projects-title" id="projects-title">
            {PROJECTS_TITLE}
          </h1>
          <p className="projects-status" data-testid="projects-status" role="status" aria-live="polite">
            {status}
          </p>
          <button type="button" className="projects-close" data-testid="projects-close" aria-label="Close projects" title="Close (Esc)" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        {addUrl !== null ? (
          <p className="projects-adding" data-testid="projects-adding">
            Choose a project for <Text value={addUrl} />
            <button type="button" className="projects-small-button" onClick={() => setAddUrl(null)}>
              Not now
            </button>
          </p>
        ) : null}
        <div className="projects-body">
          <nav className="projects-list" aria-label="Projects">
            <label className="projects-field projects-sort">
              <span>Sort by</span>
              <select className="projects-select" data-testid="projects-sort" value={sort} onChange={(event) => setSort(projectSortOf(event.target.value))}>
                {PROJECT_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <ul className="projects-items">
              {listedProjects(projects ?? [], sort).map((project) => (
                <ProjectItem
                  key={`${project.id} ${project.name}`}
                  project={project}
                  selected={project.id === selected}
                  addUrl={addUrl}
                  onSelect={() => setSelected(project.id)}
                  onRename={(name) => rename(project.id, name)}
                  onAddHere={() => void addHere(project.id)}
                  onFavorite={(next) => void favorite(project.id, next)}
                />
              ))}
            </ul>
            <form className="projects-create" onSubmit={(event) => void create(event)}>
              <input className="projects-input" data-testid="projects-create-name" type="text" autoComplete="off" placeholder="New project" aria-label="New project name" maxLength={PROJECT_NAME_MAX_CHARS} value={newName} onChange={(event) => setNewName(event.target.value)} />
              <button type="submit" className="projects-small-button" data-testid="projects-create">
                <PlusIcon />
                <span>Create</span>
              </button>
            </form>
          </nav>
          <div className="projects-main">
            {detail ? (
              <ProjectView
                key={detail.project.id}
                detail={detail}
                run={run}
                tab={tab}
                view={view}
                onView={setView}
                onChanged={reload}
                onDeleted={() => {
                  // "Capture project now" no longer offers it.
                  if (lastOpenedProject() === detail.project.id) setLastOpenedProject(undefined);
                  notifyProjectsChanged();
                  setSelected(null);
                  setDetail(undefined);
                  reload();
                }}
                onOpenUrl={openUrl}
                say={setStatus}
              />
            ) : detail === null ? (
              <p className="projects-empty">That project no longer exists.</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
