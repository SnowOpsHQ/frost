import type { BrowserState, PageBounds } from '@app/specs/browser.spec';

// Main-process services the procedures call (spec `specs/browser.spec.ts`). Main supplies the
// implementations through the IPC context (`IpcHandlerOptions.services`); this package only knows
// the interfaces, so it stays free of Electron.

/** The browser controller as the `browser.*` procedures see it (acceptance: `browser-chrome.feature.md`). */
export interface BrowserService {
  /**
   * Resolves `input` like the address bar (`resolveAddressInput`) and loads it. `true` if a
   * navigation started; `false` for a no-op (empty input, no tab or window).
   */
  navigate(input: string): boolean;
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
