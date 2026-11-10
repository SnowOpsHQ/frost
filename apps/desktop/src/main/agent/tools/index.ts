import type { SeoAuditResponse } from '@app/seo-core';
import type { TabOverrides } from '@app/specs/render-profile.spec';
import type { ToolRunner } from '../approvals';
import { createTabNavigator, type NavigableContents } from './navigator';
import { createPageToolRunner, type PageContents, type PageToolDeps } from './runner';

// The agent's page tools wired to the real browser (Phase 5 Task 5). Main calls it with its tab
// controller and Electron's `webContents` module, and hands the runner to `createAgent`:
//
//   toolRunner: createBrowserPageToolRunner({ browser, webContents }),
//
// A tab's page is the live WebContents the controller says is that tab's (`tabIdOf`), as main's
// other per-tab services find it.

/** The controller calls the page tools make (`BrowserController`). */
export interface PageToolsBrowser {
  tabIdOf(contents: unknown): number | null;
  getState(): {
    readonly activeTabId: number | null;
    /** The tabs' overrides and loaded-under-overrides markers (`TabState`), told to the model with `page_text`. */
    readonly tabs?: readonly { readonly id: number; readonly tabOverrides?: TabOverrides; readonly loadedUnderOverrides?: boolean }[];
  };
  navigate(input: string): boolean;
  readonly seo: { getAudit(tabId: number): SeoAuditResponse };
}

/** Electron's `webContents` module (the part used). */
export interface PageToolsWebContents {
  getAllWebContents(): readonly (PageContents & NavigableContents)[];
}

export interface BrowserPageToolDeps {
  readonly browser: PageToolsBrowser;
  readonly webContents: PageToolsWebContents;
  readonly now?: () => number;
  readonly ports?: PageToolDeps['ports'];
}

export function createBrowserPageToolRunner(deps: BrowserPageToolDeps): ToolRunner {
  const contentsOf = (tabId: number) => deps.webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && deps.browser.tabIdOf(contents) === tabId) ?? null;
  return createPageToolRunner({
    contentsOf,
    audit: (tabId) => deps.browser.seo.getAudit(tabId),
    navigate: createTabNavigator({ browser: deps.browser, contentsOf }),
    overridesOf: (tabId) => deps.browser.getState().tabs?.find((tab) => tab.id === tabId) ?? null,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.ports ? { ports: deps.ports } : {}),
  });
}

export { createPageToolRunner, type PageContents, type PageToolDeps } from './runner';
export { createTabNavigator, type NavigableContents, type NavigateOptions, type TabNavigation, type TabNavigator } from './navigator';
