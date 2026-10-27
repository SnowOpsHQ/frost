import type { ClearSiteDataResult, ConsoleLogAnswer, NetworkHeadersAnswer, NetworkLogAnswer, RedirectTraceAnswer, StorageAnswer } from '@app/specs/devtools.spec';

// The SEO devtools drawer as the `devtools.*` procedures see it (Phase 2.5 Task 5; acceptance
// `devtools.feature.md`). Main implements it (`apps/desktop/src/main/devtools/service.ts`); this
// package only knows the interface, so it stays free of Electron. Every answer is already masked:
// no secret header value, no body, and no cookie value but a revealed one ever crosses it. Only the
// active tab is served (`DEVTOOLS_TAB_SCOPE`): any other id answers as no tab.

export interface DevtoolsService {
  /** The tab's devtools version (any change: requests, console, reveals); `0` for a tab never recorded. */
  version(tabId: number): number;
  /**
   * Resolves with the tab's version once it exceeds `sinceVersion` (at once if it already does; a
   * `sinceVersion` above the current one waits for the next change). When `signal` aborts, resolves
   * with the current version. At most `MAX_PENDING_DEVTOOLS_WATCHES` wait; one more answers the oldest
   * with `DEVTOOLS_WATCH_EVICTED`. A tab that is not the active one answers 0 at once.
   */
  watch(tabId: number, sinceVersion: number, signal: AbortSignal): Promise<number>;
  /** The tab's log rows changed since `since` (`NetworkLogAnswer`, no headers); robots.txt verdicts still `pending` are asked for. */
  network(tabId: number, since?: number): NetworkLogAnswer;
  /** One row's headers, masked (`NetworkHeadersAnswer`). */
  requestHeaders(tabId: number, requestKey: number): NetworkHeadersAnswer;
  /** The main-frame redirect trace of the tab's current document. */
  redirects(tabId: number): RedirectTraceAnswer;
  /** The tab's console for its current document. */
  console(tabId: number): ConsoleLogAnswer;
  /** The cookies of the tab's URL, masked but for revealed ones. Never rejects. */
  storage(tabId: number): Promise<StorageAnswer>;
  /** Reveals one cookie until the tab's next navigation; `false` for an unknown cookie, tab or page. Never rejects. */
  revealCookie(tabId: number, cookie: { readonly name: string; readonly domain: string; readonly path: string }): Promise<boolean>;
  /** "Clear this site's data": asks in main's own dialog first. Never rejects. */
  clearSiteData(tabId: number): Promise<ClearSiteDataResult>;
  /** Whether `windowId`'s drawer is open (`null`: unknown window, ignored): full capture while any is. */
  setOpen(windowId: number | null, open: boolean): void;
  /** "Preserve log" for the tab; `false` for an id that names no open tab. */
  setPreserveLog(tabId: number, preserve: boolean): boolean;
}
