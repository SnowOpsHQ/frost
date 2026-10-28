import { canonicalJson } from '@app/change-intel';
import type { ChangeIntelRepository, HistoryEntry, Project } from '@app/db';
import type { ProjectsService } from '@app/ipc-contract';
import { PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/capture-search-params.schema';
import { queryLabel, searchUrlFor, type ProjectEntryCaptures, type ProjectRefusal, type ProjectSummary, type RunRefusal } from '@app/specs/projects.spec';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import { isDefaultRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { CaptureRuns, RunPlanTarget } from './capture-run';
import { storedPageUrl } from './snapshot';

// Projects (Phase 6 Task 6; spec `projects.spec.ts`, `projects.schema.ts`; acceptance
// `projects.feature.md`, The service): named lists of pages and search queries over `@app/db`'s
// project rows, and their "Capture now" runs (`capture-run.ts`). Deleting a project asks first in
// main's own dialog, tombstones it, purges its captures and screenshots as one recorded
// `project-deleted` purge, and unlinks each screenshot file no row names any more. Every method
// answers: a refusal is typed (`PROJECT_REFUSALS`, `RUN_REFUSALS`), a database failure is
// `store-failed` and one log line (its code, never its message: that may hold URLs).

export interface ProjectsServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** The screenshot files (`screenshots/store.ts`): only `unlink`, by hash, after the purge. */
  readonly files: { unlink(sha256: string): Promise<boolean> };
  /** Asks the user, in main's dialog, to delete the project `name` (`DELETE_PROJECT`); whether they confirmed. */
  readonly confirmDelete: (name: string) => Promise<boolean>;
  /** The active tab's URL (`''` or `null` when it shows none). */
  readonly activeUrl: () => string | null;
  readonly runs: CaptureRuns;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** How many versions of a page `get` looks through for the lane of a page (no search parameters) or a query. */
const LANE_LOOKUP = 20;

/** A name that is not blank, and not too long, once trimmed. */
const nameFits = (name: string): boolean => name.trim() !== '' && name.trim().length <= PROJECT_NAME_MAX_CHARS;
const refused = <R extends string>(reason: R) => ({ status: 'refused' as const, reason });
/** An error's code or name: never its message. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

/** `json` parsed with `RenderProfileSchema`; `null` for none or one that does not parse (frost's default). */
function profileOf(json: string | null): RenderProfile | null {
  if (json === null) return null;
  try {
    const parsed = RenderProfileSchema.safeParse(JSON.parse(json));
    return parsed.success && !isDefaultRenderProfile(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

function paramsOf(json: string): SearchParams | null {
  try {
    const parsed = SearchParamsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const summaryOf = (project: Project): ProjectSummary => ({
  id: project.id,
  name: project.name,
  unfiled: project.id === UNFILED_PROJECT_ID,
  renderProfile: profileOf(project.renderProfileJson),
  retention: { mode: project.retention.mode, value: project.retention.value },
});

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  const { store, runs } = deps;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);

  /** `run`'s answer, or `fallback` (logged) when the database fails. */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return fallback;
    }
  };
  const storeFailed = refused<ProjectRefusal>('store-failed');

  /** A page's (or query's) last capture in the project, and the change count of its lane's latest version. */
  const capturesOf = async (projectId: string, url: string, searchParamsJson: string | null): Promise<ProjectEntryCaptures> => {
    const { entries } = await store.history({ pageUrl: url, projectId, limit: LANE_LOOKUP });
    const lane: HistoryEntry[] = entries.filter((entry) => entry.searchParamsJson === searchParamsJson);
    const latest = lane[0];
    const lastCapturedAt = lane.reduce<number | null>((last, entry) => (entry.lastCapturedAt !== null && (last === null || entry.lastCapturedAt > last) ? entry.lastCapturedAt : last), null);
    return { lastCapturedAt, changeCount: latest?.diff ? latest.diff.changeCount : null };
  };

  /** Adds `url` (checked first) to the live project. */
  const addUrl = async (projectId: string, url: unknown) => {
    const page = storedPageUrl(url);
    if (page === null) return refused<ProjectRefusal>('invalid-url');
    if ((await store.project(projectId)) === null) return refused<ProjectRefusal>('not-found');
    const added = await store.addPage(projectId, page, now());
    return added === null ? refused<ProjectRefusal>('limit') : { status: 'added' as const, page: { id: added.id, url: added.url } };
  };

  /** A refusal for a project that is not there (or Unfiled, where `unfiledToo`). */
  const missing = async (projectId: string, unfiledToo: boolean): Promise<ProjectRefusal | Project> => {
    if (unfiledToo && projectId === UNFILED_PROJECT_ID) return 'unfiled';
    return (await store.project(projectId)) ?? 'not-found';
  };

  return {
    list: () => guarded('list', async () => ({ projects: (await store.projects()).map(summaryOf) }), { projects: [] }),

    get: (projectId) =>
      guarded(
        'get',
        async () => {
          const project = await store.project(projectId);
          if (project === null) return null;
          const [pages, queries] = [await store.projectPages(projectId), await store.projectQueries(projectId)];
          const pageEntries = [];
          for (const page of pages) pageEntries.push({ id: page.id, url: page.url, ...(await capturesOf(projectId, page.url, null)) });
          const queryEntries = [];
          for (const query of queries) {
            const params = paramsOf(query.searchParamsJson);
            if (params === null) continue;
            const url = searchUrlFor(params);
            queryEntries.push({ id: query.id, params, url, ...(await capturesOf(projectId, url, canonicalJson(params))) });
          }
          return { project: summaryOf(project), pages: pageEntries, queries: queryEntries };
        },
        null,
      ),

    create: (name) =>
      guarded(
        'create',
        async () => {
          if (!nameFits(name)) return refused<ProjectRefusal>('invalid-name');
          const project = await store.createProject(name, now());
          return project === null ? refused<ProjectRefusal>('limit') : { status: 'created' as const, project: summaryOf(project) };
        },
        storeFailed,
      ),

    rename: (projectId, name) =>
      guarded(
        'rename',
        async () => {
          const project = await missing(projectId, true);
          if (typeof project === 'string') return refused(project);
          if (!nameFits(name)) return refused<ProjectRefusal>('invalid-name');
          return (await store.renameProject(projectId, name, now())) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found');
        },
        storeFailed,
      ),

    setRenderProfile: (projectId, profile) =>
      guarded(
        'set render profile',
        async () => {
          const parsed = profile === null ? null : RenderProfileSchema.safeParse(profile);
          if (parsed !== null && !parsed.success) return refused<ProjectRefusal>('invalid-profile');
          const project = await missing(projectId, false);
          if (typeof project === 'string') return refused(project);
          const json = parsed === null || isDefaultRenderProfile(parsed.data) ? null : canonicalJson(parsed.data);
          return (await store.setProjectRenderProfile(projectId, json, now())) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found');
        },
        storeFailed,
      ),

    remove: (projectId) =>
      guarded(
        'delete',
        async () => {
          const project = await missing(projectId, true);
          if (typeof project === 'string') return refused(project);
          if (runs.running() === projectId) return refused<ProjectRefusal>('running');
          if (!(await deps.confirmDelete(project.name))) return refused<ProjectRefusal>('declined');
          // 1. The project goes (with its pages and queries), unless a run of it started meanwhile.
          if (runs.running() === projectId) return refused<ProjectRefusal>('running');
          const at = now();
          if (!(await store.tombstoneProject(projectId, at))) return refused<ProjectRefusal>('not-found');
          // 2. Its captures and screenshots, as one recorded purge (planned again if a row moved meanwhile).
          let purged: { captures: number; versions: number; diffs: number; screenshots: number } | null = null;
          let hashes: readonly string[] = [];
          try {
            for (let attempt = 0; attempt < 3 && purged === null; attempt++) {
              const plan = await store.planPurge({ projectId, policy: { mode: 'all' }, now: at });
              if (plan === null) break;
              const result = await store.executePurge(plan, 'project-deleted', at);
              if (result === null) break;
              if (result.status === 'empty') purged = { captures: 0, versions: 0, diffs: 0, screenshots: 0 };
              if (result.status === 'purged') {
                purged = { ...result.plan.counts };
                hashes = result.plan.unreferencedHashes;
              }
            }
          } catch (error) {
            log(`the purge of a deleted project failed (${codeOf(error)})`);
          }
          if (purged === null) log('a deleted project’s captures were not purged');
          // 3. The files no row names any more, each checked once more first.
          for (const hash of hashes) {
            try {
              if (!(await store.isHashReferenced(hash))) await deps.files.unlink(hash);
            } catch (error) {
              log(`a screenshot file could not be removed (${codeOf(error)})`);
            }
          }
          return { status: 'deleted' as const, purged };
        },
        storeFailed,
      ),

    addPage: (projectId, url) => guarded('add page', () => addUrl(projectId, url), storeFailed),

    addCurrentPage: (projectId) =>
      guarded(
        'add the current page',
        async () => {
          const url = deps.activeUrl();
          if (storedPageUrl(url) === null) return refused<ProjectRefusal>('no-page');
          return addUrl(projectId, url);
        },
        storeFailed,
      ),

    removePage: (projectId, pageId) =>
      guarded('remove page', async () => ((await store.removePage(projectId, pageId, now())) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found')), storeFailed),

    addQuery: (projectId, params) =>
      guarded(
        'add query',
        async () => {
          const parsed = SearchParamsSchema.safeParse(params);
          if (!parsed.success) return refused<ProjectRefusal>('invalid-query');
          if ((await store.project(projectId)) === null) return refused<ProjectRefusal>('not-found');
          const added = await store.addQuery(projectId, parsed.data.query, canonicalJson(parsed.data), now());
          return added === null ? refused<ProjectRefusal>('limit') : { status: 'added' as const, query: { id: added.id } };
        },
        storeFailed,
      ),

    removeQuery: (projectId, queryId) =>
      guarded('remove query', async () => ((await store.removeQuery(projectId, queryId, now())) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found')), storeFailed),

    forPage: (url) => guarded('projects of a page', async () => ({ projects: (await store.projectsForPage(url)).map(summaryOf) }), { projects: [] }),

    startRun: (projectId, screenshot) =>
      guarded(
        'start a run',
        async () => {
          if (runs.running() !== null) return refused<RunRefusal>('busy');
          const project = await store.project(projectId);
          if (project === null) return refused<RunRefusal>('not-found');
          const targets: RunPlanTarget[] = (await store.projectPages(projectId)).map((page) => ({ kind: 'page', label: page.url, url: page.url, searchParams: null }));
          for (const query of await store.projectQueries(projectId)) {
            const params = paramsOf(query.searchParamsJson);
            if (params !== null) targets.push({ kind: 'query', label: queryLabel(params), url: searchUrlFor(params), searchParams: params });
          }
          if (targets.length === 0) return refused<RunRefusal>('no-targets');
          return runs.start({ projectId, profile: profileOf(project.renderProfileJson), screenshot, targets });
        },
        refused<RunRefusal>('store-failed'),
      ),

    cancelRun: () => runs.cancel(),

    runState: (sinceVersion) => runs.watch(sinceVersion),
  };
}
