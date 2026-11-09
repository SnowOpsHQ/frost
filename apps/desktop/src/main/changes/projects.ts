import { canonicalJson } from '@app/change-intel';
import type { ChangeIntelRepository, EntryTag, HistoryEntry, Project, ProjectWorkspace, SettingsRepository } from '@app/db';
import type { ProjectsService, RetentionService } from '@app/ipc-contract';
import { PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { AUTO_CAPTURE_AVAILABLE, RANK_CHECK_AVAILABLE, isDue } from '@app/specs/capture-schedule.spec';
import { CAPTURE_CADENCES, MAX_TAGS_PER_ENTRY, type CaptureCadence } from '@app/specs/workspace-db.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SavedSearchInputSchema } from '@app/specs/projects.schema';
import {
  normalizeSiteDomain,
  normalizeTag,
  queryLabel,
  searchLocaleFor,
  searchUrlFor,
  type ProjectCompetitor,
  type ProjectEntryCaptures,
  type ProjectRefusal,
  type ProjectSite,
  type ProjectSummary,
  type RunRefusal,
  type RunScope,
  type StartRunAnswer,
} from '@app/specs/projects.spec';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import { isDefaultRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { ScreenshotFiles } from '../screenshots/store';
import { inRunScope, queriesAnEngine, type CaptureRuns, type RunPlanTarget } from './capture-run';
import { createPurgeFiles, type PurgeFiles } from './purge-files';
import { searchParamsForUrl } from './serp-params';
import type { WorkspaceMethod } from './workspace';
import { storedPageUrl } from './snapshot';

// Projects (Phase 6 Task 6; spec `projects.spec.ts`, `projects.schema.ts`; acceptance
// `projects.feature.md`, The service): named lists of pages and search queries over `@app/db`'s
// project rows, and their "Capture now" runs (`capture-run.ts`). Deleting a project asks first in
// main's own dialog, tombstones it, purges its captures and screenshots as one recorded
// `project-deleted` purge, and unlinks each screenshot file no row names any more. A saved search is
// stored as Phase 3's search parameters of its URL (`serp-params.ts`, `searchParamsForUrl`); a row
// that is not (Phase 6's earlier shape, a tampered URL) is skipped. Phase 10 (Task 4) adds the
// workspace to what it answers: each summary's favorite, site, creation and last capture, each entry's
// tags and the project's competitors (set through `workspace.ts`), and `startRun`'s scope. Task 8 adds
// the cadence (`setCadence`; each summary's `cadence`, `autoCapture` and `due`, from `lastProjectRunAt`
// and `isDue`), `setAutoCapture` (`unavailable` while `AUTO_CAPTURE_AVAILABLE` is `false`), and the
// disclosure (`projects.feature.md`, Searches in a run): before a run that would visit a saved search,
// and before a cadence is first set, main asks `RANK_RUN_DISCLOSURE` in its own dialog
// (`confirmRankRun`) unless the settings repository remembers a Continue on this install; Cancel starts
// or stores nothing (`declined`). The renderer has no way past it. Task 8 security review rulings: a page
// that is an engine's result page counts as a search (`runSearchOf`), and (whole-branch review) so does
// any page on an engine's result path (`queriesAnEngine`); after a Continue the project and its targets are
// read again; `startAutomaticRun` (the schedule's) never opens the dialog. Legal gate L1 (plan Decision
// 10): while `RANK_CHECK_AVAILABLE` is `false`, `setCadence` (and `setAutoCapture`) answer
// `unavailable` here in main, whatever the renderer sends, and no summary is `due`. Every method
// answers: a refusal is typed (`PROJECT_REFUSALS`, `RUN_REFUSALS`), a database failure is
// `store-failed` and one log line (its code, never its message: that may hold URLs).

export interface ProjectsServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** The screenshot files (`screenshots/store.ts`): `unlink` by hash after the purge, with the hash's `lock` (and `fileFor` to measure it). */
  readonly files: Pick<ScreenshotFiles, 'unlink' | 'lock' | 'fileFor'>;
  /** The purge-then-unlink path (`purge-files.ts`), shared with retention; default: one over `store` and `files`. */
  readonly purges?: PurgeFiles;
  /** Asks the user, in main's dialog, to delete the project `name` (`DELETE_PROJECT`); whether they confirmed. */
  readonly confirmDelete: (name: string) => Promise<boolean>;
  /** The active tab's URL (`''` or `null` when it shows none). */
  readonly activeUrl: () => string | null;
  readonly runs: CaptureRuns;
  /** Asks the user, in main's dialog, `RANK_RUN_DISCLOSURE` (`projects-dialog.ts`); whether they chose Continue. */
  readonly confirmRankRun: () => Promise<boolean>;
  /** `SessionStore.settings`: remembers a Continue once per install (`RANK_RUN_DISCLOSURE_SETTING_KEY`). */
  readonly settings: Pick<SettingsRepository, 'rankRunDisclosureAccepted' | 'setRankRunDisclosureAccepted'>;
  /** Whether automatic starts are offered (`AUTO_CAPTURE_AVAILABLE`; tests may inject `true`). */
  readonly autoCaptureAvailable?: boolean;
  /** Whether the cadence and its Due notice are offered (`RANK_CHECK_AVAILABLE`, L1; tests may inject `true`). */
  readonly rankCheckAvailable?: boolean;
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

/**
 * A saved search's stored parameters: Phase 3's (`SearchParamsSchema`), and exactly what Phase 3 reads
 * from their own `url` (so a run only ever visits an engine's result page); else `null` (skipped).
 * Also the rankings' saved searches (`rankings.ts`).
 */
export function paramsOf(json: string): SearchParams | null {
  try {
    const parsed = SearchParamsSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const again = searchParamsForUrl(parsed.data.url, parsed.data.device);
    return again !== null && canonicalJson(again) === canonicalJson(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The search parameters Phase 3 reads from a saved search's URL (`searchUrlFor` → `searchParamsForUrl`),
 * with the country and language it asked for; else `null`. The one path every saved search takes (the
 * query form's `addSearch` and Bulk add, `workspace.ts`).
 */
export function savedSearchParams(input: unknown): SearchParams | null {
  const parsed = SavedSearchInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const params = searchParamsForUrl(searchUrlFor(parsed.data), parsed.data.device);
  const { gl, hl } = searchLocaleFor(parsed.data);
  return params !== null && params.engine === parsed.data.engine && params.gl === gl && params.hl === hl ? params : null;
}

/** A stored domain as answered: only one `normalizeSiteDomain` leaves as it is (else a tampered row: none). */
export const storedDomain = (domain: string | null): string | null => (domain !== null && normalizeSiteDomain(domain) === domain ? domain : null);

/** The project's site from its workspace flags (`null`: none, Unfiled, or a row that does not fit). */
function siteOf(project: Project, workspace: ProjectWorkspace | null): ProjectSite | null {
  const domain = project.id === UNFILED_PROJECT_ID || workspace === null ? null : storedDomain(workspace.siteDomain);
  return domain === null || workspace === null ? null : { domain, subdomains: workspace.siteSubdomains };
}

/** The project's cadence from its workspace flags: `off` for Unfiled, none, or a value that is not one. */
function cadenceOf(project: Project, workspace: ProjectWorkspace | null): CaptureCadence {
  const cadence = workspace?.cadence;
  return project.id === UNFILED_PROJECT_ID || cadence === undefined || !(CAPTURE_CADENCES as readonly string[]).includes(cadence) ? 'off' : cadence;
}

const summaryOf = (project: Project, workspace: ProjectWorkspace | null, lastCapturedAt: number | null, due: boolean): ProjectSummary => ({
  id: project.id,
  name: project.name,
  unfiled: project.id === UNFILED_PROJECT_ID,
  renderProfile: profileOf(project.renderProfileJson),
  retention: { mode: project.retention.mode, value: project.retention.value },
  favorite: workspace?.favorite ?? false,
  site: siteOf(project, workspace),
  createdAt: project.createdAt,
  lastCapturedAt,
  cadence: cadenceOf(project, workspace),
  autoCapture: project.id !== UNFILED_PROJECT_ID && workspace?.autoCapture === true,
  due,
});

/** An entry's tags as answered: in `normalizeTag`'s form only, sorted, at most `MAX_TAGS_PER_ENTRY` (a tampered surplus is dropped). */
export const tagsOf = (tags: readonly EntryTag[], kind: EntryTag['entryKind'], entryId: string): string[] =>
  [...new Set(tags.filter((tag) => tag.entryKind === kind && tag.entryId === entryId && normalizeTag(tag.tag) === tag.tag).map((tag) => tag.tag))].sort().slice(0, MAX_TAGS_PER_ENTRY);

/**
 * Main's projects service: the procedures' (but retention's, `retention.ts`, and the workspace's,
 * `workspace.ts`), and the retry of deleted projects' purges.
 */
export interface MainProjectsService extends Omit<ProjectsService, keyof RetentionService | WorkspaceMethod> {
  /**
   * Purges every tombstoned project that still has captures or screenshots (a delete whose purge
   * failed): `mode: 'all'`, `project-deleted`, files unlinked as for a delete. Answers how many were
   * purged; never rejects. Run at startup and before each capture run.
   */
  purgeDeleted(): Promise<number>;
  /**
   * An automatic start (the capture schedule; never while `AUTO_CAPTURE_AVAILABLE` is `false`): as
   * `startRun(projectId, false, 'all')`, but it never opens the disclosure: a run that would load a
   * search while it was not accepted on this install is `declined` (Task 8 review ruling).
   */
  startAutomaticRun(projectId: string): Promise<StartRunAnswer>;
}

type PurgedCounts = { captures: number; versions: number; diffs: number; screenshots: number };

export function createProjectsService(deps: ProjectsServiceDeps): MainProjectsService {
  const { store, runs } = deps;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);
  const purges = deps.purges ?? createPurgeFiles({ store, files: deps.files, log });
  const autoCaptureAvailable = deps.autoCaptureAvailable ?? AUTO_CAPTURE_AVAILABLE;
  const rankCheckAvailable = deps.rankCheckAvailable ?? RANK_CHECK_AVAILABLE;

  /** Whether a Continue is remembered on this install; a setting that cannot be read is not one. */
  const disclosureAccepted = async (): Promise<boolean> => {
    try {
      return (await deps.settings.rankRunDisclosureAccepted()) === true;
    } catch (error) {
      log(`the rank run disclosure setting could not be read (${codeOf(error)})`);
      return false;
    }
  };

  /** The disclosure question under way, shared by every caller while it is open (one dialog at a time). */
  let asking: Promise<boolean> | null = null;
  /**
   * Whether the user agreed to runs that query search engines (`RANK_RUN_DISCLOSURE`): remembered on
   * this install, else asked now in main's dialog (and a Continue remembered). A setting that cannot
   * be read is not an answer: main asks. Never rejects (a failed dialog is Cancel).
   */
  const rankRunsAgreed = (): Promise<boolean> => {
    asking ??= (async () => {
      try {
        if (await disclosureAccepted()) return true;
        let agreed = false;
        try {
          agreed = (await deps.confirmRankRun()) === true;
        } catch (error) {
          log(`the rank run disclosure could not be shown (${codeOf(error)})`);
        }
        if (!agreed) return false;
        try {
          if (!(await deps.settings.setRankRunDisclosureAccepted(now()))) log('the rank run disclosure answer was not stored');
        } catch (error) {
          // The user agreed: this run goes ahead; the next one asks again.
          log(`the rank run disclosure answer could not be stored (${codeOf(error)})`);
        }
        return true;
      } finally {
        asking = null;
      }
    })();
    return asking;
  };

  /**
   * A tombstoned project's `project-deleted` purge (planned again if a row moved meanwhile), then each
   * of its unreferenced files, checked once more first. `null` when the purge did not run.
   */
  const purgeProject = async (projectId: string, at: number): Promise<PurgedCounts | null> => {
    let purged: PurgedCounts | null = null;
    try {
      for (let attempt = 0; attempt < 3 && purged === null; attempt++) {
        const plan = await store.planPurge({ projectId, policy: { mode: 'all' }, now: at });
        if (plan === null) break;
        // Its files go with it, each checked again first (`purge-files.ts`).
        const { result } = await purges.execute(plan, 'project-deleted', at);
        if (result === null) break;
        if (result.status === 'empty') purged = { captures: 0, versions: 0, diffs: 0, screenshots: 0 };
        if (result.status === 'purged') purged = { ...result.plan.counts };
      }
    } catch (error) {
      log(`the purge of a deleted project failed (${codeOf(error)})`);
    }
    if (purged === null) log('a deleted project’s captures were not purged (retried later)');
    return purged;
  };

  /** One retry at a time (startup and runs may ask together). */
  let retrying: Promise<number> | null = null;
  const purgeDeleted = (): Promise<number> => {
    retrying ??= (async () => {
      try {
        let done = 0;
        for (const projectId of await store.deletedProjectsWithRows()) if ((await purgeProject(projectId, now())) !== null) done += 1;
        return done;
      } catch (error) {
        log(`deleted projects could not be read (${codeOf(error)})`);
        return 0;
      } finally {
        retrying = null;
      }
    })();
    return retrying;
  };

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

  /**
   * Summaries of `projects`, with their workspace flags and last capture (two reads, whatever the
   * count), and whether each with a cadence is due (one more read per such project: its last run;
   * none, and never due, while the Due notice is not offered: `RANK_CHECK_AVAILABLE`).
   */
  const summaries = async (projects: readonly Project[]): Promise<ProjectSummary[]> => {
    if (projects.length === 0) return [];
    const flags = new Map((await store.projectWorkspaces()).map((workspace) => [workspace.projectId, workspace]));
    const captured = await store.projectsLastCapturedAt();
    const at = now();
    const out: ProjectSummary[] = [];
    for (const project of projects) {
      const workspace = flags.get(project.id) ?? null;
      const cadence = cadenceOf(project, workspace);
      const due = rankCheckAvailable && cadence !== 'off' && isDue(await store.lastProjectRunAt(project.id), cadence, at);
      out.push(summaryOf(project, workspace, captured.get(project.id) ?? null, due));
    }
    return out;
  };

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

  /** The project and its run targets as stored now (`null`: no such live project). */
  const planOf = async (projectId: string): Promise<{ project: Project; targets: RunPlanTarget[] } | null> => {
    const project = await store.project(projectId);
    if (project === null) return null;
    const targets: RunPlanTarget[] = (await store.projectPages(projectId)).map((page) => ({ kind: 'page', label: page.url, url: page.url, searchParams: null }));
    for (const query of await store.projectQueries(projectId)) {
      const params = paramsOf(query.searchParamsJson);
      if (params !== null) targets.push({ kind: 'query', label: queryLabel(params), url: params.url, searchParams: params });
    }
    return { project, targets };
  };

  /**
   * Starts a run of the project's targets in `scope`. One that would load a search (a saved search, a
   * page that is an engine's result page, or any page on an engine's result path: `queriesAnEngine`) needs the disclosure: asked (`ask`) or only
   * read (an automatic start never opens it); Cancel starts nothing. After a Continue the project and
   * its targets are read again: the run is of what the project holds then (Task 8 review ruling).
   */
  const startRun = (projectId: string, screenshot: boolean, scope: RunScope, ask: boolean): Promise<StartRunAnswer> =>
    guarded(
      'start a run',
      async () => {
        if (runs.running() !== null) return refused<RunRefusal>('busy');
        // A deleted project's purge that failed earlier is retried first.
        await purgeDeleted();
        /** The plan in scope, or why there is none. */
        const planned = async () => {
          const plan = await planOf(projectId);
          if (plan === null) return refused<RunRefusal>('not-found');
          // The run visits only the targets in its scope (`capture-run.ts`); none there is `no-targets`.
          const inScope = plan.targets.filter((target) => inRunScope(target, scope));
          if (inScope.length === 0) return refused<RunRefusal>('no-targets');
          return { ...plan, searches: inScope.some(queriesAnEngine) };
        };
        let plan = await planned();
        if ('status' in plan) return plan;
        if (plan.searches && !(await disclosureAccepted())) {
          if (!ask || !(await rankRunsAgreed())) return refused<RunRefusal>('declined');
          // The dialog may have been open a while: what the project holds now, and no run started meanwhile.
          if (runs.running() !== null) return refused<RunRefusal>('busy');
          plan = await planned();
          if ('status' in plan) return plan;
        }
        return runs.start({ projectId, profile: profileOf(plan.project.renderProfileJson), screenshot, scope, targets: plan.targets });
      },
      refused<RunRefusal>('store-failed'),
    );

  return {
    list: () => guarded('list', async () => ({ projects: await summaries(await store.projects()) }), { projects: [] }),

    get: (projectId) =>
      guarded(
        'get',
        async () => {
          const project = await store.project(projectId);
          if (project === null) return null;
          const [pages, queries] = [await store.projectPages(projectId), await store.projectQueries(projectId)];
          const tags = await store.projectTags(projectId);
          const pageEntries = [];
          for (const page of pages) pageEntries.push({ id: page.id, url: page.url, ...(await capturesOf(projectId, page.url, null)), tags: tagsOf(tags, 'page', page.id) });
          const queryEntries = [];
          for (const query of queries) {
            const params = paramsOf(query.searchParamsJson);
            if (params === null) continue;
            queryEntries.push({ id: query.id, params, url: params.url, ...(await capturesOf(projectId, params.url, canonicalJson(params))), tags: tagsOf(tags, 'search', query.id) });
          }
          const competitors: ProjectCompetitor[] = [];
          for (const competitor of await store.competitors(projectId)) if (storedDomain(competitor.domain) !== null) competitors.push({ id: competitor.id, domain: competitor.domain });
          const [summary] = await summaries([project]);
          return { project: summary!, pages: pageEntries, queries: queryEntries, competitors };
        },
        null,
      ),

    create: (name) =>
      guarded(
        'create',
        async () => {
          if (!nameFits(name)) return refused<ProjectRefusal>('invalid-name');
          const project = await store.createProject(name, now());
          if (project === null) return refused<ProjectRefusal>('limit');
          const [summary] = await summaries([project]);
          return { status: 'created' as const, project: summary! };
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
          // 2–3. Its captures and screenshots, and the files no row names any more (retried later if it fails).
          const purged = await purgeProject(projectId, at);
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

    addQuery: (projectId, search) =>
      guarded(
        'add query',
        async () => {
          const params = savedSearchParams(search);
          if (params === null) return refused<ProjectRefusal>('invalid-query');
          if ((await store.project(projectId)) === null) return refused<ProjectRefusal>('not-found');
          const added = await store.addQuery(projectId, params.query, canonicalJson(params), now());
          return added === null ? refused<ProjectRefusal>('limit') : { status: 'added' as const, query: { id: added.id } };
        },
        storeFailed,
      ),

    removeQuery: (projectId, queryId) =>
      guarded('remove query', async () => ((await store.removeQuery(projectId, queryId, now())) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found')), storeFailed),

    forPage: (url) => guarded('projects of a page', async () => ({ projects: await summaries(await store.projectsForPage(url)) }), { projects: [] }),

    startRun: (projectId, screenshot, scope = 'all') => startRun(projectId, screenshot, scope, true),

    startAutomaticRun: (projectId) => startRun(projectId, false, 'all', false),

    setCadence: (projectId, cadence) =>
      guarded(
        'set cadence',
        async () => {
          // Legal gate L1: no cadence until the owner's note (nothing stored, nothing asked).
          if (!rankCheckAvailable) return refused<ProjectRefusal>('unavailable');
          if (!(CAPTURE_CADENCES as readonly string[]).includes(cadence)) return refused<ProjectRefusal>('not-found');
          const project = await missing(projectId, true);
          if (typeof project === 'string') return refused(project);
          // Before a cadence is first set, the disclosure (a cadence leads to runs that query engines); `off` never asks.
          if (cadence !== 'off' && !(await rankRunsAgreed())) return refused<ProjectRefusal>('declined');
          return (await store.setProjectCadence(projectId, cadence)) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found');
        },
        storeFailed,
      ),

    setAutoCapture: (projectId, on) =>
      guarded(
        'set automatic start',
        async () => {
          // Not offered in this phase (nor without the cadence, L1): nothing is stored, whatever is asked.
          if (!autoCaptureAvailable || !rankCheckAvailable) return refused<ProjectRefusal>('unavailable');
          const project = await missing(projectId, true);
          if (typeof project === 'string') return refused(project);
          if (on && !(await rankRunsAgreed())) return refused<ProjectRefusal>('declined');
          return (await store.setProjectAutoCapture(projectId, on)) ? { status: 'ok' as const } : refused<ProjectRefusal>('not-found');
        },
        storeFailed,
      ),

    cancelRun: () => runs.cancel(),

    runState: (sinceVersion) => runs.watch(sinceVersion),

    purgeDeleted,
  };
}
