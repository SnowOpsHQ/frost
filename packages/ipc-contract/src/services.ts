import type { LinkFilter, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, PageBounds } from '@app/specs/browser.spec';
import type { PermissionDecision } from '@app/specs/permissions.spec';
import type { HighlightMode } from '@app/specs/seo-sidebar.spec';

/** The audit a panel rendered (`SeoAuditRefSchema` in `seo-snapshot.spec.ts`). */
export interface SeoAuditRef {
  readonly url: string;
  readonly takenAt: number;
}

// Main-process services the procedures call (spec `specs/browser.spec.ts`). Main supplies the
// implementations through the IPC context (`IpcHandlerOptions.services`); this package only knows
// the interfaces, so it stays free of Electron.

/**
 * The browser controller as the `browser.*` procedures see it (acceptance: `browser-chrome.feature.md`,
 * `tabs.feature.md`, `permissions.feature.md`). `navigate`, `back`, `forward`, `reload` and `stop` act on the active tab.
 */
export interface BrowserService {
  /**
   * Resolves `input` like the address bar (`resolveAddressInput`) and loads it. `true` if a
   * navigation started; `false` for a no-op (empty input, no tab or window).
   */
  navigate(input: string): boolean;
  /**
   * Opens an empty tab at the end of the strip, activates it and asks the chrome to focus the
   * address bar. Answers its id, or `null` when `MAX_TABS` are open (the `tab-limit` notice is
   * raised instead). Acceptance: `tabs.feature.md`.
   */
  newTab(): number | null;
  /**
   * Closes the tab (its view detached, its WebContents closed); the right neighbour, else the left
   * one, becomes active, and closing the last tab leaves one fresh empty tab. `false` (a no-op)
   * for an id that names no open tab.
   */
  closeTab(tabId: number): boolean;
  /** Shows the tab (only the active tab's view is attached). `false` for an id that names no open tab. */
  activateTab(tabId: number): boolean;
  /**
   * Opens the `http(s)` `url` in a new background tab right of the active tab (after the tabs it
   * already opened); the active tab stays active (`browser.spec.ts`, `OpenBackgroundTabInputSchema`).
   * Answers the new tab's id, or `null` for any other URL, no window or tab, or `MAX_TABS` (the
   * `tab-limit` notice is raised).
   */
  openBackgroundTab(url: string): number | null;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  /** The chrome's page area; main rounds and clamps it to the window before applying it. */
  setPageBounds(bounds: PageBounds): void;
  /**
   * Answers the permission prompt the **active** tab shows (acceptance: `permissions.feature.md`):
   * `true` if `promptId` is that prompt's id; `false` (a no-op) for any other id (another tab's, a
   * queued, answered, timed-out or unknown one).
   */
  answerPermission(promptId: string, decision: PermissionDecision): boolean;
  getState(): BrowserState;
  /**
   * Resolves with the state once its `version` exceeds `sinceVersion` (at once if it already
   * does; a `sinceVersion` above the current version is clamped to it). When `signal` aborts,
   * resolves with the current state and drops the waiter. At most `MAX_PENDING_WATCHES` wait; one
   * more answers the oldest early with the current state.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<BrowserState>;
}

/**
 * The SEO auditor as the `seo.*` procedures see it (acceptance: `seo-sidebar.feature.md`, Router;
 * statuses and reasons: `seo-sidebar.spec.ts`).
 */
export interface SeoService {
  /**
   * The tab's audit state: `ready` with the audit of exactly its current URL, `pending` while that
   * audit is scheduled or running, `unavailable` with a reason (`no-tab` for an id that names no
   * open tab: never an error).
   */
  getAudit(tabId: number): SeoAuditResponse;
  /** Audits the tab again at once; `false` (a no-op) when it shows nothing auditable or names no tab. */
  rerun(tabId: number): boolean;
  /**
   * Sets the tab's highlight overlay (`seo-sidebar.spec.ts`, `HIGHLIGHT_MODES`): only the active
   * tab showing a web page; `false` (a no-op) otherwise.
   */
  setHighlight(tabId: number, mode: HighlightMode): boolean;
  /**
   * Writes the links `filter` selects from the tab's ready audit to the system clipboard as CSV
   * (`seo-sidebar.spec.ts`, `LINKS_CSV_COLUMNS`); answers how many rows, or `null` (nothing
   * written) without a ready audit, or when it is not the audit the panel shows (`audit`).
   */
  copyLinksCsv(tabId: number, audit: SeoAuditRef, filter: LinkFilter): number | null;
  /**
   * Writes `url` to the system clipboard if the tab's ready audit is the one the panel shows
   * (`audit`) and lists it (`pageUrls`, parsed hrefs); else `false`, nothing written.
   */
  copyUrl(tabId: number, audit: SeoAuditRef, url: string): boolean;
}

/** Everything main hands to procedures. Optional so that a context without a service fails closed. */
export interface IpcServices {
  readonly browser?: BrowserService;
  readonly seo?: SeoService;
}
