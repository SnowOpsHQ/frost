import { app, BrowserWindow } from 'electron';
import type { ChangeIntelRepository } from '@app/db';
import type { BrowserService, ProjectsService } from '@app/ipc-contract';
import type { MainScreenshotsService } from '../screenshots/service';
import { createScreenshotFiles } from '../screenshots/store';
import { createCaptureRuns, stopRunOnQuit } from './capture-run';
import { createProjectsService, type MainProjectsService } from './projects';
import { confirmDeleteProject } from './projects-dialog';
import { createPurgeFiles } from './purge-files';
import { createRetentionService } from './retention';
import { confirmCompact, confirmPurgeNow } from './retention-dialog';
import type { MainChangesService } from './service';

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
}

export function createMainProjects({ store, userData, browser, changes, screenshots, databaseFile, log }: MainProjectsDeps): ProjectsService & Pick<MainProjectsService, 'purgeDeleted'> {
  const files = createScreenshotFiles(userData);
  // One purge at a time, whoever asks (a delete, Purge now, an enforcement).
  const purges = createPurgeFiles({ store, files, log: (message) => log(`projects: ${message}`) });
  const parent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
  // The run's end enforces its project's policy (bound below: the runs and retention know each other).
  let afterRun: (projectId: string) => void = () => undefined;
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
    afterRun: (projectId) => afterRun(projectId),
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
  changes.onCaptured((projectId) => retention.afterCapture(projectId));
  screenshots.onSaved((projectId) => retention.afterCapture(projectId));
  // A delete whose purge failed earlier (a crash, a full disk) is purged again at startup; then the
  // policies due are enforced and orphan files swept.
  void projects.purgeDeleted().then(() => retention.startup());
  const { setRetention, retentionPreview, purgeNow, usage, purgeLog, compact } = retention;
  return { ...projects, setRetention, retentionPreview, purgeNow, usage, purgeLog, compact };
}
