import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { PROJECT_NAME_MAX_CHARS, PROJECT_QUERY_MAX_CHARS } from '@app/specs/capture-db.spec';
import {
  CAPTURE_RUN_NOTE,
  DELETED_NOT_PURGED,
  PROJECTS_TITLE,
  QUERY_FIELD_MAX_CHARS,
  QUERY_LOCATION_NOTE,
  RUN_TARGET_OUTCOME_LABELS,
  SEARCH_DEVICE_LABELS,
  queryLabel,
  type ProjectDetail,
  type ProjectSummary,
  type RunState,
} from '@app/specs/projects.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { CloseIcon, PlusIcon } from '../../icons';
import { actions, ipc } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { projectsPaletteSources, retentionPaletteSources } from '../../projects-palette';
import {
  EMPTY_QUERY_FORM,
  PROJECT_PROFILE_CHOICES,
  QUERY_ENGINES,
  addPageText,
  changeCountText,
  lastCaptureText,
  pageUrlFromInput,
  profileChoiceOf,
  profileOfChoice,
  queryFromForm,
  refusalText,
  runActive,
  runProgressText,
  startRunText,
  type QueryForm,
} from '../../projects-view';
import { isolatedTooltip } from '../../seo-view';
import { lastOpenedProject, notifyProjectsChanged, openProjects, setLastOpenedProject, useProjectsRequest } from './projects-sheet';
import { Retention } from './Retention';

// The Projects sheet (acceptance `projects.feature.md`, The sheet): over the page column like
// History, it lists the projects (Unfiled first) with create, inline rename and delete (main asks
// first), and shows one project: its pages and queries with each one's last capture and change count
// (a click opens it in the active tab), its render profile, and "Capture now" with its progress and
// Cancel, and its retention and disk usage (`Retention.tsx`). While a run is under way the sheet
// shrinks to a band (`data-running`), so the run's tab is shown (a viewport screenshot captures what
// is on screen). Everything from the user or a page is React text in a `<bdi>`; no inline styles
// (strict CSP).

// The palette's Projects and retention actions (`projects-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(
  ...projectsPaletteSources({
    open: (request) => openProjects(request),
    lastProject: lastOpenedProject,
    startRun: (projectId) => ipc.projects.startRun.mutate({ projectId, screenshot: false }).catch(() => null),
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

function ProjectItem({
  project,
  selected,
  addUrl,
  onSelect,
  onRename,
  onAddHere,
}: {
  readonly project: ProjectSummary;
  readonly selected: boolean;
  readonly addUrl: string | null;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onAddHere: () => void;
}) {
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
    <li className="projects-item" data-testid="projects-item" data-project={project.id} data-selected={selected} data-unfiled={project.unfiled}>
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
        <button type="button" className="projects-item-open" data-testid="projects-item-open" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
          <Text value={project.name} className="projects-item-name" />
        </button>
      )}
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

/** A page or query: a click opens it in the active tab (not while a run is under way: the run's tab is in front). */
function EntryRow({ testId, url, label, lastCapturedAt, changeCount, running, onOpen, onRemove }: { readonly testId: string; readonly url: string; readonly label: string; readonly lastCapturedAt: number | null; readonly changeCount: number | null; readonly running: boolean; readonly onOpen: () => void; readonly onRemove: () => void }) {
  return (
    <li className="projects-entry" data-testid={testId} data-url={url} data-captured={lastCapturedAt !== null}>
      <button type="button" className="projects-entry-open" data-testid={`${testId}-open`} title={isolatedTooltip(url)} disabled={running} onClick={onOpen}>
        <Text value={label} className="projects-entry-label" />
        <span className="projects-entry-meta">
          <span data-testid={`${testId}-last`}>{lastCaptureText(lastCapturedAt)}</span>
          {lastCapturedAt !== null ? <span data-testid={`${testId}-changes`}>{changeCountText(changeCount, true)}</span> : null}
        </span>
      </button>
      <button type="button" className="projects-icon-button" data-testid={`${testId}-remove`} aria-label={`Remove ${label}`} title="Remove" onClick={onRemove}>
        <CloseIcon />
      </button>
    </li>
  );
}

function RunProgress({ run, onCancel }: { readonly run: RunState; readonly onCancel: () => void }) {
  const active = runActive(run.state);
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
    </section>
  );
}

function ProjectView({
  detail,
  run,
  tab,
  onChanged,
  onDeleted,
  onOpenUrl,
  say,
}: {
  readonly detail: NonNullable<ProjectDetail>;
  readonly run: RunState | null;
  readonly tab: TabState | undefined;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
  readonly onOpenUrl: (url: string) => void;
  readonly say: (text: string) => void;
}) {
  const { project, pages, queries } = detail;
  const projectId = project.id;
  const [pageInput, setPageInput] = useState('');
  const [form, setForm] = useState<QueryForm>(EMPTY_QUERY_FORM);
  const [screenshots, setScreenshots] = useState(false);
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
    if (await change(ipc.projects.addSearch.mutate({ projectId, params: parsed.params }).catch(() => null), 'Query added.')) setForm((current) => ({ ...EMPTY_QUERY_FORM, engine: current.engine }));
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
  const choice = profileChoiceOf(project.renderProfile);
  const canAddCurrent = tab !== undefined && isWebUrl(tab.url);

  return (
    <div className="projects-detail" data-testid="projects-detail" data-project={projectId}>
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

      <section className="projects-section projects-capture" aria-label="Capture now">
        <div className="projects-capture-row">
          <button type="button" className="panel-button panel-button-primary" data-testid="projects-capture" disabled={busy || pages.length + queries.length === 0} onClick={() => void capture()}>
            <span>{mine && busy ? 'Capturing…' : 'Capture now'}</span>
          </button>
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
        {mine && run ? <RunProgress run={run} onCancel={() => void ipc.projects.cancelRun.mutate().catch(() => false)} /> : null}
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
              running={busy}
              onOpen={() => onOpenUrl(page.url)}
              onRemove={() => void change(ipc.projects.removePage.mutate({ projectId, pageId: page.id }).catch(() => null))}
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
              running={busy}
              onOpen={() => onOpenUrl(query.url)}
              onRemove={() => void change(ipc.projects.removeSearch.mutate({ projectId, queryId: query.id }).catch(() => null))}
            />
          ))}
        </ul>
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
              <option value="">Any</option>
              {(['desktop', 'mobile'] as const).map((device) => (
                <option key={device} value={device}>
                  {SEARCH_DEVICE_LABELS[device]}
                </option>
              ))}
            </select>
          </label>
          <label className="projects-field">
            <span>Location</span>
            <input className="projects-input" data-testid="projects-query-location" type="text" spellCheck={false} autoComplete="off" maxLength={QUERY_FIELD_MAX_CHARS.location} {...field('location')} />
          </label>
          <button type="submit" className="projects-small-button" data-testid="projects-query-add">
            <PlusIcon />
            <span>Add query</span>
          </button>
          <p className="projects-note projects-field-wide">{QUERY_LOCATION_NOTE}</p>
        </form>
      </section>

      <Retention projectId={projectId} retention={project.retention} refreshKey={detail} busy={busy} say={say} onChanged={onChanged} />
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
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  const sheet = useRef<HTMLElement>(null);

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
            <ul className="projects-items">
              {(projects ?? []).map((project) => (
                <ProjectItem
                  key={`${project.id} ${project.name}`}
                  project={project}
                  selected={project.id === selected}
                  addUrl={addUrl}
                  onSelect={() => setSelected(project.id)}
                  onRename={(name) => rename(project.id, name)}
                  onAddHere={() => void addHere(project.id)}
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
