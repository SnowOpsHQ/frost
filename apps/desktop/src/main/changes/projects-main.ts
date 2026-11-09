import { app, BrowserWindow, powerMonitor } from 'electron';
import type { ChangeIntelRepository, SettingsRepository } from '@app/db';
import type { BrowserService, ProjectsService } from '@app/ipc-contract';
import type { RunState } from '@app/specs/projects.spec';
import type { MainScreenshotsService } from '../screenshots/service';
import { createScreenshotFiles } from '../screenshots/store';
import { createCaptureRuns, stopRunOnQuit } from './capture-run';
import { createCaptureSchedule, stopScheduleOnQuit } from './capture-schedule';
import { createProjectsService, type MainProjectsService } from './projects';
import { confirmDeleteProject, confirmRankRun } from './projects-dialog';
import { createPurgeFiles, type PurgeFiles } from './purge-files';
import { createRetentionService } from './retention';
import { confirmCompact, confirmPurgeNow } from './retention-dialog';
import type { MainChangesService } from './service';
import type { SearchParamsOf, SerpVerdictOf } from './serp-params';
import { createWorkspaceService } from './workspace';

// Main's projects service over Electron (Phase 6 Task 6; acceptance `projects.feature.md`): the
// capture runs drive the browser controller's own tabs (an ordinary browse tab: no WebContents of
// their own), capture through the changes service and take screenshots through the screenshots
// service; a delete asks in a message box parented to the focused window (else the app's) and
// unlinks files through the screenshot store; at startup it retries the purge of deleted projects
// that still have rows. Retention (Task 7, `retention.ts`; acceptance `retention.feature.md`) joins it:
// its procedures go out with the projects', it hears of each capture and screenshot into a project and
// of each run's end, and at startup (after that retry) it enforces due policies and sweeps orphan
// files. A quit or a window closing stops a run under way, its tab closed before the session is saved
// (`stopRunOnQuit`). Main `index.ts` creates it with one line.
// Phase 10's sweeps (`workspace-db.feature.md`, Orphans and when the sweeps run): at startup, after
// that retry, the capture-sourced SERP readings whose capture is gone (a purge pulled through sync)
// are deleted and the workspace rows (competitors, tags) of projects deleted through sync are
// tombstoned; after every purge, the orphan readings are swept again. The project workspace's
// procedures (Phase 10 Task 4, `workspace.ts`) go out with the projects'.
// Phase 10 Task 8 (`projects.feature.md`, Searches in a run; Cadence): the rank run disclosure is
// main's own message box, parented as the delete's, its Continue remembered through the settings
// repository; the capture schedule's timer starts here (Electron's `powerMonitor` and the windows'
// visibility, read only when a tick looks) and stops on quit. With `AUTO_CAPTURE_AVAILABLE` `false` it
// never starts a run.

export interface MainProjectsDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** `app.getPath('userData')`. */
  readonly userData: string;
  readonly browser: Pick<BrowserService, 'getState' | 'newTab' | 'navigate' | 'activateTab' | 'closeTab' | 'setRenderProfile'>;
  readonly changes: Pick<MainChangesService, 'capture' | 'onCaptured'>;
  readonly screenshots: Pick<MainScreenshotsService, 'take' | 'onSaved'>;
  /** `SessionStore.file`: the database file (usage measures it, Compact rewrites it), or `':memory:'`. */
  readonly databaseFile: string;
  readonly log: (message: string) => void;
  /** The run tab's search parameters from Phase 3's SERP service (`lateSearchParams().of`: `null` until it is bound). */
  readonly searchParamsOf: SearchParamsOf;
  /** Phase 3's verdict on a run tab's landed page (`lateSearchParams().verdictOf`: `pending` until it is bound). */
  readonly serpVerdictOf: SerpVerdictOf;
  /** `SessionStore.settings`: where the rank run disclosure's Continue is remembered (once per install). */
  readonly settings: Pick<SettingsRepository, 'rankRunDisclosureAccepted' | 'setRankRunDisclosureAccepted'>;
}

/** Whether a frost window is on screen: visible and not minimised. */
const windowVisible = (): boolean => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized());

