import type { SiteCrawlRepository } from '@app/db';
import { LEGAL_GATE_NOTE, type LegalGateId } from '@app/specs/data-sources.spec';
import { CrawlStartInputSchema, type CrawlSettings, type CrawlStatusView } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS, type CrawlRefusal, type CrawlServiceAnswer } from '@app/specs/site-crawl.spec';
import type { Crawler, CrawlRunHandle, CrawlStopReason } from './crawler';

// Main's crawl service (spec `site-crawl.spec.ts`, `CRAWL_AVAILABLE`, `CRAWL_REFUSALS`,
// `CrawlServiceAnswer`; `site-crawl.schema.ts`, `CrawlStartInputSchema`, `CrawlStatusViewSchema`;
// acceptance `site-crawl.feature.md`, The service; plan Decision 6, the "As built" legal gates and Task
// 6b). Task 7 wires its procedures to IPC; here it is main's only door to crawling:
// - one crawl at a time, app-wide (`busy`);
// - `start` and `resume` are refused `unavailable` (with `LEGAL_GATE_NOTE`) while the L6 gate is closed
//   (`isOpen('crawl')`); pause, cancel, delete, the view and project cleanup are never gated;
// - a paused run continues only on the user's `resume`, never by itself: start-up moves every run left
//   `running` or `queued` to `paused` (`interrupted`) and starts nothing; a run whose stored settings no
//   longer parse is never resumed;
// - quitting pauses the running crawl (`quit`): its state is written at once, before the store closes;
// - `deleteProjectCrawls` cancels the project's running crawl and awaits its end (no fetch call or row
//   write follows), then deletes the project's runs (paused and finished ones too), with their pages,
//   links and frontier. A project's delete, startup recovery (`purgeDeleted`) and a sync pull that
//   applied project tombstones all call it. A run cancelled because its project is gone deletes the
//   project's runs as it ends.
// Every answer is data (`CrawlServiceAnswer`); a database failure is `store-failed` and one log line
// (its code, never its message).

