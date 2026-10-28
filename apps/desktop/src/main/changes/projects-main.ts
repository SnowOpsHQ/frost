import { BrowserWindow } from 'electron';
import type { ChangeIntelRepository } from '@app/db';
import type { BrowserService } from '@app/ipc-contract';
import type { MainScreenshotsService } from '../screenshots/service';
import { createScreenshotFiles } from '../screenshots/store';
import { createCaptureRuns } from './capture-run';
import { createProjectsService, type MainProjectsService } from './projects';
import { confirmDeleteProject } from './projects-dialog';
import type { MainChangesService } from './service';

// Main's projects service over Electron (Phase 6 Task 6; acceptance `projects.feature.md`): the
// capture runs drive the browser controller's own tabs (an ordinary browse tab: no WebContents of
// their own), capture through the changes service and take screenshots through the screenshots
// service; a delete asks in a message box parented to the focused window (else the app's) and
// unlinks files through the screenshot store; at startup it retries the purge of deleted projects
// that still have rows. Main `index.ts` creates it with one line.

export interface MainProjectsDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** `app.getPath('userData')`. */
  readonly userData: string;
  readonly browser: Pick<BrowserService, 'getState' | 'newTab' | 'navigate' | 'activateTab' | 'closeTab' | 'setRenderProfile'>;
  readonly changes: Pick<MainChangesService, 'capture'>;
  readonly screenshots: Pick<MainScreenshotsService, 'take'>;
  readonly log: (message: string) => void;
}

export function createMainProjects({ store, userData, browser, changes, screenshots, log }: MainProjectsDeps): MainProjectsService {
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
    log,
  });
  const parent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
  const projects = createProjectsService({
    store,
    files: createScreenshotFiles(userData),
    confirmDelete: (name) => confirmDeleteProject(parent(), name),
    activeUrl: () => {
      const state = browser.getState();
      return state.tabs.find((tab) => tab.id === state.activeTabId)?.url ?? null;
    },
    runs,
    log,
  });
  // A delete whose purge failed earlier (a crash, a full disk) is purged again at startup.
  void projects.purgeDeleted();
  return projects;
}
