import { clipboard, ClipboardItem, nativeImage, shell, type WebContents } from 'electron';
import type { ChangeIntelRepository } from '@app/db';
import type { TabRenderProfile } from '@app/specs/render-profile.spec';
import type { SearchParamsOf } from '../changes/serp-params';
import { electronImaging } from './imaging';
import { createScreenshotsService, screenshotTabs, type MainScreenshotsService } from './service';
import { createScreenshotFiles } from './store';

// Main's screenshots service over Electron (Phase 6 Task 5; acceptance `screenshot.feature.md`): the
// file store under the profile, `nativeImage` and the clipboard, `shell.showItemInFolder` (never
// `openPath` or `openExternal`), and the active tab's own WebContents. Main `index.ts` creates it
// with one line.

export interface MainScreenshotsDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** `app.getPath('userData')`. */
  readonly userData: string;
  readonly browser: {
    getState(): { readonly activeTabId: number | null; readonly tabs: readonly { readonly id: number; readonly renderProfile: TabRenderProfile | null }[] };
    tabIdOf(contents: WebContents): number | null;
  };
  /** Main's live map of the tabs' WebContents (by WebContents id). */
  readonly tabContents: ReadonlyMap<number, WebContents>;
  readonly log: (message: string) => void;
  /** The tab's search parameters from Phase 3's SERP service (`lateSearchParams().of`: `null` until it is bound). */
  readonly searchParamsOf: SearchParamsOf;
}

export function createMainScreenshots({ store, userData, browser, tabContents, log, searchParamsOf }: MainScreenshotsDeps): MainScreenshotsService {
  const contentsOf = (tabId: number): WebContents | null => [...tabContents.values()].find((contents) => !contents.isDestroyed() && browser.tabIdOf(contents) === tabId) ?? null;
  return createScreenshotsService({
    store,
    files: createScreenshotFiles(userData),
    tabs: screenshotTabs(browser, contentsOf),
    imaging: electronImaging({ nativeImage, clipboard, ClipboardItem }),
    reveal: (file) => shell.showItemInFolder(file),
    log,
    searchParamsOf,
  });
}
