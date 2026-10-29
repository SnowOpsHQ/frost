import { app, type WebContents } from 'electron';
import type { ChangeIntelRepository } from '@app/db';
import type { SeoAuditResponse } from '@app/seo-core';
import { createLoadTimes } from './loads';
import { runRegions } from './regions';
import { changesTabs, createChangesService, type MainChangesService } from './service';

// Main's changes service over Electron (Phase 6 Task 3; acceptance `changes-capture.feature.md`): the
// active tab's ready audit and its regions, captured into the session database. A capture needs an
// audit taken after the tab's latest load, so each WebContents' load times are kept from its
// creation; the regions are read in the tab's own WebContents. Main `index.ts` creates it with one
// line, as `createMainScreenshots`.

export interface MainChangesDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  readonly browser: {
    getState(): { readonly activeTabId: number | null };
    readonly seo: { getAudit(tabId: number): SeoAuditResponse };
    tabIdOf(contents: WebContents): number | null;
  };
  /** Main's live map of the tabs' WebContents (by WebContents id). */
  readonly tabContents: ReadonlyMap<number, WebContents>;
  readonly log: (message: string) => void;
}

export function createMainChanges({ store, browser, tabContents, log }: MainChangesDeps): MainChangesService {
  const loads = createLoadTimes();
  app.on('web-contents-created', (_event, contents) => loads.watch(contents));
  const contentsOf = (tabId: number): WebContents | null => [...tabContents.values()].find((contents) => !contents.isDestroyed() && browser.tabIdOf(contents) === tabId) ?? null;
  return createChangesService({ store, tabs: changesTabs(browser, contentsOf, loads), extract: runRegions, log });
}