export interface CrawlServiceDeps {
  readonly repo: SiteCrawlRepository;
  /** The crawler, once main's crawl lane exists (`null` before: `start` and `resume` answer `unavailable`). */
  readonly crawler: () => Pick<Crawler, 'run'> | null;
  /** The legal gates (`legalGates.isOpen`): `crawl` gates start and resume. */
  readonly isOpen: (id: LegalGateId) => boolean;
  /** Whether a project is live (`changeIntel.project(id) !== null`). */
  readonly projectLive: (projectId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface CrawlService {
  /** Starts a crawl (`CrawlStartInputSchema`): `started` with its run, or refused. */
  start(input: unknown): Promise<CrawlServiceAnswer>;
  /** Continues a paused run from its frontier (the user's Resume; the only way a paused run goes on). */
  resume(runId: string): Promise<CrawlServiceAnswer>;
  /** Pauses the running crawl (`user`), once it has stopped. */
  pause(runId: string): Promise<CrawlServiceAnswer>;
  /** Cancels a running (awaited) or paused run (`user`). */
  cancel(runId: string): Promise<CrawlServiceAnswer>;
  /** Deletes a run and its rows (a running one is cancelled and awaited first). */
  delete(runId: string): Promise<CrawlServiceAnswer>;
  /** The crawl view: the gate, the run in progress, the runs (newest first). */
  status(): Promise<CrawlStatusView>;
  /** Cancels the project's running crawl and awaits its end, then deletes every run of the project; answers how many. Never gated. */
  deleteProjectCrawls(projectId: string): Promise<number>;
  /** Of `projectIds`, those with crawl runs. */
  projectsWithRuns(projectIds: readonly string[]): Promise<string[]>;
  /** Start-up: runs left `running` or `queued` become `paused` (`interrupted`); answers how many. Starts nothing. */
  startup(): Promise<number>;
  /** The app is quitting: the running crawl is paused (`quit`), its state written at once. */
  quit(): void;
  /** Settles once no crawl is running. */
  idle(): Promise<void>;
}

const refused = (reason: CrawlRefusal): CrawlServiceAnswer => (reason === 'unavailable' ? { status: 'refused', reason, note: LEGAL_GATE_NOTE } : { status: 'refused', reason });
const OK: CrawlServiceAnswer = { status: 'ok' };

/** An error's code or name: never its message. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

export function createCrawlService(deps: CrawlServiceDeps): CrawlService {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log?.(`crawl: ${line}`);
  /** The running crawl (at most one app-wide), and whether a start or resume is claiming the slot. */
  let active: { readonly handle: CrawlRunHandle; readonly ended: Promise<void> } | null = null;
  /** A start or resume claiming the slot (it settles once the run is launched or refused): a project's delete waits for it. */
  let claiming: Promise<unknown> | null = null;
  /** This session's notes about runs (`CRAWL_RUN_NOTES`), newest last, at most `CRAWL_LIMITS.maxListedRuns`. */
  const notes = new Map<string, string>();
  const keepNote = (runId: string, note: string | null): void => {
    if (note === null) return;
    notes.delete(runId);
    notes.set(runId, note);
    while (notes.size > CRAWL_LIMITS.maxListedRuns) notes.delete(notes.keys().next().value!);
  };
  /** Start-up recovery under way: a start waits for it, so it never pauses the new run. */
  let recovering: Promise<unknown> = Promise.resolve();

  const guarded = async (what: string, run: () => Promise<CrawlServiceAnswer>): Promise<CrawlServiceAnswer> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return refused('store-failed');
    }
  };

  /** Runs `run` on the crawler as the active crawl; when it ends cancelled because its project is gone, the project's runs are deleted. */
  const launch = (crawler: Pick<Crawler, 'run'>, run: Parameters<Crawler['run']>[0], fresh: boolean): void => {
    const handle = crawler.run(run, fresh);
    const ended = handle.done.then(async (end) => {
      keepNote(handle.runId, handle.note());
      if (end.reason === 'project-deleted' && handle.projectId !== null) {
        try {
          await repo.deleteRunsOfProject(handle.projectId);
        } catch (error) {
          log(`a deleted project's crawls could not be deleted (${codeOf(error)}); retried at start-up`);
        }
      }
    });
    const entry = { handle, ended };
    active = entry;
    void ended.finally(() => {
      if (active === entry) active = null;
    });
  };

  /** Stops the active crawl if it is `runId` (or any of `projectId`), and waits for its end. */
  const stopAndWait = async (match: (handle: CrawlRunHandle) => boolean, why: CrawlStopReason): Promise<boolean> => {
    const running = active;
    if (running === null || !match(running.handle)) return false;
    running.handle.stop(why);
    await running.ended;
    return true;
  };

  /** Claims the one crawl slot for a start or resume (refusals first), then runs `go`. */
  const claim = async (go: (crawler: Pick<Crawler, 'run'>) => Promise<CrawlServiceAnswer>): Promise<CrawlServiceAnswer> => {
    if (!deps.isOpen('crawl')) return refused('unavailable');
    const crawler = deps.crawler();
    if (crawler === null) return refused('unavailable');
    if (active !== null || claiming !== null) return refused('busy');
    const claim = (async () => {
      await recovering;
      return go(crawler);
    })();
    claiming = claim;
    try {
      return await claim;
    } finally {
      claiming = null;
    }
  };

  return {
    start: (input) =>
      guarded('start', () =>
        claim(async (crawler) => {
          const parsed = CrawlStartInputSchema.safeParse(input);
          if (!parsed.success) return refused('invalid-settings');
          const { settings, projectId } = parsed.data;
          if (projectId !== null && !(await deps.projectLive(projectId))) return refused('not-found');
          const run = await repo.createRun({ projectId, settings, now: now() });
          launch(crawler, { ...run, settings }, true);
          return { status: 'started', runId: run.id };
        }),
      ),

    resume: (runId) =>
      guarded('resume', () =>
        claim(async (crawler) => {
          const run = await repo.getRun(runId);
          if (run === null) return refused('not-found');
          if (run.state !== 'paused' || run.settings === null) return refused('not-resumable');
          if (run.projectId !== null && !(await deps.projectLive(run.projectId))) return refused('not-found');
          const settings: CrawlSettings = run.settings;
          launch(crawler, { ...run, settings }, false);
          return { status: 'resumed', runId };
        }),
      ),

    pause: (runId) => guarded('pause', async () => ((await stopAndWait((handle) => handle.runId === runId, 'pause')) ? OK : refused('not-running'))),

    cancel: (runId) =>
      guarded('cancel', async () => {
        if (await stopAndWait((handle) => handle.runId === runId, 'cancel')) return OK;
        const run = await repo.getRun(runId);
        if (run === null) return refused('not-found');
        if (run.state !== 'paused' && run.state !== 'queued') return refused('not-running');
        const at = now();
        await repo.updateRun(runId, { state: 'cancelled', reason: 'user', finishedAt: at }, at);
        return OK;
      }),

    delete: (runId) =>
      guarded('delete', async () => {
        await stopAndWait((handle) => handle.runId === runId, 'cancel');
        return (await repo.deleteRun(runId)) ? OK : refused('not-found');
      }),

    async status() {
      let runs: CrawlStatusView['runs'] = [];
      try {
        runs = await repo.listRuns();
      } catch (error) {
        log(`the runs could not be read (${codeOf(error)})`);
      }
      const running = active?.handle;
      if (running) keepNote(running.runId, running.note());
      return { available: deps.isOpen('crawl'), activeRunId: running?.runId ?? null, runs: runs.map((run) => (notes.has(run.id) ? { ...run, note: notes.get(run.id)! } : run)) };
    },

    async deleteProjectCrawls(projectId) {
      // A start or resume under way settles first (its run, if any, is then the active one), then the
      // project's running crawl ends (no fetch call or row write follows), then its runs go.
      await claiming?.catch(() => undefined);
      await stopAndWait((handle) => handle.projectId === projectId, 'project-deleted');
      return repo.deleteRunsOfProject(projectId);
    },

    projectsWithRuns: (projectIds) => repo.projectsWithRuns(projectIds),

    startup() {
      const paused = (async () => {
        try {
          return await repo.pauseInterrupted(now());
        } catch (error) {
          log(`interrupted runs could not be paused (${codeOf(error)})`);
          return 0;
        }
      })();
      recovering = paused;
      return paused;
    },

    quit() {
      const running = active;
      if (running === null) return;
      running.handle.stop('quit');
      // Written now, before the store closes at will-quit; the run's own end writes the same.
      const at = now();
      void repo.updateRun(running.handle.runId, { state: 'paused', reason: 'quit', finishedAt: null }, at).catch((error: unknown) => log(`a quit's pause could not be stored (${codeOf(error)}); start-up pauses it`));
    },

    async idle() {
      for (let running = active; running !== null; running = active) await running.ended;
    },
  };
}
