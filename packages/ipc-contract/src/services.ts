import type { BrowserState, PageBounds } from '@app/specs/browser.spec';

// Main-process services the procedures call (spec `specs/browser.spec.ts`). Main supplies the
// implementations through the IPC context (`IpcHandlerOptions.services`); this package only knows
// the interfaces, so it stays free of Electron.

/**
 * The browser controller as the `browser.*` procedures see it (acceptance: `browser-chrome.feature.md`,
 * `tabs.feature.md`). `navigate`, `back`, `forward`, `reload` and `stop` act on the active tab.
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
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  /** The chrome's page area; main rounds and clamps it to the window before applying it. */
  setPageBounds(bounds: PageBounds): void;
  getState(): BrowserState;
  /**
   * Resolves with the state once its `version` exceeds `sinceVersion` (at once if it already
   * does; a `sinceVersion` above the current version is clamped to it). When `signal` aborts,
   * resolves with the current state and drops the waiter. At most `MAX_PENDING_WATCHES` wait; one
   * more answers the oldest early with the current state.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<BrowserState>;
}

/** Everything main hands to procedures. Optional so that a context without a service fails closed. */
export interface IpcServices {
  readonly browser?: BrowserService;
}
