// One frost per profile (spec `browser-session-db.feature.md`, Single instance): two instances on
// the same `userData` would each save their own tab strip over the other's. A second launch hands
// over to the first (which shows its window) and quits. No Electron imports: the app and windows
// are injected, so this runs under Vitest.

/** The parts of Electron's `app` used here. */
export interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  isReady(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** The parts of a `BrowserWindow` used here. */
export interface ShowableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Takes the profile's single-instance lock. Without it (another frost has this profile) the app
 * quits and `false` is answered: the caller must start nothing (not even open the database).
 * With it, a later launch on the same profile shows this instance's window: restored if
 * minimized and focused, or opened if there is none (macOS); nothing before the app is ready.
 */
export function claimSingleInstance(app: InstanceApp, options: { windows: () => readonly ShowableWindow[]; openWindow: () => void }): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    if (!app.isReady()) return;
    const win = options.windows().find((w) => !w.isDestroyed());
    if (!win) {
      options.openWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  return true;
}
