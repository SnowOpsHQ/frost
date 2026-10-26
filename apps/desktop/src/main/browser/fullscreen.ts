import { FULLSCREEN_EXIT_SETTLE_MS, FULLSCREEN_NOTICE_MS } from '@app/specs/permissions.spec';
import { aliveContents, type FullscreenMode, type StripState, type Tab } from './tab-model';

// HTML fullscreen of a tab (spec `permissions.feature.md`, HTML fullscreen): the notice phase, the
// window's OS fullscreen, frost taking a tab out of it (Esc, the tab no longer shown, the tab
// going) and asking the page to leave once the window settled.

/**
 * The isolated world main leaves HTML fullscreen from (`document.exitFullscreen()`): the page's own
 * scripts cannot replace the DOM methods seen there.
 */
const FULLSCREEN_EXIT_WORLD_ID = 1_001;
const EXIT_FULLSCREEN_SCRIPT = 'document.fullscreenElement && document.exitFullscreen().catch(() => undefined)';

export interface Fullscreen {
  /** Forgets `tab`'s HTML fullscreen (no bounds or state update); answers whether it had one. */
  clear(tab: Tab): boolean;
  /**
   * Takes the window out of OS fullscreen (which Electron entered for a page). Called only when a
   * tab was fullscreen, and unconditionally then: on macOS `isFullScreen()` is still `false` during
   * the native enter animation, and Electron queues a leave requested mid-transition.
   */
  leaveWindowFullscreen(): void;
  /** The page entered HTML fullscreen (`enter-html-full-screen`): the notice phase first. */
  entered(tab: Tab): void;
  /** Electron left HTML fullscreen on its own (`leave-html-full-screen`); the page is asked as well. */
  left(tab: Tab): void;
  /**
   * frost takes `tab` out of HTML fullscreen (Esc, or the tab stops being shown), from main and at
   * once: its state (the notice goes), the window's OS fullscreen and the view's bounds (the page
   * area under the chrome). This state is authoritative: it holds even if the page never leaves
   * its own fullscreen (it hangs, or Chromium ignores the request mid-transition). Only then is the
   * page asked to leave, and asked again later (`exitRequested`).
   */
  leave(tab: Tab): void;
  /**
   * (Re)starts the wait after which the pages of tabs with `exitRequested` are asked to leave HTML
   * fullscreen: `FULLSCREEN_EXIT_SETTLE_MS` with no window or tab fullscreen event, the window out
   * of OS fullscreen (still in it, its `leave-full-screen` restarts the wait). On macOS a request
   * made while the native animation runs, or is queued to run (`isFullScreen()` does not tell), is
   * never completed and blocks every later one.
   */
  schedulePageExits(): void;
  /** The window is gone: no page exit is pending any more. */
  cancelPageExits(): void;
}

export interface FullscreenDeps {
  readonly strip: StripState;
  /** Lays `tab`'s view out for its fullscreen mode (or the page area). */
  applyBounds(tab: Tab): void;
  /** The state changed (bumps the version). */
  changed(): void;
}

export function createFullscreen({ strip, applyBounds, changed }: FullscreenDeps): Fullscreen {
  /** Asks pending pages to leave HTML fullscreen once the window settled (`schedulePageExits`). */
  let pageExitTimer: ReturnType<typeof setTimeout> | undefined;

  /** Reports a change of `tab.fullscreen` in its state. */
  const report = (tab: Tab): void => {
    if (tab.state.fullscreen === tab.fullscreen) return;
    tab.state = { ...tab.state, fullscreen: tab.fullscreen };
    changed();
  };

  const clear = (tab: Tab): boolean => {
    clearTimeout(tab.fullscreenTimer);
    tab.fullscreenTimer = undefined;
    const was = tab.fullscreen !== null;
    tab.fullscreen = null;
    return was;
  };

  const leaveWindowFullscreen = (): void => {
    const win = strip.win;
    if (win && !win.isDestroyed()) win.setFullScreen(false);
  };

  /** `tab` entered (`notice` first, then `full`) or left HTML fullscreen. */
  const set = (tab: Tab, mode: FullscreenMode | null): void => {
    clear(tab);
    tab.fullscreen = mode;
    if (mode === 'notice') {
      tab.fullscreenTimer = setTimeout(() => {
        if (tab.fullscreen === 'notice' && strip.tabs.includes(tab)) set(tab, 'full');
      }, FULLSCREEN_NOTICE_MS);
    }
    applyBounds(tab);
    report(tab);
  };

  /** Asks `tab`'s page to leave HTML fullscreen, from an isolated world the page cannot tamper with. */
  const exitHtmlFullscreen = (tab: Tab): void => {
    const contents = tab.view ? aliveContents(tab.view) : undefined;
    contents?.executeJavaScriptInIsolatedWorld(FULLSCREEN_EXIT_WORLD_ID, [{ code: EXIT_FULLSCREEN_SCRIPT }]).catch(() => {
      // The page is gone or navigating; nothing is fullscreen any more.
    });
  };

  const cancelPageExits = (): void => {
    clearTimeout(pageExitTimer);
    pageExitTimer = undefined;
  };

  const schedulePageExits = (): void => {
    cancelPageExits();
    if (!strip.tabs.some((tab) => tab.exitRequested)) return;
    pageExitTimer = setTimeout(() => {
      pageExitTimer = undefined;
      const win = strip.win;
      if (!win || win.isDestroyed() || win.isFullScreen()) return;
      for (const tab of strip.tabs) if (tab.exitRequested) exitHtmlFullscreen(tab);
    }, FULLSCREEN_EXIT_SETTLE_MS);
  };

  /** `tab` left HTML fullscreen: its page is asked to leave once the window settled, and again later. */
  const requestPageExit = (tab: Tab): void => {
    tab.exitRequested = true;
    schedulePageExits();
  };

  return {
    clear,
    leaveWindowFullscreen,
    entered(tab) {
      tab.exitRequested = false;
      set(tab, 'notice');
      schedulePageExits();
    },
    left(tab) {
      set(tab, null);
      requestPageExit(tab);
    },
    leave(tab) {
      if (!clear(tab)) return;
      leaveWindowFullscreen();
      applyBounds(tab);
      report(tab);
      requestPageExit(tab);
    },
    schedulePageExits,
    cancelPageExits,
  };
}