export function createMainProjects({ store, userData, browser, changes, screenshots, databaseFile, log, searchParamsOf, serpVerdictOf, settings }: MainProjectsDeps): ProjectsService & Pick<MainProjectsService, 'purgeDeleted'> {
  const files = createScreenshotFiles(userData);
  const sweeps = createWorkspaceSweeps({ store, log });
  // One purge at a time, whoever asks (a delete, Purge now, an enforcement); each purge is followed by the readings sweep.
  const purges = sweptAfterPurge(createPurgeFiles({ store, files, log: (message) => log(`projects: ${message}`) }), sweeps.readings);
  const parent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
  // The run's end enforces its project's policy (bound below: the runs and retention know each other).
  let afterRun: (projectId: string) => void = () => undefined;
  let runEnded: (ended: RunState) => void = () => undefined;
  const runs = createCaptureRuns({
    browser: {
      getState: () => browser.getState(),
      newTab: () => browser.newTab(),
      navigate: (input) => browser.navigate(input),
      activateTab: (tabId) => browser.activateTab(tabId),
      closeTab: (tabId) => browser.closeTab(tabId),
      // A fresh tab's own profile (never the default, never a pin: the run only sets one before its first load).
      setRenderProfile: (tabId, profile) => browser.setRenderProfile(tabId, profile),
    },
    isLive: async (projectId) => (await store.project(projectId)) !== null,
    capture: (tabId, options) => changes.capture(tabId, options),
    screenshot: (tabId, options) => screenshots.take(tabId, options),
    searchParamsOf,
    serpVerdictOf,
    afterRun: (projectId) => afterRun(projectId),
    // Every run's end reaches the capture schedule (a `blocked` one suspends automatic starts).
    onEnded: (ended) => runEnded(ended),
    log,
  });
  // Quitting (or closing the window) stops a run with its tab closed at once, so the session saved
  // at the window's close and flushed at `will-quit` never restores it as one of the user's tabs.
  stopRunOnQuit(app, runs);
  const projects = createProjectsService({
    store,
    files,
    purges,
    confirmDelete: (name) => confirmDeleteProject(parent(), name),
    confirmRankRun: () => confirmRankRun(parent()),
    settings,
    activeUrl: () => {
      const state = browser.getState();
      return state.tabs.find((tab) => tab.id === state.activeTabId)?.url ?? null;
    },
    runs,
    log,
  });
  const retention = createRetentionService({
    store,
    files,
    purges,
    databaseFile,
    running: () => runs.running(),
    confirmPurge: (name, policy, counts, bytes) => confirmPurgeNow(parent(), name, policy, counts, bytes),
    confirmCompact: () => confirmCompact(parent()),
    log,
  });
  afterRun = (projectId) => retention.afterRun(projectId);
  // The cadence's schedule: a due notice only while `AUTO_CAPTURE_AVAILABLE` is `false` (it never starts a run).
  const schedule = createCaptureSchedule({
    projects: async () => (await projects.list()).projects,
    runs,
    // Never opens the disclosure: only with a Continue already given (and `declined` otherwise).
    startRun: (projectId) => projects.startAutomaticRun(projectId),
    disclosureAccepted: async () => {
      try {
        return await settings.rankRunDisclosureAccepted();
      } catch {
        return false;
      }
    },
    powerMonitor: { getSystemIdleTime: () => powerMonitor.getSystemIdleTime() },
    windowVisible,
    log,
  });
  runEnded = (ended) => schedule.runEnded(ended);
  stopScheduleOnQuit(app, schedule);
  schedule.start();
  changes.onCaptured((projectId) => retention.afterCapture(projectId));
  screenshots.onSaved((projectId) => retention.afterCapture(projectId));
  // A delete whose purge failed earlier (a crash, a full disk) is purged again at startup; then the
  // orphan readings and workspace rows are swept, the policies due are enforced and orphan files swept.
  void startupChain(() => projects.purgeDeleted(), sweeps.startup, () => retention.startup());
  const { setRetention, retentionPreview, purgeNow, usage, purgeLog, compact } = retention;
  const workspace = createWorkspaceService({ store, log });
  return { ...projects, ...workspace, setRetention, retentionPreview, purgeNow, usage, purgeLog, compact };
}

// ---- Phase 10's sweeps (`workspace-db.feature.md`, Orphans and when the sweeps run) -------------

export interface WorkspaceSweeps {
  /** `deleteOrphanReadings()`: after every purge, and at startup. */
  readings(): Promise<void>;
  /** At startup: the readings sweep, then `tombstoneOrphanWorkspaceRows`. */
  startup(): Promise<void>;
}

/** An error's name for the log, never its message. */
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown error');

/** The sweeps over `store`; each never rejects (a failure is logged by its error's name). */
export function createWorkspaceSweeps({
  store,
  log,
  now = Date.now,
}: {
  readonly store: Pick<ChangeIntelRepository, 'deleteOrphanReadings' | 'tombstoneOrphanWorkspaceRows'>;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}): WorkspaceSweeps {
  const readings = async (): Promise<void> => {
    try {
      const swept = await store.deleteOrphanReadings();
      if (swept > 0) log(`projects: removed ${swept} search readings whose capture is gone`);
    } catch (error) {
      log(`projects: the orphan readings sweep failed (${nameOf(error)})`);
    }
  };
  return {
    readings,
    async startup() {
      await readings();
      try {
        const tombstoned = await store.tombstoneOrphanWorkspaceRows(now());
        if (tombstoned > 0) log(`projects: tombstoned ${tombstoned} competitors and tags left by deleted projects, pages or searches`);
      } catch (error) {
        log(`projects: the workspace sweep failed (${nameOf(error)})`);
      }
    },
  };
}

/** `purges`, with `sweep` run after each execute that answers `purged` (not `stale`, `empty` or `changed`). */
export function sweptAfterPurge(purges: PurgeFiles, sweep: () => Promise<void>): PurgeFiles {
  return {
    execute: async (plan, reason, at) => {
      const done = await purges.execute(plan, reason, at);
      if (done.result?.status === 'purged') await sweep();
      return done;
    },
  };
}

/** The startup order: the deleted projects' purges, then the sweeps, then retention's startup. */
export function startupChain(purgeDeleted: () => Promise<unknown>, sweep: () => Promise<void>, retentionStartup: () => Promise<unknown> | unknown): Promise<void> {
  return purgeDeleted()
    .then(sweep)
    .then(() => retentionStartup())
    .then(() => undefined);
}
